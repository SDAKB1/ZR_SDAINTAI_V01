'use strict';

/**
 * MTXS Tenant Provisioning Callbacks
 *
 * Implements subscription lifecycle callbacks for CAP multitenancy.
 * Handles tenant onboarding (subscribe) and offboarding (unsubscribe).
 *
 * @see https://cap.cloud.sap/docs/guides/multitenancy/#subscription-callbacks
 */

const cds = require('@sap/cds');
const cacheService = require('../cache/artifactCacheService');

const LOG = cds.log('mtx-provisioning');

/**
 * MTXS subscription callbacks module
 *
 * Called by CAP MTXS sidecar during tenant provisioning lifecycle:
 * - subscribe: After tenant HDI container is created and schema deployed
 * - unsubscribe: Before tenant HDI container is deleted
 * - upgrade: When application version is updated (schema migration)
 *
 * @param {cds.Service} service - The MTX sidecar service instance
 */
module.exports = service => {
  /**
   * Handle tenant subscription (onboarding)
   *
   * Called after MTXS has:
   * 1. Received subscription request from SaaS Registry
   * 2. Created tenant HDI container via Service Manager
   * 3. Deployed CDS schema to tenant container
   *
   * Use this callback to:
   * - Seed reference data for the tenant
   * - Initialize tenant-specific configurations
   * - Set up integrations
   */
  service.on('UPDATE', 'tenant', async (req, next) => {
    const { subscribedTenantId, subscribedSubdomain, eventType } = req.data;

    LOG.info('Tenant lifecycle event received', {
      tenantId: subscribedTenantId,
      subdomain: subscribedSubdomain,
      eventType,
    });

    // Handle subscription (onboarding)
    if (eventType === 'CREATE' || eventType === 'subscribe') {
      return await handleSubscribe(subscribedTenantId, subscribedSubdomain, req);
    }

    // Handle unsubscription (offboarding)
    if (eventType === 'DELETE' || eventType === 'unsubscribe') {
      return await handleUnsubscribe(subscribedTenantId, subscribedSubdomain, req);
    }

    // For other events (like upgrade), proceed with default handling
    return await next();
  });

  /**
   * Alternative handler for explicit subscribe event
   */
  service.on('subscribe', async req => {
    const { subscribedTenantId, subscribedSubdomain } = req.data;

    LOG.info('Explicit subscribe event received', {
      tenantId: subscribedTenantId,
      subdomain: subscribedSubdomain,
    });

    return await handleSubscribe(subscribedTenantId, subscribedSubdomain, req);
  });

  /**
   * Alternative handler for explicit unsubscribe event
   */
  service.on('unsubscribe', async req => {
    const { subscribedTenantId, subscribedSubdomain } = req.data;

    LOG.info('Explicit unsubscribe event received', {
      tenantId: subscribedTenantId,
      subdomain: subscribedSubdomain,
    });

    return await handleUnsubscribe(subscribedTenantId, subscribedSubdomain, req);
  });
};

/**
 * Handle tenant subscription
 * @private
 */
async function handleSubscribe(tenantId, subdomain, req) {
  LOG.info('Processing tenant subscription', { tenantId, subdomain });

  try {
    // Create transaction with tenant context
    const tx = cds.transaction({ user: { id: 'system', tenant: tenantId } });

    // Seed reference data for the tenant
    await seedReferenceData(tx, tenantId);

    await tx.commit();

    LOG.info('Tenant subscription completed', { tenantId, subdomain });

    return {
      status: 'success',
      tenantId,
      message: `Tenant ${tenantId} provisioned successfully`,
    };
  } catch (error) {
    LOG.error('Tenant subscription failed', {
      tenantId,
      subdomain,
      error: error.message,
      stack: error.stack,
    });

    // Don't throw - let MTXS handle the failure
    return {
      status: 'error',
      tenantId,
      message: `Tenant provisioning failed: ${error.message}`,
    };
  }
}

/**
 * Handle tenant unsubscription
 * @private
 */
