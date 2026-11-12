'use strict';

/**
 * PI/PO Discovery & Integration Suite Deployment Client
 *
 * Full chain (handled automatically by @sap-cloud-sdk/http-client):
 *   sdaintai -> AICONX-destination -> AICONX-connectivity -> Cloud Connector -> pj2sda.consultsda.com:50000
 *
 * Destinations (ProxyType=OnPremise, BasicAuthentication):
 *   PO_PJ2_DIR  — Integration Directory  (/rep/query|read/ext/1/*, /mdt/api/1.0/*)
 *   PO_PJ2_ESR  — Enterprise Svc Repo    (/rep/query|read/ext/1/*)
 *   IS_API      — Integration Suite      (/api/v1/*)
 */

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

// BUG-M4 & DRY-3 fix: Import from constants and use standard logger pattern
const { Destinations, Timeouts } = require('./constants');
const { scoreComplexity } = require('./complexityScorer');

// Destination names from constants
const DIR_DEST = Destinations.DIR;
const ESR_DEST = Destinations.ESR;
const IS_DEST = Destinations.IS_API;

// DRY-3 fix: Standard logger initialization
const LOG = cds.log('pipo-client');

// ═══════════════════════════════════════════════════════════════════════════════
// CORE HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function pipoGet(dest, path, params = {}) {
  LOG.debug(`[pipo] GET ${dest}${path}`, params);
  const res = await executeHttpRequest(
    { destinationName: dest },
    { method: 'GET', url: path, params, headers: { Accept: 'application/xml' }, timeout: Timeouts.DEFAULT }
  );
  return res.data;
}

async function pipoGetJson(dest, path, params = {}) {
  LOG.debug(`[pipo] GET JSON ${dest}${path}`, params);
  const res = await executeHttpRequest(
    { destinationName: dest },
    { method: 'GET', url: path, params, headers: { Accept: 'application/json' }, timeout: Timeouts.DEFAULT }
  );
  return res.data;
}

async function pipoPost(dest, path, data, params = {}) {
  LOG.debug(`[pipo] POST ${dest}${path}`, params);
  const res = await executeHttpRequest(
    { destinationName: dest },
    {
      method: 'POST',
      url: path,
      data,
      params,
      headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
      timeout: Timeouts.DEFAULT,
    }
  );
  return res.data;
}

async function callIS(path, method = 'GET', data = null) {
  LOG.debug(`[IS] ${method} ${path}`);
  const config = { method, url: path, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } };
  if (data) config.data = data;
  const res = await executeHttpRequest({ destinationName: IS_DEST }, config);
  return res.data;
}

// Shorthand helpers for query/read APIs
const dirQuery = (type, params) => pipoGet(DIR_DEST, `/rep/query/ext/1/${type}`, params);
const esrQuery = (type, params) => pipoGet(ESR_DEST, `/rep/query/ext/1/${type}`, params);
const dirRead = (type, params) => pipoGet(DIR_DEST, `/rep/read/ext/1/${type}`, params);
const esrRead = (type, params) => pipoGet(ESR_DEST, `/rep/read/ext/1/${type}`, params);

// Simple Query API (alternative, returns HTML form with data)
const dirSimpleQuery = type => pipoGet(DIR_DEST, `/rep/support/SimpleQuery?type=${type}&swcSelection=all`);
const esrSimpleQuery = type => pipoGet(ESR_DEST, `/rep/support/SimpleQuery?type=${type}&swcSelection=all`);

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLEXITY SCORING (TDD §4.1 — 8-factor score)
// ═══════════════════════════════════════════════════════════════════════════════
// COMPLEXITY SCORING (DRY-2 fix: Use centralized complexityScorer module)
// scoreComplexity is imported from ./complexityScorer at the top of this file
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// PI/PO DISCOVERY - Generic Functions
// ═══════════════════════════════════════════════════════════════════════════════

// Object types supported
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

/**
 * Lists artifacts of any type from ESR or DIR.
 * @param {'ESR'|'DIR'} repository
 * @param {string} objectType  e.g. 'IntegratedConfiguration', 'MessageInterface'
 * @param {object} [opts]      { namespace, swcv }
 */
async function discoverPipoArtifacts(repository, objectType, opts = {}) {
  const params = {};
  if (opts.namespace) params.namespace = opts.namespace;
  if (opts.swcv) params.softwareComponentVersion = opts.swcv;
  return repository === 'ESR' ? esrQuery(objectType, params) : dirQuery(objectType, params);
}

/**
 * Fetches a single artifact and scores its migration complexity.
 */
async function assessComplexity(repository, objectType, name, namespace, opts = {}) {
  const params = { name, namespace };
  if (opts.swcv) params.softwareComponentVersion = opts.swcv;
  const artifact = repository === 'ESR' ? await esrRead(objectType, params) : await dirRead(objectType, params);
  return { artifact, complexity: scoreComplexity(artifact) };
}

/**
 * Reads and returns the full definition of a single artifact.
 */
async function parseArtifact(repository, objectType, name, namespace, opts = {}) {
  const params = { name, namespace };
  if (opts.swcv) params.softwareComponentVersion = opts.swcv;
  return repository === 'ESR' ? esrRead(objectType, params) : dirRead(objectType, params);
}

/**
 * Generic query for any object type (via Simple Query API)
 */
