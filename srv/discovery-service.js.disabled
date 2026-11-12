'use strict';
/**
 * Discovery Service Handler
 * 
 * Implements the DiscoveryService CDS actions for PI/PO artifact discovery.
 * Handles multi-tenant context, progress tracking, and async job execution.
 */

const cds = require('@sap/cds');
const { PIPoSoapClient, ESR_OBJECT_TYPES } = require('./utils/pipoSoapClient');
const { randomUUID } = require('crypto');
const sseHandler = require('./sse-handler');
const destinationService = require('./utils/destinationService');

// Discovery phases with weights for progress calculation
const DISCOVERY_PHASES = [
  { name: 'Software Components', types: ['SoftwareComponentVersion'], weight: 5, category: 'esr' },
  { name: 'Integrated Configurations', types: ['IntegratedConfiguration'], weight: 25, category: 'dir' },
  { name: 'Communication Channels', types: ['CommunicationChannel'], weight: 20, category: 'dir' },
  { name: 'Message Mappings', types: ['MessageMapping', 'OperationMapping'], weight: 20, category: 'esr' },
  { name: 'Agreements', types: ['SenderAgreement', 'ReceiverAgreement'], weight: 15, category: 'dir' },
  { name: 'Value Mappings', types: ['ValueMappingGroup'], weight: 15, category: 'dir' },
];

module.exports = class DiscoveryService extends cds.ApplicationService {
  async init() {
    console.log('[DISCOVERY] Service init starting');
    const { PISystem, DiscoveryJob, Artifact, AuditLog } = cds.entities('tenant');
    console.log('[DISCOVERY] Entities loaded, registering handlers');

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
            console.warn('[DISCOVERY] Destination creation warnings:', destResult.errors);
          }
        } catch (destError) {
          console.warn('[DISCOVERY] Auto destination creation failed, manual creation required:', destError.message);
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
        
        // Update artifact with assessment
        await UPDATE(Artifact).where({ ID: artifactId }).set({
          migrationTier: assessment.tier,
          complexityScore: assessment.complexityScore,
          recommendedTool: assessment.recommendedTool,
          estimatedHours: assessment.estimatedHours,
          assessedAt: new Date(),
          assessmentNotes: assessment.rationale,
          migrationStatus: 'assessed',
        });
        
        return {
          artifactId,
          tier: assessment.tier,
          complexityScore: assessment.complexityScore,
          recommendedTool: assessment.recommendedTool,
          estimatedHours: assessment.estimatedHours,
          rationale: assessment.rationale,
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
    // INTERNAL HELPERS
    // ---------------------------------------------------------------------------

    /**
     * Run discovery job asynchronously
     */
    this._runDiscoveryAsync = async (jobId, system, options, tenantId) => {
      const tx = cds.transaction({ user: { id: 'system', tenant: tenantId } });
      
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
          
          // Discover artifacts for this phase
          for (const type of phase.types) {
            try {
              const client = phase.category === 'dir' ? dirClient : esrClient;
              const items = await this._discoverArtifactType(client, type);
              
              // Store artifacts
              for (const item of items) {
                const artifactId = randomUUID();
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
                }));
                totalArtifacts++;
              }
              
              // Update count
              await tx.run(UPDATE(DiscoveryJob).where({ ID: jobId }).set({
                artifactsFound: totalArtifacts,
              }));
              
            } catch (error) {
              errors.push({ phase: phase.name, type, error: error.message });
              console.error(`Discovery error for ${type}:`, error.message);
            }
          }
          
          totalProgress += phase.weight;
        }
        
        // Complete job
        await tx.run(UPDATE(DiscoveryJob).where({ ID: jobId }).set({
          status: errors.length > 0 ? 'completed' : 'completed',
          completedAt: new Date(),
          progressPercent: 100,
          artifactsFound: totalArtifacts,
          errorsCount: errors.length,
          errorLog: JSON.stringify(errors),
          durationMs: Date.now() - new Date(currentJob.startedAt).getTime(),
        }));
        
        // Broadcast completion via SSE
        sseHandler.broadcastCompletion(tenantId, jobId, {
          status: errors.length > 0 ? 'completed_with_errors' : 'completed',
          artifactsFound: totalArtifacts,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - new Date(currentJob.startedAt).getTime(),
        });
        
        // Update system stats
        await tx.run(UPDATE(PISystem).where({ ID: system.ID }).set({
          totalArtifacts,
          lastDiscoveryAt: new Date(),
        }));
        
        await tx.commit();
        
      } catch (error) {
        console.error('Discovery job failed:', error);
        await tx.run(UPDATE(DiscoveryJob).where({ ID: jobId }).set({
          status: 'failed',
          completedAt: new Date(),
          errorLog: JSON.stringify([{ error: error.message }]),
        }));
        await tx.commit();
      }
    };

    /**
     * Discover artifacts of a specific type
     */
    this._discoverArtifactType = async (client, type) => {
      switch (type) {
        case 'IntegratedConfiguration':
          return client.queryIntegratedConfigurations();
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
        default:
          return client.queryEsrSimple(type);
      }
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