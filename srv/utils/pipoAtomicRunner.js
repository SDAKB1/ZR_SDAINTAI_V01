'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { AsyncResource } = require('node:async_hooks');
const cds = require('@sap/cds');

// Captured at module load time (outside any HTTP request AsyncLocalStorage)
const ROOT_ASYNC_SCOPE = new AsyncResource('PipoDetachedScope');

const LEASE_TTL_MS = 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 12 * 1000;
const MAX_GLOBAL_CONCURRENT_JOBS = Number(process.env.PIPO_MAX_CONCURRENT_DISCOVERY_JOBS || 4);
const HEAP_RATIO_LIMIT = Number(process.env.PIPO_HEAP_HIGH_WATERMARK || 0.85);

const activeWorkerCountByTenant = new Map();
let globalActiveWorkers = 0;

class DiscoveryJobError extends Error {
  constructor(code, message, statusCode = 400, extra = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}

function getCapacitySnapshot({ vectorStore = null } = {}) {
  const v8 = require('node:v8');
  const heapStats = v8.getHeapStatistics();
  const mem = process.memoryUsage();
  const heapUsedRatio = heapStats.heap_size_limit > 0 ? mem.heapUsed / heapStats.heap_size_limit : 0;
  const cpuLoad = os.loadavg ? os.loadavg()[0] : 0;
  const scaleHorizontalRecommended = globalActiveWorkers >= Math.max(1, MAX_GLOBAL_CONCURRENT_JOBS - 1);
  const scaleVerticalRecommended = heapUsedRatio >= 0.75;

  return {
    instanceId: process.env.CF_INSTANCE_INDEX || String(process.pid),
    activeGlobalDiscoveryJobs: globalActiveWorkers,
    maxGlobalDiscoveryJobs: MAX_GLOBAL_CONCURRENT_JOBS,
    activeTenants: activeWorkerCountByTenant.size,
    memoryRssMb: Math.round(mem.rss / (1024 * 1024)),
    heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
    heapLimitMb: Math.round(heapStats.heap_size_limit / (1024 * 1024)),
    heapUsedRatio: Number(heapUsedRatio.toFixed(3)),
    cpuLoad1m: Number(cpuLoad.toFixed(2)),
    vectorPool: vectorStore ? vectorStore.getPoolStats() : null,
    scalingRecommendation: scaleVerticalRecommended
      ? 'VERTICAL_SCALE_UP_MEMORY_AND_DISK'
      : scaleHorizontalRecommended
        ? 'HORIZONTAL_SCALE_OUT_INSTANCES'
        : 'HEALTHY'
  };
}

function assertInstanceCapacity() {
  const snap = getCapacitySnapshot();
  if (snap.activeGlobalDiscoveryJobs >= MAX_GLOBAL_CONCURRENT_JOBS) {
    throw new DiscoveryJobError(
      'CAPACITY_HORIZONTAL_SCALE_REQUIRED',
      `Discovery worker pool at capacity (${snap.activeGlobalDiscoveryJobs}/${MAX_GLOBAL_CONCURRENT_JOBS} active jobs). Retry shortly while horizontal autoscaling adds instances.`,
      503,
      { retryAfterSeconds: 30, scalingAction: 'HORIZONTAL_SCALE_OUT' }
    );
  }
  if (snap.heapUsedRatio >= HEAP_RATIO_LIMIT) {
    throw new DiscoveryJobError(
      'CAPACITY_VERTICAL_SCALE_REQUIRED',
      `Instance memory utilization (${Math.round(snap.heapUsedRatio * 100)}%) exceeded safety watermark to protect in-flight atomic jobs. Vertical scale-up triggered.`,
      503,
      { retryAfterSeconds: 45, scalingAction: 'VERTICAL_SCALE_UP' }
    );
  }
  return snap;
}

async function verifyRunManifestIntegrity(runDir) {
  const manifestPath = path.join(runDir, 'manifest.json');
  const rawManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (rawManifest.status !== 'completed' || !Array.isArray(rawManifest.files)) {
    throw new DiscoveryJobError('MANIFEST_INCOMPLETE', 'Discovery run manifest did not complete cleanly.', 502);
  }
  for (const entry of rawManifest.files) {
    const rel = String(entry.filename || entry.path || '');
    const expectedSize = entry.size ?? entry.bytes;
    const expectedHash = entry.hash || entry.sha256;
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
      throw new DiscoveryJobError('MANIFEST_UNSAFE_PATH', 'Unsafe file path detected in discovery manifest.', 502);
    }
    const targetPath = path.join(runDir, rel);
    const bytes = await fs.readFile(targetPath);
    if (Number.isInteger(expectedSize) && bytes.byteLength !== expectedSize) {
      throw new DiscoveryJobError('MANIFEST_SIZE_MISMATCH', `Artifact byte-size verification failed for ${rel}.`, 502);
    }
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (expectedHash && sha !== expectedHash) {
      throw new DiscoveryJobError('MANIFEST_HASH_MISMATCH', `SHA-256 integrity verification failed for ${rel}.`, 502);
    }
  }
  const manifestBytes = await fs.readFile(manifestPath);
  return {
    manifest: rawManifest,
    manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex')
  };
}

