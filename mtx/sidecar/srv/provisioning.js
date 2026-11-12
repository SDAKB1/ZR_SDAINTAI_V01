'use strict';

/**
 * MTX Sidecar - Tenant Provisioning Handler
 * 
 * Handles SaaS subscription callbacks for tenant provisioning/deprovisioning.
 * Creates HDI containers and deploys CDS schema for each tenant.
 */

const cds = require('@sap/cds');
const LOG = cds.log('mtx-provisioning');

module.exports = async (service) => {
  
  // Subscribe callback - tenant subscribes to the SaaS application
  service.on('subscribe', async (req, next) => {
    const { tenant, metadata } = req.data;
    LOG.info('Tenant subscribing', { tenant, subdomain: metadata?.subscribedSubdomain });
    
    // Let MTXS handle the actual provisioning (HDI container creation, schema deployment)
    await next();
    
    LOG.info('Tenant provisioned successfully', { tenant });
  });

  // Unsubscribe callback - tenant cancels subscription
  service.on('unsubscribe', async (req, next) => {
    const { tenant } = req.data;
    LOG.info('Tenant unsubscribing', { tenant });
    
    // Let MTXS handle the deprovisioning
    await next();
    
    LOG.info('Tenant deprovisioned successfully', { tenant });
  });

  // Dependencies callback - return required services for the tenant
  service.on('dependencies', async () => {
    // Return xsappname of dependent services (e.g., destination, connectivity)
    return [];
  });

  // Upgrade tenants callback - upgrade tenant schemas
  service.on('upgradeTenant', async (req, next) => {
    const { tenant } = req.data;
    LOG.info('Upgrading tenant schema', { tenant });
    
    await next();
    
    LOG.info('Tenant upgraded successfully', { tenant });
  });
};