async function queryArtifacts(repo, objectType, params = {}) {
  return repo === 'DIR' ? dirSimpleQuery(objectType) : esrSimpleQuery(objectType);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PI/PO DISCOVERY - Specific Functions
// ═══════════════════════════════════════════════════════════════════════════════

/** Lists all software component versions (packages) in ESR */
async function listPipoPackages(opts = {}) {
  return esrQuery('SoftwareComponentVersion', opts.name ? { name: opts.name } : {});
}

/** Lists all ICOs from DIR */
async function listIcos(opts = {}) {
  return dirQuery('IntegratedConfiguration', {});
}

/** Fetches the full ICO definition from DIR */
async function getIcoDefinition(name, namespace, opts = {}) {
  const params = { name, namespace };
  if (opts.swcv) params.softwareComponentVersion = opts.swcv;
  return dirRead('IntegratedConfiguration', params);
}

/** Lists or fetches communication channels from DIR */
async function getCommunicationChannels(opts = {}) {
  const params = {};
  if (opts.name) params.name = opts.name;
  if (opts.namespace) params.namespace = opts.namespace;
  if (opts.partyName) params.partyName = opts.partyName;
  if (opts.componentName) params.componentName = opts.componentName;
  return opts.name ? dirRead('CommunicationChannel', params) : dirQuery('CommunicationChannel', params);
}

/** Lists or fetches operation mappings from ESR */
async function getOperationMappings(opts = {}) {
  const params = {};
  if (opts.name) params.name = opts.name;
  if (opts.namespace) params.namespace = opts.namespace;
  if (opts.swcv) params.softwareComponentVersion = opts.swcv;
  return opts.name ? esrRead('OperationMapping', params) : esrQuery('OperationMapping', params);
}

/** Lists or fetches value mapping groups from ESR */
async function getValueMappings(opts = {}) {
  const params = {};
  if (opts.name) params.name = opts.name;
  if (opts.namespace) params.namespace = opts.namespace;
  if (opts.swcv) params.softwareComponentVersion = opts.swcv;
  return opts.name ? esrRead('ValueMappingGroup', params) : esrQuery('ValueMappingGroup', params);
}

/** Lists message types from ESR */
async function getMessageTypes(opts = {}) {
  return esrQuery('MessageType', {});
}

/** Lists data types from ESR */
async function getDataTypes(opts = {}) {
  return esrQuery('DataType', {});
}

/** Lists service interfaces from ESR */
async function getServiceInterfaces(opts = {}) {
  return esrQuery('ServiceInterface', {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// PI/PO MONITORING
// ═══════════════════════════════════════════════════════════════════════════════

/** Fetches message processing logs from PI/PO monitoring */
async function getMessageProcessingLogs(opts = {}) {
  const params = {
    $top: opts.top || 50,
    $orderby: opts.orderby || 'LogEnd desc',
    $format: 'json',
  };
  if (opts.filter) params['$filter'] = opts.filter;
  return pipoGetJson(DIR_DEST, '/mdt/api/1.0/MessageProcessingLogs', params);
}

/** Fetches only FAILED / ERROR logs from PI/PO monitoring */
async function getErrorLogs(opts = {}) {
  return getMessageProcessingLogs({
    ...opts,
    filter: "Status eq 'FAILED' or Status eq 'ERROR'",
  });
}

/** Fetches detailed run entries for a specific PI/PO message GUID */
async function getPipoMessageLogs(messageId) {
  return pipoGetJson(
    DIR_DEST,
    `/mdt/api/1.0/MessageProcessingLogs('${encodeURIComponent(messageId)}')/MessageProcessingLogRuns`,
    { $format: 'json' }
  );
}

/** Triggers a test message on a PI/PO ICO */
async function executeIflowTest(icoName, icoNamespace, xmlPayload) {
  return pipoPost(DIR_DEST, '/rep/test/ext/1/MessageTest', xmlPayload, {
    name: icoName,
    namespace: icoNamespace,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION SUITE DEPLOYMENT (Target System)
// ═══════════════════════════════════════════════════════════════════════════════

/** Create integration package in IS */
async function createIntegrationPackage(packageData) {
  return callIS('/api/v1/IntegrationPackages', 'POST', packageData);
}

/** Deploy integration flow to IS */
async function deployIntegrationFlow(packageId, iflowId, iflowContent) {
  const artifact = {
    Id: iflowId,
    PackageId: packageId,
    Name: iflowId,
    ArtifactContent: Buffer.from(JSON.stringify(iflowContent)).toString('base64'),
  };
  await callIS('/api/v1/IntegrationDesigntimeArtifacts', 'POST', artifact);
  return callIS(`/api/v1/DeployIntegrationDesigntimeArtifact?Id='${iflowId}'&Version='active'`, 'POST');
}

/** Get deployment status from IS */
async function getDeploymentStatus(artifactId) {
  return callIS(`/api/v1/IntegrationRuntimeArtifacts('${artifactId}')`);
}

/** Undeploy artifact from IS */
async function undeployArtifact(artifactId) {
  return callIS(`/api/v1/IntegrationRuntimeArtifacts('${artifactId}')`, 'DELETE');
}

/** Get runtime status from IS */
async function getRuntimeStatus(params = {}) {
  const query = new URLSearchParams(params).toString();
  return callIS('/api/v1/IntegrationRuntimeArtifacts' + (query ? '?' + query : ''));
}

/** List all packages from IS */
async function listIsPackages() {
  return callIS('/api/v1/IntegrationPackages');
}

/** List artifacts in an IS package */
async function listIsArtifacts(packageId) {
  return callIS(`/api/v1/IntegrationPackages('${packageId}')/IntegrationDesigntimeArtifacts`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Generic discovery
  discoverPipoArtifacts,
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
  createIntegrationPackage,
  deployIntegrationFlow,
  getDeploymentStatus,
  undeployArtifact,
  getRuntimeStatus,
  listIsPackages,
  listIsArtifacts,
};