function defaultFetchPipoSpawn({ stagingParentDir, onProgress, env = process.env }) {
  return new Promise((resolve, reject) => {
    const mcpDir = path.resolve(__dirname, '../../mcp/pipo-rfc-server');
    const scriptPath = path.join(mcpDir, 'fetch-pipo.js');
    const envFilePath = path.join(mcpDir, '.env');
    const fsSync = require('node:fs');
    const args = [];
    if (fsSync.existsSync(envFilePath)) args.push(`--env-file=${envFilePath}`);
    args.push(scriptPath, '--export', `--output-dir=${stagingParentDir}`);

    const childEnv = { ...env };
    delete childEnv.NODE_OPTIONS;

    const child = spawn(process.execPath, args, {
      cwd: mcpDir,
      env: childEnv,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderrBuf = '';
    let endpointDone = 0;
    let readsDone = 0;
    let generatedRunDir = null;

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop() || '';
      for (const line of lines) {
        const dirMatch = line.match(/\[PIPO\] Run reports:\s*(.+)$/);
        if (dirMatch) generatedRunDir = dirMatch[1].trim();
        if (line.startsWith('[pipo-discovery] ')) {
          try {
            const evt = JSON.parse(line.slice('[pipo-discovery] '.length));
            if (evt.phase === 'discovery' && evt.event === 'endpoint-result') {
              endpointDone += 1;
              const pct = Math.min(42, 8 + Math.round((endpointDone / 23) * 34));
              onProgress?.({ phase: 'endpoints', progressPct: pct, progressMessage: `Probed ${endpointDone}/23 PI/PO discovery endpoints (${evt.tool || ''})…` });
            } else if (evt.phase === 'read' || evt.event === 'read-result') {
              readsDone += 1;
              const pct = Math.min(78, 44 + Math.min(34, Math.floor(readsDone / 8)));
              onProgress?.({ phase: 'reads', progressPct: pct, progressMessage: `Exported ${readsDone} sanitized definition/ESR payloads…` });
            }
          } catch { /* ignore non-JSON stderr line */ }
        }
      }
    });

    child.on('error', (err) => reject(err));
    child.on('close', async (code) => {
      if (code !== 0) {
        return reject(new DiscoveryJobError('FETCH_PIPO_FAILED', `fetch-pipo.js exited with code ${code}; partial staging rolled back.`, 502));
      }
      try {
        if (!generatedRunDir) {
          const entries = await fs.readdir(stagingParentDir, { withFileTypes: true });
          const sub = entries.find((d) => d.isDirectory());
          if (sub) generatedRunDir = path.join(stagingParentDir, sub.name);
        }
        if (!generatedRunDir) throw new Error('No run directory generated.');
        resolve({ runDir: generatedRunDir });
      } catch (err) {
        reject(new DiscoveryJobError('RUN_DIR_MISSING', err.message, 502));
      }
    });
  });
}

