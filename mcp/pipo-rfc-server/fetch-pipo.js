'use strict';

const { summarizeDiscovery, logSummary } = require('./discovery-report');
const { ENDPOINTS } = require('./pipo-endpoints');
const { exportDefinitions } = require('./definition-export');
const { diagnose, validateRoles, projectDiagnostic } = require('./discovery-diagnostics');
const { createCapCacheClient, checkedUrl, boundedFetch, readJson,
  MAX_PAYLOAD_BYTES, REQUEST_TIMEOUT } = require('./cap-cache-client');

// Node.js 20+. No new dependencies; MCP mode uses this package's existing SDK.
const DEFAULT_URL = 'https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com/mcp';
const READ_TOOLS = ['get_pi8_status', 'list_pi8_esr_objects'];
const REQUEST_OPTIONS = { timeout: REQUEST_TIMEOUT };
const MAX_PARAMETERS_BYTES = 64 * 1024;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function serverUrl(value) {
  const url = checkedUrl(value || DEFAULT_URL, 'PIPO_MCP_URL');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/mcp') ? path : `${path}/mcp`;
  return url;
}

function defaultParameters(endpoint) {
  const query = endpoint.kind === 'simple-query' || endpoint.kind === 'soap' && Boolean(endpoint.entity);
  const parameters = { mode: query ? 'query' : 'metadata' };
  if (query || endpoint.kind === 'query') Object.assign(parameters, { maxItems: 1000, offset: 0 });
  return parameters;
}

function endpointFailure(endpoint, status = 'failed', raw = {}, layer = 'source') {
  return { tool: endpoint.tool, path: endpoint.path, category: endpoint.category, kind: endpoint.kind,
    status, metadataOnly: true, artifacts: [], response: { format: 'omitted', body: null },
    ...(Number.isInteger(raw.httpStatus) && raw.httpStatus >= 100 && raw.httpStatus <= 599 ? { httpStatus: raw.httpStatus } : {}),
    failureLayer: ['source', 'mcp', 'cap', 'client'].includes(raw.failureLayer) ? raw.failureLayer : layer,
    ...(['SOAP_FAULT', 'AUTH_REQUIRED'].includes(raw.failureCode) ? { failureCode: raw.failureCode } : {}),
    warnings: ['Discovery endpoint unavailable or failed; sensitive details omitted.'] };
}

function parseJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) {
    throw new Error('Invalid or oversized discovery JSON response.');
  }
  try { return JSON.parse(text); } catch { throw new Error('Invalid discovery JSON response.'); }
}

function decodeResult(result) {
  if (typeof result === 'string') return parseJson(result);
  if (!record(result) || result.isError) throw new Error('Discovery tool failed.');
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_PAYLOAD_BYTES) throw new Error('Discovery response exceeds 5 MB.');
  if (record(result.structuredContent)) return result.structuredContent;
  const text = result.content?.find((item) => item.type === 'text');
  if (text) return parseJson(text.text);
  if (Object.hasOwn(result, 'content')) throw new Error('Discovery tool returned no JSON result.');
  return result;
}

// Scrub both common credential representations and the actual credentials in use,
// even if a server echoes them under an innocuous key or in a tool description.
function sanitizeOutput(value, env) {
  const secrets = ['PIPO_MCP_USER', 'PIPO_MCP_PASS', 'PIPO_CAP_TOKEN', 'PIPO_CAP_USER', 'PIPO_CAP_PASS']
    .map((key) => env[key]).filter((item) => typeof item === 'string' && item);
  for (const prefix of ['PIPO_MCP', 'PIPO_CAP']) {
    if (env[`${prefix}_USER`] && env[`${prefix}_PASS`]) {
      secrets.push(Buffer.from(`${env[`${prefix}_USER`]}:${env[`${prefix}_PASS`]}`).toString('base64'));
    }
  }
  function clean(item, depth = 0) {
    if (depth > 80) throw new Error('Discovery response nesting exceeds the safety limit.');
    if (typeof item === 'string') {
      let text = item;
      for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
      return text.replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9+/_=.~-]+/gi, '[REDACTED]')
        .replace(/((?:password|passwd|pwd|token|secret|api[-_]?key|authorization|cookie)[A-Za-z0-9_.-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s<>&;,]+)/gi, '$1[REDACTED]')
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
    }
    if (Array.isArray(item)) return item.map((child) => clean(child, depth + 1));
    if (!record(item)) return item;
    const entries = Object.entries(item).filter(([key]) => !['__proto__', 'prototype', 'constructor'].includes(key));
    const pair = entries.some(([key, child]) => /^(?:@_)?(?:name|key|type)$/i.test(key.split(':').pop()) &&
      typeof child === 'string' && /password|passwd|pwd|token|secret|credential|auth|cookie|user(?:name)?|login|passphrase/i.test(child));
    return Object.fromEntries(entries.map(([key, child]) => {
      const opaque = /^Attributes$/i.test(key.replace(/^@_/, '').split(':').pop()) &&
        (typeof child === 'string' || Array.isArray(child) || typeof child?.['#text'] === 'string');
      return [clean(key, depth + 1), opaque ? '[OMITTED: opaque adapter attributes]' :
        /password|passwd|pwd|token|secret|credential|authorization|cookie|api[-_]?key|private[-_]?key/i.test(key) ||
        /^(?:headers|request|requestheaders|authheaders|config)$/i.test(key) || pair && /^(?:@_)?(?:value|#text)$/i.test(key)
          ? '[REDACTED]' : clean(child, depth + 1)];
    }));
  }
  return clean(value);
}

