'use strict';
/**
 * Discovery Service Handler
 *
 * Implements the DiscoveryService CDS actions for PI/PO artifact discovery.
 * Handles multi-tenant context, progress tracking, and async job execution.
 *
 * SAP NetWeaver 7.50 Enhanced:
 * - Uses IntegratedConfiguration750InService for 7.50-specific fields
 * - Extracts full module chains from Communication Channels
 * - Populates ModuleConfiguration entity for migration analysis
 * - Extracts security material references for credential planning
 */

const cds = require('@sap/cds');
const { PIPoSoapClient, ESR_OBJECT_TYPES, XI_NAMESPACES } = require('./utils/pipoSoapClient');
const { randomUUID } = require('crypto');
const sseHandler = require('./sse-handler');
const destinationService = require('./utils/destinationService');

// Discovery phases with weights for progress calculation
// SAP NetWeaver 7.50 Enhanced - includes module extraction and 7.50-specific fields
const DISCOVERY_PHASES = [
  { name: 'Software Components', types: ['SoftwareComponentVersion'], weight: 5, category: 'esr' },
  { name: 'Integrated Configurations (7.50)', types: ['IntegratedConfiguration'], weight: 20, category: 'dir', use750: true },
  { name: 'Communication Channels', types: ['CommunicationChannel'], weight: 15, category: 'dir' },
  { name: 'Channel Module Extraction', types: ['_ModuleExtraction'], weight: 10, category: 'post' },
  { name: 'Message Mappings', types: ['MessageMapping', 'OperationMapping'], weight: 15, category: 'esr' },
  { name: 'Agreements', types: ['SenderAgreement', 'ReceiverAgreement'], weight: 15, category: 'dir' },
  { name: 'Value Mappings', types: ['ValueMappingGroup'], weight: 10, category: 'dir' },
  { name: 'Configuration Scenarios', types: ['ConfigurationScenario'], weight: 5, category: 'dir' },
  { name: 'Business Systems & Parties', types: ['BusinessSystem', 'Party'], weight: 5, category: 'dir' },
];

// CDS Logger for this module - per North Star "use cds logs in the entire repo"
const LOG = cds.log('discovery-service');