async function handleUnsubscribe(tenantId, subdomain, req) {
  LOG.info('Processing tenant unsubscription', { tenantId, subdomain });

  try {
    // Clean up tenant-specific cache entries
    LOG.info('Cleaning up tenant cache', { tenantId });

    try {
      // Invalidate all cached artifacts for this tenant
      const cacheStats = await cacheService.getStats(tenantId);

      if (cacheStats.totalEntries > 0) {
        // Invalidate by pattern - all cache keys for this tenant
        await cacheService.invalidateByPattern(tenantId, '%');

        LOG.info('Tenant cache cleared', {
          tenantId,
          entriesCleared: cacheStats.totalEntries,
        });
      }
    } catch (cacheError) {
      LOG.warn('Cache cleanup failed (non-fatal)', {
        tenantId,
        error: cacheError.message,
      });
    }

    // Clean up idempotency records
    try {
      const idempotencyService = require('../utils/idempotencyService');
      const cleaned = await idempotencyService.cleanExpired(tenantId);

      LOG.info('Idempotency records cleaned', { tenantId, count: cleaned });
    } catch (idempError) {
      LOG.warn('Idempotency cleanup failed (non-fatal)', {
        tenantId,
        error: idempError.message,
      });
    }

    LOG.info('Tenant unsubscription completed', { tenantId, subdomain });

    return {
      status: 'success',
      tenantId,
      message: `Tenant ${tenantId} offboarded successfully`,
    };
  } catch (error) {
    LOG.error('Tenant unsubscription failed', {
      tenantId,
      subdomain,
      error: error.message,
      stack: error.stack,
    });

    // Don't throw - let MTXS handle the failure
    return {
      status: 'error',
      tenantId,
      message: `Tenant offboarding failed: ${error.message}`,
    };
  }
}

/**
 * Seed reference data for a new tenant
 * @private
 */
