'use strict';
/**
 * BTP Destination Service API Client
 *
 * Programmatically creates and manages destinations for PI/PO systems.
 * Uses the Destination Service REST API.
 *
 * @see https://api.sap.com/api/SAP_CP_CF_Connectivity_Destination/resource
 */
const cds = require('@sap/cds');
const { executeHttpRequest, getDestination } = require('@sap-cloud-sdk/connectivity');

const LOG = cds.log('destination-service');

// Destination Service API base path
const DESTINATION_SERVICE_PATH = '/destination-configuration/v1';

/**
 * Create destinations for a PI/PO system.
 * Creates both DIR (Directory) and ESR (Enterprise Services Repository) destinations.
 */
async function createPISystemDestinations(config) {
  const { tenantId, systemName, virtualHost, virtualPort, protocol, locationId, techUser, techPassword } = config;

  // Generate destination names
  const destSuffix = `${systemName}_${tenantId}`.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const destinationDir = `PO_${destSuffix}_DIR`;
  const destinationEsr = `PO_${destSuffix}_ESR`;

  const baseUrl = `${protocol}://${virtualHost}:${virtualPort}`;

  // Directory API destination (for ICOs, Channels, Agreements)
  const dirDestination = {
    Name: destinationDir,
    Type: 'HTTP',
    URL: baseUrl,
    Authentication: 'BasicAuthentication',
    ProxyType: 'OnPremise',
    User: techUser,
    Password: techPassword,
    'sap-client': '',
    CloudConnectorLocationId: locationId,
    Description: `PI/PO Directory API for ${systemName} (Tenant: ${tenantId})`,
    // Additional properties for Cloud Connector
    'HTML5.DynamicDestination': 'true',
    WebIDEEnabled: 'true',
    WebIDEUsage: 'odata_gen',
  };

  // ESR API destination (for Message Mappings, Data Types, etc.)
  const esrDestination = {
    Name: destinationEsr,
    Type: 'HTTP',
    URL: baseUrl,
    Authentication: 'BasicAuthentication',
    ProxyType: 'OnPremise',
    User: techUser,
    Password: techPassword,
    'sap-client': '',
    CloudConnectorLocationId: locationId,
    Description: `PI/PO ESR API for ${systemName} (Tenant: ${tenantId})`,
    'HTML5.DynamicDestination': 'true',
    WebIDEEnabled: 'true',
    WebIDEUsage: 'odata_gen',
  };

  const results = {
    destinationDir: null,
    destinationEsr: null,
    errors: [],
  };

  try {
    results.destinationDir = await createDestination(dirDestination);
    LOG.info('Created DIR destination', { name: destinationDir });
  } catch (error) {
    LOG.error('Failed to create DIR destination', { name: destinationDir, error: error.message });
    results.errors.push({ destination: destinationDir, error: error.message });
  }

  try {
    results.destinationEsr = await createDestination(esrDestination);
    LOG.info('Created ESR destination', { name: destinationEsr });
  } catch (error) {
    LOG.error('Failed to create ESR destination', { name: destinationEsr, error: error.message });
    results.errors.push({ destination: destinationEsr, error: error.message });
  }

  return results;
}

/**
 * Create a single destination via the Destination Service API.
 */
