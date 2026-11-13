'use strict';

const { getEndpoint } = require('./pipo-endpoints');

const DESTINATIONS = new Set(['PO_PJ2_DIR', 'PO_PJ2_ESR']);
const KNOWN_ROLES = new Set(['SAP_XI_API_DISPLAY_J2EE', 'SAP_XI_DISPLAY_USER_J2EE', 'SAP_XI_MONITOR_J2EE']);
const LAYERS = new Set(['source', 'mcp', 'cap', 'client']);
const LOCAL_CODES = {
  cap: new Set(['CAP_URL_MISSING', 'CAP_URL_INVALID', 'CAP_AUTH_MISSING', 'CAP_AUTH_INVALID']),
  client: new Set(['INVALID_ARGUMENTS'])
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeHttpStatus = (value) => Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;

function validateRoles(value) {
  if (value === undefined) return {};
  const invalid = () => new TypeError('Invalid role inventory; expected destination arrays of strings, maximum 1000 entries.');
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const inventory = {};
  let count = 0;
  for (const destination of Object.keys(value)) {
    if (!DESTINATIONS.has(destination) || !Array.isArray(value[destination])) throw invalid();
    const roles = value[destination];
    count += roles.length;
    if (count > 1000) throw invalid();
    // Reject the whole input before returning anything, even if earlier entries were valid.
    for (const role of roles) if (typeof role !== 'string') throw invalid();
    inventory[destination] = [...new Set(roles.filter((role) => KNOWN_ROLES.has(role)))];
  }
  return inventory;
}

const MESSAGES = Object.freeze({
  AUTH_REQUIRED: ['Authentication is required or was not accepted.',
    'Check source destination authentication and credential validity; role inventory does not verify effective access.'],
  FORBIDDEN: ['The endpoint refused access; the cause is not established by the response status.',
    'Ask the source owner to verify endpoint-specific read access and access policies; do not grant elevated roles automatically.'],
  NOT_FOUND: ['The requested endpoint was not found.',
    'Verify the configured source path and the service available for this release.'],
  RATE_LIMITED: ['The endpoint is limiting requests.',
    'Reduce request frequency and retry later according to the source policy.'],
  UNAVAILABLE: ['The endpoint service is unavailable.',
    'Check source service health and connectivity before retrying.'],
  HTTP_ERROR: ['The HTTP request did not succeed.',
    'Check source service health, routing and endpoint availability.'],
  SOAP_FAULT: ['The endpoint returned a SOAP fault; fault details are omitted.',
    'Ask the source owner to check the supported SOAP contract and source-side diagnostics.'],
  NEEDS_PARAMETERS: ['The request needs supported parameters or a verified protocol.',
    'Use the registered read-only schema and an enumerated identifier where required.'],
  METADATA_ONLY: ['Only metadata or a protocol response was established, not extracted objects.',
    'Verify the supported read contract before treating the response as extracted data.'],
  CAP_URL_MISSING: ['PIPO_CAP_URL is not configured; no CAP request was made.',
    'Set PIPO_CAP_URL to the running CAP application URL in the CLI environment. MCP settings alone do not configure the CAP cache.'],
  CAP_URL_INVALID: ['PIPO_CAP_URL is invalid; no CAP request was made.',
    'Use the CAP application HTTPS URL, or HTTP on exact localhost for development, without embedded credentials, query parameters or fragments.'],
  CAP_AUTH_MISSING: ['CAP authentication is not configured; no CAP request was made.',
    'Set PIPO_CAP_TOKEN for production, or PIPO_CAP_USER and PIPO_CAP_PASS for local mocked authentication, through protected configuration. MCP credentials are separate.'],
  CAP_AUTH_INVALID: ['The CAP token format is invalid; no CAP request was made.',
    'Set PIPO_CAP_TOKEN to a raw access token without a Bearer prefix or whitespace through protected configuration; never paste it into logs or commands.'],
  INVALID_ARGUMENTS: ['The discovery command contains invalid or incompatible arguments.',
    'Use separate flags: --cache --export, not --cache--export. Run --help for supported options.'],
  OK: ['The endpoint reported success.', 'No failure remediation is indicated.'],
  FAILED: ['The request failed without a recognized safe failure code.',
    'Check source connectivity and configuration using trusted source-side diagnostics.']
});
const LAYER_REMEDIATION = Object.freeze({
  mcp: 'Check MCP connectivity, authentication and tool registration; this does not establish a source authorization failure.',
  cap: 'Check CAP connectivity, authentication and service configuration; this does not establish a source authorization failure.',
  client: 'Check client configuration and request validation; this does not establish a source authorization failure.'
});

function failureCode(result, layer) {
  const status = safeHttpStatus(result.httpStatus);
  const codes = { 401: 'AUTH_REQUIRED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 429: 'RATE_LIMITED', 503: 'UNAVAILABLE' };
  if (codes[status]) return codes[status];
  if (status === undefined && LOCAL_CODES[layer]?.has(result.failureCode)) return result.failureCode;
  if (result.failureCode === 'SOAP_FAULT') return 'SOAP_FAULT';
  if (status >= 500) return 'HTTP_ERROR';
  if (result.failureCode === 'AUTH_REQUIRED') return 'AUTH_REQUIRED';
  if (status !== undefined && (status < 200 || status >= 300)) return 'HTTP_ERROR';
  if (result.status === 'needs_parameters') return 'NEEDS_PARAMETERS';
  if (result.status === 'metadata-only') return 'METADATA_ONLY';
  if (result.status === 'ok') return 'OK';
  return 'FAILED';
}

function candidateRoles(endpoint) {
  // Directory Programming Interface read example, not evidence for ESR:
  // https://help.sap.com/doc/saphelp_em92/9.2/en-US/f1/544ad104f6494c9eb0a8a87a601549/content.htm
  if (endpoint.category === 'Directory' && endpoint.kind === 'soap') {
    return [{ role: 'SAP_XI_API_DISPLAY_J2EE', evidence: 'documented' }];
  }
  if (endpoint.category === 'Directory' || endpoint.category === 'Repository') {
    return [{ role: 'SAP_XI_DISPLAY_USER_J2EE', evidence: 'suggested' }];
  }
  if (endpoint.category === 'Monitoring') return [{ role: 'SAP_XI_MONITOR_J2EE', evidence: 'suggested' }];
  return [];
}

function diagnose(endpoint, result, { roles = {}, layer = 'source' } = {}) {
  const descriptor = typeof endpoint === 'string' ? getEndpoint(endpoint) :
    record(endpoint) ? getEndpoint(endpoint.tool) || getEndpoint(endpoint.path) : undefined;
  result = record(result) ? result : {};
  // Honor safe upstream layer metadata, but never turn an explicit non-source layer into source advice.
  layer = LAYERS.has(layer) ? layer : 'client';
  if (layer === 'source' && LAYERS.has(result.failureLayer)) layer = result.failureLayer;
  let inventory;
  try { inventory = validateRoles(roles); } catch { inventory = {}; }
  const supplied = Boolean(descriptor && Object.hasOwn(inventory, descriptor.destination));
  const code = failureCode(result, layer);
  const [reason, remediation] = MESSAGES[code];
  const candidates = layer === 'source' && descriptor && code === 'FORBIDDEN'
    ? candidateRoles(descriptor).map((candidate) => ({ ...candidate,
      present: supplied ? inventory[descriptor.destination].includes(candidate.role) : null })) : [];
  return { code, layer, reason, remediation: layer === 'source' || LOCAL_CODES[layer]?.has(code) ? remediation : LAYER_REMEDIATION[layer],
    roleAssessment: { inventory: supplied ? 'supplied' : 'unavailable', candidates, effectivePermissionsVerified: false } };
}

function projectDiagnostic(value) {
  if (!record(value)) return undefined;
  const layer = LAYERS.has(value.layer) ? value.layer : 'client';
  let code = Object.hasOwn(MESSAGES, value.code) ? value.code : 'FAILED';
  if (Object.values(LOCAL_CODES).some(codes => codes.has(code)) && !LOCAL_CODES[layer]?.has(code)) code = 'FAILED';
  const [reason, remediation] = MESSAGES[code];
  const candidates = layer === 'source' && code === 'FORBIDDEN' && Array.isArray(value.roleAssessment?.candidates)
    ? value.roleAssessment.candidates.filter(item => record(item) && KNOWN_ROLES.has(item.role))
      .slice(0, 3).map(item => ({ role: item.role, evidence: item.evidence === 'documented' ? 'documented' : 'suggested',
        present: typeof item.present === 'boolean' ? item.present : null })) : [];
  return { code, layer, reason, remediation: layer === 'source' || LOCAL_CODES[layer]?.has(code) ? remediation : LAYER_REMEDIATION[layer],
    roleAssessment: { inventory: value.roleAssessment?.inventory === 'supplied' ? 'supplied' : 'unavailable',
      candidates, effectivePermissionsVerified: false } };
}

module.exports = { diagnose, validateRoles, projectDiagnostic };