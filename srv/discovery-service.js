'use strict';

/**
 * Discovery Service Handler
 *
 * Implements PI/PO artifact discovery with multi-tenant support.
 * Integrates with:
 * - artifactCacheService for durable caching of discovered artifacts
 * - idempotencyService for duplicate prevention
 * - SSE for real-time progress updates
 *
 * All operations preserve tenant context via cds.context.tenant.
 */

const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');
const cacheService = require('./cache/artifactCacheService');
const idempotencyService = require('./utils/idempotencyService');

const LOG = cds.log('discovery-service');

// Discovery phases with weights for progress calculation
const DISCOVERY_PHASES = [
  { name: 'Software Components', types: ['SoftwareComponentVersion'], weight: 5, category: 'esr' },
  { name: 'Integrated Configurations', types: ['IntegratedConfiguration'], weight: 20, category: 'dir' },
  { name: 'Communication Channels', types: ['CommunicationChannel'], weight: 15, category: 'dir' },
  { name: 'Message Mappings', types: ['MessageMapping', 'OperationMapping'], weight: 15, category: 'esr' },
  { name: 'Agreements', types: ['SenderAgreement', 'ReceiverAgreement'], weight: 15, category: 'dir' },
  { name: 'Value Mappings', types: ['ValueMappingGroup'], weight: 10, category: 'dir' },
];

