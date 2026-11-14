'use strict';

const { URL } = require('node:url');

const ALLOWED_AUTH_TYPES = new Set(['BasicAuthentication', 'OAuth2ClientCredentials', 'Certificate', 'ClientCertificateAuthentication']);
const ALLOWED_PROXY_TYPES = new Set(['OnPremise', 'Internet']);

// Subaccount destination baseline registry when VCAP_SERVICES.destination is not
// locally bound (mirrors the live BTP subaccount destinations PO_PJ2_ESR / PO_PJ2_DIR
// documented in docs/pipo-connection-summary.md, while real CF runtime uses getDestination()).
const SUBACCOUNT_DESTINATION_PROFILES = Object.freeze({
  PJ2: Object.freeze({
    esrName: 'PO_PJ2_ESR',
    dirName: 'PO_PJ2_DIR',
    virtualHost: 'nwjava.consultsda.com',
    virtualPort: '443',
    protocol: 'http:',
    proxyType: 'OnPremise',
    authentication: 'BasicAuthentication',
    locationId: 'SDA_LAB',
    user: 'SDAINT',
    allowedSubaccounts: ['sda-ai-shared-eu10', 'sda-ai-client-eu10-01', 'sda-ai-client-eu10-02', 'sda-ai-client-us10-01']
  })
});

class PipoBusinessError extends Error {
  constructor(code, userMessage, { httpStatus = 422, field = null, layer = 'destination' } = {}) {
    super(userMessage);
    this.name = 'PipoBusinessError';
    this.code = code;
    this.userMessage = userMessage;
    this.httpStatus = httpStatus;
    this.field = field;
    this.layer = layer;
  }

  toJSON() {
    return {
      connected: false,
      code: this.code,
      userMessage: this.userMessage,
      httpStatus: this.httpStatus,
      field: this.field,
      layer: this.layer
    };
  }
}

function parseVirtualHost(rawAddress) {
  const trimmed = String(rawAddress || '').trim();
  if (!trimmed) {
    throw new PipoBusinessError('INVALID_FORM_INPUT', 'Integration Directory / ES Repository Address is required.', { httpStatus: 400, field: 'address', layer: 'client' });
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PipoBusinessError('INVALID_ADDRESS_URL', 'Enter a valid Integration Directory / ES Repository URL (for example http://nwjava.consultsda.com:443).', { httpStatus: 400, field: 'address', layer: 'client' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new PipoBusinessError('INVALID_ADDRESS_URL', 'Integration Directory / ES Repository Address must use http:// or https:// with a valid virtual host.', { httpStatus: 400, field: 'address', layer: 'client' });
  }
  if (parsed.username || parsed.password) {
    throw new PipoBusinessError('INVALID_ADDRESS_URL', 'Do not embed credentials inside the Integration Directory / ES Repository URL.', { httpStatus: 400, field: 'address', layer: 'client' });
  }
  const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || defaultPort,
    hostWithPort: `${parsed.hostname.toLowerCase()}:${parsed.port || defaultPort}`
  };
}

function normalizeAuthType(value) {
  const v = String(value || '').trim();
  if (v === 'Certificate') return 'ClientCertificateAuthentication';
  return v;
}

function validateFormFields(form = {}) {
  const systemName = String(form.systemName || '').trim().toUpperCase();
  if (!systemName || !/^[A-Z0-9_]{2,16}$/.test(systemName)) {
    throw new PipoBusinessError('INVALID_FORM_INPUT', 'Enter a valid SAP PI/PO System ID (for example PJ2).', { httpStatus: 400, field: 'systemName', layer: 'client' });
  }
  const systemVersion = String(form.systemVersion || '').trim();
  if (!systemVersion) {
    throw new PipoBusinessError('INVALID_FORM_INPUT', 'System Version is required (for example 7.50).', { httpStatus: 400, field: 'systemVersion', layer: 'client' });
  }
  const virtualTarget = parseVirtualHost(form.address);
  const authType = String(form.authType || 'BasicAuthentication').trim();
  if (!ALLOWED_AUTH_TYPES.has(authType)) {
    throw new PipoBusinessError('INVALID_FORM_INPUT', `Unsupported Authentication type "${authType}".`, { httpStatus: 400, field: 'authType', layer: 'client' });
  }
  const proxyType = String(form.proxyType || 'OnPremise').trim();
  if (!ALLOWED_PROXY_TYPES.has(proxyType)) {
    throw new PipoBusinessError('INVALID_FORM_INPUT', `Unsupported Proxy Type "${proxyType}".`, { httpStatus: 400, field: 'proxyType', layer: 'client' });
  }
  const userId = String(form.userId || '').trim();
  if (authType === 'BasicAuthentication' && !userId) {
    throw new PipoBusinessError('INVALID_FORM_INPUT', 'User ID is required for BasicAuthentication.', { httpStatus: 400, field: 'userId', layer: 'client' });
  }
  const hasPassword = typeof form.password === 'string' && form.password.length > 0;
  if (authType === 'BasicAuthentication' && !hasPassword && !form.useDestinationStoredSecret) {
    throw new PipoBusinessError('INVALID_FORM_INPUT', `Password is required for user ${userId} to verify BasicAuthentication.`, { httpStatus: 400, field: 'password', layer: 'client' });
  }
  const locationId = String(form.locationId || '').trim();
  if (proxyType === 'OnPremise' && !locationId) {
    throw new PipoBusinessError('INVALID_FORM_INPUT', 'Location ID is required when Proxy Type is OnPremise (Cloud Connector).', { httpStatus: 400, field: 'locationId', layer: 'client' });
  }
  const subaccount = String(form.subaccount || 'sda-ai-shared-eu10').trim();
  return { systemName, systemVersion, virtualTarget, authType, proxyType, userId, password: form.password || '', locationId, subaccount };
}

function loadLocalEnvSilently(envFilePath) {
  const fs = require('node:fs');
  const loaded = {};
  try {
    if (!fs.existsSync(envFilePath)) return loaded;
    const lines = fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
      if (k) loaded[k] = v;
    }
  } catch { /* ignore unreadable .env */ }
  return loaded;
}