function createAtomicDiscoveryManager({
  baseRunsDir = path.resolve(__dirname, '../../mcp/pipo-rfc-server/discovery-runs'),
  executeExportFn = defaultFetchPipoSpawn,
  getVectorStoreFn = () => require('../ai/pgVectorStore').getTenantVectorStore(),
  analyzeRunFn = (data, opts) => require('../../mcp/pipo-rfc-server/analyze-pipo-run').analyzeRun(data, opts)
} = {}) {
  const { classifyPipoObject, buildSemanticChunks, computePlanRevisionHash } = require('./pipoArchitectReport');

  function entities() {
    const disc = cds.entities('pipo.discovery');
    const aic = cds.entities('aiconx');
    return {
      DiscoveryRuns: disc.DiscoveryRuns,
      DiscoveredArtifacts: disc.DiscoveredArtifacts,
      ArtifactDependencies: disc.ArtifactDependencies,
      PlanApprovals: disc.PlanApprovals,
      MigrationAsset: aic?.MigrationAsset
    };
  }

  async function expireOrphanedLeases(tenantId) {
    const { DiscoveryRuns } = entities();
    const nowIso = new Date().toISOString();
    await cds.db.run(
      cds.ql.UPDATE(DiscoveryRuns)
        .set({
          status: 'FAILED',
          phase: 'failed',
          errorCode: 'WORKER_LEASE_EXPIRED',
          errorMessage: 'Prior discovery worker lease expired unexpectedly; staging discarded. Use Re-run Discovery to start fresh.',
          completedAt: nowIso
        })
        .where({ tenantId, status: { in: ['STAGING', 'RUNNING'] }, leaseExpiresAt: { '<': nowIso } })
    );
  }

  async function startAtomicDiscovery({ tenantId, projectId = 'PIPO32Migration', connectionMeta }) {
    await expireOrphanedLeases(tenantId);
    const { DiscoveryRuns } = entities();

    const existingActive = await cds.db.run(
      cds.ql.SELECT.one.from(DiscoveryRuns).where({
        tenantId,
        systemName: connectionMeta.systemName,
        status: { in: ['STAGING', 'RUNNING'] }
      })
    );
    if (existingActive) {
      throw new DiscoveryJobError(
        'DISCOVERY_ALREADY_RUNNING',
        `An atomic discovery run (${existingActive.ID}) is already in progress for ${connectionMeta.systemName} and cannot be cancelled or duplicated.`,
        409,
        { runId: existingActive.ID }
      );
    }

    assertInstanceCapacity();

    const runId = crypto.randomUUID();
    const now = Date.now();
    const leaseOwner = `worker-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    await cds.db.run(
      cds.ql.INSERT.into(DiscoveryRuns).entries({
        ID: runId,
        tenantId,
        projectId,
        systemName: connectionMeta.systemName,
        systemVersion: connectionMeta.systemVersion || '7.50',
        address: connectionMeta.address || '',
        subaccount: connectionMeta.subaccount || '',
        locationId: connectionMeta.locationId || '',
        authType: connectionMeta.authType || 'BasicAuthentication',
        proxyType: connectionMeta.proxyType || 'OnPremise',
        status: 'RUNNING',
        isActive: false,
        nonCancellable: true,
        phase: 'tools',
        progressPct: 5,
        progressMessage: 'Initializing non-cancellable atomic discovery worker & verifying MCP tools…',
        leaseOwner,
        leaseExpiresAt: new Date(now + LEASE_TTL_MS).toISOString(),
        startedAt: new Date(now).toISOString()
      })
    );

    // Launch non-cancellable background execution strictly outside the HTTP request's AsyncLocalStorage (cds.context)
    ROOT_ASYNC_SCOPE.runInAsyncScope(() => {
      setTimeout(() => {
        runBackgroundJob({ runId, tenantId, projectId, connectionMeta, leaseOwner }).catch(() => {});
      }, 20);
    });

    return {
      runId,
      status: 'RUNNING',
      nonCancellable: true,
      phase: 'tools',
      progressPct: 5,
      message: `Atomic discovery started for ${connectionMeta.systemName}. Job runs to completion without cancellation.`
    };
  }

  async function runBackgroundJob({ runId, tenantId, projectId, leaseOwner }) {
    const safeTenantSegment = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const tenantBaseDir = path.join(baseRunsDir, safeTenantSegment);
    const stagingDir = path.join(tenantBaseDir, `.staging-${runId}`);
    const finalRunDir = path.join(tenantBaseDir, runId);
    const { DiscoveryRuns, DiscoveredArtifacts, ArtifactDependencies, MigrationAsset } = entities();

    globalActiveWorkers += 1;
    activeWorkerCountByTenant.set(tenantId, (activeWorkerCountByTenant.get(tenantId) || 0) + 1);

    let lastProgressWrite = 0;
    const heartbeat = setInterval(() => {
      cds.db.run(
        cds.ql.UPDATE(DiscoveryRuns)
          .set({ leaseExpiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString() })
          .where({ ID: runId, tenantId, leaseOwner, status: 'RUNNING' })
      ).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    if (heartbeat.unref) heartbeat.unref();

    try {
      await fs.mkdir(stagingDir, { recursive: true });
      const onProgress = ({ phase, progressPct, progressMessage }) => {
        const now = Date.now();
        if (now - lastProgressWrite < 250 && progressPct < 75) return;
        lastProgressWrite = now;
        cds.db.run(
          cds.ql.UPDATE(DiscoveryRuns)
            .set({
              phase,
              progressPct,
              progressMessage,
              leaseExpiresAt: new Date(now + LEASE_TTL_MS).toISOString()
            })
            .where({ ID: runId, tenantId })
        ).catch(() => {});
      };

      const { runDir: rawGeneratedDir } = await executeExportFn({ stagingParentDir: stagingDir, onProgress });

      await cds.db.run(
        cds.ql.UPDATE(DiscoveryRuns)
          .set({ phase: 'analyze', progressPct: 82, progressMessage: 'Verifying SHA-256 manifest hashes & running PI/PO Architect dependency analysis…' })
          .where({ ID: runId, tenantId })
      );

      const { manifestSha256 } = await verifyRunManifestIntegrity(rawGeneratedDir);
      const discoveryBytes = await fs.readFile(path.join(rawGeneratedDir, 'discovery.json'), 'utf8');
      const discoveryJson = JSON.parse(discoveryBytes);
      const analysis = analyzeRunFn(discoveryJson, { sourceHash: manifestSha256 });

      const classified = analysis.objects.map((obj) => classifyPipoObject(obj, analysis.references));
      const depEntries = analysis.references.map((ref) => ({
        ID: crypto.randomUUID(),
        tenantId,
        run_ID: runId,
        sourceArtifactId: ref.sourceId,
        sourceName: classified.find((c) => c.objectId === ref.sourceId)?.name || ref.sourceId,
        referenceKind: ref.kind,
        targetType: ref.target?.typeID || '',
        targetKey: JSON.stringify(ref.target || {}).slice(0, 300),
        matched: ref.match?.status === 'matched-in-run'
      }));

      await cds.db.run(
        cds.ql.UPDATE(DiscoveryRuns)
          .set({ phase: 'embed', progressPct: 91, progressMessage: 'Generating semantic embeddings & indexing into pgvector cosine store…' })
          .where({ ID: runId, tenantId })
      );

      const vectorStore = getVectorStoreFn();
      const semanticChunks = buildSemanticChunks(classified, analysis);
      const planRevisionHash = computePlanRevisionHash(runId, classified);

      // Move staging directory atomically into tenant's committed discovery-runs/<tenantId>/<runId>
      await fs.rm(finalRunDir, { recursive: true, force: true }).catch(() => {});
      await fs.rename(rawGeneratedDir, finalRunDir);
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});

      const esrCount = classified.filter((c) => c.sourceArea === 'ESR').length;
      const dirCount = classified.filter((c) => c.sourceArea !== 'ESR').length;
      const icoCount = classified.filter((c) => c.artifactType === 'IntegratedConfiguration').length;
      const channelCount = classified.filter((c) => c.artifactType === 'CommunicationChannel').length;
      const mappingCount = classified.filter((c) => /Mapping/.test(c.artifactType)).length;
      const ccBpmCount = classified.filter((c) => c.isCcBpm).length;
      const failedEndpoints = (analysis.endpoints || []).filter((e) => e.status === 'failed' || (e.httpStatus && e.httpStatus >= 400)).length;

      // Single atomic DB commit for relational entities + auto-populated MigrationAssets
      await cds.db.tx(async (tx) => {
        await tx.run(cds.ql.UPDATE(DiscoveryRuns).set({ isActive: false }).where({ tenantId, projectId, isActive: true }));
        if (classified.length) {
          await tx.run(cds.ql.INSERT.into(DiscoveredArtifacts).entries(
            classified.map((c) => ({ ID: crypto.randomUUID(), tenantId, run_ID: runId, ...c }))
          ));
        }
        if (depEntries.length) {
          await tx.run(cds.ql.INSERT.into(ArtifactDependencies).entries(depEntries));
        }
        if (MigrationAsset) {
          const scopedProjectKey = `${tenantId}:${projectId}`;
          await tx.run(cds.ql.DELETE.from(MigrationAsset).where({ projectId: scopedProjectKey }));
          const migScope = classified.filter((c) => ['IntegratedConfiguration', 'IntegrationProcess', 'ServiceInterface'].includes(c.artifactType)).slice(0, 150);
          if (migScope.length) {
            const nowIso = new Date().toISOString();
            await tx.run(cds.ql.INSERT.into(MigrationAsset).entries(
              migScope.map((c) => ({
                ID: crypto.randomUUID(),
                assetCode: c.objectId,
                name: c.name,
                assetType: c.artifactType,
                createdDate: nowIso,
                lastUsedDate: nowIso,
                proposedTarget: c.proposedTarget,
                complexity: c.complexityTier,
                supported: !c.isCcBpm,
                mode: c.complexityTier === 'Simple' ? 'Auto' : 'AI-Assisted',
                size: `Wave ${c.waveNumber} (${c.estimatedHours}h)`,
                projectId: scopedProjectKey
              }))
            ));
          }
        }
        if (vectorStore.backend === 'cds-tenant-vectors') {
          await vectorStore.upsertRunChunks(tenantId, runId, semanticChunks, tx);
        }
        await tx.run(
          cds.ql.UPDATE(DiscoveryRuns).set({
            status: 'COMPLETED',
            isActive: true,
            phase: 'commit',
            progressPct: 100,
            progressMessage: `Completed atomically — ${classified.length} artifacts discovered, classified into Waves 1–3, and indexed.`,
            runDirectory: path.relative(baseRunsDir, finalRunDir),
            manifestSha256,
            planRevisionHash,
            totalObjects: classified.length,
            verifiedDefs: analysis.summary.verifiedDefinitions,
            esrCount,
            dirCount,
            channelCount,
            icoCount,
            mappingCount,
            ccBpmCount,
            failedEndpoints,
            matchedRefs: analysis.summary.matchedReferences,
            unmatchedRefs: analysis.summary.unmatchedReferences,
            completedAt: new Date().toISOString(),
            summaryJson: JSON.stringify(analysis.summary),
            endpointsJson: JSON.stringify(analysis.endpoints)
          }).where({ ID: runId, tenantId })
        );
      });

      if (vectorStore.backend !== 'cds-tenant-vectors') {
        await vectorStore.upsertRunChunks(tenantId, runId, semanticChunks);
      }
    } catch (err) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(finalRunDir, { recursive: true, force: true }).catch(() => {});
      await cds.db.run(
        cds.ql.UPDATE(DiscoveryRuns).set({
          status: 'FAILED',
          isActive: false,
          phase: 'failed',
          errorCode: err.code || 'DISCOVERY_EXPORT_FAILED',
          errorMessage: String(err.message || 'Discovery failed; staging rolled back atomically.').slice(0, 500),
          completedAt: new Date().toISOString()
        }).where({ ID: runId, tenantId })
      ).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      globalActiveWorkers = Math.max(0, globalActiveWorkers - 1);
      const nextCount = (activeWorkerCountByTenant.get(tenantId) || 1) - 1;
      if (nextCount <= 0) activeWorkerCountByTenant.delete(tenantId);
      else activeWorkerCountByTenant.set(tenantId, nextCount);
    }
  }

  async function rerunAtomicDiscovery({ tenantId, projectId = 'PIPO32Migration', connectionMeta, confirmInvalidateApprovals = false }) {
    await expireOrphanedLeases(tenantId);
    const { DiscoveryRuns, DiscoveredArtifacts, ArtifactDependencies, PlanApprovals, MigrationAsset } = entities();

    const running = await cds.db.run(
      cds.ql.SELECT.one.from(DiscoveryRuns).where({ tenantId, status: { in: ['STAGING', 'RUNNING'] } })
    );
    if (running) {
      throw new DiscoveryJobError(
        'ATOMIC_JOB_LOCKED',
        `Discovery run ${running.ID} is currently executing and cannot be interrupted or wiped until finished.`,
        409
      );
    }

    const activeApproval = await cds.db.run(
      cds.ql.SELECT.one.from(PlanApprovals).where({ tenantId, projectId, decision: 'APPROVED' })
    );
    if (activeApproval && !confirmInvalidateApprovals) {
      return {
        confirmationRequired: true,
        hasActiveApproval: true,
        approvedBy: activeApproval.decidedBy,
        approvedAt: activeApproval.decidedAt,
        message: 'Existing wave/deployment approval will be invalidated and the prior discovery run will be wiped. Confirm Re-run to proceed.'
      };
    }

    const priorRuns = await cds.db.run(cds.ql.SELECT.from(DiscoveryRuns).where({ tenantId, projectId }));
    const vectorStore = getVectorStoreFn();
    const safeTenantSegment = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');

    const purgeWork = async (runner) => {
      await runner.run(cds.ql.UPDATE(PlanApprovals).set({ decision: 'INVALIDATED' }).where({ tenantId, projectId, decision: 'APPROVED' }));
      for (const old of priorRuns) {
        await runner.run(cds.ql.DELETE.from(DiscoveredArtifacts).where({ tenantId, run_ID: old.ID }));
        await runner.run(cds.ql.DELETE.from(ArtifactDependencies).where({ tenantId, run_ID: old.ID }));
      }
      if (MigrationAsset) {
        await runner.run(cds.ql.DELETE.from(MigrationAsset).where({ projectId: `${tenantId}:${projectId}` }));
      }
      await runner.run(cds.ql.DELETE.from(DiscoveryRuns).where({ tenantId, projectId }));
      if (vectorStore.backend === 'cds-tenant-vectors') {
        await vectorStore.purgeTenantRun(tenantId, null, runner);
      }
    };
    if (cds.context) await purgeWork(cds.db);
    else await cds.db.tx(purgeWork);

    if (vectorStore.backend !== 'cds-tenant-vectors') {
      await vectorStore.purgeTenantRun(tenantId, null);
    }
    for (const old of priorRuns) {
      const oldDir = path.join(baseRunsDir, safeTenantSegment, old.ID);
      await fs.rm(oldDir, { recursive: true, force: true }).catch(() => {});
    }

    const started = await startAtomicDiscovery({ tenantId, projectId, connectionMeta });
    return { ...started, confirmationRequired: false, priorRunsWiped: priorRuns.length };
  }

  return {
    startAtomicDiscovery,
    rerunAtomicDiscovery,
    expireOrphanedLeases
  };
}

module.exports = {
  LEASE_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  DiscoveryJobError,
  getCapacitySnapshot,
  assertInstanceCapacity,
  verifyRunManifestIntegrity,
  createAtomicDiscoveryManager
};