module.exports = class DiscoveryService extends cds.ApplicationService {
  async init() {
    const { PISystem, DiscoveryJob, Artifact, AuditLog, DependencyGraph } = cds.entities('tenant');

    // Track active jobs for cancellation
    this._activeJobs = new Map();

    // ═══════════════════════════════════════════════════════════════════════════
    // ACTION: startDiscovery
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('startDiscovery', async req => {
      const tenantId = cds.context?.tenant || req.user?.tenant || 'default';
      const { systemId, includeInactive, includeHistory, artifactTypes } = req.data;

      LOG.info('startDiscovery called', { tenantId, systemId });

      if (!systemId) {
        return req.error(400, 'systemId is required');
      }

      // Get system configuration
      const system = await SELECT.one.from(PISystem).where({ ID: systemId, tenantId });

      if (!system) {
        return req.error(404, 'PI/PO system not found');
      }

      // Check idempotency - prevent duplicate concurrent discoveries
      const idempotencyKey = `discovery_${systemId}`;
      const idempotencyCheck = await idempotencyService.checkAndLock(
        tenantId,
        idempotencyKey,
        'discovery_start',
        3600 // 1 hour TTL
      );

      // If we didn't acquire the lock and there's already processing in progress
      if (!idempotencyCheck.locked && (idempotencyCheck.alreadyProcessed || idempotencyCheck.inProgress)) {
        return {
          jobId: idempotencyCheck.result?.jobId,
          status: 'already_running',
          estimatedTime: 120,
          message: `Discovery is already running for system "${system.systemName}". Job ID: ${idempotencyCheck.result?.jobId}`,
        };
      }

      try {
        // Create job record
        const jobId = randomUUID();
        const options = JSON.stringify({
          includeInactive: includeInactive || false,
          includeHistory: includeHistory || false,
          artifactTypes: artifactTypes ? JSON.parse(artifactTypes) : null,
        });

        await INSERT.into(DiscoveryJob).entries({
          ID: jobId,
          tenantId,
          system_ID: systemId,
          status: 'pending',
          startedAt: new Date(),
          startedBy: req.user?.id || 'system',
          options,
          progressLog: '[]',
          errorLog: '[]',
          totalPhases: DISCOVERY_PHASES.length,
          currentPhase: 0,
          currentPhaseName: 'Initializing',
          progressPercent: 0,
          artifactsFound: 0,
          artifactsNew: 0,
          artifactsUpdated: 0,
          errorsCount: 0,
          warningsCount: 0,
        });

        // Update idempotency record with job ID
        await idempotencyService.complete(tenantId, idempotencyKey, { jobId });

        // Log audit
        await this._audit(tenantId, req.user, 'discovery_started', 'DiscoveryJob', jobId, system.systemName, {
          systemId,
          options,
        });

        // Start async discovery (non-blocking)
        const discoveryPromise = this._runDiscoveryAsync(
          jobId,
          system,
          {
            includeInactive,
            includeHistory,
            artifactTypes: artifactTypes ? JSON.parse(artifactTypes) : null,
          },
          tenantId
        )
          .catch(err => {
            LOG.error('Discovery job failed', { jobId, tenantId, error: err.message, stack: err.stack });
            return this._updateJobStatus(jobId, tenantId, 'failed', err.message);
          })
          .finally(() => {
            this._activeJobs.delete(jobId);
            idempotencyService.remove(tenantId, idempotencyKey);
          });

        this._activeJobs.set(jobId, discoveryPromise);

        return {
          jobId,
          status: 'pending',
          estimatedTime: 120,
          message: `Discovery started for "${system.systemName}". Monitor progress via getDiscoveryProgress or SSE.`,
        };
      } catch (error) {
        await idempotencyService.fail(tenantId, idempotencyKey, error);
        LOG.error('Error starting discovery', { tenantId, systemId, error: error.message });
        return req.error(500, `Failed to start discovery: ${error.message}`);
      }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // FUNCTION: getDiscoveryProgress
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('getDiscoveryProgress', async req => {
      const tenantId = cds.context?.tenant || req.user?.tenant || 'default';
      const { jobId } = req.data;

      if (!jobId) {
        return req.error(400, 'jobId is required');
      }

      const job = await SELECT.one.from(DiscoveryJob).where({ ID: jobId, tenantId });

      if (!job) {
        return req.error(404, 'Discovery job not found');
      }

      return {
        jobId: job.ID,
        status: job.status,
        phase: job.currentPhase,
        phaseName: job.currentPhaseName,
        progressPercent: job.progressPercent,
        artifactsFound: job.artifactsFound,
        currentItem: job.currentPhaseName,
        errors: job.errorLog,
        estimatedRemaining:
          job.status === 'running'
            ? Math.max(0, 120 - Math.floor((Date.now() - new Date(job.startedAt).getTime()) / 1000))
            : 0,
      };
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ACTION: cancelDiscovery
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('cancelDiscovery', async req => {
      const tenantId = cds.context?.tenant || req.user?.tenant || 'default';
      const { jobId } = req.data;

      if (!jobId) {
        return req.error(400, 'jobId is required');
      }

      const job = await SELECT.one.from(DiscoveryJob).where({ ID: jobId, tenantId });

      if (!job) {
        return req.error(404, 'Discovery job not found');
      }

      if (job.status !== 'running' && job.status !== 'pending') {
        return {
          success: false,
          message: `Cannot cancel job in status: ${job.status}`,
        };
      }

      await UPDATE(DiscoveryJob)
        .set({
          status: 'cancelled',
          completedAt: new Date(),
        })
        .where({ ID: jobId, tenantId });

      LOG.info('Discovery cancelled', { tenantId, jobId });

      return {
        success: true,
        message: 'Discovery cancelled',
      };
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // FUNCTION: getDiscoverySummary
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('getDiscoverySummary', async req => {
      const tenantId = cds.context?.tenant || req.user?.tenant || 'default';
      const { systemId } = req.data;

      if (!systemId) {
        return req.error(400, 'systemId is required');
      }

      const system = await SELECT.one.from(PISystem).where({ ID: systemId, tenantId });

      if (!system) {
        return req.error(404, 'PI/PO system not found');
      }

      const artifacts = await SELECT.from(Artifact).where({ system_ID: systemId, tenantId });

      const byType = {};
      const byTier = { simple: 0, medium: 0, complex: 0, unassessed: 0 };
      const byStatus = { discovered: 0, assessed: 0, approved: 0, migrated: 0, skipped: 0 };
      let totalHours = 0;

      for (const a of artifacts) {
        byType[a.artifactType] = (byType[a.artifactType] || 0) + 1;
        byTier[a.migrationTier || 'unassessed']++;
        byStatus[a.migrationStatus || 'discovered']++;
        totalHours += Number(a.estimatedHours) || 0;
      }

      return {
        systemName: system.systemName,
        totalArtifacts: artifacts.length,
        byType: JSON.stringify(byType),
        byTier: JSON.stringify(byTier),
        byStatus: JSON.stringify(byStatus),
        estimatedTotalHours: totalHours,
        lastDiscoveryAt: system.lastDiscoveryAt,
      };
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ACTION: assessArtifact
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('assessArtifact', async req => {
      const tenantId = cds.context?.tenant || req.user?.tenant || 'default';
      const { artifactId, async: runAsync = true } = req.data;

      if (!artifactId) {
        return req.error(400, 'artifactId is required');
      }

      const artifact = await SELECT.one.from(Artifact).where({ ID: artifactId, tenantId });

      if (!artifact) {
        return req.error(404, 'Artifact not found');
      }

      if (runAsync) {
        // Queue for async processing via CAP outbox
        const queuedService = cds.queued(this);
        await queuedService.emit('AssessmentRequested', {
          artifactId,
          tenantId,
          userId: req.user?.id || 'system',
        });

        await UPDATE(Artifact).set({ migrationStatus: 'assessing' }).where({ ID: artifactId, tenantId });

        LOG.info('Assessment queued', { tenantId, artifactId });

        return {
          artifactId,
          status: 'queued',
          message: 'Assessment queued for async processing. Monitor via SSE or polling.',
        };
      }

      // Synchronous processing
      try {
        const brainService = await cds.connect.to('BrainService');
        const assessment = await brainService.send('migrationAdvisor', {
          key: process.env.BRAIN_MASTER_KEY || 'AYMAN2026',
          objectId: artifact.objectId || artifact.name,
          objectDesc: artifact.description || artifact.name,
          segmentCount: artifact.dependencyCount || 10,
          hasZFields: false,
          mappingType: artifact.mappingType || 'graphical',
          adapterType: artifact.adapterType || 'soap',
          volumePerDay: 1000,
          isBpmProcess: false,
          isEdiBased: artifact.adapterType === 'as2',
          sourceSystem: 'SAP_PI_PO',
        });

        await UPDATE(Artifact)
          .set({
            migrationTier: assessment.tier,
            complexityScore: assessment.complexityScore,
            recommendedTool: assessment.recommendedTool,
            estimatedHours: assessment.estimatedHours,
            assessedAt: new Date(),
            assessmentNotes: assessment.rationale,
            migrationStatus: 'assessed',
            scenarioPattern: assessment.scenarioPattern,
            sapMigrationStatus: assessment.sapMigrationStatus,
            matchedTemplate: assessment.matchedTemplate,
          })
          .where({ ID: artifactId, tenantId });

        // Update cache with assessment results
        const cacheKey = `${artifact.artifactType}:${artifact.objectId}`;
        try {
          await cacheService.set(
            tenantId,
            cacheKey,
            {
              ...artifact,
              migrationTier: assessment.tier,
              complexityScore: assessment.complexityScore,
              recommendedTool: assessment.recommendedTool,
              estimatedHours: assessment.estimatedHours,
              assessedAt: new Date().toISOString(),
            },
            -1,
            { assessed: true }
          );
        } catch (cacheError) {
          LOG.warn('Cache update failed during assessment', { artifactId, error: cacheError.message });
        }

        return {
          artifactId,
          status: 'complete',
          tier: assessment.tier,
          complexityScore: assessment.complexityScore,
          recommendedTool: assessment.recommendedTool,
          estimatedHours: assessment.estimatedHours,
          rationale: assessment.rationale,
          scenarioPattern: assessment.scenarioPattern,
          sapMigrationStatus: assessment.sapMigrationStatus,
          matchedTemplate: assessment.matchedTemplate,
          message: 'Assessment complete',
        };
      } catch (error) {
        LOG.error('Assessment failed', { tenantId, artifactId, error: error.message });
        return req.error(500, `Assessment failed: ${error.message}`);
      }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENT: AssessmentRequested - Process queued assessments
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('AssessmentRequested', async data => {
      const { artifactId, tenantId, userId } = data.data || data;

      LOG.info('Processing queued assessment', { artifactId, tenantId });

      // Create transaction with tenant context
      const tx = cds.transaction({ user: { id: userId || 'system', tenant: tenantId } });

      try {
        const artifact = await tx.run(SELECT.one.from(Artifact).where({ ID: artifactId, tenantId }));

        if (!artifact) {
          LOG.warn('Artifact not found for queued assessment', { artifactId, tenantId });
          return;
        }

        const brainService = await cds.connect.to('BrainService');
        const assessment = await brainService.send('migrationAdvisor', {
          key: process.env.BRAIN_MASTER_KEY || 'AYMAN2026',
          objectId: artifact.objectId || artifact.name,
          objectDesc: artifact.description || artifact.name,
          segmentCount: artifact.dependencyCount || 10,
          hasZFields: false,
          mappingType: artifact.mappingType || 'graphical',
          adapterType: artifact.adapterType || 'soap',
          volumePerDay: 1000,
          isBpmProcess: false,
          isEdiBased: artifact.adapterType === 'as2',
          sourceSystem: 'SAP_PI_PO',
        });

        await tx.run(
          UPDATE(Artifact)
            .set({
              migrationTier: assessment.tier,
              complexityScore: assessment.complexityScore,
              recommendedTool: assessment.recommendedTool,
              estimatedHours: assessment.estimatedHours,
              assessedAt: new Date(),
              assessmentNotes: assessment.rationale,
              migrationStatus: 'assessed',
              scenarioPattern: assessment.scenarioPattern,
              sapMigrationStatus: assessment.sapMigrationStatus,
              matchedTemplate: assessment.matchedTemplate,
            })
            .where({ ID: artifactId })
        );

        await tx.commit();

        // Update cache
        const cacheKey = `${artifact.artifactType}:${artifact.objectId}`;
        try {
          await cacheService.set(
            tenantId,
            cacheKey,
            {
              ...artifact,
              migrationTier: assessment.tier,
              assessedAt: new Date().toISOString(),
            },
            -1,
            { assessed: true }
          );
        } catch (cacheError) {
          LOG.warn('Cache update failed', { artifactId, error: cacheError.message });
        }

        LOG.info('Assessment completed', { artifactId, tenantId, tier: assessment.tier });

        // Emit SSE event for UI update
        this._emitProgress(tenantId, artifactId, {
          type: 'assessment_complete',
          artifactId,
          tier: assessment.tier,
          recommendedTool: assessment.recommendedTool,
        });
      } catch (error) {
        LOG.error('Queued assessment failed', { artifactId, tenantId, error: error.message, stack: error.stack });
        await tx.rollback();
        throw error;
      }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ACTION: approveArtifact
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('approveArtifact', async req => {
      const tenantId = cds.context?.tenant || req.user?.tenant || 'default';
      const { artifactId, wave, notes } = req.data;

      if (!artifactId) {
        return req.error(400, 'artifactId is required');
      }

      if (notes && notes.length > 5000) {
        return req.error(400, 'notes exceeds maximum length of 5000 characters');
      }

      const artifact = await SELECT.one.from(Artifact).where({ ID: artifactId, tenantId });

      if (!artifact) {
        return req.error(404, 'Artifact not found');
      }

      await UPDATE(Artifact)
        .set({
          migrationStatus: 'approved',
          migrationWave: wave || 1,
          approvedBy: req.user?.id || 'system',
          approvedAt: new Date(),
          approvalNotes: notes,
        })
        .where({ ID: artifactId, tenantId });

      await this._audit(tenantId, req.user, 'artifact_approved', 'Artifact', artifactId, artifact.name, {
        wave,
        notes,
      });

      LOG.info('Artifact approved', { tenantId, artifactId, wave });

      return {
        success: true,
        message: `Artifact "${artifact.name}" approved for wave ${wave || 1}`,
      };
    });

    await super.init();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Run discovery job asynchronously with cache integration
   * @private
   */
  async _runDiscoveryAsync(jobId, system, options, tenantId) {
    const { PISystem, DiscoveryJob, Artifact, DependencyGraph } = cds.entities('tenant');
    const tx = cds.transaction({ user: { id: 'system', tenant: tenantId } });

    LOG.info('Starting async discovery', { jobId, tenantId, systemId: system.ID });

    let totalArtifactsFound = 0;
    let newArtifacts = 0;
    let updatedArtifacts = 0;
    let errorsCount = 0;
    const errors = [];

    try {
      // Update job status to running
      await tx.run(
        UPDATE(DiscoveryJob)
          .set({ status: 'running', currentPhase: 0, currentPhaseName: 'Initializing' })
          .where({ ID: jobId })
      );

      // Import SOAP client
      let PIPoSoapClient;
      try {
        const clientModule = require('./utils/pipoSoapClient');
        PIPoSoapClient = clientModule.PIPoSoapClient;
      } catch (e) {
        LOG.warn('PIPoSoapClient not available, using mock data', { error: e.message });
        PIPoSoapClient = null;
      }

      // Process each phase
      for (let phaseIndex = 0; phaseIndex < DISCOVERY_PHASES.length; phaseIndex++) {
        const phase = DISCOVERY_PHASES[phaseIndex];

        // Check for cancellation
        const jobStatus = await tx.run(SELECT.one.from(DiscoveryJob).columns('status').where({ ID: jobId }));
        if (jobStatus?.status === 'cancelled') {
          LOG.info('Discovery cancelled by user', { jobId, tenantId });
          break;
        }

        const progressPercent = Math.round((phaseIndex / DISCOVERY_PHASES.length) * 100);

        // Update phase progress
        await tx.run(
          UPDATE(DiscoveryJob)
            .set({
              currentPhase: phaseIndex + 1,
              currentPhaseName: phase.name,
              progressPercent,
            })
            .where({ ID: jobId })
        );

        // Emit SSE progress event
        this._emitProgress(tenantId, jobId, {
          type: 'phase_start',
          phase: phaseIndex + 1,
          phaseName: phase.name,
          progressPercent,
        });

        LOG.debug('Processing phase', { jobId, phase: phase.name, phaseIndex: phaseIndex + 1 });

        // Process each artifact type in the phase
        for (const artifactType of phase.types) {
          try {
            // Use idempotency service for each artifact type processing
            const typeKey = `discovery_${jobId}_${artifactType}`;
            const typeCheck = await idempotencyService.checkAndLock(tenantId, typeKey, 'artifact_type_discovery', 300);

            if (typeCheck.exists && typeCheck.status === 'completed') {
              LOG.debug('Artifact type already processed', { artifactType, jobId });
              continue;
            }

            let artifacts = [];

            if (PIPoSoapClient) {
              // Create client and query artifacts
              const client = new PIPoSoapClient(
                phase.category === 'dir' ? system.destinationDir : system.destinationEsr
              );

              try {
                artifacts = await this._queryArtifacts(client, artifactType);
              } catch (queryError) {
                LOG.warn('Query failed for artifact type', { artifactType, error: queryError.message });
                errors.push({
                  ts: new Date().toISOString(),
                  phase: phase.name,
                  type: artifactType,
                  message: queryError.message,
                });
                errorsCount++;
              }
            } else {
              // Use mock data for local development
              artifacts = this._getMockArtifacts(artifactType);
            }

            // Process and cache each artifact
            for (const artifact of artifacts) {
              try {
                const result = await this._processArtifact(tx, tenantId, system.ID, jobId, artifactType, artifact);

                if (result.isNew) {
                  newArtifacts++;
                } else {
                  updatedArtifacts++;
                }
                totalArtifactsFound++;

                // Cache the artifact (TTL=-1 for indefinite/durable cache)
                const cacheKey = `${artifactType}:${result.objectId}`;
                await cacheService.set(
                  tenantId,
                  cacheKey,
                  {
                    ...result,
                    systemId: system.ID,
                    discoveredAt: new Date().toISOString(),
                  },
                  -1,
                  {
                    source: 'discovery',
                    jobId,
                    phase: phase.name,
                  }
                );
              } catch (artifactError) {
                LOG.warn('Error processing artifact', { artifactType, error: artifactError.message });
                errorsCount++;
              }
            }

            // Mark artifact type as completed
            await idempotencyService.complete(tenantId, typeKey, { count: artifacts.length });
          } catch (typeError) {
            LOG.error('Error processing artifact type', { artifactType, error: typeError.message });
            errorsCount++;
          }
        }

        // Update artifacts found count after each phase
        await tx.run(
          UPDATE(DiscoveryJob)
            .set({
              artifactsFound: totalArtifactsFound,
              artifactsNew: newArtifacts,
              artifactsUpdated: updatedArtifacts,
              errorsCount,
            })
            .where({ ID: jobId })
        );
      }

      // Update job to completed
      await tx.run(
        UPDATE(DiscoveryJob)
          .set({
            status: 'completed',
            completedAt: new Date(),
            progressPercent: 100,
            currentPhaseName: 'Completed',
            artifactsFound: totalArtifactsFound,
            artifactsNew: newArtifacts,
            artifactsUpdated: updatedArtifacts,
            errorsCount,
            errorLog: JSON.stringify(errors),
            durationMs: Date.now() - new Date(await this._getJobStartTime(tx, jobId)).getTime(),
          })
          .where({ ID: jobId })
      );

      // Update system statistics
      await tx.run(
        UPDATE(PISystem)
          .set({
            totalArtifacts: totalArtifactsFound,
            lastDiscoveryAt: new Date(),
          })
          .where({ ID: system.ID })
      );

      await tx.commit();

      // Final SSE event
      this._emitProgress(tenantId, jobId, {
        type: 'discovery_complete',
        totalArtifacts: totalArtifactsFound,
        newArtifacts,
        updatedArtifacts,
        errorsCount,
      });

      LOG.info('Discovery completed', {
        jobId,
        tenantId,
        totalArtifactsFound,
        newArtifacts,
        updatedArtifacts,
        errorsCount,
      });
    } catch (error) {
      LOG.error('Discovery failed', { jobId, tenantId, error: error.message, stack: error.stack });
      await tx.rollback();

      await UPDATE(DiscoveryJob)
        .set({
          status: 'failed',
          completedAt: new Date(),
          errorLog: JSON.stringify([
            {
              ts: new Date().toISOString(),
              phase: 'execution',
              type: 'fatal',
              message: error.message,
            },
          ]),
        })
        .where({ ID: jobId, tenantId });

      throw error;
    }
  }

  /**
   * Query artifacts from PI/PO system
   * @private
   */
  async _queryArtifacts(client, artifactType) {
    switch (artifactType) {
      case 'IntegratedConfiguration':
        return await client.queryIntegratedConfigurations();
      case 'CommunicationChannel':
        return await client.queryCommunicationChannels();
      case 'SenderAgreement':
        return await client.querySenderAgreements();
      case 'ReceiverAgreement':
        return await client.queryReceiverAgreements();
      case 'ValueMappingGroup':
        return await client.queryValueMappings();
      case 'SoftwareComponentVersion':
        return await client.querySoftwareComponentVersions();
      case 'MessageMapping':
        return await client.queryMessageMappings();
      case 'OperationMapping':
        return await client.queryOperationMappings();
      default:
        return [];
    }
  }

  /**
   * Process a single artifact (upsert to DB)
   * @private
   */
  async _processArtifact(tx, tenantId, systemId, jobId, artifactType, rawArtifact) {
    const { Artifact } = cds.entities('tenant');

    const objectId =
      rawArtifact.ObjectID || rawArtifact.objectId || rawArtifact.Name || rawArtifact.name || randomUUID();

    const artifactKey = JSON.stringify({
      type: artifactType,
      id: objectId,
    });

    // Check if artifact already exists
    const existing = await tx.run(
      SELECT.one.from(Artifact).columns('ID').where({ tenantId, system_ID: systemId, artifactKey })
    );

    const artifactData = {
      tenantId,
      system_ID: systemId,
      discoveryJob_ID: jobId,
      artifactType,
      artifactKey,
      objectId,
      name: rawArtifact.Name || rawArtifact.name || objectId,
      description: rawArtifact.Description || rawArtifact.description || '',
      namespace: rawArtifact.Namespace || rawArtifact.namespace || '',
      swcv: rawArtifact.SoftwareComponentVersion || rawArtifact.swcv || '',
      direction: rawArtifact.Direction || rawArtifact.direction || '',
      adapterType: rawArtifact.AdapterType || rawArtifact.adapterType || '',
      senderParty: rawArtifact.SenderPartyID || '',
      senderComponent: rawArtifact.SenderComponentID || '',
      senderInterface: rawArtifact.InterfaceName || '',
      senderNamespace: rawArtifact.InterfaceNamespace || '',
      receiverParty: rawArtifact.ReceiverPartyID || '',
      receiverComponent: rawArtifact.ReceiverComponentID || '',
      piStatus: rawArtifact.AdministrativeState === 'active' ? 'active' : 'inactive',
      rawDefinition: JSON.stringify(rawArtifact),
      rawFormat: 'json',
    };

    if (existing) {
      // Update existing artifact
      await tx.run(UPDATE(Artifact).set(artifactData).where({ ID: existing.ID }));

      return { ...artifactData, ID: existing.ID, isNew: false };
    } else {
      // Insert new artifact
      const newId = randomUUID();
      await tx.run(
        INSERT.into(Artifact).entries({
          ID: newId,
          ...artifactData,
          migrationStatus: 'discovered',
        })
      );

      return { ...artifactData, ID: newId, isNew: true };
    }
  }

  /**
   * Get mock artifacts for local development
   * @private
   */
  _getMockArtifacts(artifactType) {
    const mockData = {
      IntegratedConfiguration: [
        { ObjectID: 'ICO_ORDERS_001', Name: 'Orders Outbound ICO', AdapterType: 'SOAP', Direction: 'outbound' },
        { ObjectID: 'ICO_VENDOR_002', Name: 'Vendor Master ICO', AdapterType: 'IDoc', Direction: 'inbound' },
      ],
      CommunicationChannel: [
        { ObjectID: 'CC_SOAP_001', Name: 'SOAP Receiver Channel', AdapterType: 'SOAP', Direction: 'receiver' },
        { ObjectID: 'CC_FILE_002', Name: 'File Sender Channel', AdapterType: 'FILE', Direction: 'sender' },
      ],
      MessageMapping: [
        { ObjectID: 'MM_ORDERS_001', Name: 'Orders to S4 Mapping', Namespace: 'urn:sap:mm' },
        { ObjectID: 'MM_VENDOR_002', Name: 'Vendor Master Mapping', Namespace: 'urn:sap:mm' },
      ],
      SoftwareComponentVersion: [{ ObjectID: 'SWCV_001', Name: 'CustomSWCV 1.0', Version: '1.0' }],
    };

    return mockData[artifactType] || [];
  }

  /**
   * Get job start time
   * @private
   */
  async _getJobStartTime(tx, jobId) {
    const { DiscoveryJob } = cds.entities('tenant');
    const job = await tx.run(SELECT.one.from(DiscoveryJob).columns('startedAt').where({ ID: jobId }));
    return job?.startedAt || new Date();
  }

  /**
   * Update job status
   * @private
   */
  async _updateJobStatus(jobId, tenantId, status, errorMessage) {
    const { DiscoveryJob } = cds.entities('tenant');

    await UPDATE(DiscoveryJob)
      .set({
        status,
        completedAt: new Date(),
        errorLog: errorMessage
          ? JSON.stringify([
              {
                ts: new Date().toISOString(),
                phase: 'execution',
                type: 'error',
                message: errorMessage,
              },
            ])
          : '[]',
      })
      .where({ ID: jobId, tenantId });
  }

  /**
   * Emit SSE progress event
   * Uses CAP event mesh to publish progress events that server.js subscribes to
   * @private
   */
  _emitProgress(tenantId, entityId, data) {
    try {
      // Emit via CAP event for SSE listeners
      // Server.js subscribes to this event via cds.on('served')
      this.emit('DiscoveryProgress', {
        tenantId,
        jobId: entityId,
        ...data,
      });

      // Also try to broadcast directly if Express app is available
      // This connects discovery-service to server.js SSE broadcasting
      try {
        const app = cds.app;
        if (app?.locals?.broadcastDiscoveryProgress) {
          app.locals.broadcastDiscoveryProgress(entityId, {
            jobId: entityId,
            tenantId,
            status: data.type === 'discovery_complete' ? 'completed' : 'in_progress',
            progress: data.progressPercent || 0,
            phase: data.phaseName || '',
            currentPhase: data.phaseName || data.phase || '',
            message: data.phaseName ? `${data.phaseName}...` : '',
            artifactsFound: data.totalArtifacts || data.artifactsFound || 0,
            ...(data.type === 'discovery_complete'
              ? {
                  completedAt: new Date().toISOString(),
                  artifactsCount: data.totalArtifacts,
                  newArtifacts: data.newArtifacts,
                  updatedArtifacts: data.updatedArtifacts,
                  errorsCount: data.errorsCount,
                }
              : {}),
          });
        }
      } catch (broadcastError) {
        // App not available in this context - progress still emitted via CAP event
        LOG.debug('Direct SSE broadcast not available', { error: broadcastError.message });
      }
    } catch (error) {
      LOG.warn('Failed to emit progress event', { tenantId, entityId, error: error.message });
    }
  }

  /**
   * Create audit log entry
   * @private
   */
  async _audit(tenantId, user, action, entityType, entityId, entityName, details = {}) {
    const { AuditLog } = cds.entities('tenant');

    try {
      await INSERT.into(AuditLog).entries({
        ID: randomUUID(),
        tenantId,
        userId: user?.id || 'system',
        userName: user?.name || 'System',
        userRole: user?.roles?.admin ? 'Admin' : user?.roles?.approver ? 'Approver' : 'Viewer',
        action,
        entityType,
        entityId,
        entityName,
        details: JSON.stringify(details),
      });
    } catch (error) {
      LOG.warn('Audit log failed', { action, entityType, entityId, error: error.message });
    }
  }
};
