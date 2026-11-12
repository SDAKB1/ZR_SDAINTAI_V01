'use strict';

/**
 * Discovery Worker
 *
 * Dedicated async worker for PI/PO artifact discovery job processing.
 * Handles the heavy lifting of querying PI/PO APIs and persisting artifacts.
 *
 * Key Features:
 * - Phase-level progress tracking with SSE emission
 * - Retry logic with exponential backoff (BR-006)
 * - Cancellation support (UC-003)
 * - Idempotent artifact upsert
 * - Batch processing for large result sets
 *
 * @module workers/discoveryWorker
 */

const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');

const LOG = cds.log('discovery-worker');

// Discovery phases configuration (per design)
const DISCOVERY_PHASES = [
  {
    order: 1,
    code: 'ConfigurationScenario',
    name: 'Configuration Scenarios',
    types: ['ConfigurationScenario'],
    weight: 5,
    category: 'dir',
    timeout: 60000,
  },
  {
    order: 2,
    code: 'IntegratedConfiguration',
    name: 'Integrated Configurations',
    types: ['IntegratedConfiguration', 'IntegratedConfiguration750'],
    weight: 20,
    category: 'dir',
    timeout: 180000,
  },
  {
    order: 3,
    code: 'CommunicationChannel',
    name: 'Communication Channels',
    types: ['CommunicationChannel'],
    weight: 15,
    category: 'dir',
    timeout: 180000,
  },
  {
    order: 4,
    code: 'Agreement',
    name: 'Agreements',
    types: ['SenderAgreement', 'ReceiverAgreement'],
    weight: 15,
    category: 'dir',
    timeout: 60000,
  },
  {
    order: 5,
    code: 'ValueMapping',
    name: 'Value Mappings',
    types: ['ValueMappingGroup'],
    weight: 10,
    category: 'dir',
    timeout: 60000,
  },
  {
    order: 6,
    code: 'ESRObjects',
    name: 'ESR Objects',
    types: ['SoftwareComponentVersion', 'MessageMapping', 'OperationMapping', 'ServiceInterface'],
    weight: 35,
    category: 'esr',
    timeout: 300000,
  },
];

// Retry configuration (BR-006)
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS = [1000, 4000, 16000]; // Exponential backoff: 1s, 4s, 16s

// Batch size for artifact processing
const ARTIFACT_BATCH_SIZE = 100;

/**
 * DiscoveryWorker class handles asynchronous PI/PO artifact discovery.
 */
class DiscoveryWorker {
  /**
   * @param {object} options - Worker configuration
   * @param {string} options.tenantId - Tenant identifier
   * @param {string} options.jobId - Discovery job ID
   * @param {object} options.system - PI/PO system configuration
   * @param {object} options.options - Discovery options
   */
  constructor(options) {
    this.tenantId = options.tenantId;
    this.jobId = options.jobId;
    this.system = options.system;
    this.discoveryOptions = options.options || {};
    this.cancelled = false;
    this.metrics = {
      totalArtifacts: 0,
      newArtifacts: 0,
      updatedArtifacts: 0,
      errors: 0,
      warnings: 0,
    };
    this.errors = [];
    this.startTime = null;
  }

