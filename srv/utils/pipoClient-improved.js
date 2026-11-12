'use strict';

/**
 * PI/PO Discovery & Integration Suite Deployment Client (Improved)
 *
 * Improvements over original:
 *   - Retry with exponential backoff for transient failures
 *   - Circuit breaker to prevent cascade failures
 *   - Pagination support for large result sets
 *   - Configurable timeouts
 *   - Structured error handling with context
 *   - Request correlation IDs for tracing
 *   - XML to JSON parsing
 *
 * Full chain (handled by @sap-cloud-sdk/http-client):
 *   AICONX-srv -> AICONX-destination -> AICONX-connectivity -> Cloud Connector -> pj2sda.consultsda.com:50000
 *
 * Destinations (ProxyType=OnPremise, BasicAuthentication):
 *   PO_PJ2_DIR  — Integration Directory  (/rep/query|read/ext/1/*, /mdt/api/1.0/*)
 *   PO_PJ2_ESR  — Enterprise Svc Repo    (/rep/query|read/ext/1/*)
 *   IS_API      — Integration Suite      (/api/v1/*)
 */

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { randomUUID } = require('node:crypto');
const crypto = require('node:crypto');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Retry settings
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,

  // Timeout settings (ms)
  timeout: 30000,
  longTimeout: 60000, // For large payloads

  // Circuit breaker settings
  failureThreshold: 5,
  resetTimeoutMs: 60000,

  // Pagination defaults
  defaultPageSize: 100,
  maxPageSize: 500,

  // Destination names
  destinations: {
    DIR: 'PO_PJ2_DIR',
    ESR: 'PO_PJ2_ESR',
    IS: 'IS_API',
  },

  // PI/PO SOAP Web Service Endpoints
  // Note: These require the /...InImplBean suffix for WSDL access
  soapEndpoints: {
    // Integration Directory SOAP Services
    CommunicationChannel: '/CommunicationChannelInService/CommunicationChannelInImplBean',
    IntegratedConfiguration: '/IntegratedConfigurationInService/IntegratedConfigurationInImplBean',
    ValueMapping: '/ValueMappingInService/ValueMappingInImplBean',
    AlertRule: '/AlertRuleInService/AlertRuleInImplBean',
    SenderAgreement: '/SenderAgreementInService/SenderAgreementInImplBean',
    ReceiverAgreement: '/ReceiverAgreementInService/ReceiverAgreementInImplBean',
    InterfaceDetermination: '/InterfaceDeterminationInService/InterfaceDeterminationInImplBean',
    ReceiverDetermination: '/ReceiverDeterminationInService/ReceiverDeterminationInImplBean',
    // ESR SOAP Services
    MessageMapping: '/MessageMappingInService/MessageMappingInImplBean',
    OperationMapping: '/OperationMappingInService/OperationMappingInImplBean',
    InterfaceMapping: '/InterfaceMappingInService/InterfaceMappingInImplBean',
  },
};

let _log;
const LOG = () => {
  if (!_log) {
    _log = cds.log('pipo-client');
  }
  return _log;
};

// ═══════════════════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════════════════════════════

const circuitState = {
  PO_PJ2_DIR: { failures: 0, lastFailure: null, state: 'CLOSED' },
  PO_PJ2_ESR: { failures: 0, lastFailure: null, state: 'CLOSED' },
  IS_API: { failures: 0, lastFailure: null, state: 'CLOSED' },
};

function checkCircuit(dest) {
  const circuit = circuitState[dest];
  if (!circuit) return true;

  if (circuit.state === 'OPEN') {
    const elapsed = Date.now() - circuit.lastFailure;
    if (elapsed > CONFIG.resetTimeoutMs) {
      circuit.state = 'HALF_OPEN';
      LOG().info(`[circuit] ${dest} transitioning to HALF_OPEN after ${elapsed}ms`);
      return true;
    }
    return false;
  }
  return true;
}

function recordSuccess(dest) {
  const circuit = circuitState[dest];
  if (circuit) {
    circuit.failures = 0;
    circuit.state = 'CLOSED';
  }
}