function endpointResult(endpoint, raw, env) {
  try {
    const result = decodeResult(raw);
    const allowed = ['ok', 'success', 'successful', 'available', 'reachable', 'metadata-only'];
    if (!record(result) || !allowed.includes(result.status) || result.isError || result.success === false ||
        result.ok === false || result.httpStatus >= 400 ||
        (Array.isArray(result.errors) ? result.errors.length :
          record(result.errors) ? Object.keys(result.errors).length : Boolean(result.errors))) {
      const status = ['unavailable', 'unsupported', 'needs_parameters'].includes(result?.status) ? result.status : 'failed';
      return endpointFailure(endpoint, status, record(result) ? result : {});
    }
    return { ...sanitizeOutput(result, env), tool: endpoint.tool, path: endpoint.path,
      category: endpoint.category, kind: endpoint.kind };
  } catch { return endpointFailure(endpoint); }
}

async function readParametersFile(path) {
  const { open } = require('node:fs/promises');
  let file;
  try {
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_PARAMETERS_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_PARAMETERS_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_PARAMETERS_BYTES) throw new Error();
    const parameters = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!record(parameters)) throw new Error();
    return parameters;
  } catch { throw new Error('Parameters file must contain a JSON object of at most 64 KB.'); }
  finally { if (file) await file.close().catch(() => {}); }
}

function validateOptions({ rest, toolsOnly, cache, ttlSeconds, forceRefresh, tool, parametersFile, parameters,
  export: fullExport, inputFile, maxReads, maxPages }) {
  if (rest && toolsOnly) throw new Error('--tools-only requires MCP mode.');
  if (cache && (rest || toolsOnly)) throw new Error('--cache cannot be combined with --rest or --tools-only.');
  if (!cache && (ttlSeconds !== undefined || forceRefresh)) throw new Error('TTL and force refresh require --cache.');
  if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > 604800)) {
    throw new Error('TTL must be an integer from 0 to 604800.');
  }
  if (typeof forceRefresh !== 'boolean') throw new Error('forceRefresh must be a boolean.');
  if (tool !== undefined && !ENDPOINTS.some((endpoint) => endpoint.tool === tool)) throw new Error('Unknown registry tool.');
  if ((parametersFile !== undefined || parameters !== undefined) && tool === undefined) {
    throw new Error('Parameters require a single --tool.');
  }
  if ((tool !== undefined || parametersFile !== undefined) && (rest || toolsOnly)) {
    throw new Error('--tool requires discovery or --cache mode.');
  }
  if (parametersFile !== undefined && parameters !== undefined) throw new Error('Choose one parameters source.');
  if (parameters !== undefined && (!record(parameters) || Buffer.byteLength(JSON.stringify(parameters)) > MAX_PARAMETERS_BYTES)) {
    throw new Error('Parameters must be a JSON object of at most 64 KB.');
  }
  if (fullExport && (rest || toolsOnly || tool)) throw new Error('--export requires full discovery or --cache.');
  if (inputFile !== undefined && !fullExport) throw new Error('--input-file requires --export.');
  for (const [name, value, limit] of [['maxReads', maxReads, 100000], ['maxPages', maxPages, 1000]]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > limit)) throw new Error(`Invalid ${name} limit.`);
  }
}

