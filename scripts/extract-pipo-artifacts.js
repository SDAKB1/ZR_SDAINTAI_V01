#!/usr/bin/env node
'use strict';
/**
 * PI/PO 7.50 Full Artifact Extraction Script
 *
 * Extracts ALL artifacts from a PI/PO system via BTP destinations.
 * Supports all 23 endpoints for complete migration assessment.
 *
 * Usage:
 *   node scripts/extract-pipo-artifacts.js
 *
 * Prerequisites:
 *   - BTP destinations PO_PJ2_DIR and PO_PJ2_ESR configured
 *   - Cloud Connector tunnel active
 *   - Required roles assigned in PI/PO system
 */

const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

// Lazy load SAP Cloud SDK - may not be available in standalone mode
let executeHttpRequest = null;

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const DESTINATION_DIR = process.env.PIPO_DIR_DESTINATION || 'PO_PJ2_DIR';
const DESTINATION_ESR = process.env.PIPO_ESR_DESTINATION || 'PO_PJ2_ESR';

const OUTPUT_BASE_DIR = path.join(
  process.cwd(),
  'data',
  'pipo-extraction'
);

// SOAP Service Endpoints (Directory API)
const SOAP_SERVICES = {
  // Standard Directory Services
  IntegratedConfiguration: '/IntegratedConfigurationInService/IntegratedConfigurationInImplBean',
  IntegratedConfiguration750: '/IntegratedConfiguration750InService/IntegratedConfiguration750InImplBean',
  CommunicationChannel: '/CommunicationChannelInService/CommunicationChannelInImplBean',
  SenderAgreement: '/SenderAgreementInService/SenderAgreementInImplBean',
  ReceiverAgreement: '/ReceiverAgreementInService/ReceiverAgreementInImplBean',
  ReceiverDetermination: '/ReceiverDeterminationInService/ReceiverDeterminationInImplBean',
  InterfaceDetermination: '/InterfaceDeterminationInService/InterfaceDeterminationInImplBean',
  ReceiverRule: '/ReceiverRuleInService/ReceiverRuleInImplBean',
  ValueMapping: '/ValueMappingInService/ValueMappingInImplBean',
  ConfigurationScenario: '/ConfigurationScenarioInService/ConfigurationScenarioInImplBean',
  BusinessComponent: '/BusinessComponentInService/BusinessComponentInImplBean',
  BusinessSystem: '/BusinessSystemInService/BusinessSystemInImplBean',
  Party: '/PartyInService/PartyInImplBean',
  AlertRule: '/AlertRuleInService/AlertRuleInImplBean',
  IntegrationProcess: '/IntegrationProcessInService/IntegrationProcessInImplBean',
  BPMFacade: '/BPMFacadeBeanImplService',
};

// ESR Endpoints
const ESR_ENDPOINTS = {
  simpleQuery: '/rep/support/SimpleQuery',
  queryExt: '/rep/query/ext',
  queryInt: '/rep/query/int',
  readExt: '/rep/read/ext',
};

// Directory Read/Query Endpoints (alternative to SOAP services)
const DIR_ENDPOINTS = {
  queryExt: '/dir/query/ext',
  readExt: '/dir/read/ext',
};

// ESR Object Types for extraction
const ESR_OBJECT_TYPES = [
  'SoftwareComponentVersion',
  'ServiceInterface',
  'MessageMapping',
  'OperationMapping',
  'DataType',
  'ExternalDefinition',
  'FunctionLibrary',
  'ImportedArchive',
];

// Runtime/Monitoring Endpoints
const RUNTIME_ENDPOINTS = {
  channelAdmin: '/AdapterFramework/ChannelAdminServlet',
  cpaCache: '/CPACache',
  mdt: '/mdt',
};

// XML Namespaces
const XI_NAMESPACE = 'http://sap.com/xi/BASIS';

// Timeouts
const DEFAULT_TIMEOUT = 60000;
const LONG_TIMEOUT = 180000;

