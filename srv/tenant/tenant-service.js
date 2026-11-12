'use strict';

/**
 * Tenant Service Implementation
 *
 * Implements tenant-isolated PI/PO system management and discovery triggering.
 * All operations use cds.context.tenant for tenant isolation.
 *
 * Uses CAP Native Event Queues (cds.queued) for async discovery processing.
 */

const cds = require('@sap/cds');
const { randomUUID } = require('node:crypto');

const LOG = cds.log('tenant-service');

// URL validation regex
const URL_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// Maximum string lengths for input validation
const MAX_STRING_LENGTHS = {
  systemName: 50,
  description: 200,
  virtualHost: 200,
  locationId: 50,
  techUser: 50,
  techPassword: 100,
  piVersion: 20,
  protocol: 10,
};

module.exports = class TenantService extends cds.ApplicationService {
  async init() {
    const { PISystem, DiscoveryJob } = cds.entities('tenant');

    // ═══════════════════════════════════════════════════════════════════════════
    // ACTION: savePipoSystem
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('savePipoSystem', async req => {
      const tenantId = cds.context?.tenant || req.user?.tenant || 'default';
      const { systemConfig } = req.data;

      LOG.info('savePipoSystem called', { tenantId, systemName: systemConfig?.systemName });

      // Input validation
      const validationError = this._validateSystemConfig(systemConfig, req);
      if (validationError) return validationError;

      const {
        systemId,
        systemName,
        description,
        virtualHost,
        virtualPort = 443,
        protocol = 'https',
        locationId,
        techUser,
        techPassword,
        piVersion = '7.50',
      } = systemConfig;

      try {
        // Check for existing system (update case)
        if (systemId) {
          const existing = await SELECT.one.from(PISystem).where({ ID: systemId, tenantId });

          if (!existing) {
            return req.error(404, 'PI/PO system not found');
          }

          // Update existing system
          const updateData = {
            systemName,
            description,
            virtualHost,
            virtualPort,
            protocol,
            locationId,
            techUser,
            piVersion,
            status: 'configured',
          };

          await UPDATE(PISystem).set(updateData).where({ ID: systemId, tenantId });

          LOG.info('PI/PO system updated', { tenantId, systemId, systemName });

          return await SELECT.one.from(PISystem).where({ ID: systemId });
        }

        // Create new system
        const newSystemId = randomUUID();

        // Generate destination names
        const destSuffix = `${systemName}_${tenantId}`.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        const destinationDir = `PO_${destSuffix}_DIR`;
        const destinationEsr = `PO_${destSuffix}_ESR`;

        await INSERT.into(PISystem).entries({
          ID: newSystemId,
          tenantId,
          systemName,
          description,
          virtualHost,
          virtualPort,
          protocol,
          locationId,
          destinationDir,
          destinationEsr,
          techUser,
          piVersion,
          status: 'configured',
          totalArtifacts: 0,
        });

        LOG.info('PI/PO system created', { tenantId, systemId: newSystemId, systemName });

        // Create BTP destinations (best-effort, non-blocking)
        // Store a reference to update system status after completion
        this._createDestinationsAsync(tenantId, newSystemId, systemConfig, destinationDir, destinationEsr);

        // Return with destination_pending status to indicate async creation is in progress
        const result = await SELECT.one.from(PISystem).where({ ID: newSystemId });
        return {
          ...result,
          destinationStatus: 'pending',
          destinationMessage: 'BTP destinations are being created asynchronously. Test connection to verify.',
        };
      } catch (error) {
        LOG.error('Error saving PI/PO system', { tenantId, error: error.message, stack: error.stack });
        return req.error(500, `Failed to save PI/PO system: ${error.message}`);
      }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ACTION: testConnection
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('testConnection', async req => {
      const tenantId = cds.context?.tenant || req.user?.tenant || 'default';
      const { systemId } = req.data;

      LOG.info('testConnection called', { tenantId, systemId });

      if (!systemId) {
        return req.error(400, 'systemId is required');
      }

      const system = await SELECT.one.from(PISystem).where({ ID: systemId, tenantId });

      if (!system) {
        return req.error(404, 'PI/PO system not found');
      }

      try {
        // Import SOAP client
        const { PIPoSoapClient } = require('../utils/pipoSoapClient');

        // Create clients for DIR and ESR
        const dirClient = new PIPoSoapClient(system.destinationDir);
        const esrClient = new PIPoSoapClient(system.destinationEsr);

        // Test connections
        const dirTest = await dirClient.testConnection().catch(e => ({
          success: false,
          error: e.message,
        }));
        const esrTest = await esrClient.testConnection().catch(e => ({
          success: false,
          error: e.message,
        }));

        const success = dirTest.success !== false && esrTest.success !== false;

        // Update system status
        await UPDATE(PISystem)
          .set({
            status: success ? 'active' : 'error',
            lastTestedAt: new Date(),
            lastTestResult: JSON.stringify({ dirTest, esrTest }),
          })
          .where({ ID: systemId, tenantId });

        LOG.info('Connection test completed', { tenantId, systemId, success });

        return {
          success,
          dirStatus: dirTest.success !== false ? 'ok' : dirTest.error || 'failed',
          esrStatus: esrTest.success !== false ? 'ok' : esrTest.error || 'failed',
          message: success ? 'Connection successful' : 'Connection failed - check destination configuration',
          piVersion: esrTest.version || system.piVersion,
          swcvCount: esrTest.swcvCount || 0,
          channelCount: dirTest.channelCount || 0,
        };
      } catch (error) {
        LOG.error('Connection test failed', { tenantId, systemId, error: error.message });
        return {
          success: false,
          dirStatus: 'error',
          esrStatus: 'error',
          message: `Connection test failed: ${error.message}`,
          piVersion: system.piVersion,
          swcvCount: 0,
          channelCount: 0,
        };
      }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ACTION: triggerDiscovery
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('triggerDiscovery', async req => {
      const tenantId = cds.context?.tenant || req.user?.tenant || 'default';
      const { systemId } = req.data;

      LOG.info('triggerDiscovery called', { tenantId, systemId });

      if (!systemId) {
        return req.error(400, 'systemId is required');
      }

      const system = await SELECT.one.from(PISystem).where({ ID: systemId, tenantId });

      if (!system) {
        return req.error(404, 'PI/PO system not found');
      }

      if (system.status === 'error' || system.status === 'disabled') {
        return req.error(
          400,
          `Cannot trigger discovery for system with status: ${system.status}. Please test the connection first.`
        );
      }

      try {
        // Create DiscoveryJob record
        const jobId = randomUUID();
        const now = new Date();
        const options = JSON.stringify({
          includeInactive: false,
          includeHistory: false,
          artifactTypes: null, // All types
        });

        await INSERT.into(DiscoveryJob).entries({
          ID: jobId,
          tenantId,
          system_ID: systemId,
          status: 'pending',
          startedAt: now,
          startedBy: req.user?.id || 'system',
          options,
          progressLog: '[]',
          errorLog: '[]',
          totalPhases: 6,
          currentPhase: 0,
          currentPhaseName: 'Initializing',
          progressPercent: 0,
          artifactsFound: 0,
          artifactsNew: 0,
          artifactsUpdated: 0,
          errorsCount: 0,
          warningsCount: 0,
        });

        // Queue discovery event via cds.queued() for async processing
        const queuedService = cds.queued(this);
        await queuedService.emit('DiscoveryRequested', {
          tenantId,
          systemId,
          jobId,
          options,
          triggeredBy: req.user?.id || 'system',
          timestamp: now.toISOString(),
        });

        LOG.info('Discovery triggered', { tenantId, systemId, jobId });

        return await SELECT.one.from(DiscoveryJob).where({ ID: jobId });
      } catch (error) {
        LOG.error('Error triggering discovery', { tenantId, systemId, error: error.message, stack: error.stack });
        return req.error(500, `Failed to trigger discovery: ${error.message}`);
      }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENT: DiscoveryRequested - Forward to DiscoveryService
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('DiscoveryRequested', async req => {
      const { tenantId, systemId, jobId, options, triggeredBy } = req.data;

      LOG.info('Processing DiscoveryRequested event', { tenantId, systemId, jobId, triggeredBy });

      try {
        // Connect to DiscoveryService and delegate processing
        const discoveryService = await cds.connect.to('DiscoveryService');

        // Start discovery with the system ID
        await discoveryService.send('startDiscovery', {
          systemId,
          ...JSON.parse(options || '{}'),
        });

        LOG.info('Discovery event forwarded to DiscoveryService', { tenantId, jobId });
      } catch (error) {
        LOG.error('DiscoveryRequested event processing failed', {
          tenantId,
          jobId,
          error: error.message,
          stack: error.stack,
        });

        // Update job status to failed
        const { DiscoveryJob } = cds.entities('tenant');
        await UPDATE(DiscoveryJob)
          .set({
            status: 'failed',
            completedAt: new Date(),
            errorLog: JSON.stringify([
              {
                ts: new Date().toISOString(),
                phase: 'init',
                type: 'error',
                message: error.message,
              },
            ]),
          })
          .where({ ID: jobId, tenantId });

        throw error; // Let CAP event queue handle retry
      }
    });

    await super.init();
  }

  /**
   * Validate system configuration input
   * @private
   */
  _validateSystemConfig(config, req) {
    if (!config) {
      return req.error(400, 'systemConfig is required');
    }

    // Required fields
    const requiredFields = ['systemName', 'virtualHost', 'locationId', 'techUser'];
    for (const field of requiredFields) {
      if (!config[field]) {
        return req.error(400, `${field} is required`, field);
      }
    }

    // New system requires password
    if (!config.systemId && !config.techPassword) {
      return req.error(400, 'techPassword is required for new systems', 'techPassword');
    }

    // String length validation
    for (const [field, maxLength] of Object.entries(MAX_STRING_LENGTHS)) {
      if (config[field] && typeof config[field] === 'string' && config[field].length > maxLength) {
        return req.error(400, `${field} exceeds maximum length of ${maxLength} characters`, field);
      }
    }

    // URL format validation
    if (config.virtualHost && !URL_PATTERN.test(config.virtualHost)) {
      return req.error(400, 'virtualHost must be a valid hostname', 'virtualHost');
    }

    // Port range validation
    if (config.virtualPort !== undefined && config.virtualPort !== null) {
      const port = Number(config.virtualPort);
      if (isNaN(port) || port < 1 || port > 65535) {
        return req.error(400, 'virtualPort must be between 1 and 65535', 'virtualPort');
      }
    }

    // Protocol validation
    if (config.protocol && !['http', 'https'].includes(config.protocol.toLowerCase())) {
      return req.error(400, 'protocol must be http or https', 'protocol');
    }

    // PI version validation
    if (config.piVersion && !['7.31', '7.40', '7.50'].includes(config.piVersion)) {
      return req.error(400, 'piVersion must be 7.31, 7.40, or 7.50', 'piVersion');
    }

    return null; // No validation errors
  }

  /**
   * Create BTP destinations asynchronously (best-effort)
   * Updates system status on completion/failure
   * @private
   */
  async _createDestinationsAsync(tenantId, systemId, config, destinationDir, destinationEsr) {
    const { PISystem } = cds.entities('tenant');

    try {
      const destinationService = require('../utils/destinationService');

      await destinationService.createPISystemDestinations({
        tenantId,
        systemName: config.systemName,
        virtualHost: config.virtualHost,
        virtualPort: config.virtualPort || 443,
        protocol: config.protocol || 'https',
        locationId: config.locationId,
        techUser: config.techUser,
        techPassword: config.techPassword,
      });

      LOG.info('BTP destinations created', { tenantId, systemId, destinationDir, destinationEsr });

      // Update system to indicate destinations are ready
      await UPDATE(PISystem)
        .set({
          status: 'configured',
          lastTestedAt: null,
          lastTestResult: JSON.stringify({ destinationsCreated: true }),
        })
        .where({ ID: systemId, tenantId });
    } catch (error) {
      LOG.warn('BTP destination creation failed (manual creation required)', {
        tenantId,
        systemId,
        destinationDir,
        destinationEsr,
        error: error.message,
      });

      // Update system status to indicate destination creation failed
      await UPDATE(PISystem)
        .set({
          status: 'destination_pending',
          lastTestResult: JSON.stringify({
            destinationsCreated: false,
            error: error.message,
            message: 'Manual destination creation required in BTP cockpit',
          }),
        })
        .where({ ID: systemId, tenantId });
    }
  }
};
