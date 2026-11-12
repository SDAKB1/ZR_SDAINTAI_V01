'use strict';

/**
 * PI/PO 7.50 Comprehensive Discovery Module
 *
 * Covers all six migration discovery areas:
 *   1. Integration Directory - ICOs, channels, routing, agreements, value mappings
 *   2. ESR - SWCVs, namespaces, interfaces, message/data types, mappings
 *   3. System Landscape (SLD) - Technical/business systems, software components
 *   4. Channel Monitoring - Channel state, adapter errors
 *   5. Message Monitoring - Usage volumes, failures, processing times
 *   6. Platform Configuration - Installed components, SP/patch levels
 *
 * Output: Connected migration inventory with dependency resolution
 *
 * @see SAP Help Portal - PI/PO Migration Extraction Requirements
 */

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { randomUUID } = require('crypto');

// BUG-M4 fix: Import timeout values from centralized constants
const { Timeouts, Destinations } = require('./constants');
// DRY-2 fix: Import centralized complexity scorer
const { assessMigrationComplexity: _assessComplexity } = require('./complexityScorer');

const LOG = cds.log('pipo-discovery');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  destinations: {
    DIR: Destinations.DIR, // Integration Directory
    ESR: Destinations.ESR, // Enterprise Services Repository
    SLD: Destinations.SLD, // System Landscape Directory (if separate)
  },

  timeout: Timeouts.SHORT,
  longTimeout: Timeouts.LONG,

  // ─────────────────────────────────────────────────────────────────────────
  // INTEGRATION DIRECTORY SOAP SERVICES
  // Append ?wsdl for contract, use binding address for SOAP calls
  // ─────────────────────────────────────────────────────────────────────────
  directorySoapServices: {
    // Core configuration objects
    IntegratedConfiguration: '/IntegratedConfigurationInService/IntegratedConfigurationInImplBean',
    CommunicationChannel: '/CommunicationChannelInService/CommunicationChannelInImplBean',

    // Routing and agreements
    SenderAgreement: '/SenderAgreementInService/SenderAgreementInImplBean',
    ReceiverAgreement: '/ReceiverAgreementInService/ReceiverAgreementInImplBean',
    InterfaceDetermination: '/InterfaceDeterminationInService/InterfaceDeterminationInImplBean',
    ReceiverDetermination: '/ReceiverDeterminationInService/ReceiverDeterminationInImplBean',

    // Value mappings and alerts
    ValueMapping: '/ValueMappingInService/ValueMappingInImplBean',
    AlertRule: '/AlertRuleInService/AlertRuleInImplBean',

    // Business components and scenarios (verify deployment)
    BusinessComponent: '/BusinessComponentInService/BusinessComponentInImplBean',
    ConfigurationScenario: '/ConfigurationScenarioInService/ConfigurationScenarioInImplBean',

    // PI 7.50 specific (verify if deployed - has wildcard receiver info)
    IntegratedConfiguration750: '/IntegratedConfiguration750InService/IntegratedConfiguration750InImplBean',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // ESR REPOSITORY INTERFACES
  // These are version-sensitive with distinct request formats
  // ─────────────────────────────────────────────────────────────────────────
  esrInterfaces: {
    // Simple Query - HTML form-based, returns all objects of a type
    simpleQuery: '/rep/support/SimpleQuery',

    // External Query API - XML-based, supports filtering
    queryExt: '/rep/query/ext/1',

    // External Read API - fetches full object definition
    readExt: '/rep/read/ext/1',

    // Internal Query API (different format, may require different auth)
    queryInt: '/rep/query/int/1',

    // Content export
    exportContent: '/rep/export/ext/1',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SYSTEM LANDSCAPE DIRECTORY (SLD)
  // CIM interface, may reside on a different host
  // ─────────────────────────────────────────────────────────────────────────
  sldInterfaces: {
    cimom: '/sld/cimom',
    dataSupplier: '/sld/ds',
    bridge: '/sld/bridge',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // MONITORING INTERFACES
  // ─────────────────────────────────────────────────────────────────────────
  monitoringInterfaces: {
    // Channel monitoring - returns XML
    channelAdmin: '/AdapterFramework/ChannelAdminServlet',

    // Message monitoring (MDT)
    messageProcessingLogs: '/mdt/api/1.0/MessageProcessingLogs',
    messageOverview: '/mdt/overview.do',

    // Cache administration
    cacheAdmin: '/rep/cache/admin',

    // Runtime configuration
    runtimeConfig: '/rep/support/admin',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // ESR OBJECT TYPES
  // ─────────────────────────────────────────────────────────────────────────
  esrObjectTypes: [
    'SoftwareComponentVersion',
    'Namespace',
    'MessageType',
    'DataType',
    'ExternalDefinition',
    'ServiceInterface',
    'MessageMapping',
    'OperationMapping',
    'InterfaceMapping',
    'FunctionLibrary',
    'ImportedArchive',
  ],

  // ─────────────────────────────────────────────────────────────────────────
  // DIRECTORY OBJECT TYPES
  // ─────────────────────────────────────────────────────────────────────────
  dirObjectTypes: [
    'IntegratedConfiguration',
    'CommunicationChannel',
    'SenderAgreement',
    'ReceiverAgreement',
    'InterfaceDetermination',
    'ReceiverDetermination',
    'ValueMappingGroup',
    'BusinessComponent',
    'ConfigurationScenario',
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function httpGet(dest, path, params = {}, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  LOG.debug(`[GET] ${dest} ${path}`, { params, correlationId });

  try {
    const res = await executeHttpRequest(
      { destinationName: dest },
      {
        method: 'GET',
        url: path,
        params,
        timeout: opts.timeout || CONFIG.timeout,
        headers: {
          Accept: opts.accept || 'application/xml, text/xml, */*',
          'X-Correlation-ID': correlationId,
        },
      }
    );
    return { success: true, status: res.status, data: res.data, headers: res.headers };
  } catch (error) {
    LOG.error(`[GET] ${dest} ${path} failed`, { error: error.message, correlationId });
    return {
      success: false,
      status: error.response?.status,
      error: error.message,
      data: error.response?.data,
    };
  }
}

async function httpPost(dest, path, data, params = {}, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  LOG.debug(`[POST] ${dest} ${path}`, { correlationId });

  try {
    const res = await executeHttpRequest(
      { destinationName: dest },
      {
        method: 'POST',
        url: path,
        data,
        params,
        timeout: opts.timeout || CONFIG.timeout,
        headers: {
          'Content-Type': opts.contentType || 'application/xml',
          Accept: opts.accept || 'application/xml, text/xml, */*',
          'X-Correlation-ID': correlationId,
        },
      }
    );
    return { success: true, status: res.status, data: res.data, headers: res.headers };
  } catch (error) {
    LOG.error(`[POST] ${dest} ${path} failed`, { error: error.message, correlationId });
    return {
      success: false,
      status: error.response?.status,
      error: error.message,
      data: error.response?.data,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CAPABILITY DISCOVERY
// Record source version, SP, deployed services, accessible operations, gaps
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discover PI/PO system capabilities and available services
 * @returns {object} Capability report with version, services, gaps
 */
async function discoverCapabilities(opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const report = {
    timestamp: new Date().toISOString(),
    correlationId,
    system: {},
    services: {
      directory: {},
      esr: {},
      sld: {},
      monitoring: {},
    },
    gaps: [],
  };

  LOG.info('[capabilities] Starting capability discovery', { correlationId });

  // ─────────────────────────────────────────────────────────────────────────
  // Check Directory SOAP services
  // ─────────────────────────────────────────────────────────────────────────
  for (const [name, path] of Object.entries(CONFIG.directorySoapServices)) {
    const wsdlPath = path + '?wsdl';
    const result = await httpGet(CONFIG.destinations.DIR, wsdlPath, {}, { correlationId });

    report.services.directory[name] = {
      path,
      wsdlAvailable: result.success && result.status === 200,
      status: result.status,
      error: result.error,
    };

    if (!result.success) {
      report.gaps.push({
        area: 'directory',
        service: name,
        reason: result.error || `HTTP ${result.status}`,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check ESR interfaces
  // ─────────────────────────────────────────────────────────────────────────
  for (const [name, path] of Object.entries(CONFIG.esrInterfaces)) {
    // Test with a simple query
    const testPath =
      name === 'simpleQuery'
        ? `${path}?type=SoftwareComponentVersion&swcSelection=all`
        : name.startsWith('query')
          ? `${path}/SoftwareComponentVersion`
          : path;

    const result = await httpGet(CONFIG.destinations.ESR, testPath, {}, { correlationId });

    report.services.esr[name] = {
      path,
      available: result.success && result.status === 200,
      status: result.status,
      error: result.error,
    };

    if (!result.success && result.status !== 404) {
      report.gaps.push({
        area: 'esr',
        service: name,
        reason: result.error || `HTTP ${result.status}`,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check SLD interfaces
  // ─────────────────────────────────────────────────────────────────────────
  for (const [name, path] of Object.entries(CONFIG.sldInterfaces)) {
    // SLD may be on DIR destination or separate
    const result = await httpGet(CONFIG.destinations.DIR, path, {}, { correlationId });

    report.services.sld[name] = {
      path,
      available: result.success && result.status === 200,
      status: result.status,
      error: result.error,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check monitoring interfaces
  // ─────────────────────────────────────────────────────────────────────────
  // Channel Admin Servlet
  const channelResult = await httpGet(
    CONFIG.destinations.DIR,
    CONFIG.monitoringInterfaces.channelAdmin,
    { action: 'status' },
    { correlationId }
  );
  report.services.monitoring.channelAdmin = {
    path: CONFIG.monitoringInterfaces.channelAdmin,
    available: channelResult.success,
    status: channelResult.status,
  };

  // MDT API
  const mdtResult = await httpGet(
    CONFIG.destinations.DIR,
    CONFIG.monitoringInterfaces.messageProcessingLogs,
    { $top: 1, $format: 'json' },
    { correlationId, accept: 'application/json' }
  );
  report.services.monitoring.mdt = {
    path: CONFIG.monitoringInterfaces.messageProcessingLogs,
    available: mdtResult.success,
    status: mdtResult.status,
  };

  LOG.info('[capabilities] Discovery complete', {
    correlationId,
    gapsCount: report.gaps.length,
  });

  return report;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. INTEGRATION DIRECTORY COLLECTION
// ICOs, channels, routing, agreements, value mappings
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Query Directory objects using Simple Query API
 */
async function queryDirectoryObjects(objectType, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const path = `${CONFIG.esrInterfaces.simpleQuery}?type=${objectType}&swcSelection=all`;

  LOG.info(`[directory] Querying ${objectType}`, { correlationId });

  const result = await httpGet(
    CONFIG.destinations.DIR,
    path,
    {},
    {
      correlationId,
      timeout: CONFIG.longTimeout,
    }
  );

  return {
    objectType,
    success: result.success,
    timestamp: new Date().toISOString(),
    correlationId,
    data: result.data,
    error: result.error,
  };
}

/**
 * Read a specific Directory object's full definition
 */
async function readDirectoryObject(objectType, identifier, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const path = `${CONFIG.esrInterfaces.readExt}/${objectType}`;

  LOG.info(`[directory] Reading ${objectType}`, { identifier, correlationId });

  const result = await httpGet(CONFIG.destinations.DIR, path, identifier, { correlationId });

  return {
    objectType,
    identifier,
    success: result.success,
    timestamp: new Date().toISOString(),
    correlationId,
    data: result.data,
    error: result.error,
  };
}

/**
 * Collect all Integration Directory objects
 * BUG-M3 fix: Use parallel execution with Promise.allSettled and rate limiting
 */
async function collectDirectoryInventory(opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const inventory = {
    timestamp: new Date().toISOString(),
    correlationId,
    objects: {},
    summary: {},
    errors: [],
  };

  LOG.info('[directory] Starting inventory collection', { correlationId });

  // Process in parallel batches of 3 to avoid overwhelming the PI/PO system
  const batchSize = 3;
  for (let i = 0; i < CONFIG.dirObjectTypes.length; i += batchSize) {
    const batch = CONFIG.dirObjectTypes.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(objectType => queryDirectoryObjects(objectType, { correlationId }))
    );

    results.forEach((result, idx) => {
      const objectType = batch[idx];
      if (result.status === 'fulfilled') {
        inventory.objects[objectType] = result.value;
        inventory.summary[objectType] = {
          collected: result.value.success,
          error: result.value.error,
        };
        if (!result.value.success) {
          inventory.errors.push({
            objectType,
            error: result.value.error,
          });
        }
      } else {
        inventory.objects[objectType] = { success: false, error: result.reason?.message };
        inventory.summary[objectType] = { collected: false, error: result.reason?.message };
        inventory.errors.push({
          objectType,
          error: result.reason?.message || 'Unknown error',
        });
      }
    });

    // Throttle between batches
    if (i + batchSize < CONFIG.dirObjectTypes.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  LOG.info('[directory] Inventory collection complete', {
    correlationId,
    typesCollected: Object.keys(inventory.objects).length,
    errors: inventory.errors.length,
  });

  return inventory;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. ESR COLLECTION
// SWCVs, namespaces, interfaces, message/data types, mappings
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Query ESR objects using Query Ext API
 */
async function queryEsrObjects(objectType, params = {}, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const path = `${CONFIG.esrInterfaces.queryExt}/${objectType}`;

  LOG.info(`[esr] Querying ${objectType}`, { params, correlationId });

  const result = await httpGet(CONFIG.destinations.ESR, path, params, {
    correlationId,
    timeout: CONFIG.longTimeout,
  });

  return {
    objectType,
    success: result.success,
    timestamp: new Date().toISOString(),
    correlationId,
    data: result.data,
    error: result.error,
  };
}

/**
 * Read a specific ESR object's full definition
 */
async function readEsrObject(objectType, identifier, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const path = `${CONFIG.esrInterfaces.readExt}/${objectType}`;

  LOG.info(`[esr] Reading ${objectType}`, { identifier, correlationId });

  const result = await httpGet(CONFIG.destinations.ESR, path, identifier, { correlationId });

  return {
    objectType,
    identifier,
    success: result.success,
    timestamp: new Date().toISOString(),
    correlationId,
    data: result.data,
    error: result.error,
  };
}

/**
 * Collect all ESR objects
 * BUG-M3 fix: Use parallel execution with Promise.allSettled and rate limiting
 */
async function collectEsrInventory(opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const inventory = {
    timestamp: new Date().toISOString(),
    correlationId,
    objects: {},
    summary: {},
    errors: [],
  };

  LOG.info('[esr] Starting inventory collection', { correlationId });

  // Process in parallel batches of 3 to avoid overwhelming the PI/PO system
  const batchSize = 3;
  for (let i = 0; i < CONFIG.esrObjectTypes.length; i += batchSize) {
    const batch = CONFIG.esrObjectTypes.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(objectType => queryEsrObjects(objectType, {}, { correlationId }))
    );

    results.forEach((result, idx) => {
      const objectType = batch[idx];
      if (result.status === 'fulfilled') {
        inventory.objects[objectType] = result.value;
        inventory.summary[objectType] = {
          collected: result.value.success,
          error: result.value.error,
        };
        if (!result.value.success) {
          inventory.errors.push({
            objectType,
            error: result.value.error,
          });
        }
      } else {
        inventory.objects[objectType] = { success: false, error: result.reason?.message };
        inventory.summary[objectType] = { collected: false, error: result.reason?.message };
        inventory.errors.push({
          objectType,
          error: result.reason?.message || 'Unknown error',
        });
      }
    });

    // Throttle between batches
    if (i + batchSize < CONFIG.esrObjectTypes.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  LOG.info('[esr] Inventory collection complete', {
    correlationId,
    typesCollected: Object.keys(inventory.objects).length,
    errors: inventory.errors.length,
  });

  return inventory;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SLD COLLECTION
// Technical/business systems, software components
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Query SLD via CIM interface
 */
async function querySld(cimClass, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();

  // SLD uses CIM/XML protocol
  const cimRequest = `<?xml version="1.0" encoding="UTF-8"?>
<CIM CIMVERSION="2.0" DTDVERSION="2.0">
  <MESSAGE ID="1" PROTOCOLVERSION="1.0">
    <SIMPLEREQ>
      <IMETHODCALL NAME="EnumerateInstances">
        <LOCALNAMESPACEPATH>
          <NAMESPACE NAME="sld"/>
          <NAMESPACE NAME="active"/>
        </LOCALNAMESPACEPATH>
        <IPARAMVALUE NAME="ClassName">
          <CLASSNAME NAME="${cimClass}"/>
        </IPARAMVALUE>
      </IMETHODCALL>
    </SIMPLEREQ>
  </MESSAGE>
</CIM>`;

  LOG.info(`[sld] Querying ${cimClass}`, { correlationId });

  const result = await httpPost(
    CONFIG.destinations.DIR,
    CONFIG.sldInterfaces.cimom,
    cimRequest,
    {},
    {
      correlationId,
      contentType: 'application/xml',
      timeout: CONFIG.longTimeout,
    }
  );

  return {
    cimClass,
    success: result.success,
    timestamp: new Date().toISOString(),
    correlationId,
    data: result.data,
    error: result.error,
  };
}

/**
 * Collect SLD landscape information
 */
async function collectSldInventory(opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const cimClasses = ['SAP_BusinessSystem', 'SAP_TechnicalSystem', 'SAP_SoftwareComponent', 'SAP_ApplicationServer'];

  const inventory = {
    timestamp: new Date().toISOString(),
    correlationId,
    objects: {},
    errors: [],
  };

  LOG.info('[sld] Starting inventory collection', { correlationId });

  for (const cimClass of cimClasses) {
    const result = await querySld(cimClass, { correlationId });
    inventory.objects[cimClass] = result;

    if (!result.success) {
      inventory.errors.push({
        cimClass,
        error: result.error,
      });
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return inventory;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CHANNEL MONITORING
// Channel state, adapter errors, processing logs
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get channel status from ChannelAdminServlet
 */
async function getChannelStatus(opts = {}) {
  const correlationId = opts.correlationId || randomUUID();

  LOG.info('[monitoring] Getting channel status', { correlationId });

  const result = await httpGet(
    CONFIG.destinations.DIR,
    CONFIG.monitoringInterfaces.channelAdmin,
    { action: 'status' },
    { correlationId }
  );

  return {
    type: 'channelStatus',
    success: result.success,
    timestamp: new Date().toISOString(),
    correlationId,
    data: result.data,
    error: result.error,
  };
}

/**
 * Get channel details for a specific channel
 */
async function getChannelDetails(party, component, channel, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();

  LOG.info('[monitoring] Getting channel details', { party, component, channel, correlationId });

  const result = await httpGet(
    CONFIG.destinations.DIR,
    CONFIG.monitoringInterfaces.channelAdmin,
    {
      action: 'detail',
      party: party || '',
      component,
      channel,
    },
    { correlationId }
  );

  return {
    type: 'channelDetail',
    identifier: { party, component, channel },
    success: result.success,
    timestamp: new Date().toISOString(),
    correlationId,
    data: result.data,
    error: result.error,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. MESSAGE MONITORING
// Usage volumes, failures, processing times
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get message processing logs from MDT API
 */
async function getMessageLogs(opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const params = {
    $top: opts.top || 100,
    $orderby: opts.orderby || 'LogEnd desc',
    $format: 'json',
  };

  if (opts.filter) params.$filter = opts.filter;
  if (opts.skip) params.$skip = opts.skip;

  LOG.info('[monitoring] Getting message logs', { params, correlationId });

  const result = await httpGet(CONFIG.destinations.DIR, CONFIG.monitoringInterfaces.messageProcessingLogs, params, {
    correlationId,
    accept: 'application/json',
  });

  return {
    type: 'messageLogs',
    success: result.success,
    timestamp: new Date().toISOString(),
    correlationId,
    data: result.data,
    error: result.error,
  };
}

/**
 * Get error/failure logs only
 */
async function getErrorLogs(opts = {}) {
  return getMessageLogs({
    ...opts,
    filter: "Status eq 'FAILED' or Status eq 'ERROR'",
  });
}

/**
 * Get usage statistics for a time period
 */
async function getUsageStatistics(startDate, endDate, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();

  // Build filter for date range
  const filter = `LogStart ge datetime'${startDate}' and LogEnd le datetime'${endDate}'`;

  LOG.info('[monitoring] Getting usage statistics', { startDate, endDate, correlationId });

  // Get all logs in the period (paginated)
  const allLogs = [];
  let skip = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await getMessageLogs({
      ...opts,
      correlationId,
      filter,
      top: 1000,
      skip,
    });

    if (!result.success || !result.data?.d?.results?.length) {
      hasMore = false;
    } else {
      allLogs.push(...result.data.d.results);
      skip += 1000;

      // Safety limit
      if (allLogs.length > 50000) hasMore = false;
    }
  }

  // Calculate statistics
  const stats = {
    period: { start: startDate, end: endDate },
    totalMessages: allLogs.length,
    byStatus: {},
    byInterface: {},
    processingTimes: {
      min: Infinity,
      max: 0,
      sum: 0,
      count: 0,
    },
  };

  for (const log of allLogs) {
    // Count by status
    const status = log.Status || 'UNKNOWN';
    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

    // Count by interface
    const iface = log.InterfaceName || 'UNKNOWN';
    if (!stats.byInterface[iface]) {
      stats.byInterface[iface] = { total: 0, errors: 0 };
    }
    stats.byInterface[iface].total++;
    if (status === 'FAILED' || status === 'ERROR') {
      stats.byInterface[iface].errors++;
    }

    // Processing time
    if (log.LogStart && log.LogEnd) {
      const duration = new Date(log.LogEnd) - new Date(log.LogStart);
      if (duration > 0) {
        stats.processingTimes.min = Math.min(stats.processingTimes.min, duration);
        stats.processingTimes.max = Math.max(stats.processingTimes.max, duration);
        stats.processingTimes.sum += duration;
        stats.processingTimes.count++;
      }
    }
  }

  stats.processingTimes.avg =
    stats.processingTimes.count > 0 ? stats.processingTimes.sum / stats.processingTimes.count : 0;

  if (stats.processingTimes.min === Infinity) stats.processingTimes.min = 0;

  return {
    success: true,
    timestamp: new Date().toISOString(),
    correlationId,
    statistics: stats,
    note: 'Statistics based on observed messages in the period. "Not observed" != "unused".',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. DEPENDENCY RESOLUTION
// Connect sender -> channel -> routing/ICO -> interfaces -> mappings -> receiver
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build dependency graph from collected inventory
 * @param {object} dirInventory - Directory inventory from collectDirectoryInventory
 * @param {object} esrInventory - ESR inventory from collectEsrInventory
 * @returns {object} Dependency graph
 */
function buildDependencyGraph(dirInventory, esrInventory) {
  const graph = {
    timestamp: new Date().toISOString(),
    nodes: {},
    edges: [],
    orphans: [],
    warnings: [],
  };

  // This is a placeholder for actual XML parsing logic
  // In production, you'd parse the XML data to extract:
  // - Sender/Receiver from ICOs
  // - Channel references
  // - Interface references
  // - Mapping references

  LOG.info('[dependency] Building dependency graph');

  graph.warnings.push({
    type: 'implementation',
    message: 'Full dependency resolution requires XML parsing of collected data',
  });

  return graph;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. MIGRATION ASSESSMENT
// Identify reusable mappings, adapter replacements, custom dependencies
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Assess migration complexity for an artifact
 * DRY-2 fix: Delegate to centralized complexityScorer module
 */
function assessMigrationComplexity(artifact) {
  return _assessComplexity(artifact);
}

/**
 * Generate migration assessment report
 */
async function generateMigrationAssessment(opts = {}) {
  const correlationId = opts.correlationId || randomUUID();

  LOG.info('[assessment] Starting migration assessment', { correlationId });

  // 1. Discover capabilities
  const capabilities = await discoverCapabilities({ correlationId });

  // 2. Collect Directory inventory
  const dirInventory = await collectDirectoryInventory({ correlationId });

  // 3. Collect ESR inventory
  const esrInventory = await collectEsrInventory({ correlationId });

  // 4. Get usage statistics (last 30 days)
  const endDate = new Date().toISOString();
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const usage = await getUsageStatistics(startDate, endDate, { correlationId });

  // 5. Build dependency graph
  const dependencies = buildDependencyGraph(dirInventory, esrInventory);

  // 6. Compile assessment
  const assessment = {
    timestamp: new Date().toISOString(),
    correlationId,
    capabilities,
    inventory: {
      directory: dirInventory.summary,
      esr: esrInventory.summary,
    },
    usage: usage.statistics,
    dependencies,
    recommendations: [
      'Review BPM scenarios for Integration Flow redesign',
      'Audit custom Java/ABAP mappings for Groovy conversion',
      'Verify adapter compatibility matrix',
      'Plan phased migration by interface criticality',
    ],
    gaps: capabilities.gaps,
  };

  LOG.info('[assessment] Migration assessment complete', { correlationId });

  return assessment;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Configuration
  CONFIG,

  // 1. Capability discovery
  discoverCapabilities,

  // 2. Directory collection
  queryDirectoryObjects,
  readDirectoryObject,
  collectDirectoryInventory,

  // 3. ESR collection
  queryEsrObjects,
  readEsrObject,
  collectEsrInventory,

  // 4. SLD collection
  querySld,
  collectSldInventory,

  // 5. Channel monitoring
  getChannelStatus,
  getChannelDetails,

  // 6. Message monitoring
  getMessageLogs,
  getErrorLogs,
  getUsageStatistics,

  // 7. Dependency resolution
  buildDependencyGraph,

  // 8. Migration assessment
  assessMigrationComplexity,
  generateMigrationAssessment,
};