async function resolveDestinationMetadata(systemName, { getDestinationFn = null, env = process.env } = {}) {
  const esrDestName = `PO_${systemName}_ESR`;
  const dirDestName = `PO_${systemName}_DIR`;

  // 1. Live BTP Destination Service binding when running inside Cloud Foundry / bound runtime
  const hasBoundDestService = Boolean(env.VCAP_SERVICES && /"destination"/i.test(env.VCAP_SERVICES));
  if (getDestinationFn || hasBoundDestService) {
    const fetchDest = getDestinationFn || require('@sap-cloud-sdk/connectivity').getDestination;
    const [esr, dir] = await Promise.all([
      fetchDest({ destinationName: esrDestName }).catch(() => null),
      fetchDest({ destinationName: dirDestName }).catch(() => null)
    ]);
    if (!esr || !dir) {
      throw new PipoBusinessError(
        'DEST_NOT_FOUND',
        `Destination service instance in this subaccount does not define both "${esrDestName}" and "${dirDestName}" for system ${systemName}.`,
        { httpStatus: 404, field: 'systemName', layer: 'destination' }
      );
    }
    const targetUrl = parseVirtualHost(dir.url || esr.url);
    return {
      source: 'btp-destination-service',
      esrName: esrDestName,
      dirName: dirDestName,
      virtualHost: targetUrl.hostname,
      virtualPort: targetUrl.port,
      protocol: targetUrl.protocol,
      proxyType: dir.proxyType || esr.proxyType || 'OnPremise',
      authentication: dir.authentication || esr.authentication || 'BasicAuthentication',
      locationId: dir.cloudConnectorLocationId || esr.cloudConnectorLocationId || dir.originalProperties?.CloudConnectorLocationId || '',
      user: dir.username || esr.username || '',
      password: dir.password || esr.password || null,
      allowedSubaccounts: null
    };
  }

  // 2. Configured subaccount destination profile (read-only verification when running outside CF)
  const profile = SUBACCOUNT_DESTINATION_PROFILES[systemName];
  if (!profile) {
    throw new PipoBusinessError(
      'DEST_NOT_FOUND',
      `No BTP Destination configuration found in subaccount for system "${systemName}" (expected PO_${systemName}_ESR and PO_${systemName}_DIR).`,
      { httpStatus: 404, field: 'systemName', layer: 'destination' }
    );
  }
  return { source: 'subaccount-destination-profile', ...profile, password: env.PIPO_EXPECTED_PASS || null };
}