async function createDestination(destinationConfig) {
  try {
    const response = await executeHttpRequest(
      { destinationName: 'DESTINATION_SERVICE' },
      {
        method: 'POST',
        url: `${DESTINATION_SERVICE_PATH}/subaccountDestinations`,
        data: destinationConfig,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    return {
      name: destinationConfig.Name,
      status: 'created',
      response: response.data,
    };
  } catch (error) {
    // Check if destination already exists
    if (error.response?.status === 409) {
      LOG.info('Destination already exists, updating', { name: destinationConfig.Name });
      return await updateDestination(destinationConfig);
    }
    throw error;
  }
}

/**
 * Update an existing destination.
 */
async function updateDestination(destinationConfig) {
  const response = await executeHttpRequest(
    { destinationName: 'DESTINATION_SERVICE' },
    {
      method: 'PUT',
      url: `${DESTINATION_SERVICE_PATH}/subaccountDestinations/${destinationConfig.Name}`,
      data: destinationConfig,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );

  return {
    name: destinationConfig.Name,
    status: 'updated',
    response: response.data,
  };
}

/**
 * Delete a destination.
 */
async function deleteDestination(destinationName) {
  try {
    await executeHttpRequest(
      { destinationName: 'DESTINATION_SERVICE' },
      {
        method: 'DELETE',
        url: `${DESTINATION_SERVICE_PATH}/subaccountDestinations/${destinationName}`,
      }
    );

    LOG.info('Deleted destination', { name: destinationName });
    return { name: destinationName, status: 'deleted' };
  } catch (error) {
    if (error.response?.status === 404) {
      LOG.info('Destination not found, skipping delete', { name: destinationName });
      return { name: destinationName, status: 'not_found' };
    }
    throw error;
  }
}

/**
 * Delete all destinations for a PI/PO system.
 */
async function deletePISystemDestinations(tenantId, systemName) {
  const destSuffix = `${systemName}_${tenantId}`.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const destinationDir = `PO_${destSuffix}_DIR`;
  const destinationEsr = `PO_${destSuffix}_ESR`;

  const results = {
    destinationDir: null,
    destinationEsr: null,
    errors: [],
  };

  try {
    results.destinationDir = await deleteDestination(destinationDir);
  } catch (error) {
    results.errors.push({ destination: destinationDir, error: error.message });
  }

  try {
    results.destinationEsr = await deleteDestination(destinationEsr);
  } catch (error) {
    results.errors.push({ destination: destinationEsr, error: error.message });
  }

  return results;
}

/**
 * Get destination details.
 */
async function getDestinationDetails(destinationName) {
  try {
    const response = await executeHttpRequest(
      { destinationName: 'DESTINATION_SERVICE' },
      {
        method: 'GET',
        url: `${DESTINATION_SERVICE_PATH}/subaccountDestinations/${destinationName}`,
      }
    );

    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * List all destinations for a tenant (filtered by naming pattern).
 */
async function listPISystemDestinations(tenantId) {
  const response = await executeHttpRequest(
    { destinationName: 'DESTINATION_SERVICE' },
    {
      method: 'GET',
      url: `${DESTINATION_SERVICE_PATH}/subaccountDestinations`,
    }
  );

  const allDestinations = response.data || [];
  const pattern = `_${tenantId}`.toUpperCase().replace(/[^A-Z0-9]/g, '_');

  return allDestinations.filter(dest => dest.Name.startsWith('PO_') && dest.Name.includes(pattern));
}

/**
 * Test destination connectivity.
 */
async function testDestinationConnectivity(destinationName) {
  try {
    // Get the destination to verify it exists and is configured
    const dest = await getDestination({ destinationName });

    if (!dest) {
      return {
        success: false,
        message: `Destination ${destinationName} not found`,
      };
    }

    // Try a simple request through the destination
    const testResponse = await executeHttpRequest(
      { destinationName },
      {
        method: 'GET',
        url: '/dir/hmi', // PI/PO health check endpoint
        timeout: 10000,
      }
    );

    return {
      success: true,
      statusCode: testResponse.status,
      message: 'Connection successful',
    };
  } catch (error) {
    return {
      success: false,
      statusCode: error.response?.status,
      message: error.message,
      details: error.response?.data,
    };
  }
}

/**
 * Validate destination configuration.
 */
function validateDestinationConfig(config) {
  const required = ['systemName', 'virtualHost', 'locationId', 'techUser', 'techPassword'];
  const missing = required.filter(field => !config[field]);

  if (missing.length > 0) {
    return {
      valid: false,
      errors: missing.map(field => `Missing required field: ${field}`),
    };
  }

  // Validate URL format
  if (config.virtualHost && !config.virtualHost.match(/^[a-zA-Z0-9.-]+$/)) {
    return {
      valid: false,
      errors: ['Invalid virtualHost format'],
    };
  }

  // Validate port
  if (config.virtualPort && (config.virtualPort < 1 || config.virtualPort > 65535)) {
    return {
      valid: false,
      errors: ['Invalid virtualPort (must be 1-65535)'],
    };
  }

  return { valid: true, errors: [] };
}

module.exports = {
  createPISystemDestinations,
  createDestination,
  updateDestination,
  deleteDestination,
  deletePISystemDestinations,
  getDestinationDetails,
  listPISystemDestinations,
  testDestinationConnectivity,
  validateDestinationConfig,
};