async function readDiscoveryFile(path) {
  const fs = require('node:fs/promises');
  let file;
  try {
    file = await fs.open(path, 'r');
    const stat = await file.stat();
    const limit = 100 * 1024 * 1024;
    if (!stat.isFile() || stat.size > limit) throw new Error();
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;
    while (length < bytes.length) {
      const next = await file.read(bytes, length, bytes.length - length, null);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    if (length > stat.size || length > limit) throw new Error();
    const utf16 = bytes[0] === 255 && bytes[1] === 254;
    const data = JSON.parse(bytes.subarray(0, length).toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(data.discovery?.endpoints)) throw new Error();
    return data.discovery.endpoints;
  } catch { throw new Error('Input must be a discovery JSON file (UTF-8 or UTF-16 LE) of at most 100 MB.'); }
  finally { await file?.close().catch(() => {}); }
}

async function fetchPipo({ rest = false, toolsOnly = false, cache = false, ttlSeconds,
  forceRefresh = false, tool, parametersFile, parameters, export: fullExport = false, inputFile,
  rolesFile, roles = {}, maxReads = 5000, maxPages = 100, event = async () => {}, env = process.env } = {}) {
  validateOptions({ rest, toolsOnly, cache, ttlSeconds, forceRefresh, tool, parametersFile, parameters,
    export: fullExport, inputFile, maxReads, maxPages });
  roles = validateRoles(rolesFile ? await readParametersFile(rolesFile) : roles);
  const seed = inputFile ? await readDiscoveryFile(inputFile) : undefined;
  const overrides = parametersFile === undefined ? parameters : await readParametersFile(parametersFile);
  const endpoints = tool === undefined ? ENDPOINTS : ENDPOINTS.filter((endpoint) => endpoint.tool === tool);
  const argsFor = (endpoint) => ({ ...defaultParameters(endpoint), ...overrides });
  const decorate = (endpoint, result) => ({ ...result, diagnostic: diagnose(endpoint, result, { roles }) });
  const initialResults = () => seed?.flatMap(raw => {
    const endpoint = ENDPOINTS.find(item => item.tool === raw?.tool);
    return endpoint ? [decorate(endpoint, endpointResult(endpoint, raw, env))] : [];
  });
  async function complete(output, fetchEndpoint) {
    if (fullExport) output.export = await exportDefinitions({ discovery: output.discovery, fetchEndpoint, event, maxReads, maxPages });
    return sanitizeOutput(output, env);
  }
  async function observed(endpoint, work) {
    const start = Date.now();
    let result;
    try { result = decorate(endpoint, await work()); }
    catch (error) {
      const failure = endpointFailure(endpoint, 'failed', error, cache ? 'cap' : 'mcp');
      await event({ event: 'endpoint-result', phase: 'discovery', tool: endpoint.tool,
        status: 'failed', httpStatus: failure.httpStatus, diagnostic: diagnose(endpoint, failure, { roles }),
        durationMs: Date.now() - start });
      error.abortRun = true;
      throw error;
    }
    await event({ event: 'endpoint-result', phase: 'discovery', tool: endpoint.tool,
      status: result.status, httpStatus: result.httpStatus, diagnostic: result.diagnostic,
      durationMs: Date.now() - start, counts: { artifacts: result.artifacts?.length || 0,
        hits: result.cache?.hit ? 1 : 0, misses: result.cache && !result.cache.hit ? 1 : 0 } });
    return result;
  }

  // CAP owns authentication, persistence and MCP access in cache mode. Do not
  // even require the MCP SDK, inspect its configuration or discover its tools.
  if (cache) {
    const capFetch = createCapCacheClient(env);
    const fetchEndpoint = (endpoint, parameters) => observed(endpoint, async () => {
      try {
        const envelope = await capFetch(endpoint.tool, parameters, { ttlSeconds, forceRefresh });
        return { ...endpointResult(endpoint, envelope.result, env), cache: envelope.cache };
      } catch (error) {
        error.failureLayer = 'cap';
        throw error;
      }
    });
    const results = initialResults() || [];
    if (!seed) for (const endpoint of endpoints) results.push(await fetchEndpoint(endpoint, argsFor(endpoint)));
    return complete({ mode: 'cache', discovery: { endpoints: results } }, fetchEndpoint);
  }
  const url = serverUrl(env.PIPO_MCP_URL);

  if (rest) {
    const output = { mode: 'rest' };
    for (const [key, path] of [['status', 'ping'], ['objects', 'objects']]) {
      const endpoint = new URL(url);
      endpoint.pathname = endpoint.pathname.replace(/\/mcp$/, `/api/pi8/${path}`);
      const response = await boundedFetch(endpoint);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`PI8 ${key} request failed (HTTP ${response.status}).`);
      }
      output[key] = await readJson(response);
    }
    return sanitizeOutput(output, env);
  }

  if (!env.PIPO_MCP_USER || !env.PIPO_MCP_PASS) {
    throw new Error('Set PIPO_MCP_USER and PIPO_MCP_PASS, or use --rest without credentials.');
  }
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const authorization = 'Basic ' + Buffer.from(`${env.PIPO_MCP_USER}:${env.PIPO_MCP_PASS}`).toString('base64');
  const client = new Client({ name: 'pipo-fetch', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (url, init) => {
      const response = await boundedFetch(url, init);
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error('MCP HTTP request failed; response omitted.');
        error.httpStatus = response.status;
        error.failureLayer = 'mcp';
        throw error;
      }
      return response;
    },
    requestInit: { headers: { Authorization: authorization }, redirect: 'error' }
  });

  try {
    await client.connect(transport, REQUEST_OPTIONS);
    const tools = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, REQUEST_OPTIONS);
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('MCP tool discovery returned a repeated cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);

    const output = { mode: 'mcp', tools };
    if (!toolsOnly) {
      const available = new Set(tools.map((entry) => entry.name));
      const fetchEndpoint = (endpoint, parameters) => observed(endpoint, async () => {
        let result = endpointFailure(endpoint, 'unavailable', {}, 'mcp');
        if (available.has(endpoint.tool)) {
          try {
            const raw = await client.callTool({ name: endpoint.tool, arguments: parameters }, undefined, REQUEST_OPTIONS);
            result = endpointResult(endpoint, raw, env);
          } catch (error) { result = endpointFailure(endpoint, 'failed', error, 'mcp'); }
        }
        return result;
      });
      output.discovery = { endpoints: initialResults() || [] };
      if (!seed) for (const endpoint of endpoints) output.discovery.endpoints.push(await fetchEndpoint(endpoint, argsFor(endpoint)));
      if (!seed && tool === undefined && !ENDPOINTS.some((endpoint) => available.has(endpoint.tool))) {
        for (const [index, name] of READ_TOOLS.entries()) {
          if (!available.has(name)) throw new Error(`Required tool ${name} is unavailable.`);
          const result = await client.callTool({ name, arguments: {} }, undefined, REQUEST_OPTIONS);
          if (result.isError) throw new Error(`Tool ${name} failed; check the server's destination configuration.`);
          output[index === 0 ? 'status' : 'objects'] = decodeResult(result);
        }
      }
      return await complete(output, fetchEndpoint);
    }
    return sanitizeOutput(output, env);
  } finally {
    await client.close();
  }
}