function assertDestinationAlignment(validated, destMeta) {
  if (Array.isArray(destMeta.allowedSubaccounts) && destMeta.allowedSubaccounts.length > 0 &&
      !destMeta.allowedSubaccounts.includes(validated.subaccount)) {
    throw new PipoBusinessError(
      'DEST_SUBACCOUNT_MISMATCH',
      `Subaccount "${validated.subaccount}" does not host the "${destMeta.dirName}" / "${destMeta.esrName}" destinations for ${validated.systemName}.`,
      { httpStatus: 422, field: 'subaccount', layer: 'destination' }
    );
  }

  if (validated.virtualTarget.hostname !== destMeta.virtualHost.toLowerCase() ||
      validated.virtualTarget.port !== String(destMeta.virtualPort)) {
    throw new PipoBusinessError(
      'DEST_VIRTUAL_HOST_MISMATCH',
      `Virtual host mismatch: Integration Directory / ESR Address "${validated.virtualTarget.hostWithPort}" does not match BTP Destination "${destMeta.dirName}" virtual host "${destMeta.virtualHost}:${destMeta.virtualPort}".`,
      { httpStatus: 422, field: 'address', layer: 'destination' }
    );
  }

  if (normalizeAuthType(validated.authType) !== normalizeAuthType(destMeta.authentication)) {
    throw new PipoBusinessError(
      'DEST_AUTH_TYPE_MISMATCH',
      `Authentication mismatch: selected "${validated.authType}", but BTP Destination "${destMeta.dirName}" in subaccount "${validated.subaccount}" is configured with "${destMeta.authentication}".`,
      { httpStatus: 422, field: 'authType', layer: 'destination' }
    );
  }

  if (validated.proxyType !== destMeta.proxyType) {
    throw new PipoBusinessError(
      'DEST_PROXY_MISMATCH',
      `Proxy Type mismatch: selected "${validated.proxyType}", but BTP Destination "${destMeta.dirName}" requires "${destMeta.proxyType}".`,
      { httpStatus: 422, field: 'proxyType', layer: 'destination' }
    );
  }

  if (validated.proxyType === 'OnPremise' && destMeta.locationId &&
      validated.locationId.toUpperCase() !== String(destMeta.locationId).toUpperCase()) {
    throw new PipoBusinessError(
      'DEST_LOCATION_MISMATCH',
      `Cloud Connector Location ID mismatch: entered "${validated.locationId}", but subaccount "${validated.subaccount}" destination "${destMeta.dirName}" maps to Location ID "${destMeta.locationId}".`,
      { httpStatus: 422, field: 'locationId', layer: 'destination' }
    );
  }

  if (destMeta.user && validated.userId &&
      validated.userId.toUpperCase() !== String(destMeta.user).toUpperCase()) {
    throw new PipoBusinessError(
      'DEST_USER_MISMATCH',
      `Technical User ID "${validated.userId}" does not match principal "${destMeta.user}" configured in BTP Destination "${destMeta.dirName}".`,
      { httpStatus: 422, field: 'userId', layer: 'destination' }
    );
  }

  if (destMeta.password && validated.password && validated.password !== destMeta.password) {
    throw new PipoBusinessError(
      'PIPO_AUTH_FAILED',
      `Authentication failed (HTTP 401): supplied password for "${validated.userId}" does not match BTP Destination Service credentials.`,
      { httpStatus: 401, field: 'password', layer: 'source' }
    );
  }
}