  /**
   * Run the discovery job
   * @returns {Promise<object>} Discovery result summary
   */
  async run() {
    const { PISystem, DiscoveryJob, Artifact, DependencyGraph } = cds.entities('tenant');

    this.startTime = Date.now();
    LOG.info('Discovery worker started', {
      tenantId: this.tenantId,
      jobId: this.jobId,
      systemId: this.system.ID,
    });

    try {
      // Update job status to running
      await UPDATE(DiscoveryJob)
        .set({
          status: 'running',
          currentPhase: 0,
          currentPhaseName: 'Initializing',
          startedAt: new Date(),
        })
        .where({ ID: this.jobId, tenantId: this.tenantId });

      // Get SOAP client
      const PIPoSoapClient = await this._getSoapClient();

      // Process each phase
      for (let phaseIndex = 0; phaseIndex < DISCOVERY_PHASES.length; phaseIndex++) {
        // Check for cancellation
        if (await this._isCancelled()) {
          LOG.info('Discovery cancelled', { jobId: this.jobId });
          break;
        }

        const phase = DISCOVERY_PHASES[phaseIndex];
        await this._processPhase(phase, phaseIndex, PIPoSoapClient);
      }

      // Finalize job
      const finalStatus = this.cancelled ? 'cancelled' : 'completed';
      const durationMs = Date.now() - this.startTime;

      await UPDATE(DiscoveryJob)
        .set({
          status: finalStatus,
          completedAt: new Date(),
          progressPercent: 100,
          currentPhaseName: finalStatus === 'cancelled' ? 'Cancelled' : 'Completed',
          artifactsFound: this.metrics.totalArtifacts,
          artifactsNew: this.metrics.newArtifacts,
          artifactsUpdated: this.metrics.updatedArtifacts,
          errorsCount: this.metrics.errors,
          warningsCount: this.metrics.warnings,
          errorLog: JSON.stringify(this.errors),
          durationMs,
        })
        .where({ ID: this.jobId, tenantId: this.tenantId });

      // Update system statistics
      await UPDATE(PISystem)
        .set({
          totalArtifacts: this.metrics.totalArtifacts,
          lastDiscoveryAt: new Date(),
        })
        .where({ ID: this.system.ID, tenantId: this.tenantId });

      // Emit completion event
      await this._emitProgress({
        type: 'discovery_complete',
        status: finalStatus,
        totalArtifacts: this.metrics.totalArtifacts,
        newArtifacts: this.metrics.newArtifacts,
        updatedArtifacts: this.metrics.updatedArtifacts,
        errorsCount: this.metrics.errors,
        durationMs,
      });

      LOG.info('Discovery completed', {
        jobId: this.jobId,
        status: finalStatus,
        totalArtifacts: this.metrics.totalArtifacts,
        durationMs,
      });

      return {
        status: finalStatus,
        ...this.metrics,
        durationMs,
        errors: this.errors,
      };
    } catch (error) {
      LOG.error('Discovery worker failed', {
        jobId: this.jobId,
        error: error.message,
        stack: error.stack,
      });

      // Update job to failed
      await UPDATE(DiscoveryJob)
        .set({
          status: 'failed',
          completedAt: new Date(),
          lastError: error.message,
          errorLog: JSON.stringify([
            ...this.errors,
            {
              ts: new Date().toISOString(),
              phase: 'execution',
              type: 'fatal',
              message: error.message,
            },
          ]),
          durationMs: Date.now() - this.startTime,
        })
        .where({ ID: this.jobId, tenantId: this.tenantId });

      throw error;
    }
  }

  /**
   * Process a single discovery phase
   * @private
   */
  async _processPhase(phase, phaseIndex, PIPoSoapClient) {
    const { DiscoveryJob } = cds.entities('tenant');
    const progressPercent = Math.round(
      DISCOVERY_PHASES.slice(0, phaseIndex).reduce((sum, p) => sum + p.weight, 0)
    );

    LOG.debug('Processing phase', { phase: phase.name, order: phase.order });

    // Update phase progress
    await UPDATE(DiscoveryJob)
      .set({
        currentPhase: phase.order,
        currentPhaseName: phase.name,
        progressPercent,
      })
      .where({ ID: this.jobId, tenantId: this.tenantId });

    // Emit phase start event
    await this._emitProgress({
      type: 'phase_start',
      phase: phase.order,
      phaseName: phase.name,
      progressPercent,
    });

    // Process each artifact type in the phase
    for (const artifactType of phase.types) {
      if (await this._isCancelled()) break;

      await this._processArtifactType(artifactType, phase, PIPoSoapClient);
    }

    // Emit phase complete event
    const phaseProgress = progressPercent + phase.weight;
    await this._emitProgress({
      type: 'phase_complete',
      phase: phase.order,
      phaseName: phase.name,
      progressPercent: Math.min(phaseProgress, 99),
      artifactsFound: this.metrics.totalArtifacts,
    });
  }

  /**
   * Process a single artifact type with retry logic
   * @private
   */
  async _processArtifactType(artifactType, phase, PIPoSoapClient) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        let artifacts = [];

        if (PIPoSoapClient) {
          const client = new PIPoSoapClient(
            phase.category === 'dir' ? this.system.destinationDir : this.system.destinationEsr,
            { timeout: phase.timeout }
          );

          artifacts = await this._queryArtifacts(client, artifactType);
        } else {
          // Mock data for development
          artifacts = this._getMockArtifacts(artifactType);
        }