function recordFailure(dest) {
  const circuit = circuitState[dest];
  if (circuit) {
    circuit.failures++;
    circuit.lastFailure = Date.now();
    if (circuit.failures >= CONFIG.failureThreshold) {
      circuit.state = 'OPEN';
      LOG().warn(`[circuit] ${dest} OPEN after ${circuit.failures} failures`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

class PipoClientError extends Error {
  constructor(message, { destination, path, statusCode, correlationId, cause } = {}) {
    super(message);
    this.name = 'PipoClientError';
    this.destination = destination;
    this.path = path;
    this.statusCode = statusCode;
    this.correlationId = correlationId;
    this.cause = cause;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      destination: this.destination,
      path: this.path,
      statusCode: this.statusCode,
      correlationId: this.correlationId,
      timestamp: this.timestamp,
    };
  }
}

function isRetryable(error) {
  // Network errors
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true;
  }
  // HTTP 5xx errors (server-side)
  if (error.response?.status >= 500) {
    return true;
  }
  // HTTP 429 Too Many Requests
  if (error.response?.status === 429) {
    return true;
  }
  // Cloud Connector transient failures
  if (error.message?.includes('Cloud Connector') || error.message?.includes('proxy')) {
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RETRY WITH EXPONENTIAL BACKOFF
// ═══════════════════════════════════════════════════════════════════════════════

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, context = {}) {
  const { dest, path } = context;
  let lastError;

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      // Check circuit breaker
      if (!checkCircuit(dest)) {
        throw new PipoClientError(`Circuit breaker OPEN for ${dest}`, {
          destination: dest,
          path,
          correlationId: context.correlationId,
        });
      }

      const result = await fn();
      recordSuccess(dest);
      return result;
    } catch (error) {
      lastError = error;
      recordFailure(dest);

      if (!isRetryable(error) || attempt === CONFIG.maxRetries) {
        break;
      }

      // Exponential backoff with jitter (crypto random — safe for non-security use)
      const jitterBuf = new Uint32Array(1);
      crypto.getRandomValues(jitterBuf);
      const jitter = jitterBuf[0] % 1000;
      const delay = Math.min(CONFIG.baseDelayMs * Math.pow(2, attempt) + jitter, CONFIG.maxDelayMs);
      LOG().warn(
        `[retry] Attempt ${attempt + 1}/${CONFIG.maxRetries} failed for ${dest}${path}, retrying in ${delay}ms: ${error.message}`
      );
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    }
  }

  throw new PipoClientError(`Request failed after ${CONFIG.maxRetries + 1} attempts: ${lastError.message}`, {
    destination: dest,
    path,
    statusCode: lastError.response?.status,
    correlationId: context.correlationId,
    cause: lastError,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// XML PARSING (lightweight)
// ═══════════════════════════════════════════════════════════════════════════════

function parseXmlToBasicJson(xml) {
  // Basic XML to JSON conversion for PI/PO responses
  // For production, consider using fast-xml-parser
  if (typeof xml !== 'string') return xml;

  // Extract key-value pairs from simple XML structures
  const result = {};
  const tagRegex = /<(\w+)>([^<]*)<\/\1>/g;
  let match;

  while ((match = tagRegex.exec(xml)) !== null) {
    const [, tag, value] = match;
    if (result[tag]) {
      // Convert to array if multiple values
      if (!Array.isArray(result[tag])) {
        result[tag] = [result[tag]];
      }
      result[tag].push(value);
    } else {
      result[tag] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : xml;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE HTTP HELPERS (with improvements)
// ═══════════════════════════════════════════════════════════════════════════════

async function pipoGet(dest, path, params = {}, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const timeout = opts.timeout || CONFIG.timeout;

  LOG().debug(`[pipo] GET ${dest}${path}`, { params, correlationId });

  return withRetry(
    async () => {
      const res = await executeHttpRequest(
        { destinationName: dest },
        {
          method: 'GET',
          url: path,
          params,
          timeout,
          headers: {
            Accept: opts.accept || 'application/xml',
            'X-Correlation-ID': correlationId,
          },
        }
      );
      return opts.parseXml !== false ? parseXmlToBasicJson(res.data) : res.data;
    },
    { dest, path, correlationId }
  );
}

async function pipoGetJson(dest, path, params = {}, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const timeout = opts.timeout || CONFIG.timeout;

  LOG().debug(`[pipo] GET JSON ${dest}${path}`, { params, correlationId });

  return withRetry(
    async () => {
      const res = await executeHttpRequest(
        { destinationName: dest },
        {
          method: 'GET',
          url: path,
          params,
          timeout,
          headers: {
            Accept: 'application/json',
            'X-Correlation-ID': correlationId,
          },
        }
      );
      return res.data;
    },
    { dest, path, correlationId }
  );
}

async function pipoPost(dest, path, data, params = {}, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const timeout = opts.timeout || CONFIG.longTimeout;

  LOG().debug(`[pipo] POST ${dest}${path}`, { params, correlationId });

  return withRetry(
    async () => {
      const res = await executeHttpRequest(
        { destinationName: dest },
        {
          method: 'POST',
          url: path,
          data,
          params,
          timeout,
          headers: {
            'Content-Type': opts.contentType || 'application/xml',
            Accept: opts.accept || 'application/xml',
            'X-Correlation-ID': correlationId,
          },
        }
      );
      return opts.parseXml !== false ? parseXmlToBasicJson(res.data) : res.data;
    },
    { dest, path, correlationId }
  );
}

async function callIS(path, method = 'GET', data = null, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();
  const timeout = opts.timeout || CONFIG.timeout;

  LOG().debug(`[IS] ${method} ${path}`, { correlationId });

  return withRetry(
    async () => {
      const config = {
        method,
        url: path,
        timeout,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Correlation-ID': correlationId,
        },
      };
      if (data) config.data = data;
      const res = await executeHttpRequest({ destinationName: CONFIG.destinations.IS }, config);
      return res.data;
    },
    { dest: CONFIG.destinations.IS, path, correlationId }
  );
}

// Shorthand helpers
const dirQuery = (type, params, opts) => pipoGet(CONFIG.destinations.DIR, `/rep/query/ext/1/${type}`, params, opts);
const esrQuery = (type, params, opts) => pipoGet(CONFIG.destinations.ESR, `/rep/query/ext/1/${type}`, params, opts);
const dirRead = (type, params, opts) => pipoGet(CONFIG.destinations.DIR, `/rep/read/ext/1/${type}`, params, opts);
const esrRead = (type, params, opts) => pipoGet(CONFIG.destinations.ESR, `/rep/read/ext/1/${type}`, params, opts);
const dirSimpleQuery = (type, opts) =>
  pipoGet(CONFIG.destinations.DIR, `/rep/support/SimpleQuery?type=${type}&swcSelection=all`, {}, opts);
const esrSimpleQuery = (type, opts) =>
  pipoGet(CONFIG.destinations.ESR, `/rep/support/SimpleQuery?type=${type}&swcSelection=all`, {}, opts);

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLEXITY SCORING (TDD §4.1 — 8-factor score)
// ═══════════════════════════════════════════════════════════════════════════════

function scoreComplexity(artifact) {
  let score = 0;
  const factors = [];
  const a = JSON.stringify(artifact).toLowerCase();

  if (a.includes('ccbpm') || a.includes('bpm')) {
    score += 10;
    factors.push('BPM');
  }
  if (a.includes('java') || a.includes('abap')) {
    score += 6;
    factors.push('Custom Code');
  }
  if (a.includes('xslt')) {
    score += 3;
    factors.push('XSLT');
  }
  if (a.includes('as2') || a.includes('jms')) {
    score += 6;
    factors.push('AS2/JMS');
  }
  if (a.includes('jdbc') || a.includes('rfc')) {
    score += 3;
    factors.push('JDBC/RFC');
  }
  if (a.includes('edi') || a.includes('edifact')) {
    score += 4;
    factors.push('EDI');
  }
  if (a.includes('zfield') || a.includes('z_field')) {
    score += 4;
    factors.push('Z-Fields');
  }
  let tier;
  if (score >= 19) {
    tier = 'Complex';
  } else if (score >= 9) {
    tier = 'Medium';
  } else {
    tier = 'Simple';
  }
  return {
    score: Math.min(100, Math.round((score / 30) * 100)),
    tier,
    factors,
    rawScore: score,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// OBJECT TYPE REGISTRY
// ═══════════════════════════════════════════════════════════════════════════════

const PIPO_OBJECT_TYPES = {
  ESR: [
    'SoftwareComponentVersion',
    'MessageType',
    'DataType',
    'ServiceInterface',
    'MessageMapping',
    'OperationMapping',
    'InterfaceMapping',
  ],
  DIR: [
    'IntegratedConfiguration',
    'CommunicationChannel',
    'SenderAgreement',
    'ReceiverAgreement',
    'InterfaceDetermination',
    'ReceiverDetermination',
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY — GENERIC (with pagination)
// ═══════════════════════════════════════════════════════════════════════════════

async function discoverPipoArtifacts(repository, objectType, opts = {}) {
  const params = {};
  if (opts.namespace) params.namespace = opts.namespace;
  if (opts.swcv) params.softwareComponentVersion = opts.swcv;

  // Pagination support (PI/PO uses $skip/$top OData-style)
  if (opts.pageSize) params.$top = Math.min(opts.pageSize, CONFIG.maxPageSize);
  if (opts.offset) params.$skip = opts.offset;

  const query = repository === 'ESR' ? esrQuery : dirQuery;
  return query(objectType, params, { correlationId: opts.correlationId });
}

/**
 * Fetch ALL artifacts of a type with automatic pagination
 */
async function discoverAllArtifacts(repository, objectType, opts = {}) {
  const pageSize = opts.pageSize || CONFIG.defaultPageSize;
  const correlationId = opts.correlationId || randomUUID();
  const allResults = [];
  let offset = 0;
  let hasMore = true;

  LOG().info(`[discover] Starting paginated fetch of ${repository}/${objectType}`, { correlationId });

  const fetchPage = off =>
    discoverPipoArtifacts(repository, objectType, {
      ...opts,
      pageSize,
      offset: off,
      correlationId,
    });

  while (hasMore) {
    // eslint-disable-next-line no-await-in-loop
    const page = await fetchPage(offset);

    // Handle different response structures
    const items = Array.isArray(page) ? page : page.results || page.value || [page];
    allResults.push(...items);

    hasMore = items.length === pageSize;
    offset += pageSize;

    if (hasMore) {
      LOG().debug(`[discover] Fetched ${allResults.length} items, continuing...`, { correlationId });
    }
  }

  LOG().info(`[discover] Completed fetch of ${allResults.length} ${objectType} items`, { correlationId });
  return allResults;
}

async function assessComplexity(repository, objectType, name, namespace, opts = {}) {
  const params = { name, namespace };
  if (opts.swcv) params.softwareComponentVersion = opts.swcv;

  const readFn = repository === 'ESR' ? esrRead : dirRead;
  const artifact = await readFn(objectType, params, { correlationId: opts.correlationId });

  return {
    artifact,
    complexity: scoreComplexity(artifact),
    metadata: { repository, objectType, name, namespace },
  };
}

async function parseArtifact(repository, objectType, name, namespace, opts = {}) {
  const params = { name, namespace };
  if (opts.swcv) params.softwareComponentVersion = opts.swcv;

  const readFn = repository === 'ESR' ? esrRead : dirRead;
  return readFn(objectType, params, { correlationId: opts.correlationId, parseXml: opts.parseXml });
}

async function queryArtifacts(repo, objectType, opts = {}) {
  const queryFn = repo === 'DIR' ? dirSimpleQuery : esrSimpleQuery;
  return queryFn(objectType, { correlationId: opts.correlationId });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY — SPECIFIC
// ═══════════════════════════════════════════════════════════════════════════════

async function listPipoPackages(opts = {}) {
  const params = opts.name ? { name: opts.name } : {};
  return esrQuery('SoftwareComponentVersion', params, { correlationId: opts.correlationId });
}

async function listIcos(opts = {}) {
  if (opts.all) {
    return discoverAllArtifacts('DIR', 'IntegratedConfiguration', opts);
  }
  return dirQuery('IntegratedConfiguration', {}, { correlationId: opts.correlationId });
}

async function getIcoDefinition(name, namespace, opts = {}) {
  const params = { name, namespace };
  if (opts.swcv) params.softwareComponentVersion = opts.swcv;
  return dirRead('IntegratedConfiguration', params, {
    correlationId: opts.correlationId,
    timeout: CONFIG.longTimeout, // ICO definitions can be large
  });
}

async function getCommunicationChannels(opts = {}) {
  const params = {};
  if (opts.name) params.name = opts.name;
  if (opts.namespace) params.namespace = opts.namespace;
  if (opts.partyName) params.partyName = opts.partyName;
  if (opts.componentName) params.componentName = opts.componentName;

  const fn = opts.name ? dirRead : dirQuery;
  return fn('CommunicationChannel', params, { correlationId: opts.correlationId });
}

async function getOperationMappings(opts = {}) {
  const params = {};
  if (opts.name) params.name = opts.name;
  if (opts.namespace) params.namespace = opts.namespace;
  if (opts.swcv) params.softwareComponentVersion = opts.swcv;

  const fn = opts.name ? esrRead : esrQuery;
  return fn('OperationMapping', params, { correlationId: opts.correlationId });
}

async function getValueMappings(opts = {}) {
  const params = {};
  if (opts.name) params.name = opts.name;
  if (opts.namespace) params.namespace = opts.namespace;
  if (opts.swcv) params.softwareComponentVersion = opts.swcv;

  const fn = opts.name ? esrRead : esrQuery;
  return fn('ValueMappingGroup', params, { correlationId: opts.correlationId });
}

async function getMessageTypes(opts = {}) {
  const params = opts.namespace ? { namespace: opts.namespace } : {};
  return esrQuery('MessageType', params, { correlationId: opts.correlationId });
}

async function getDataTypes(opts = {}) {
  const params = opts.namespace ? { namespace: opts.namespace } : {};
  return esrQuery('DataType', params, { correlationId: opts.correlationId });
}

async function getServiceInterfaces(opts = {}) {
  const params = opts.namespace ? { namespace: opts.namespace } : {};
  return esrQuery('ServiceInterface', params, { correlationId: opts.correlationId });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MONITORING
// ═══════════════════════════════════════════════════════════════════════════════

async function getMessageProcessingLogs(opts = {}) {
  const params = {
    $top: opts.top || 50,
    $orderby: opts.orderby || 'LogEnd desc',
    $format: 'json',
  };
  if (opts.filter) params.$filter = opts.filter;

  return pipoGetJson(CONFIG.destinations.DIR, '/mdt/api/1.0/MessageProcessingLogs', params, {
    correlationId: opts.correlationId,
  });
}

async function getErrorLogs(opts = {}) {
  return getMessageProcessingLogs({
    ...opts,
    filter: "Status eq 'FAILED' or Status eq 'ERROR'",
  });
}

async function getPipoMessageLogs(messageId, opts = {}) {
  return pipoGetJson(
    CONFIG.destinations.DIR,
    `/mdt/api/1.0/MessageProcessingLogs('${encodeURIComponent(messageId)}')/MessageProcessingLogRuns`,
    { $format: 'json' },
    { correlationId: opts.correlationId }
  );
}

async function executeIflowTest(icoName, icoNamespace, xmlPayload, opts = {}) {
  return pipoPost(
    CONFIG.destinations.DIR,
    '/rep/test/ext/1/MessageTest',
    xmlPayload,
    { name: icoName, namespace: icoNamespace },
    { correlationId: opts.correlationId, timeout: CONFIG.longTimeout }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION SUITE DEPLOYMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function listIsPackages(opts = {}) {
  return callIS('/api/v1/IntegrationPackages', 'GET', null, { correlationId: opts.correlationId });
}

async function listIsArtifacts(packageId, opts = {}) {
  return callIS(`/api/v1/IntegrationPackages('${packageId}')/IntegrationDesigntimeArtifacts`, 'GET', null, {
    correlationId: opts.correlationId,
  });
}

async function createIntegrationPackage(packageData, opts = {}) {
  return callIS('/api/v1/IntegrationPackages', 'POST', packageData, {
    correlationId: opts.correlationId,
  });
}

async function deployIntegrationFlow(packageId, iflowId, iflowContent, opts = {}) {
  const correlationId = opts.correlationId || randomUUID();

  const artifact = {
    Id: iflowId,
    PackageId: packageId,
    Name: iflowId,
    ArtifactContent: Buffer.from(JSON.stringify(iflowContent)).toString('base64'),
  };

  LOG().info(`[IS] Deploying iFlow ${iflowId} to package ${packageId}`, { correlationId });

  await callIS('/api/v1/IntegrationDesigntimeArtifacts', 'POST', artifact, {
    correlationId,
    timeout: CONFIG.longTimeout,
  });

  return callIS(`/api/v1/DeployIntegrationDesigntimeArtifact?Id='${iflowId}'&Version='active'`, 'POST', null, {
    correlationId,
    timeout: CONFIG.longTimeout,
  });
}

async function getDeploymentStatus(artifactId, opts = {}) {
  return callIS(`/api/v1/IntegrationRuntimeArtifacts('${artifactId}')`, 'GET', null, {
    correlationId: opts.correlationId,
  });
}

async function undeployArtifact(artifactId, opts = {}) {
  LOG().info(`[IS] Undeploying artifact ${artifactId}`, { correlationId: opts.correlationId });
  return callIS(`/api/v1/IntegrationRuntimeArtifacts('${artifactId}')`, 'DELETE', null, {
    correlationId: opts.correlationId,
  });
}

async function getRuntimeStatus(params = {}, opts = {}) {
  const query = new URLSearchParams(params).toString();
  const path =
    query.length > 0 ? `/api/v1/IntegrationRuntimeArtifacts?${query}` : '/api/v1/IntegrationRuntimeArtifacts';
  return callIS(path, 'GET', null, { correlationId: opts.correlationId });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK & DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the correct SOAP WSDL URL for a PI/PO service
 * @param {string} serviceType - e.g. 'CommunicationChannel', 'IntegratedConfiguration'
 * @returns {string} The WSDL URL path (append ?wsdl for WSDL, use as-is for SOAP calls)
 */
function getSoapEndpoint(serviceType) {
  const endpoint = CONFIG.soapEndpoints[serviceType];
  if (!endpoint) {
    throw new PipoClientError(`Unknown SOAP service type: ${serviceType}`, {
      availableTypes: Object.keys(CONFIG.soapEndpoints),
    });
  }
  return endpoint;
}

/**
 * Get WSDL URL for a PI/PO SOAP service
 * @param {string} serviceType - e.g. 'CommunicationChannel', 'IntegratedConfiguration'
 * @returns {string} The full WSDL URL path
 */
function getSoapWsdlUrl(serviceType) {
  return getSoapEndpoint(serviceType) + '?wsdl';
}

/**
 * Fetch WSDL for a SOAP service
 * @param {string} serviceType - e.g. 'CommunicationChannel'
 * @param {object} opts - { correlationId }
 */
async function fetchSoapWsdl(serviceType, opts = {}) {
  const wsdlPath = getSoapWsdlUrl(serviceType);
  const dest = ['MessageMapping', 'OperationMapping', 'InterfaceMapping'].includes(serviceType)
    ? CONFIG.destinations.ESR
    : CONFIG.destinations.DIR;

  return pipoGet(
    dest,
    wsdlPath,
    {},
    {
      correlationId: opts.correlationId,
      accept: 'application/xml, text/xml',
    }
  );
}

async function checkDestinationHealth(name, dest) {
  try {
    const start = Date.now();
    if (name === 'IS') {
      await callIS('/api/v1/IntegrationPackages?$top=1', 'GET', null, { timeout: 5000 });
    } else {
      await pipoGet(
        dest,
        '/rep/support/SimpleQuery?type=SoftwareComponentVersion&swcSelection=all',
        {},
        { timeout: 5000 }
      );
    }
    return { status: 'OK', latencyMs: Date.now() - start, circuitState: circuitState[dest]?.state || 'N/A' };
  } catch (error) {
    return { status: 'ERROR', error: error.message, circuitState: circuitState[dest]?.state || 'N/A' };
  }
}

async function checkHealth() {
  const results = {
    timestamp: new Date().toISOString(),
    destinations: {},
  };

  await Promise.all(
    Object.entries(CONFIG.destinations).map(async ([name, dest]) => {
      results.destinations[name] = await checkDestinationHealth(name, dest);
    })
  );

  return results;
}

function getCircuitStatus() {
  return { ...circuitState };
}

function resetCircuit(dest) {
  if (circuitState[dest]) {
    circuitState[dest] = { failures: 0, lastFailure: null, state: 'CLOSED' };
    LOG().info(`[circuit] ${dest} manually reset to CLOSED`);
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Configuration
  CONFIG,

  // Error class
  PipoClientError,

  // Generic discovery
  discoverPipoArtifacts,
  discoverAllArtifacts,
  assessComplexity,
  parseArtifact,
  queryArtifacts,
  scoreComplexity,
  PIPO_OBJECT_TYPES,

  // PI/PO specific discovery
  listPipoPackages,
  listIcos,
  getIcoDefinition,
  getCommunicationChannels,
  getOperationMappings,
  getValueMappings,
  getMessageTypes,
  getDataTypes,
  getServiceInterfaces,

  // PI/PO monitoring
  getMessageProcessingLogs,
  getErrorLogs,
  getPipoMessageLogs,
  executeIflowTest,

  // Integration Suite deployment
  listIsPackages,
  listIsArtifacts,
  createIntegrationPackage,
  deployIntegrationFlow,
  getDeploymentStatus,
  undeployArtifact,
  getRuntimeStatus,

  // Health & diagnostics
  checkHealth,
  getCircuitStatus,
  resetCircuit,

  // SOAP service helpers (use these for correct WSDL URLs)
  getSoapEndpoint,
  getSoapWsdlUrl,
  fetchSoapWsdl,
};