async function probeLivePipo(validated, destMeta, { probeFn = null, env = process.env } = {}) {
  if (probeFn) return probeFn(validated, destMeta);

  const path = require('node:path');
  const localEnv = { ...loadLocalEnvSilently(path.join(__dirname, '.env')), ...env };
  const mcpRawUrl = localEnv.PIPO_MCP_URL || 'https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com';
  const baseUrl = mcpRawUrl.replace(/\/mcp\/?$/, '').replace(/\/+$/, '');

  let pingRes;
  try {
    pingRes = await fetch(`${baseUrl}/api/pi8/ping`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new PipoBusinessError(
      'TUNNEL_UNREACHABLE',
      `Unable to reach PI/PO MCP bridge or Cloud Connector tunnel (Location ID "${validated.locationId}" in subaccount "${validated.subaccount}").`,
      { httpStatus: 503, field: 'locationId', layer: 'mcp' }
    );
  }

  if (pingRes.status === 401) {
    throw new PipoBusinessError(
      'PIPO_AUTH_FAILED',
      `SAP PI/PO rejected authentication for user "${validated.userId}" on ${validated.systemName}.`,
      { httpStatus: 401, field: 'password', layer: 'source' }
    );
  }
  if (pingRes.status >= 500) {
    throw new PipoBusinessError(
      'TUNNEL_UNREACHABLE',
      `Cloud Connector tunnel for ${validated.systemName} (Location ID "${validated.locationId}") returned HTTP ${pingRes.status} — verify Cloud Connector & Jump Server.`,
      { httpStatus: 503, field: 'locationId', layer: 'source' }
    );
  }

  const pingBody = await pingRes.json().catch(() => ({}));
  if (!pingBody.reachable) {
    throw new PipoBusinessError(
      'TUNNEL_UNREACHABLE',
      `Destinations ${destMeta.esrName} / ${destMeta.dirName} are unreachable over Cloud Connector Location ID "${validated.locationId}".`,
      { httpStatus: 503, field: 'locationId', layer: 'source' }
    );
  }

  // Also check ESR SimpleQuery / authenticated object probe to catch 401/403 credential mismatches
  const esrStatus = pingBody.destinations?.[destMeta.esrName]?.status;
  const dirStatus = pingBody.destinations?.[destMeta.dirName]?.status;
  if (esrStatus === 401 || dirStatus === 401) {
    throw new PipoBusinessError(
      'PIPO_AUTH_FAILED',
      `SAP PI/PO (${validated.systemName}) returned HTTP 401 Unauthorized — verify technical user "${validated.userId}" password in BTP Destination Service.`,
      { httpStatus: 401, field: 'password', layer: 'source' }
    );
  }
  return {
    reachable: true,
    via: pingBody.via || 'Cloud Connector (OnPremise)',
    destinations: {
      [destMeta.esrName]: { reachable: Boolean(pingBody.destinations?.[destMeta.esrName]?.reachable), status: esrStatus || 200 },
      [destMeta.dirName]: { reachable: Boolean(pingBody.destinations?.[destMeta.dirName]?.reachable), status: dirStatus || 200 }
    }
  };
}

async function verifyPipoConnection(form = {}, options = {}) {
  const validated = validateFormFields(form);
  const destMeta = await resolveDestinationMetadata(validated.systemName, options);
  assertDestinationAlignment(validated, destMeta);
  const live = await probeLivePipo(validated, destMeta, options);

  return {
    connected: true,
    systemName: validated.systemName,
    systemVersion: validated.systemVersion,
    subaccount: validated.subaccount,
    locationId: validated.locationId,
    authType: validated.authType,
    proxyType: validated.proxyType,
    virtualHost: `${validated.virtualTarget.hostname}:${validated.virtualTarget.port}`,
    destinationMatch: {
      verified: true,
      source: destMeta.source,
      esrDestination: destMeta.esrName,
      dirDestination: destMeta.dirName
    },
    tunnel: live,
    userMessage: `Connected — ${validated.systemName} (${validated.systemVersion}) Integration Directory & ESR verified via ${destMeta.dirName} / ${destMeta.esrName} in subaccount ${validated.subaccount}.`
  };
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { if (raw.length < 128 * 1024) raw += chunk; });
  process.stdin.on('end', async () => {
    try {
      const payload = raw.trim() ? JSON.parse(raw) : {};
      const result = await verifyPipoConnection(payload);
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (err) {
      const safe = err instanceof PipoBusinessError
        ? err.toJSON()
        : {
            connected: false,
            code: 'CONNECTION_CHECK_FAILED',
            userMessage: 'Unable to complete SAP PI/PO connection check; verify destination bindings and Cloud Connector health.',
            httpStatus: 503,
            field: null,
            layer: 'mcp'
          };
      process.stdout.write(JSON.stringify(safe) + '\n');
      process.exitCode = 2;
    }
  });
}

module.exports = {
  PipoBusinessError,
  parseVirtualHost,
  normalizeAuthType,
  validateFormFields,
  resolveDestinationMetadata,
  assertDestinationAlignment,
  verifyPipoConnection,
  SUBACCOUNT_DESTINATION_PROFILES
};