function parseArgs(args) {
  const options = {};
  const seen = new Set();
  for (const arg of args) {
    const key = arg.split('=')[0];
    if (seen.has(key)) throw new Error('Duplicate argument. Use --help for usage.');
    seen.add(key);
    if (arg === '--rest') options.rest = true;
    else if (arg === '--tools-only') options.toolsOnly = true;
    else if (arg === '--cache') options.cache = true;
    else if (arg === '--force-refresh') options.forceRefresh = true;
    else if (arg === '--export') options.export = true;
    else if (arg.startsWith('--ttl-seconds=') && /^[0-9]+$/.test(arg.slice(14))) options.ttlSeconds = Number(arg.slice(14));
    else if (arg.startsWith('--tool=') && arg.slice(7)) options.tool = arg.slice(7);
    else if (arg.startsWith('--parameters-file=') && arg.slice(18)) options.parametersFile = arg.slice(18);
    else if (arg.startsWith('--input-file=') && arg.slice(13)) options.inputFile = arg.slice(13);
    else if (arg.startsWith('--roles-file=') && arg.slice(13)) options.rolesFile = arg.slice(13);
    else if (arg.startsWith('--output-dir=') && arg.slice(13)) options.outputDir = arg.slice(13);
    else if (arg.startsWith('--max-reads=') && /^[0-9]+$/.test(arg.slice(12))) options.maxReads = Number(arg.slice(12));
    else if (arg.startsWith('--max-pages=') && /^[0-9]+$/.test(arg.slice(12))) options.maxPages = Number(arg.slice(12));
    else throw new Error('Unknown or invalid argument. Use --help for usage.');
  }
  validateOptions({ forceRefresh: false, ...options });
  return options;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node fetch-pipo.js [--rest | --tools-only | --cache] [--tool=NAME --parameters-file=PATH]\n' +
      'Default: discover all MCP tool pages and fetch the 23 fixed discovery endpoints.\n' +
      'Legacy status/objects are used only if no expanded tool is available.\n' +
      '--tools-only: list live MCP tool descriptions and input schemas without calling tools.\n' +
      '--rest: fetch public PI8 status/objects without credentials or MCP discovery.\n' +
      '--cache: authenticated CAP fetchEndpoint only; no direct MCP/SAP fallback.\n' +
      '--ttl-seconds=N (0..604800) and --force-refresh require --cache.\n' +
      '--tool: exact registry tool name; optional JSON object parameters file (64 KB maximum).\n' +
      '--export: follow catalog identifiers with bounded, read-only definition requests.\n' +
      '--input-file=PATH: reuse an existing discovery catalog with --export (UTF-8/UTF-16 LE).\n' +
      '--roles-file=PATH: supplied destination-scoped UME role inventory; effective access is not verified.\n' +
      '--max-reads=N (default 5000), --max-pages=N (default 100 extra query pages).\n' +
      '--output-dir=PATH (default discovery-runs): unique UTC run folder with reports, logs and hashes.\n' +
      'MCP environment: PIPO_MCP_URL (optional), PIPO_MCP_USER, PIPO_MCP_PASS.\n' +
      'CAP environment: PIPO_CAP_URL, PIPO_CAP_TOKEN (Bearer), or PIPO_CAP_USER/PIPO_CAP_PASS (Basic).\n' +
      'URLs require HTTPS; HTTP is allowed only on localhost. Requests time out after 60 seconds.\n' +
      'Prints JSON (including summary counts) to stdout and count logs to stderr.');
    return;
  }
  let options;
  try { options = parseArgs(args); }
  catch {
    const failure = new Error('Invalid discovery arguments.');
    failure.diagnostic = diagnose(null, { failureCode: 'INVALID_ARGUMENTS' }, { layer: 'client' });
    throw failure;
  }
  const run = await require('./discovery-run').createRun({ outputDir: options.outputDir });
  try {
    await run.event({ event: 'run-start', phase: 'discovery', status: 'started' });
    const output = await fetchPipo({ ...options, event: run.event });
    output.summary = summarizeDiscovery(output);
    await run.event({ event: 'run-finish', phase: 'complete', status: 'completed', counts: output.summary });
    await run.finish(output);
    logSummary(output.summary, (message) => console.error(`[PIPO] ${message}`));
    if (output.export) {
      const counts = output.export.coverage;
      console.error(`[PIPO] Definition reads: ${counts.reads}; verified definitions: ${counts.verifiedDefinitions}; metadata-only: ${counts.metadataOnly}; failed: ${counts.failed}; skipped: ${counts.skippedReads}.`);
      console.error('[PIPO] Migration readiness is not established; review export gaps in report.html.');
    }
    console.error(`[PIPO] Run reports: ${run.directory}`);
    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    const diagnostic = diagnose(null, { status: 'failed', httpStatus: error.httpStatus, failureCode: error.failureCode },
      { layer: error.failureLayer || (options.cache ? 'cap' : 'mcp') });
    await run.event({ event: 'run-failed', phase: 'failed', status: 'failed', httpStatus: error.httpStatus,
      diagnostic }).catch(() => {});
    let reported = false;
    await run.fail().then(() => { reported = true; }).catch(() => {});
    if (reported) console.error(`[PIPO] Run reports: ${run.directory}`);
    const failure = new Error('PIPO discovery failed.');
    failure.diagnostic = diagnostic;
    throw failure;
  }
}

if (require.main === module) {
  main().catch((error) => {
    // SDK/network errors can include response bodies; never echo them or credentials.
    const detail = projectDiagnostic(error?.diagnostic);
    console.error('PIPO fetch failed. ' + (detail ? `${detail.code}: ${detail.reason} ${detail.remediation}` :
      'Check arguments (--help), URL, credentials and server connectivity.'));
    process.exitCode = 1;
  });
}

module.exports = { fetchPipo, parseArgs, defaultParameters, decodeResult, readParametersFile, readDiscoveryFile, endpointResult };