        // Process artifacts in batches
        for (let i = 0; i < artifacts.length; i += ARTIFACT_BATCH_SIZE) {
          if (await this._isCancelled()) break;

          const batch = artifacts.slice(i, i + ARTIFACT_BATCH_SIZE);
          await this._processArtifactBatch(batch, artifactType);
        }

        LOG.debug('Artifact type processed', {
          artifactType,
          count: artifacts.length,
          attempt,
        });

        return; // Success, exit retry loop
      } catch (error) {
        lastError = error;
        LOG.warn('Artifact type query failed', {
          artifactType,
          attempt,
          maxAttempts: MAX_RETRY_ATTEMPTS,
          error: error.message,
        });

        if (attempt < MAX_RETRY_ATTEMPTS) {
          const delay = RETRY_DELAYS[attempt - 1];
          await this._sleep(delay);
        }
      }
    }

    // Max retries exceeded
    this.metrics.errors++;
    this.errors.push({
      ts: new Date().toISOString(),
      phase: phase.name,
      type: artifactType,
      message: `Failed after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError?.message}`,
    });
  }

  /**
   * Process a batch of artifacts
   * @private
   */
  async _processArtifactBatch(artifacts, artifactType) {
    const { Artifact, DependencyGraph } = cds.entities('tenant');

    for (const rawArtifact of artifacts) {
      try {
        const result = await this._upsertArtifact(rawArtifact, artifactType);
        this.metrics.totalArtifacts++;
        if (result.isNew) {
          this.metrics.newArtifacts++;
        } else {
          this.metrics.updatedArtifacts++;
        }
      } catch (error) {
        LOG.warn('Failed to process artifact', {
          artifactType,
          objectId: rawArtifact.ObjectID || rawArtifact.Name,
          error: error.message,
        });
        this.metrics.errors++;
      }
    }

    // Update progress
    await this._updateJobProgress();
  }

  /**
   * Upsert a single artifact to the database
   * @private
   */
  async _upsertArtifact(rawArtifact, artifactType) {
    const { Artifact } = cds.entities('tenant');

    const objectId =
      rawArtifact.ObjectID ||
      rawArtifact.objectId ||
      rawArtifact.Name ||
      rawArtifact.name ||
      randomUUID();

    const artifactKey = JSON.stringify({
      type: artifactType,
      id: objectId,
    });

    // Check if artifact exists
    const existing = await SELECT.one
      .from(Artifact)
      .columns('ID')
      .where({
        tenantId: this.tenantId,
        system_ID: this.system.ID,
        artifactKey,
      });

    const artifactData = {
      tenantId: this.tenantId,
      system_ID: this.system.ID,
      discoveryJob_ID: this.jobId,
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
      await UPDATE(Artifact).set(artifactData).where({ ID: existing.ID });
      return { ...artifactData, ID: existing.ID, isNew: false };
    } else {
      const newId = randomUUID();
      await INSERT.into(Artifact).entries({
        ID: newId,
        ...artifactData,
        migrationStatus: 'discovered',
      });
      return { ...artifactData, ID: newId, isNew: true };
    }
  }

  /**
   * Query artifacts from PI/PO system
   * @private
   */
  async _queryArtifacts(client, artifactType) {
    switch (artifactType) {
      case 'ConfigurationScenario':
        return await client.queryConfigurationScenarios();
      case 'IntegratedConfiguration':
        return await client.queryIntegratedConfigurations();
      case 'IntegratedConfiguration750':
        return await client.queryIntegratedConfigurations750();
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
      case 'ServiceInterface':
        return await client.queryServiceInterfaces();
      default:
        return [];
    }
  }

  /**
   * Get mock artifacts for development
   * @private
   */
  _getMockArtifacts(artifactType) {
    const mockData = {
      ConfigurationScenario: [
        { ObjectID: 'CS_ORDER_001', Name: 'Order Processing Scenario' },
        { ObjectID: 'CS_VENDOR_001', Name: 'Vendor Integration Scenario' },
      ],
      IntegratedConfiguration: [
        { ObjectID: 'ICO_ORDERS_001', Name: 'Orders Outbound ICO', AdapterType: 'SOAP', Direction: 'outbound' },
        { ObjectID: 'ICO_VENDOR_002', Name: 'Vendor Master ICO', AdapterType: 'IDoc', Direction: 'inbound' },
        { ObjectID: 'ICO_MATERIAL_003', Name: 'Material Master ICO', AdapterType: 'RFC', Direction: 'outbound' },
      ],
      IntegratedConfiguration750: [],
      CommunicationChannel: [
        { ObjectID: 'CC_SOAP_001', Name: 'SOAP Receiver Channel', AdapterType: 'SOAP', Direction: 'receiver' },
        { ObjectID: 'CC_FILE_002', Name: 'File Sender Channel', AdapterType: 'FILE', Direction: 'sender' },
        { ObjectID: 'CC_HTTP_003', Name: 'HTTP Receiver Channel', AdapterType: 'HTTP', Direction: 'receiver' },
      ],
      SenderAgreement: [
        { ObjectID: 'SA_001', Name: 'Sender Agreement 1' },
      ],
      ReceiverAgreement: [
        { ObjectID: 'RA_001', Name: 'Receiver Agreement 1' },
      ],
      ValueMappingGroup: [
        { ObjectID: 'VM_COUNTRY_001', Name: 'Country Code Mapping' },
        { ObjectID: 'VM_CURRENCY_002', Name: 'Currency Code Mapping' },
      ],
      SoftwareComponentVersion: [
        { ObjectID: 'SWCV_001', Name: 'Custom SWCV 1.0', SoftwareComponentVersion: 'CUSTOM_1.0' },
      ],
      MessageMapping: [
        { ObjectID: 'MM_ORDERS_001', Name: 'Orders to S4 Mapping', Namespace: 'urn:sap:mm' },
        { ObjectID: 'MM_VENDOR_002', Name: 'Vendor Master Mapping', Namespace: 'urn:sap:mm' },
      ],
      OperationMapping: [
        { ObjectID: 'OM_001', Name: 'Operation Mapping 1' },
      ],
      ServiceInterface: [
        { ObjectID: 'SI_ORDER_001', Name: 'Order Service Interface' },
        { ObjectID: 'SI_VENDOR_001', Name: 'Vendor Service Interface' },
      ],
    };

    return mockData[artifactType] || [];
  }

  /**
   * Update job progress in database
   * @private
   */
  async _updateJobProgress() {
    const { DiscoveryJob } = cds.entities('tenant');

    await UPDATE(DiscoveryJob)
      .set({
        artifactsFound: this.metrics.totalArtifacts,
        artifactsNew: this.metrics.newArtifacts,
        artifactsUpdated: this.metrics.updatedArtifacts,
        errorsCount: this.metrics.errors,
        warningsCount: this.metrics.warnings,
      })
      .where({ ID: this.jobId, tenantId: this.tenantId });
  }

  /**
   * Emit progress event for SSE streaming
   * @private
   */
  async _emitProgress(data) {
    try {
      const event = {
        tenantId: this.tenantId,
        jobId: this.jobId,
        timestamp: new Date().toISOString(),
        ...data,
      };

      // Emit via CDS events (picked up by SSE handler)
      const discoveryService = await cds.connect.to('DiscoveryService');
      if (discoveryService.emit) {
        await discoveryService.emit('DiscoveryProgress', event);
      }
    } catch (error) {
      LOG.warn('Failed to emit progress event', { error: error.message });
    }
  }

  /**
   * Check if job has been cancelled
   * @private
   */
  async _isCancelled() {
    if (this.cancelled) return true;

    const { DiscoveryJob } = cds.entities('tenant');
    const job = await SELECT.one
      .from(DiscoveryJob)
      .columns('status')
      .where({ ID: this.jobId, tenantId: this.tenantId });

    if (job?.status === 'cancelled') {
      this.cancelled = true;
      return true;
    }

    return false;
  }

  /**
   * Get SOAP client class
   * @private
   */
  async _getSoapClient() {
    try {
      const { PIPoSoapClient } = require('../utils/pipoSoapClient');
      return PIPoSoapClient;
    } catch (e) {
      LOG.warn('PIPoSoapClient not available, using mock data', { error: e.message });
      return null;
    }
  }

  /**
   * Sleep for specified milliseconds
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Create and run a discovery worker
 * @param {object} options - Worker options
 * @returns {Promise<object>} Discovery result
 */
async function runDiscovery(options) {
  const worker = new DiscoveryWorker(options);
  return worker.run();
}

module.exports = {
  DiscoveryWorker,
  runDiscovery,
  DISCOVERY_PHASES,
};