// ═══════════════════════════════════════════════════════════════════════════════
// XML PARSER SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const xmlParser = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: false,
  tagNameProcessors: [xml2js.processors.stripPrefix],
});

function parseXml(xml) {
  return new Promise((resolve, reject) => {
    xmlParser.parseString(xml, (err, result) => {
      if (err) reject(new Error(`XML parse error: ${err.message}`));
      else resolve(result);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

async function initializeHttpClient() {
  if (executeHttpRequest) return;

  try {
    const httpClientModule = require('@sap-cloud-sdk/http-client');
    executeHttpRequest = httpClientModule.executeHttpRequest;
    console.log('✓ SAP Cloud SDK HTTP client loaded');
  } catch (e) {
    console.warn('⚠ SAP Cloud SDK not available - using mock mode');
    // Mock for standalone testing
    executeHttpRequest = async (dest, config) => {
      throw new Error(`Mock mode: Cannot execute real request to ${dest.destinationName}${config.url}`);
    };
  }
}

async function httpRequest(destinationName, path, method = 'GET', data = null, headers = {}, timeout = DEFAULT_TIMEOUT) {
  const config = {
    method,
    url: path,
    headers: {
      Accept: 'application/xml, text/xml, */*',
      ...headers,
    },
    timeout,
  };

  if (data) {
    config.data = data;
    config.headers['Content-Type'] = headers['Content-Type'] || 'text/xml; charset=utf-8';
  }

  try {
    const response = await executeHttpRequest({ destinationName }, config);
    return response;
  } catch (error) {
    const statusCode = error.response?.status || error.code || 'UNKNOWN';
    const message = error.response?.data || error.message;
    throw new Error(`Request failed [${statusCode}]: ${message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOAP CLIENT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function buildSoapEnvelope(operation, namespace, body = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${namespace}">
  <soapenv:Header/>
  <soapenv:Body>
    <ns:${operation}>
      ${body}
    </ns:${operation}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function soapCall(destinationName, servicePath, operation, namespace, body = '', timeout = DEFAULT_TIMEOUT) {
  const envelope = buildSoapEnvelope(operation, namespace, body);
  const soapAction = `${namespace}/${operation}`;

  const response = await httpRequest(
    destinationName,
    servicePath,
    'POST',
    envelope,
    {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: soapAction,
    },
    timeout
  );

  const parsed = await parseXml(response.data);

  // Extract SOAP body
  const soapBody = parsed?.Envelope?.Body;
  if (!soapBody) {
    throw new Error('Invalid SOAP response: missing Body element');
  }

  // Check for SOAP fault
  if (soapBody.Fault) {
    const faultString = soapBody.Fault.faultstring || soapBody.Fault.faultString || 'Unknown SOAP fault';
    throw new Error(`SOAP Fault: ${faultString}`);
  }

  return soapBody;
}

function extractQueryResponse(soapBody, responseElement) {
  const response = soapBody[responseElement];
  if (!response) {
    return [];
  }

  // Find the items array (varies by response type)
  const possibleKeys = [
    'IntegratedConfiguration',
    'IntegratedConfiguration750',
    'CommunicationChannel',
    'SenderAgreement',
    'ReceiverAgreement',
    'ReceiverDetermination',
    'InterfaceDetermination',
    'ReceiverRule',
    'ValueMappingGroup',
    'ValueMapping',
    'ConfigurationScenario',
    'BusinessComponent',
    'BusinessSystem',
    'Party',
    'AlertRule',
    'IntegrationProcess',
    'Item',
    'item',
  ];

  for (const key of possibleKeys) {
    if (response[key]) {
      const items = response[key];
      return Array.isArray(items) ? items : [items];
    }
  }

  return [];
}

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIRECTORY API QUERY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function queryIntegratedConfigurations() {
  console.log('  Querying Integrated Configurations (standard)...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.IntegratedConfiguration,
    'IntegratedConfigurationQueryRequest',
    XI_NAMESPACE,
    '',
    LONG_TIMEOUT
  );
  return extractQueryResponse(body, 'IntegratedConfigurationQueryResponse');
}

async function queryIntegratedConfigurations750() {
  console.log('  Querying Integrated Configurations (7.50)...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.IntegratedConfiguration750,
    'IntegratedConfiguration750QueryRequest',
    XI_NAMESPACE,
    '',
    LONG_TIMEOUT
  );
  return extractQueryResponse(body, 'IntegratedConfiguration750QueryResponse');
}

async function queryCommunicationChannels() {
  console.log('  Querying Communication Channels...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.CommunicationChannel,
    'CommunicationChannelQueryRequest',
    XI_NAMESPACE,
    '',
    LONG_TIMEOUT
  );
  return extractQueryResponse(body, 'CommunicationChannelQueryResponse');
}

async function querySenderAgreements() {
  console.log('  Querying Sender Agreements...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.SenderAgreement,
    'SenderAgreementQueryRequest',
    XI_NAMESPACE
  );
  return extractQueryResponse(body, 'SenderAgreementQueryResponse');
}

async function queryReceiverAgreements() {
  console.log('  Querying Receiver Agreements...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.ReceiverAgreement,
    'ReceiverAgreementQueryRequest',
    XI_NAMESPACE
  );
  return extractQueryResponse(body, 'ReceiverAgreementQueryResponse');
}

async function queryReceiverDeterminations() {
  console.log('  Querying Receiver Determinations...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.ReceiverDetermination,
    'ReceiverDeterminationQueryRequest',
    XI_NAMESPACE,
    '',
    LONG_TIMEOUT
  );
  return extractQueryResponse(body, 'ReceiverDeterminationQueryResponse');
}

async function queryInterfaceDeterminations() {
  console.log('  Querying Interface Determinations...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.InterfaceDetermination,
    'InterfaceDeterminationQueryRequest',
    XI_NAMESPACE,
    '',
    LONG_TIMEOUT
  );
  return extractQueryResponse(body, 'InterfaceDeterminationQueryResponse');
}

async function queryReceiverRules() {
  console.log('  Querying Receiver Rules...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.ReceiverRule,
    'ReceiverRuleQueryRequest',
    XI_NAMESPACE
  );
  return extractQueryResponse(body, 'ReceiverRuleQueryResponse');
}

async function queryValueMappings() {
  console.log('  Querying Value Mappings...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.ValueMapping,
    'ValueMappingQueryRequest',
    XI_NAMESPACE
  );
  return extractQueryResponse(body, 'ValueMappingQueryResponse');
}

async function queryConfigurationScenarios() {
  console.log('  Querying Configuration Scenarios...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.ConfigurationScenario,
    'ConfigurationScenarioQueryRequest',
    XI_NAMESPACE,
    '',
    LONG_TIMEOUT
  );
  return extractQueryResponse(body, 'ConfigurationScenarioQueryResponse');
}

async function queryBusinessComponents() {
  console.log('  Querying Business Components...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.BusinessComponent,
    'BusinessComponentQueryRequest',
    XI_NAMESPACE
  );
  return extractQueryResponse(body, 'BusinessComponentQueryResponse');
}

async function queryBusinessSystems() {
  console.log('  Querying Business Systems...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.BusinessSystem,
    'BusinessSystemQueryRequest',
    XI_NAMESPACE
  );
  return extractQueryResponse(body, 'BusinessSystemQueryResponse');
}

async function queryParties() {
  console.log('  Querying Parties...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.Party,
    'PartyQueryRequest',
    XI_NAMESPACE
  );
  return extractQueryResponse(body, 'PartyQueryResponse');
}

async function queryAlertRules() {
  console.log('  Querying Alert Rules...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.AlertRule,
    'AlertRuleQueryRequest',
    XI_NAMESPACE
  );
  return extractQueryResponse(body, 'AlertRuleQueryResponse');
}

async function queryIntegrationProcesses() {
  console.log('  Querying Integration Processes (BPM)...');
  const body = await soapCall(
    DESTINATION_DIR,
    SOAP_SERVICES.IntegrationProcess,
    'IntegrationProcessQueryRequest',
    XI_NAMESPACE,
    '',
    LONG_TIMEOUT
  );
  return extractQueryResponse(body, 'IntegrationProcessQueryResponse');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ESR API QUERY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function queryEsrSimple(objectType) {
  console.log(`  Querying ESR ${objectType}...`);
  const path = `${ESR_ENDPOINTS.simpleQuery}?type=${objectType}&swcSelection=all`;

  const response = await httpRequest(
    DESTINATION_ESR,
    path,
    'GET',
    null,
    { Accept: 'text/html, application/xml, */*' },
    LONG_TIMEOUT
  );

  return parseSimpleQueryResponse(response.data, objectType);
}

async function queryEsrExt(objectType) {
  console.log(`  Querying ESR ${objectType} (ext API)...`);
  const path = `${ESR_ENDPOINTS.queryExt}/${objectType}`;

  try {
    const response = await httpRequest(
      DESTINATION_ESR,
      path,
      'GET',
      null,
      { Accept: 'application/xml' },
      LONG_TIMEOUT
    );

    const parsed = await parseXml(response.data);
    return extractEsrQueryResponse(parsed, objectType);
  } catch (e) {
    // Fall back to Simple Query
    console.log(`    Falling back to SimpleQuery for ${objectType}...`);
    return queryEsrSimple(objectType);
  }
}

function parseSimpleQueryResponse(html, objectType) {
  // Simple Query can return either HTML table or XML
  if (html.includes('<?xml')) {
    return parseXml(html).then(parsed => extractEsrQueryResponse(parsed, objectType));
  }

  // Parse HTML table response
  const items = [];
  const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gs;
  const cellRegex = /<td[^>]*>(.*?)<\/td>/gs;

  let match;
  let isHeader = true;
  const headers = [];

  while ((match = rowRegex.exec(html)) !== null) {
    const rowHtml = match[1];
    const cells = [];
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }

    if (isHeader && cells.length > 0) {
      headers.push(...cells);
      isHeader = false;
    } else if (cells.length > 0) {
      const item = {};
      cells.forEach((cell, i) => {
        if (headers[i]) {
          item[headers[i]] = cell;
        }
      });
      if (Object.keys(item).length > 0) {
        items.push(item);
      }
    }
  }

  return items;
}

function extractEsrQueryResponse(parsed, objectType) {
  const root = parsed?.rws?.response || parsed?.response || parsed;
  const items = root?.[objectType] || root?.item || root?.Item || [];
  return Array.isArray(items) ? items : items ? [items] : [];
}

async function querySoftwareComponentVersions() {
  return queryEsrSimple('SoftwareComponentVersion');
}

async function queryServiceInterfaces() {
  return queryEsrSimple('ServiceInterface');
}

async function queryMessageMappings() {
  return queryEsrSimple('MessageMapping');
}

async function queryOperationMappings() {
  return queryEsrSimple('OperationMapping');
}

async function queryDataTypes() {
  return queryEsrSimple('DataType');
}

async function queryExternalDefinitions() {
  return queryEsrSimple('ExternalDefinition');
}

async function queryFunctionLibraries() {
  return queryEsrSimple('FunctionLibrary');
}

async function queryImportedArchives() {
  return queryEsrSimple('ImportedArchive');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ESR INTERNAL QUERY API (/rep/query/int)
// ═══════════════════════════════════════════════════════════════════════════════

async function queryEsrInt(objectType) {
  console.log(`  Querying ESR ${objectType} (int API)...`);
  const queryPath = `${ESR_ENDPOINTS.queryInt}/${objectType}`;

  try {
    const response = await httpRequest(
      DESTINATION_ESR,
      queryPath,
      'GET',
      null,
      { Accept: 'application/xml' },
      LONG_TIMEOUT
    );

    const parsed = await parseXml(response.data);
    return extractEsrQueryResponse(parsed, objectType);
  } catch (e) {
    console.log(`    /rep/query/int not available for ${objectType}: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIRECTORY HTTP ENDPOINTS (/dir/query/ext, /dir/read/ext)
// ═══════════════════════════════════════════════════════════════════════════════

async function queryDirExt(objectType) {
  console.log(`  Querying Directory ${objectType} via /dir/query/ext...`);
  const queryPath = `${DIR_ENDPOINTS.queryExt}/${objectType}`;

  try {
    const response = await httpRequest(
      DESTINATION_DIR,
      queryPath,
      'GET',
      null,
      { Accept: 'application/xml' },
      LONG_TIMEOUT
    );

    const parsed = await parseXml(response.data);
    return extractDirQueryResponse(parsed, objectType);
  } catch (e) {
    console.log(`    /dir/query/ext not available for ${objectType}: ${e.message}`);
    return null;
  }
}

async function readDirExt(objectType, objectKey) {
  console.log(`  Reading Directory ${objectType}/${objectKey} via /dir/read/ext...`);
  const keyParam = encodeURIComponent(objectKey);
  const readPath = `${DIR_ENDPOINTS.readExt}/${objectType}/${keyParam}`;

  try {
    const response = await httpRequest(
      DESTINATION_DIR,
      readPath,
      'GET',
      null,
      { Accept: 'application/xml' },
      LONG_TIMEOUT
    );

    return await parseXml(response.data);
  } catch (e) {
    console.log(`    /dir/read/ext failed for ${objectType}/${objectKey}: ${e.message}`);
    return null;
  }
}

function extractDirQueryResponse(parsed, objectType) {
  const root = parsed?.rws?.response || parsed?.response || parsed;
  const items = root?.[objectType] || root?.item || root?.Item || [];
  return Array.isArray(items) ? items : items ? [items] : [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// BPM FACADE SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

async function queryBpmFacade() {
  console.log('  Querying BPM Facade...');
  try {
    // BPM Facade may use different operations - try common ones
    const body = await soapCall(
      DESTINATION_DIR,
      SOAP_SERVICES.BPMFacade,
      'QueryRequest',
      XI_NAMESPACE,
      '',
      LONG_TIMEOUT
    );
    return body;
  } catch (e) {
    // Try alternative operation name
    try {
      const response = await httpRequest(
        DESTINATION_DIR,
        SOAP_SERVICES.BPMFacade + '?wsdl',
        'GET',
        null,
        { Accept: 'application/xml, text/xml' }
      );
      return { wsdlAvailable: true, wsdlLength: response.data?.length || 0 };
    } catch (e2) {
      throw new Error(`BPM Facade query failed: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUNTIME/MONITORING ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchChannelStatus() {
  console.log('  Fetching Channel Admin status...');
  try {
    const response = await httpRequest(
      DESTINATION_DIR,
      RUNTIME_ENDPOINTS.channelAdmin,
      'GET',
      null,
      { Accept: 'text/html, application/xml, */*' }
    );
    return parseChannelAdminResponse(response.data);
  } catch (e) {
    throw new Error(`Channel Admin fetch failed: ${e.message}`);
  }
}

function parseChannelAdminResponse(html) {
  // Channel Admin servlet returns HTML with channel status information
  const channels = [];

  // Look for channel status patterns in HTML
  const channelPattern = /Channel\s+([^\s<]+)\s+.*?(Started|Stopped|Error)/gi;
  let match;
  while ((match = channelPattern.exec(html)) !== null) {
    channels.push({
      channelId: match[1],
      status: match[2],
    });
  }

  // If pattern matching fails, return raw structure indicator
  if (channels.length === 0) {
    return {
      rawResponse: true,
      dataLength: html.length,
      containsChannelInfo: html.includes('Channel') || html.includes('channel'),
    };
  }

  return { channels };
}

async function fetchCpaCache() {
  console.log('  Fetching CPA Cache info...');
  try {
    const response = await httpRequest(
      DESTINATION_DIR,
      RUNTIME_ENDPOINTS.cpaCache,
      'GET',
      null,
      { Accept: 'application/xml, text/xml, */*' }
    );

    // Try to parse as XML first
    try {
      return await parseXml(response.data);
    } catch {
      // Return as text if not XML
      return { rawData: response.data.substring(0, 5000) };
    }
  } catch (e) {
    throw new Error(`CPA Cache fetch failed: ${e.message}`);
  }
}

async function fetchMdtStats() {
  console.log('  Fetching MDT statistics...');
  try {
    const response = await httpRequest(
      DESTINATION_DIR,
      RUNTIME_ENDPOINTS.mdt,
      'GET',
      null,
      { Accept: 'application/xml, text/html, */*' }
    );

    // Try to parse as XML first
    try {
      return await parseXml(response.data);
    } catch {
      // Return as text if not XML
      return { rawData: response.data.substring(0, 5000) };
    }
  } catch (e) {
    throw new Error(`MDT fetch failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE OUTPUT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`  Created directory: ${dirPath}`);
  }
}

function saveJson(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDirectoryExists(dir);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`  ✓ Saved: ${path.basename(filePath)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTRACTION ORCHESTRATION
// ═══════════════════════════════════════════════════════════════════════════════

async function extractWithTiming(name, extractFn) {
  const startTime = Date.now();
  let result = null;
  let error = null;
  let count = 0;

  try {
    result = await extractFn();
    count = Array.isArray(result) ? result.length : (result ? 1 : 0);
    console.log(`    Found ${count} ${name}`);
  } catch (e) {
    error = e.message;
    console.error(`    ✗ Error: ${e.message}`);
  }

  const duration = Date.now() - startTime;

  return {
    name,
    data: result,
    count,
    error,
    durationMs: duration,
  };
}

async function extractEsrArtifacts() {
  console.log('\n═══ Extracting ESR Artifacts ═══');
  const results = {};

  const extractions = [
    { name: 'software-components', fn: querySoftwareComponentVersions },
    { name: 'service-interfaces', fn: queryServiceInterfaces },
    { name: 'message-mappings', fn: queryMessageMappings },
    { name: 'operation-mappings', fn: queryOperationMappings },
    { name: 'data-types', fn: queryDataTypes },
    { name: 'external-definitions', fn: queryExternalDefinitions },
    { name: 'function-libraries', fn: queryFunctionLibraries },
    { name: 'imported-archives', fn: queryImportedArchives },
  ];

  for (const extraction of extractions) {
    const result = await extractWithTiming(extraction.name, extraction.fn);
    results[extraction.name] = result;

    // Save individual file
    if (result.data) {
      const filePath = path.join(OUTPUT_BASE_DIR, 'esr', `${extraction.name}.json`);
      saveJson(filePath, {
        extractedAt: new Date().toISOString(),
        count: result.count,
        items: result.data,
      });
    }
  }

  return results;
}

async function extractDirectoryArtifacts() {
  console.log('\n═══ Extracting Directory Artifacts ═══');
  const results = {};

  const extractions = [
    {
      name: 'integrated-configurations', fn: async () => {
        // Try 7.50 first, fall back to standard
        try {
          return await queryIntegratedConfigurations750();
        } catch {
          console.log('    Falling back to standard ICO service...');
          return await queryIntegratedConfigurations();
        }
      }
    },
    { name: 'communication-channels', fn: queryCommunicationChannels },
    { name: 'sender-agreements', fn: querySenderAgreements },
    { name: 'receiver-agreements', fn: queryReceiverAgreements },
    { name: 'receiver-determinations', fn: queryReceiverDeterminations },
    { name: 'receiver-rules', fn: queryReceiverRules },
    { name: 'interface-determinations', fn: queryInterfaceDeterminations },
    { name: 'value-mappings', fn: queryValueMappings },
    { name: 'configuration-scenarios', fn: queryConfigurationScenarios },
    { name: 'business-components', fn: queryBusinessComponents },
    { name: 'business-systems', fn: queryBusinessSystems },
    { name: 'parties', fn: queryParties },
    { name: 'alert-rules', fn: queryAlertRules },
    { name: 'integration-processes', fn: queryIntegrationProcesses },
    { name: 'bpm-facade', fn: queryBpmFacade },
  ];

  for (const extraction of extractions) {
    const result = await extractWithTiming(extraction.name, extraction.fn);
    results[extraction.name] = result;

    // Save individual file
    if (result.data) {
      const filePath = path.join(OUTPUT_BASE_DIR, 'directory', `${extraction.name}.json`);
      saveJson(filePath, {
        extractedAt: new Date().toISOString(),
        count: result.count,
        items: result.data,
      });
    }
  }

  return results;
}

async function extractRuntimeInfo() {
  console.log('\n═══ Extracting Runtime Information ═══');
  const results = {};

  const extractions = [
    { name: 'channel-status', fn: fetchChannelStatus },
    { name: 'cpa-cache', fn: fetchCpaCache },
    { name: 'mdt-stats', fn: fetchMdtStats },
  ];

  for (const extraction of extractions) {
    const result = await extractWithTiming(extraction.name, extraction.fn);
    results[extraction.name] = result;

    // Save individual file
    if (result.data) {
      const filePath = path.join(OUTPUT_BASE_DIR, 'runtime', `${extraction.name}.json`);
      saveJson(filePath, {
        extractedAt: new Date().toISOString(),
        data: result.data,
      });
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXTRACTION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

async function extractAllArtifacts() {
  const startTime = Date.now();
  const results = {
    esr: {},
    directory: {},
    runtime: {},
    errors: [],
    timing: {},
    summary: {},
  };

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║        PI/PO 7.50 Full Artifact Extraction                    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`\nOutput directory: ${OUTPUT_BASE_DIR}`);
  console.log(`ESR Destination: ${DESTINATION_ESR}`);
  console.log(`DIR Destination: ${DESTINATION_DIR}`);
  console.log(`Started at: ${new Date().toISOString()}\n`);

  // Ensure output directories exist
  ensureDirectoryExists(path.join(OUTPUT_BASE_DIR, 'esr'));
  ensureDirectoryExists(path.join(OUTPUT_BASE_DIR, 'directory'));
  ensureDirectoryExists(path.join(OUTPUT_BASE_DIR, 'runtime'));

  // Extract ESR artifacts
  let esrStartTime = Date.now();
  try {
    results.esr = await extractEsrArtifacts();
    results.timing.esr = Date.now() - esrStartTime;
  } catch (e) {
    results.errors.push({ phase: 'esr', error: e.message });
    console.error(`\n✗ ESR extraction phase failed: ${e.message}`);
  }

  // Extract Directory artifacts
  let dirStartTime = Date.now();
  try {
    results.directory = await extractDirectoryArtifacts();
    results.timing.directory = Date.now() - dirStartTime;
  } catch (e) {
    results.errors.push({ phase: 'directory', error: e.message });
    console.error(`\n✗ Directory extraction phase failed: ${e.message}`);
  }

  // Extract Runtime information
  let runtimeStartTime = Date.now();
  try {
    results.runtime = await extractRuntimeInfo();
    results.timing.runtime = Date.now() - runtimeStartTime;
  } catch (e) {
    results.errors.push({ phase: 'runtime', error: e.message });
    console.error(`\n✗ Runtime extraction phase failed: ${e.message}`);
  }

  // Calculate summary
  results.timing.total = Date.now() - startTime;

  results.summary = {
    extractedAt: new Date().toISOString(),
    destinations: {
      esr: DESTINATION_ESR,
      directory: DESTINATION_DIR,
    },
    counts: {
      esr: {},
      directory: {},
      runtime: {},
    },
    totalArtifacts: 0,
    totalErrors: 0,
    successfulEndpoints: 0,
    failedEndpoints: 0,
    timing: results.timing,
  };

  // Collect counts
  for (const [key, value] of Object.entries(results.esr)) {
    results.summary.counts.esr[key] = value.count || 0;
    results.summary.totalArtifacts += value.count || 0;
    if (value.error) {
      results.summary.totalErrors++;
      results.summary.failedEndpoints++;
      results.errors.push({ endpoint: `esr/${key}`, error: value.error });
    } else {
      results.summary.successfulEndpoints++;
    }
  }

  for (const [key, value] of Object.entries(results.directory)) {
    results.summary.counts.directory[key] = value.count || 0;
    results.summary.totalArtifacts += value.count || 0;
    if (value.error) {
      results.summary.totalErrors++;
      results.summary.failedEndpoints++;
      results.errors.push({ endpoint: `directory/${key}`, error: value.error });
    } else {
      results.summary.successfulEndpoints++;
    }
  }

  for (const [key, value] of Object.entries(results.runtime)) {
    results.summary.counts.runtime[key] = value.count || 0;
    if (value.error) {
      results.summary.totalErrors++;
      results.summary.failedEndpoints++;
      results.errors.push({ endpoint: `runtime/${key}`, error: value.error });
    } else {
      results.summary.successfulEndpoints++;
    }
  }

  // Save extraction summary
  const summaryPath = path.join(OUTPUT_BASE_DIR, 'extraction-summary.json');
  saveJson(summaryPath, {
    ...results.summary,
    errors: results.errors,
  });

  // Print final summary
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║                     Extraction Summary                         ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║ Total artifacts extracted: ${String(results.summary.totalArtifacts).padStart(30)} ║`);
  console.log(`║ Successful endpoints:      ${String(results.summary.successfulEndpoints).padStart(30)} ║`);
  console.log(`║ Failed endpoints:          ${String(results.summary.failedEndpoints).padStart(30)} ║`);
  console.log(`║ Total time:                ${String(results.timing.total + ' ms').padStart(30)} ║`);
  console.log('╚════════════════════════════════════════════════════════════════╝');

  if (results.errors.length > 0) {
    console.log('\n⚠ Errors encountered:');
    for (const err of results.errors) {
      console.log(`  - ${err.endpoint || err.phase}: ${err.error}`);
    }
  }

  console.log(`\n✓ Results saved to: ${OUTPUT_BASE_DIR}`);

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCRIPT ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  try {
    await initializeHttpClient();
    const results = await extractAllArtifacts();

    // Exit with error code if any endpoints failed
    if (results.errors.length > 0) {
      process.exit(1);
    }
  } catch (e) {
    console.error('\n✗ Fatal error during extraction:', e.message);
    console.error(e.stack);
    process.exit(2);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

// Export for use as module
module.exports = {
  extractAllArtifacts,
  // ESR functions
  querySoftwareComponentVersions,
  queryServiceInterfaces,
  queryMessageMappings,
  queryOperationMappings,
  queryDataTypes,
  queryExternalDefinitions,
  queryFunctionLibraries,
  queryImportedArchives,
  queryEsrSimple,
  queryEsrExt,
  queryEsrInt,
  // Directory SOAP functions
  queryIntegratedConfigurations,
  queryIntegratedConfigurations750,
  queryCommunicationChannels,
  querySenderAgreements,
  queryReceiverAgreements,
  queryReceiverDeterminations,
  queryInterfaceDeterminations,
  queryReceiverRules,
  queryValueMappings,
  queryConfigurationScenarios,
  queryBusinessComponents,
  queryBusinessSystems,
  queryParties,
  queryAlertRules,
  queryIntegrationProcesses,
  queryBpmFacade,
  // Directory HTTP functions
  queryDirExt,
  readDirExt,
  // Runtime functions
  fetchChannelStatus,
  fetchCpaCache,
  fetchMdtStats,
  // Utilities
  buildSoapEnvelope,
  parseXml,
  // Config
  DESTINATION_DIR,
  DESTINATION_ESR,
  SOAP_SERVICES,
  ESR_ENDPOINTS,
  DIR_ENDPOINTS,
  ESR_OBJECT_TYPES,
  RUNTIME_ENDPOINTS,
  XI_NAMESPACE,
};