async function seedReferenceData(tx, tenantId) {
  LOG.info('Seeding reference data for tenant', { tenantId });

  const { ArtifactType, MigrationLimitationRef, ScenarioPatternRef, AdapterMigrationRef } = cds.entities('tenant');

  // Seed artifact types
  const artifactTypes = [
    {
      code: 'IntegratedConfiguration',
      name: 'Integrated Configuration (ICO)',
      category: 'directory',
      discoveryOrder: 1,
      supportsQuery: true,
      supportsRead: true,
    },
    {
      code: 'CommunicationChannel',
      name: 'Communication Channel',
      category: 'directory',
      discoveryOrder: 2,
      supportsQuery: true,
      supportsRead: true,
    },
    {
      code: 'SenderAgreement',
      name: 'Sender Agreement',
      category: 'directory',
      discoveryOrder: 3,
      supportsQuery: true,
      supportsRead: true,
    },
    {
      code: 'ReceiverAgreement',
      name: 'Receiver Agreement',
      category: 'directory',
      discoveryOrder: 4,
      supportsQuery: true,
      supportsRead: true,
    },
    {
      code: 'ValueMappingGroup',
      name: 'Value Mapping Group',
      category: 'directory',
      discoveryOrder: 5,
      supportsQuery: true,
      supportsRead: true,
    },
    {
      code: 'MessageMapping',
      name: 'Message Mapping',
      category: 'esr',
      discoveryOrder: 6,
      supportsQuery: true,
      supportsRead: true,
    },
    {
      code: 'OperationMapping',
      name: 'Operation Mapping',
      category: 'esr',
      discoveryOrder: 7,
      supportsQuery: true,
      supportsRead: true,
    },
    {
      code: 'SoftwareComponentVersion',
      name: 'Software Component Version',
      category: 'esr',
      discoveryOrder: 8,
      supportsQuery: true,
      supportsRead: false,
    },
  ];

  for (const type of artifactTypes) {
    try {
      const existing = await tx.run(SELECT.one.from(ArtifactType).where({ code: type.code }));
      if (!existing) {
        await tx.run(INSERT.into(ArtifactType).entries(type));
      }
    } catch (e) {
      LOG.debug('Artifact type seed skipped (may already exist)', { code: type.code });
    }
  }

  // Seed scenario patterns
  const scenarioPatterns = [
    { code: 'P2P_ASYNC', name: 'Point-to-Point Asynchronous', baseComplexity: 'simple', typicalHours: 8 },
    { code: 'P2P_SYNC', name: 'Point-to-Point Synchronous', baseComplexity: 'simple', typicalHours: 12 },
    { code: 'MULTICAST', name: 'Multicast/Broadcast', baseComplexity: 'medium', typicalHours: 20 },
    { code: 'BPM', name: 'Business Process Management', baseComplexity: 'complex', typicalHours: 60 },
    { code: 'CCBPM', name: 'Cross-Component BPM', baseComplexity: 'complex', typicalHours: 80 },
    { code: 'CUSTOM', name: 'Custom Pattern', baseComplexity: 'complex', typicalHours: 40 },
  ];

  for (const pattern of scenarioPatterns) {
    try {
      const existing = await tx.run(SELECT.one.from(ScenarioPatternRef).where({ code: pattern.code }));
      if (!existing) {
        await tx.run(INSERT.into(ScenarioPatternRef).entries(pattern));
      }
    } catch (e) {
      LOG.debug('Scenario pattern seed skipped', { code: pattern.code });
    }
  }

  // Seed known migration limitations
  const limitations = [
    {
      code: 'NFS_ADAPTER',
      name: 'NFS Adapter Not Supported',
      category: 'adapter',
      severity: 'blocker',
      workaroundType: 'custom_adapter',
    },
    {
      code: 'ASMA_HEADER',
      name: 'ASMA Headers Limited Support',
      category: 'runtime',
      severity: 'major',
      workaroundType: 'script',
    },
    {
      code: 'CCBPM_PATTERNS',
      name: 'ccBPM Pattern Not Directly Supported',
      category: 'feature',
      severity: 'major',
      workaroundType: 'rebuild',
    },
    {
      code: 'JAVA_MAPPING',
      name: 'Java Mapping Requires Conversion',
      category: 'mapping',
      severity: 'minor',
      workaroundType: 'script',
    },
    {
      code: 'CUSTOM_MODULE',
      name: 'Custom Adapter Module',
      category: 'adapter',
      severity: 'major',
      workaroundType: 'script',
    },
  ];

  for (const limitation of limitations) {
    try {
      const existing = await tx.run(SELECT.one.from(MigrationLimitationRef).where({ code: limitation.code }));
      if (!existing) {
        await tx.run(INSERT.into(MigrationLimitationRef).entries(limitation));
      }
    } catch (e) {
      LOG.debug('Limitation seed skipped', { code: limitation.code });
    }
  }

  // Seed adapter migration matrix
  const adapterMigrations = [
    { pipoAdapter: 'SOAP', direction: 'sender', isAdapter: 'SOAP', migrationStatus: 'direct' },
    { pipoAdapter: 'SOAP', direction: 'receiver', isAdapter: 'SOAP', migrationStatus: 'direct' },
    { pipoAdapter: 'IDoc_AAE', direction: 'sender', isAdapter: 'IDoc', migrationStatus: 'direct' },
    { pipoAdapter: 'IDoc_AAE', direction: 'receiver', isAdapter: 'IDoc', migrationStatus: 'direct' },
    { pipoAdapter: 'HTTP_AAE', direction: 'sender', isAdapter: 'HTTP', migrationStatus: 'direct' },
    { pipoAdapter: 'HTTP_AAE', direction: 'receiver', isAdapter: 'HTTP', migrationStatus: 'direct' },
    { pipoAdapter: 'FILE', direction: 'sender', isAdapter: 'SFTP', migrationStatus: 'alternative' },
    { pipoAdapter: 'FILE', direction: 'receiver', isAdapter: 'SFTP', migrationStatus: 'alternative' },
    { pipoAdapter: 'AS2', direction: 'sender', isAdapter: 'AS2', migrationStatus: 'direct' },
    { pipoAdapter: 'AS2', direction: 'receiver', isAdapter: 'AS2', migrationStatus: 'direct' },
    { pipoAdapter: 'JDBC', direction: 'sender', isAdapter: 'JDBC', migrationStatus: 'direct' },
    { pipoAdapter: 'JDBC', direction: 'receiver', isAdapter: 'JDBC', migrationStatus: 'direct' },
  ];

  for (const adapter of adapterMigrations) {
    try {
      const existing = await tx.run(
        SELECT.one.from(AdapterMigrationRef).where({ pipoAdapter: adapter.pipoAdapter, direction: adapter.direction })
      );
      if (!existing) {
        await tx.run(INSERT.into(AdapterMigrationRef).entries(adapter));
      }
    } catch (e) {
      LOG.debug('Adapter migration seed skipped', { adapter: adapter.pipoAdapter });
    }
  }

  LOG.info('Reference data seeding completed', { tenantId });
}