module.exports = class DiscoveryService extends cds.ApplicationService {
  async init() {
    LOG.info('Service init starting');
    const { PISystem, DiscoveryJob, Artifact, AuditLog } = cds.entities('tenant');
    LOG.debug('Entities loaded, registering handlers');

    this.on('addPISystem', async (req) => {
      const { systemName, description, virtualHost, virtualPort, protocol, locationId, techUser, techPassword, piVersion } = req.data;
      const tenantId = req.user.tenant || 'default';

      // Generate destination names
      const destSuffix = `${systemName}_${tenantId}`.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const destinationDir = `PO_${destSuffix}_DIR`;
      const destinationEsr = `PO_${destSuffix}_ESR`;

      try {
        // Create the system record
        const systemId = randomUUID();
        await INSERT.into(PISystem).entries({
          ID: systemId,
          tenantId,
          systemName,
          description,
          virtualHost,
          virtualPort: virtualPort || 443,
          protocol: protocol || 'http',
          locationId,
          destinationDir,
          destinationEsr,
          techUser,
          piVersion: piVersion || '7.50',
          status: 'configured',
        });

        // Log audit
        await this._audit(req, 'system_added', 'PISystem', systemId, systemName, { virtualHost, locationId });

        // Create BTP destinations programmatically
        try {
          const destResult = await destinationService.createPISystemDestinations({
            tenantId,
            systemName,
            virtualHost,
            virtualPort: virtualPort || 443,
            protocol: protocol || 'http',
            locationId,
            techUser,
            techPassword,
          });
          if (destResult.errors.length > 0) {
            LOG.warn('Destination creation warnings', { errors: destResult.errors });
          }
        } catch (destError) {
          LOG.warn('Auto destination creation failed, manual creation required', { error: destError.message });
        }
        // For now, destinations must be created manually in BTP Cockpit

        return {
          systemId,
          destinationDir,
          destinationEsr,
          status: 'configured',
          message: `System "${systemName}" added. Please create destinations "${destinationDir}" and "${destinationEsr}" in BTP Cockpit with the provided credentials.`,
        };
      } catch (error) {
        return req.error(500, `Failed to add system: ${error.message}`);
      }
    });

    this.on('testConnection', async (req) => {
      const { systemId } = req.data;
      const tenantId = req.user.tenant || 'default';

      // Get system config
      const system = await SELECT.one.from(PISystem).where({ ID: systemId, tenantId });
      if (!system) {
        return req.error(404, 'System not found');
      }

      try {
        // Create SOAP client for DIR
        const dirClient = new PIPoSoapClient(system.destinationDir);
        const esrClient = new PIPoSoapClient(system.destinationEsr);

        // Test connections
        const dirTest = await dirClient.testConnection().catch(e => ({ success: false, error: e.message }));
        const esrTest = await esrClient.testConnection().catch(e => ({ success: false, error: e.message }));

        const success = dirTest.success !== false && esrTest.success !== false;

        // Update system status
        await UPDATE(PISystem).where({ ID: systemId }).set({
          status: success ? 'active' : 'error',
          lastTestedAt: new Date(),
          lastTestResult: JSON.stringify({ dirTest, esrTest }),
        });

        // Log audit
        await this._audit(req, 'system_tested', 'PISystem', systemId, system.systemName, { success });

        return {
          success,
          dirStatus: dirTest.dirStatus || dirTest.error || 'ok',
          esrStatus: esrTest.esrStatus || esrTest.error || 'ok',
          sldStatus: 'not_tested',
          piVersion: esrTest.version || system.piVersion,
          swcvCount: esrTest.swcvCount || 0,
          icoCount: 0,
          channelCount: dirTest.channelCount || 0,
          message: success ? 'Connection successful' : 'Connection failed - check destination configuration',
          details: JSON.stringify({ dirTest, esrTest }),
        };
      } catch (error) {
        return {
          success: false,
          dirStatus: 'error',
          esrStatus: 'error',
          message: `Connection test failed: ${error.message}`,
        };
      }
    });

    // ---------------------------------------------------------------------------
    // DISCOVERY OPERATIONS
    // ---------------------------------------------------------------------------

    this.on('startDiscovery', async (req) => {
      const { systemId, includeInactive, includeHistory, artifactTypes } = req.data;
      const tenantId = req.user.tenant || 'default';

      // Get system
      const system = await SELECT.one.from(PISystem).where({ ID: systemId, tenantId });
      if (!system) {
        return req.error(404, 'System not found');
      }

      // Create job record
      const jobId = randomUUID();
      await INSERT.into(DiscoveryJob).entries({
        ID: jobId,
        tenantId,
        system_ID: systemId,
        status: 'pending',
        startedBy: req.user.id,
        options: JSON.stringify({ includeInactive, includeHistory, artifactTypes }),
        progressLog: '[]',
        errorLog: '[]',
      });

      // Log audit
      await this._audit(req, 'discovery_started', 'DiscoveryJob', jobId, system.systemName, { options: req.data });

      // Start async discovery (non-blocking)
      this._runDiscoveryAsync(jobId, system, { includeInactive, includeHistory, artifactTypes }, tenantId);

      return {
        jobId,
        status: 'pending',
        estimatedTime: 120, // Estimate based on typical discovery
        message: `Discovery started for "${system.systemName}". Monitor progress via getDiscoveryProgress.`,
      };
    });

    this.on('getDiscoveryProgress', async (req) => {
      const { jobId } = req.data;
      const tenantId = req.user.tenant || 'default';

      const job = await SELECT.one.from(DiscoveryJob).where({ ID: jobId, tenantId });
      if (!job) {
        return req.error(404, 'Job not found');
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
        estimatedRemaining: job.status === 'running' ? Math.max(0, 120 - Math.floor((Date.now() - new Date(job.startedAt).getTime()) / 1000)) : 0,
      };
    });

    this.on('cancelDiscovery', async (req) => {
      const { jobId } = req.data;
      const tenantId = req.user.tenant || 'default';

      const job = await SELECT.one.from(DiscoveryJob).where({ ID: jobId, tenantId });
      if (!job) {
        return req.error(404, 'Job not found');
      }

      if (job.status !== 'running' && job.status !== 'pending') {
        return { success: false, message: `Cannot cancel job in status: ${job.status}` };
      }

      await UPDATE(DiscoveryJob).where({ ID: jobId }).set({
        status: 'cancelled',
        completedAt: new Date(),
      });

      return { success: true, message: 'Discovery cancelled' };
    });

    // ---------------------------------------------------------------------------
    // ARTIFACT OPERATIONS
    // ---------------------------------------------------------------------------

    this.on('assessArtifact', async (req) => {
      const { artifactId } = req.data;
      const tenantId = req.user.tenant || 'default';

      const artifact = await SELECT.one.from(Artifact).where({ ID: artifactId, tenantId });
      if (!artifact) {
        return req.error(404, 'Artifact not found');
      }

      // Call the brain service for AI assessment
      try {
        const brainService = await cds.connect.to('BrainService');
        const assessment = await brainService.send('migrationAdvisor', {
          key: process.env.BRAIN_MASTER_KEY || 'AYMAN2026',
          objectId: artifact.objectId || artifact.name,
          objectDesc: artifact.description || artifact.name,
          segmentCount: 10, // Would parse from rawDefinition
          hasZFields: false,
          mappingType: artifact.mappingType || 'graphical',
          adapterType: artifact.adapterType || 'soap',
          volumePerDay: 1000,
          isBpmProcess: false,
          isEdiBased: artifact.adapterType === 'as2',
          sourceSystem: 'SAP_PI_PO',
        });

        // Update artifact with assessment including SAP-aligned fields (Gaps #1, #2, #3)
        await UPDATE(Artifact).where({ ID: artifactId }).set({
          migrationTier: assessment.tier,
          complexityScore: assessment.complexityScore,
          recommendedTool: assessment.recommendedTool,
          estimatedHours: assessment.estimatedHours,
          assessedAt: new Date(),
          assessmentNotes: assessment.rationale,
          migrationStatus: 'assessed',
          // Gap #1: Scenario Pattern
          scenarioPattern: assessment.scenarioPattern,
          // Gap #2: SAP Migration Status
          sapMigrationStatus: assessment.sapMigrationStatus,
          matchedTemplate: assessment.matchedTemplate,
        });

        // Gap #3: Create ArtifactLimitation records if any limitations detected
        if (assessment.limitations) {
          try {
            const limitations = JSON.parse(assessment.limitations);
            const { ArtifactLimitation } = this.entities;
            for (const lim of limitations) {
              await INSERT.into(ArtifactLimitation).entries({
                tenant_ID: tenantId,
                artifact_ID: artifactId,  // Association to Artifact
                limitation_code: lim.code,  // Association key to MigrationLimitationRef
                detectedAt: new Date(),
                detectedBy: 'auto',
                context: JSON.stringify({
                  severity: lim.severity,
                  category: lim.category,
                  workaroundType: lim.workaroundType,
                  workaroundDesc: lim.workaroundDesc,
                }),
                resolutionStatus: 'open',
              });
            }
          } catch (limErr) {
            LOG.warn('Failed to persist limitations', { error: limErr.message });
          }
        }

        return {
          artifactId,
          tier: assessment.tier,
          complexityScore: assessment.complexityScore,
          recommendedTool: assessment.recommendedTool,
          estimatedHours: assessment.estimatedHours,
          rationale: assessment.rationale,
          // Include SAP-aligned fields in response
          scenarioPattern: assessment.scenarioPattern,
          scenarioPatternName: assessment.scenarioPatternName,
          sapMigrationStatus: assessment.sapMigrationStatus,
          matchedTemplate: assessment.matchedTemplate,
          limitations: assessment.limitations,
          limitationCount: assessment.limitationCount,
          hasBlockers: assessment.hasBlockers,
          message: 'Assessment complete',
        };
      } catch (error) {
        return req.error(500, `Assessment failed: ${error.message}`);
      }
    });

    this.on('approveArtifact', async (req) => {
      const { artifactId, wave, notes } = req.data;
      const tenantId = req.user.tenant || 'default';

      const artifact = await SELECT.one.from(Artifact).where({ ID: artifactId, tenantId });
      if (!artifact) {
        return req.error(404, 'Artifact not found');
      }

      await UPDATE(Artifact).where({ ID: artifactId }).set({
        migrationStatus: 'approved',
        migrationWave: wave,
        approvedBy: req.user.id,
        approvedAt: new Date(),
        approvalNotes: notes,
      });

      await this._audit(req, 'artifact_approved', 'Artifact', artifactId, artifact.name, { wave, notes });

      return { success: true, message: `Artifact "${artifact.name}" approved for wave ${wave}` };
    });

    this.on('getDiscoverySummary', async (req) => {
      const { systemId } = req.data;
      const tenantId = req.user.tenant || 'default';

      const system = await SELECT.one.from(PISystem).where({ ID: systemId, tenantId });
      if (!system) {
        return req.error(404, 'System not found');
      }

      // Get artifact counts by type
      const artifacts = await SELECT.from(Artifact).where({ system_ID: systemId, tenantId });

      const byType = {};
      const byTier = { simple: 0, medium: 0, complex: 0, unassessed: 0 };
      const byStatus = { discovered: 0, assessed: 0, approved: 0, migrated: 0, skipped: 0 };
      let totalHours = 0;

      for (const a of artifacts) {
        byType[a.artifactType] = (byType[a.artifactType] || 0) + 1;
        byTier[a.migrationTier || 'unassessed']++;
        byStatus[a.migrationStatus || 'discovered']++;
        totalHours += a.estimatedHours || 0;
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

    // ---------------------------------------------------------------------------
    // SAP NETWEAVER 7.50 SPECIFIC OPERATIONS
    // ---------------------------------------------------------------------------

    this.on('extractChannelDetails', async (req) => {
      const { systemId, channelIds, includeModules = true, includeSecurityConfig = true } = req.data;
      const tenantId = req.user.tenant || 'default';

      const system = await SELECT.one.from(PISystem).where({ ID: systemId, tenantId });
      if (!system) {
        return req.error(404, 'System not found');
      }

      try {
        const dirClient = new PIPoSoapClient(system.destinationDir);

        // Get channels to process
        let channels;
        if (channelIds) {
          const ids = JSON.parse(channelIds);
          channels = await SELECT.from(Artifact)
            .where({ system_ID: systemId, tenantId, artifactType: 'CommunicationChannel' })
            .and({ objectId: { in: ids } });
        } else {
          channels = await SELECT.from(Artifact)
            .where({ system_ID: systemId, tenantId, artifactType: 'CommunicationChannel' });
        }

        if (channels.length === 0) {
          return { processed: 0, modulesExtracted: 0, credentialsFound: 0, message: 'No channels found' };
        }

        // Extract details using the new 7.50 methods
        const result = await this._extractChannelModules(
          cds.transaction({ user: { id: req.user.id, tenant: tenantId } }),
          dirClient,
          tenantId,
          channels
        );

        return {
          processed: channels.length,
          modulesExtracted: result.moduleCount,
          credentialsFound: result.credentialCount,
          errors: '[]',
          message: `Extracted details from ${channels.length} channels`,
        };
      } catch (error) {
        return req.error(500, `Channel extraction failed: ${error.message}`);
      }
    });

    this.on('extractIcoDetails750', async (req) => {
      const { systemId, icoIds } = req.data;
      const tenantId = req.user.tenant || 'default';

      const system = await SELECT.one.from(PISystem).where({ ID: systemId, tenantId });
      if (!system) {
        return req.error(404, 'System not found');
      }

      try {
        const dirClient = new PIPoSoapClient(system.destinationDir);

        // Get ICOs to process
        let icos;
        if (icoIds) {
          const ids = JSON.parse(icoIds);
          icos = await SELECT.from(Artifact)
            .where({ system_ID: systemId, tenantId, artifactType: 'IntegratedConfiguration' })
            .and({ objectId: { in: ids } });
        } else {
          icos = await SELECT.from(Artifact)
            .where({ system_ID: systemId, tenantId, artifactType: 'IntegratedConfiguration' });
        }

        if (icos.length === 0) {
          return { processed: 0, with750Fields: 0, message: 'No ICOs found' };
        }

        // Extract 7.50 details
        const result = await this._extractIcoDetails750(
          cds.transaction({ user: { id: req.user.id, tenant: tenantId } }),
          dirClient,
          tenantId,
          icos
        );

        return {
          processed: icos.length,
          with750Fields: result.updatedCount,
          errors: '[]',
          message: `Extracted 7.50 details from ${icos.length} ICOs`,
        };
      } catch (error) {
        return req.error(500, `ICO extraction failed: ${error.message}`);
      }
    });

    this.on('getConfigurationScenarios', async (req) => {
      const { systemId } = req.data;
      const tenantId = req.user.tenant || 'default';

      const system = await SELECT.one.from(PISystem).where({ ID: systemId, tenantId });
      if (!system) {
        return req.error(404, 'System not found');
      }

      try {
        const dirClient = new PIPoSoapClient(system.destinationDir);
        const scenarios = await dirClient.queryConfigurationScenarios();

        return {
          scenarios: JSON.stringify(scenarios),
          count: scenarios.length,
          message: `Found ${scenarios.length} configuration scenarios`,
        };
      } catch (error) {
        return {
          scenarios: '[]',
          count: 0,
          message: `Failed to query scenarios: ${error.message}`,
        };
      }
    });

    this.on('getChannelModules', async (req) => {
      const { channelId } = req.data;
      const tenantId = req.user.tenant || 'default';
      const { ModuleConfiguration } = cds.entities('tenant');

      // Get module configurations for this channel
      const modules = await SELECT.from(ModuleConfiguration)
        .where({ tenant_ID: tenantId, channelId });

      const hasCustomModules = modules.some(m =>
        !m.isEquivalent || m.isEquivalent.includes('Groovy') || m.isEquivalent.includes('Manual')
      );

      // Get channel info
      const channel = await SELECT.one.from(Artifact)
        .where({ tenantId, objectId: channelId });

      return {
        channelId,
        channelName: channel?.name || channelId,
        adapterType: channel?.adapterType || 'unknown',
        modules: JSON.stringify(modules),
        moduleCount: modules.length,
        hasCustomModules,
        message: modules.length > 0
          ? `Found ${modules.length} modules`
          : 'No modules found (run extractChannelDetails first)',
      };
    });

    this.on('getSecurityInventory', async (req) => {
      const { systemId } = req.data;
      const tenantId = req.user.tenant || 'default';
      const { CredentialInventory } = cds.entities('tenant');

      // Get credentials associated with artifacts from this system
      const artifacts = await SELECT.from(Artifact)
        .columns('objectId')
        .where({ system_ID: systemId, tenantId, artifactType: 'CommunicationChannel' });

      const channelIds = artifacts.map(a => a.objectId);

      // Get credentials - referenced by these channels
      const credentials = await SELECT.from(CredentialInventory)
        .where({ tenant_ID: tenantId });

      // Filter to those referenced by our channels
      const relevantCreds = credentials.filter(c => {
        try {
          const refs = JSON.parse(c.referencedBy || '[]');
          return refs.some(r => channelIds.includes(r));
        } catch {
          return false;
        }
      });

      // Count by type
      const byType = {};
      let needsMigration = 0;
      for (const c of relevantCreds) {
        byType[c.credentialType] = (byType[c.credentialType] || 0) + 1;
        if (c.migrationStatus === 'pending') {
          needsMigration++;
        }
      }

      return {
        credentials: JSON.stringify(relevantCreds),
        count: relevantCreds.length,
        byType: JSON.stringify(byType),
        needsMigration,
        message: `Found ${relevantCreds.length} security material items`,
      };
    });

    // ---------------------------------------------------------------------------
    // INTERNAL HELPERS
    // ---------------------------------------------------------------------------

    /**
     * Run discovery job asynchronously (SAP NetWeaver 7.50 Enhanced)
     * Includes module extraction and 7.50-specific field extraction
     */
    this._runDiscoveryAsync = async (jobId, system, options, tenantId) => {
      const tx = cds.transaction({ user: { id: 'system', tenant: tenantId } });

      // Track discovered channels and ICOs for post-processing
      const discoveredChannels = [];
      const discoveredIcos = [];

      try {
        await tx.run(UPDATE(DiscoveryJob).where({ ID: jobId }).set({
          status: 'running',
          startedAt: new Date(),
        }));

        const dirClient = new PIPoSoapClient(system.destinationDir);
        const esrClient = new PIPoSoapClient(system.destinationEsr);

        let totalProgress = 0;
        let totalArtifacts = 0;
        const errors = [];
        let startTime = Date.now();

        for (let i = 0; i < DISCOVERY_PHASES.length; i++) {
          const phase = DISCOVERY_PHASES[i];

          // Check if job was cancelled
          const currentJob = await tx.run(SELECT.one.from(DiscoveryJob).where({ ID: jobId }));
          if (currentJob.status === 'cancelled') {
            break;
          }

          // Update progress
          await tx.run(UPDATE(DiscoveryJob).where({ ID: jobId }).set({
            currentPhase: i + 1,
            currentPhaseName: phase.name,
            progressPercent: Math.round(totalProgress),
          }));

          // Broadcast progress via SSE
          sseHandler.broadcastProgress(tenantId, jobId, {
            phase: i + 1,
            phaseName: phase.name,
            progressPercent: Math.round(totalProgress),
            artifactsFound: totalArtifacts,
          });

          // Handle post-processing phases
          if (phase.category === 'post') {
            if (phase.types.includes('_ModuleExtraction') && discoveredChannels.length > 0) {
              try {
                LOG.info('Extracting modules from channels', { count: discoveredChannels.length });
                const moduleResult = await this._extractChannelModules(tx, dirClient, tenantId, discoveredChannels);
                LOG.info('Module extraction complete', { moduleCount: moduleResult.moduleCount, credentialCount: moduleResult.credentialCount });
              } catch (error) {
                errors.push({ phase: phase.name, type: '_ModuleExtraction', error: error.message });
                LOG.error('Module extraction error', { error: error.message });
              }
            }
            totalProgress += phase.weight;
            continue;
          }

          // Discover artifacts for this phase
          for (const type of phase.types) {
            try {
              const client = phase.category === 'dir' ? dirClient : esrClient;
              const items = await this._discoverArtifactType(client, type, { use750Service: phase.use750 });

              // Store artifacts
              for (const item of items) {
                const artifactId = randomUUID();

                // Extract additional fields for 7.50 ICOs
                const extraFields = {};
                if (type === 'IntegratedConfiguration' && item.ReceiverWildcardIndicator) {
                  extraFields.dependencies = JSON.stringify({
                    receiverWildcardIndicator: item.ReceiverWildcardIndicator,
                    _is750: true,
                  });
                }

                await tx.run(INSERT.into(Artifact).entries({
                  ID: artifactId,
                  tenantId,
                  system_ID: system.ID,
                  discoveryJob_ID: jobId,
                  artifactType: type,
                  artifactKey: JSON.stringify(item.key || item),
                  objectId: item.ObjectID || item.Name || item.name,
                  name: item.Name || item.name || item.ObjectID,
                  description: item.Description || item.description,
                  namespace: item.Namespace || item.namespace,
                  swcv: item.SoftwareComponentVersionID || item.swcv,
                  adapterType: item.AdapterType || item.adapterType,
                  senderComponent: item.SenderComponentID || item.senderComponent,
                  senderInterface: item.SenderInterfaceName || item.senderInterface,
                  receiverComponent: item.ReceiverComponentID || item.receiverComponent,
                  receiverInterface: item.ReceiverInterfaceName || item.receiverInterface,
                  piStatus: item.Status || 'active',
                  rawDefinition: JSON.stringify(item),
                  migrationStatus: 'discovered',
                  ...extraFields,
                }));
                totalArtifacts++;

                // Track for post-processing
                if (type === 'CommunicationChannel') {
                  discoveredChannels.push({ ...item, ID: artifactId });
                } else if (type === 'IntegratedConfiguration') {
                  discoveredIcos.push({ ...item, ID: artifactId });
                }
              }

              // Update count
              await tx.run(UPDATE(DiscoveryJob).where({ ID: jobId }).set({
                artifactsFound: totalArtifacts,
              }));

            } catch (error) {
              errors.push({ phase: phase.name, type, error: error.message });
              LOG.error('Discovery error', { type, error: error.message });
            }
          }

          totalProgress += phase.weight;
        }

        // Calculate duration
        const durationMs = Date.now() - startTime;

        // Complete job
        await tx.run(UPDATE(DiscoveryJob).where({ ID: jobId }).set({
          status: errors.length > 0 ? 'completed_with_errors' : 'completed',
          completedAt: new Date(),
          progressPercent: 100,
          artifactsFound: totalArtifacts,
          errorsCount: errors.length,
          errorLog: JSON.stringify(errors),
          durationMs,
        }));

        // Broadcast completion via SSE
        sseHandler.broadcastCompletion(tenantId, jobId, {
          status: errors.length > 0 ? 'completed_with_errors' : 'completed',
          artifactsFound: totalArtifacts,
          completedAt: new Date().toISOString(),
          durationMs,
          channelsWithModules: discoveredChannels.length,
        });

        // Update system stats
        await tx.run(UPDATE(PISystem).where({ ID: system.ID }).set({
          totalArtifacts,
          lastDiscoveryAt: new Date(),
        }));

        await tx.commit();

      } catch (error) {
        LOG.error('Discovery job failed', { error: error.message, stack: error.stack });
        await tx.run(UPDATE(DiscoveryJob).where({ ID: jobId }).set({
          status: 'failed',
          completedAt: new Date(),
          errorLog: JSON.stringify([{ error: error.message }]),
        }));
        await tx.commit();
      }
    };

    /**
     * Discover artifacts of a specific type (SAP NetWeaver 7.50 Enhanced)
     * Uses 7.50-specific APIs when available for richer metadata
     */
    this._discoverArtifactType = async (client, type, options = {}) => {
      const { use750Service = true } = options;

      switch (type) {
        case 'IntegratedConfiguration':
          // Use 7.50 service for ReceiverWildcardIndicator support
          return use750Service
            ? client.queryIntegratedConfigurations750()
            : client.queryIntegratedConfigurations();
        case 'CommunicationChannel':
          return client.queryCommunicationChannels();
        case 'SenderAgreement':
          return client.querySenderAgreements();
        case 'ReceiverAgreement':
          return client.queryReceiverAgreements();
        case 'ValueMappingGroup':
          return client.queryValueMappings();
        case 'SoftwareComponentVersion':
          return client.querySoftwareComponentVersions();
        case 'MessageMapping':
          return client.queryMessageMappings();
        case 'OperationMapping':
          return client.queryOperationMappings();
        case 'ConfigurationScenario':
          return client.queryConfigurationScenarios();
        case 'BusinessSystem':
          return client.queryBusinessSystems();
        case 'Party':
          return client.queryParties();
        default:
          return client.queryEsrSimple(type);
      }
    };

    /**
     * Extract and store channel module configurations
     * Called after discovering Communication Channels to extract ModuleProcess chains
     * @param {Object} tx - CDS transaction
     * @param {Object} client - PIPoSoapClient instance
     * @param {string} tenantId - Tenant ID
     * @param {Array} channels - Array of discovered channel artifacts
     */
    this._extractChannelModules = async (tx, client, tenantId, channels) => {
      const { ModuleConfiguration, CredentialInventory } = cds.entities('tenant');
      let moduleCount = 0;
      let credentialCount = 0;

      for (const channel of channels) {
        try {
          const channelKey = channel.ObjectID || channel.objectId || channel.ID;
          if (!channelKey) continue;

          // Read full channel definition with modules
          const fullChannel = await client.readCommunicationChannelWithModules(channelKey);
          if (!fullChannel) continue;

          // Extract and store module chain
          if (fullChannel.moduleChain && fullChannel.moduleChain.length > 0) {
            for (const mod of fullChannel.moduleChain) {
              await tx.run(INSERT.into(ModuleConfiguration).entries({
                tenant_ID: tenantId,
                channelId: channelKey,
                moduleKey: mod.moduleKey,
                moduleName: mod.moduleName,
                moduleType: mod.moduleType,
                parameters: JSON.stringify(mod.parameters || {}),
                processingSequence: mod.sequence,
                isEquivalent: mod.isEquivalent,
                migrationNotes: mod.isEquivalent
                  ? `IS equivalent: ${mod.isEquivalent}`
                  : 'Requires manual analysis',
                migrationStatus: mod.isEquivalent ? 'analyzed' : 'pending',
              }));
              moduleCount++;
            }
          }

          // Extract and store security/credential references
          if (fullChannel.securityConfig) {
            const sec = fullChannel.securityConfig;
            if (sec.credentialAlias) {
              await tx.run(INSERT.into(CredentialInventory).entries({
                tenant_ID: tenantId,
                credentialAlias: sec.credentialAlias,
                credentialType: 'Password',
                authType: sec.authMethod || 'Basic',
                referencedBy: JSON.stringify([channelKey]),
                migrationStatus: 'pending',
              }).onConflictIgnore());
              credentialCount++;
            }

            if (sec.certificates && sec.certificates.length > 0) {
              for (const cert of sec.certificates) {
                await tx.run(INSERT.into(CredentialInventory).entries({
                  tenant_ID: tenantId,
                  credentialAlias: cert.alias || cert.value,
                  credentialType: 'Certificate',
                  authType: 'Certificate',
                  referencedBy: JSON.stringify([channelKey]),
                  notes: `Keystore view: ${sec.keystoreView || 'default'}`,
                  migrationStatus: 'pending',
                }).onConflictIgnore());
                credentialCount++;
              }
            }
          }
        } catch (error) {
          LOG.warn('Failed to extract modules for channel', { channelId: channel.ObjectID, error: error.message });
        }
      }

      LOG.info('Channel module extraction completed', { moduleCount, credentialCount });
      return { moduleCount, credentialCount };
    };

    /**
     * Extract 7.50-specific ICO fields
     * @param {Object} tx - CDS transaction
     * @param {Object} client - PIPoSoapClient instance
     * @param {string} tenantId - Tenant ID
     * @param {Array} icos - Array of discovered ICO artifacts
     */
    this._extractIcoDetails750 = async (tx, client, tenantId, icos) => {
      let updatedCount = 0;

      for (const ico of icos) {
        try {
          const icoKey = ico.ObjectID || ico.objectId || ico.ID;
          if (!icoKey) continue;

          // Read full ICO with 7.50 fields
          const fullIco = await client.readIntegratedConfiguration750(icoKey);
          if (!fullIco) continue;

          // Update artifact with 7.50-specific fields
          await tx.run(UPDATE('tenant.Artifact')
            .where({ objectId: icoKey, tenantId })
            .set({
              rawDefinition: JSON.stringify(fullIco),
              // Add 7.50-specific metadata
              dependencies: JSON.stringify({
                receiverWildcardIndicator: fullIco.receiverWildcardIndicator,
                is750: fullIco._is750,
              }),
            }));
          updatedCount++;
        } catch (error) {
          LOG.warn('Failed to extract 7.50 details for ICO', { icoId: ico.ObjectID, error: error.message });
        }
      }

      LOG.info('ICO 7.50 extraction completed', { updatedCount });
      return { updatedCount };
    };

    /**
     * Create audit log entry
     */
    this._audit = async (req, action, entityType, entityId, entityName, details = {}) => {
      const tenantId = req.user.tenant || 'default';
      await INSERT.into(AuditLog).entries({
        ID: randomUUID(),
        tenantId,
        userId: req.user.id,
        userName: req.user.name || req.user.id,
        userRole: req.user.roles?.admin ? 'Admin' : req.user.roles?.approver ? 'Approver' : 'Viewer',
        action,
        entityType,
        entityId,
        entityName,
        details: JSON.stringify(details),
        ipAddress: req.headers?.['x-forwarded-for'] || 'unknown',
        userAgent: req.headers?.['user-agent'] || 'unknown',
      });
    };

    return super.init();
  }
};