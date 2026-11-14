'use strict';

const cds = require('@sap/cds');
const crypto = require('node:crypto');
const { AuthorizationError, isProductionRuntime, resolveAuthContext, requirePersona } = require('./utils/personaAuth');
const { canonicalConnectionFingerprint, issueConnectionToken, verifyConnectionToken, runPipoVerifyScript } = require('./utils/pipoDestinationVerifier');
const { DiscoveryJobError, getCapacitySnapshot, createAtomicDiscoveryManager } = require('./utils/pipoAtomicRunner');
const { buildArchitectReport } = require('./utils/pipoArchitectReport');
const { getTenantVectorStore } = require('./ai/pgVectorStore');

module.exports = cds.service.impl(function () {
  const defaultAtomicManager = createAtomicDiscoveryManager();
  const getAtomicManager = () => this._customAtomicManager || defaultAtomicManager;
  const getVerifyRunner = () => this._customVerifyRunner || runPipoVerifyScript;

  function rejectSafe(req, err, fallbackMessage = 'Discovery service operation failed.') {
    const numericCode = Number.isInteger(Number(err?.code)) && Number(err.code) >= 400 && Number(err.code) < 600
      ? Number(err.code)
      : null;
    const status = err?.statusCode || err?.status || numericCode;
    if (err instanceof AuthorizationError || err instanceof DiscoveryJobError || status) {
      return req.reject(status || 400, err.message);
    }
    return req.reject(503, fallbackMessage);
  }

  const discoveryEntities = () => cds.entities('pipo.discovery');

  this.on('getCurrentPersona', async (req) => {
    try {
      const ctx = resolveAuthContext(req);
      return { tenantId: ctx.tenantId, persona: ctx.persona, userId: ctx.userId, isProduction: isProductionRuntime(), allowedTools: [...ctx.allowedTools] };
    } catch (err) { return rejectSafe(req, err); }
  });

  this.on('verifyConnection', async (req) => {
    try {
      const ctx = requirePersona(req, ['Admin']);
      const form = {
        systemName: req.data.systemName, systemVersion: req.data.systemVersion, address: req.data.address,
        userId: req.data.userId, password: req.data.password, authType: req.data.authType,
        proxyType: req.data.proxyType, locationId: req.data.locationId, subaccount: req.data.subaccount
      };
      const result = await (getVerifyRunner())(form);
      if (!result || result.connected !== true) {
        return {
          connected: false, connectionToken: '', formFingerprint: '',
          code: result?.code || 'CONNECTION_FAILED', field: result?.field || '',
          layer: result?.layer || 'destination', userMessage: result?.userMessage || 'SAP PI/PO connection test failed.',
          detailsJson: JSON.stringify(result || {})
        };
      }
      const fp = canonicalConnectionFingerprint(form);
      const token = issueConnectionToken({ tenantId: ctx.tenantId, projectId: req.data.projectId || 'PIPO32Migration', formFingerprint: fp });
      return {
        connected: true, connectionToken: token, formFingerprint: fp, code: 'CONNECTED', field: '', layer: 'source',
        userMessage: result.userMessage,
        detailsJson: JSON.stringify({ destinationMatch: result.destinationMatch, tunnel: result.tunnel, virtualHost: result.virtualHost })
      };
    } catch (err) { return rejectSafe(req, err, 'Unable to verify PI/PO connection.'); }
  });

  this.on('startDiscovery', async (req) => {
    try {
      const ctx = requirePersona(req, ['Admin']);
      const projectId = req.data.projectId || 'PIPO32Migration';
      const form = {
        systemName: req.data.systemName, systemVersion: req.data.systemVersion, address: req.data.address,
        userId: req.data.userId, authType: req.data.authType, proxyType: req.data.proxyType,
        locationId: req.data.locationId, subaccount: req.data.subaccount
      };
      verifyConnectionToken(req.data.connectionToken, { tenantId: ctx.tenantId, projectId, expectedFingerprint: canonicalConnectionFingerprint(form) });
      return await getAtomicManager().startAtomicDiscovery({ tenantId: ctx.tenantId, projectId, connectionMeta: form });
    } catch (err) { return rejectSafe(req, err, 'Unable to start atomic discovery job.'); }
  });

  this.on('cancelDiscovery', async (req) =>
    req.reject(409, 'ATOMIC_JOB_LOCKED: Discovery jobs are strictly atomic (all-or-nothing) and cannot be cancelled while running.')
  );
  this.on('getDiscoveryStatus', async (req) => {
    try {
      const ctx = resolveAuthContext(req);
      await getAtomicManager().expireOrphanedLeases(ctx.tenantId);
      const { DiscoveryRuns, PlanApprovals } = discoveryEntities();
      const projectId = req.data.projectId || 'PIPO32Migration';
      let run = null;
      if (req.data.runId) {
        run = await cds.db.run(cds.ql.SELECT.one.from(DiscoveryRuns).where({ ID: req.data.runId, tenantId: ctx.tenantId }));
      } else {
        const rows = await cds.db.run(cds.ql.SELECT.from(DiscoveryRuns).where({ tenantId: ctx.tenantId, projectId }).orderBy('createdAt desc').limit(1));
        run = rows[0] || null;
      }
      if (!run) {
        return { found: false, runId: '', status: 'NONE', isActive: false, nonCancellable: true, phase: '', progressPct: 0, progressMessage: 'No discovery run yet.', totalObjects: 0, icoCount: 0, channelCount: 0, mappingCount: 0, ccBpmCount: 0, failedEndpoints: 0, planRevisionHash: '', approvalStatus: 'PENDING', approvedBy: '', errorCode: '', errorMessage: '', completedAt: null };
      }
      const approvalRows = await cds.db.run(cds.ql.SELECT.from(PlanApprovals).where({ tenantId: ctx.tenantId, projectId, run_ID: run.ID }).orderBy('decidedAt desc').limit(1));
      const latestApproval = approvalRows[0];
      return {
        found: true, runId: run.ID, status: run.status, isActive: Boolean(run.isActive), nonCancellable: true,
        phase: run.phase || '', progressPct: run.progressPct || 0, progressMessage: run.progressMessage || '',
        totalObjects: run.totalObjects || 0, icoCount: run.icoCount || 0, channelCount: run.channelCount || 0,
        mappingCount: run.mappingCount || 0, ccBpmCount: run.ccBpmCount || 0, failedEndpoints: run.failedEndpoints || 0,
        planRevisionHash: run.planRevisionHash || '',
        approvalStatus: latestApproval ? latestApproval.decision : 'PENDING',
        approvedBy: latestApproval ? latestApproval.decidedBy : '',
        errorCode: run.errorCode || '', errorMessage: run.errorMessage || '', completedAt: run.completedAt || null
      };
    } catch (err) { return rejectSafe(req, err); }
  });

  this.on('getArchitectReport', async (req) => {
    try {
      const ctx = resolveAuthContext(req);
      const { DiscoveryRuns, DiscoveredArtifacts, ArtifactDependencies, PlanApprovals } = discoveryEntities();
      const projectId = req.data.projectId || 'PIPO32Migration';
      const run = req.data.runId
        ? await cds.db.run(cds.ql.SELECT.one.from(DiscoveryRuns).where({ ID: req.data.runId, tenantId: ctx.tenantId, status: 'COMPLETED' }))
        : await cds.db.run(cds.ql.SELECT.one.from(DiscoveryRuns).where({ tenantId: ctx.tenantId, projectId, isActive: true, status: 'COMPLETED' }));
      if (!run) return req.reject(404, 'No completed atomic discovery run found for this tenant/project.');
      const [artifacts, deps, approvals] = await Promise.all([
        cds.db.run(cds.ql.SELECT.from(DiscoveredArtifacts).where({ tenantId: ctx.tenantId, run_ID: run.ID })),
        cds.db.run(cds.ql.SELECT.from(ArtifactDependencies).where({ tenantId: ctx.tenantId, run_ID: run.ID })),
        cds.db.run(cds.ql.SELECT.from(PlanApprovals).where({ tenantId: ctx.tenantId, run_ID: run.ID }).orderBy('decidedAt desc').limit(1))
      ]);
      const report = buildArchitectReport(run, artifacts, deps, req.data.filter || 'interfaces');
      const waveInterfaces = artifacts
        .filter((a) => ['IntegratedConfiguration', 'IntegrationProcess'].includes(a.artifactType))
        .concat(artifacts.some((a) => a.artifactType === 'IntegratedConfiguration') ? [] : artifacts.filter((a) => a.artifactType === 'ServiceInterface').slice(0, 30));
      report.projectDetails = {
        projectId, projectName: `${run.systemName}_PIPO_2_IS_Migration`, sourceSystem: run.systemName,
        sourceVersion: run.systemVersion, subaccount: run.subaccount, locationId: run.locationId,
        discoveredAt: run.completedAt, totalCatalogued: artifacts.length, migrationInterfacesCount: waveInterfaces.length
      };
      report.wavePlan = {
        planRevisionHash: run.planRevisionHash,
        approvalStatus: approvals[0]?.decision || 'PENDING',
        approvedBy: approvals[0]?.decidedBy || null,
        approvedAt: approvals[0]?.decidedAt || null,
        items: waveInterfaces.map((a) => ({
          id: a.objectId, name: a.name,
          type: a.artifactType === 'IntegratedConfiguration' ? 'ICO' : a.artifactType,
          tier: a.complexityTier, complexityScore: a.complexityScore, wave: a.waveNumber,
          estimatedHours: Number(a.estimatedHours || 4), adapterType: a.adapterType,
          sender: a.senderComponent, receiver: a.receiverComponent,
          proposedTarget: a.proposedTarget, isCcBpm: Boolean(a.isCcBpm), processSteps: a.processSteps || 0
        }))
      };
      return JSON.stringify(report);
    } catch (err) { return rejectSafe(req, err); }
  });

  this.on('rerunDiscovery', async (req) => {
    try {
      const ctx = requirePersona(req, ['Admin']);
      const projectId = req.data.projectId || 'PIPO32Migration';
      const form = {
        systemName: req.data.systemName, systemVersion: req.data.systemVersion, address: req.data.address,
        userId: req.data.userId, authType: req.data.authType, proxyType: req.data.proxyType,
        locationId: req.data.locationId, subaccount: req.data.subaccount
      };
      verifyConnectionToken(req.data.connectionToken, { tenantId: ctx.tenantId, projectId, expectedFingerprint: canonicalConnectionFingerprint(form) });
      const res = await getAtomicManager().rerunAtomicDiscovery({
        tenantId: ctx.tenantId, projectId, connectionMeta: form,
        confirmInvalidateApprovals: Boolean(req.data.confirmInvalidateApprovals)
      });
      return {
        confirmationRequired: Boolean(res.confirmationRequired), hasActiveApproval: Boolean(res.hasActiveApproval),
        approvedBy: res.approvedBy || '', runId: res.runId || '', status: res.status || 'CONFIRMATION_NEEDED',
        priorRunsWiped: res.priorRunsWiped || 0, message: res.message || 'Prior run wiped and fresh discovery started.'
      };
    } catch (err) { return rejectSafe(req, err); }
  });

  this.on('approveWavePlan', async (req) => {
    try {
      const ctx = requirePersona(req, ['Approver']);
      const { DiscoveryRuns, PlanApprovals } = discoveryEntities();
      const projectId = req.data.projectId || 'PIPO32Migration';
      const run = await cds.db.run(cds.ql.SELECT.one.from(DiscoveryRuns).where({ ID: req.data.runId, tenantId: ctx.tenantId, status: 'COMPLETED' }));
      if (!run) return req.reject(404, 'Discovery run not found for tenant.');
      const revHash = req.data.planRevisionHash || run.planRevisionHash;
      if (revHash !== run.planRevisionHash) return req.reject(409, 'Plan revision hash is stale; reload the latest discovery wave plan before approving.');
      await cds.db.run(cds.ql.INSERT.into(PlanApprovals).entries({
        ID: crypto.randomUUID(), tenantId: ctx.tenantId, projectId, run_ID: run.ID, planRevisionHash: revHash,
        decision: 'APPROVED', decidedBy: ctx.userId, decidedPersona: ctx.persona,
        rationale: String(req.data.rationale || 'Approved via Migration Factory governance gate.').slice(0, 500),
        decidedAt: new Date().toISOString()
      }));
      return { approved: true, decision: 'APPROVED', decidedBy: ctx.userId, planRevisionHash: revHash, message: `Wave plan revision ${revHash.slice(0, 8)} approved by ${ctx.userId}. Admin deployment is now unlocked.` };
    } catch (err) { return rejectSafe(req, err); }
  });

  this.on('rejectWavePlan', async (req) => {
    try {
      const ctx = requirePersona(req, ['Approver']);
      const { DiscoveryRuns, PlanApprovals } = discoveryEntities();
      const projectId = req.data.projectId || 'PIPO32Migration';
      const run = await cds.db.run(cds.ql.SELECT.one.from(DiscoveryRuns).where({ ID: req.data.runId, tenantId: ctx.tenantId, status: 'COMPLETED' }));
      if (!run) return req.reject(404, 'Discovery run not found for tenant.');
      await cds.db.run(cds.ql.INSERT.into(PlanApprovals).entries({
        ID: crypto.randomUUID(), tenantId: ctx.tenantId, projectId, run_ID: run.ID, planRevisionHash: run.planRevisionHash,
        decision: 'REJECTED', decidedBy: ctx.userId, decidedPersona: ctx.persona,
        rationale: String(req.data.rationale || 'Rejected — requires wave adjustment.').slice(0, 500),
        decidedAt: new Date().toISOString()
      }));
      return { approved: false, decision: 'REJECTED', decidedBy: ctx.userId, message: `Wave plan rejected by ${ctx.userId}. Deployment remains locked.` };
    } catch (err) { return rejectSafe(req, err); }
  });

  this.on('deployApprovedWave', async (req) => {
    try {
      const ctx = requirePersona(req, ['Admin']);
      const { DiscoveryRuns, PlanApprovals } = discoveryEntities();
      const projectId = req.data.projectId || 'PIPO32Migration';
      const run = await cds.db.run(cds.ql.SELECT.one.from(DiscoveryRuns).where({ ID: req.data.runId, tenantId: ctx.tenantId, isActive: true, status: 'COMPLETED' }));
      if (!run) return req.reject(404, 'No active completed discovery run found for deployment.');
      const approvals = await cds.db.run(cds.ql.SELECT.from(PlanApprovals).where({ tenantId: ctx.tenantId, projectId, run_ID: run.ID }).orderBy('decidedAt desc').limit(1));
      const latest = approvals[0];
      if (!latest || latest.decision !== 'APPROVED' || latest.planRevisionHash !== run.planRevisionHash) {
        return req.reject(412, 'APPROVAL_REQUIRED: An Approver must approve the current wave plan revision before an Admin can deploy.');
      }
      await cds.db.run(cds.ql.UPDATE(PlanApprovals).set({ deployedAt: new Date().toISOString(), deployedBy: ctx.userId }).where({ ID: latest.ID, tenantId: ctx.tenantId }));
      const waveNum = Number(req.data.waveNumber || 1);
      return { deployed: true, waveNumber: waveNum, approvedBy: latest.decidedBy, message: `Wave ${waveNum} deployment package staged & dispatched for target ${req.data.targetTenant || 'SAP Integration Suite'} under Approver sign-off (${latest.decidedBy}).` };
    } catch (err) { return rejectSafe(req, err); }
  });

  this.on('semanticSearchArtifacts', async (req) => {
    try {
      const ctx = resolveAuthContext(req);
      const store = getTenantVectorStore();
      const { DiscoveryRuns } = discoveryEntities();
      let runId = null;
      if (req.data.projectId) {
        const active = await cds.db.run(cds.ql.SELECT.one.from(DiscoveryRuns).where({ tenantId: ctx.tenantId, projectId: req.data.projectId, isActive: true }));
        runId = active?.ID || null;
      }
      const hits = await store.searchTenant(ctx.tenantId, req.data.query || '', { runId, chunkKind: req.data.chunkKind || null, topK: req.data.topK || 8 });
      return JSON.stringify({ tenantId: ctx.tenantId, vectorBackend: store.backend, results: hits });
    } catch (err) { return rejectSafe(req, err); }
  });

  this.on('getCapacityHealth', async (req) => {
    try {
      requirePersona(req, ['Admin']);
      return JSON.stringify(getCapacitySnapshot({ vectorStore: getTenantVectorStore() }));
    } catch (err) { return rejectSafe(req, err); }
  });
});
