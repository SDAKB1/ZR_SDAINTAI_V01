'use strict';

const { ENDPOINTS } = require('./pipo-endpoints');

const SUCCESS = new Set(['ok', 'success', 'successful', 'completed']);
const STATUSES = new Set([...SUCCESS, 'failed', 'error', 'partial', 'unavailable', 'unsupported',
  'not-found', 'skipped', 'metadata-only', 'needs_parameters', 'unauthorized', 'forbidden', 'timeout']);
const ESR_KEYS = ['object_type', 'object_key', 'swc_guid'];
const ESR_READ = ENDPOINTS.find(endpoint => endpoint.tool === 'fetch_pi8_repository_read_ext');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const artifacts = result => Array.isArray(result.artifacts) ? result.artifacts : [];
const text = value => typeof value === 'string' && value.length <= 4096 &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const successful = result => SUCCESS.has(result.status) && result.metadataOnly !== true &&
  (result.httpStatus === undefined || result.httpStatus >= 200 && result.httpStatus < 300);

function identifierFor(endpoint, value) {
  if (endpoint.category === 'Repository') {
    return record(value) && ESR_KEYS.every(key => text(value[key]) && value[key].trim())
      ? Object.fromEntries(ESR_KEYS.map(key => [key, value[key]])) : null;
  }
  if (text(value)) return value.trim() ? value : null;
  if (!record(value)) return null;
  const keys = Object.keys(value).sort();
  return keys.length > 0 && keys.length <= 24 && keys.every(key =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/^(?:__proto__|prototype|constructor)$/.test(key) &&
    !/password|passwd|pwd|token|secret|credential|authorization|cookie|api[-_]?key|private[-_]?key/i.test(key) &&
    text(value[key])) && keys.some(key => value[key].trim())
    ? Object.fromEntries(keys.map(key => [key, value[key]])) : null;
}

function canonicalResult(endpoint, input) {
  const result = record(input) ? { ...input } : {};
  Object.assign(result, { tool: endpoint.tool, path: endpoint.path, category: endpoint.category,
    kind: endpoint.kind, status: STATUSES.has(result.status) ? result.status : 'failed' });
  if (!Number.isInteger(result.httpStatus) || result.httpStatus < 100 || result.httpStatus > 599) {
    delete result.httpStatus;
  }
  result.artifacts = artifacts(result);
  if (result.status === 'metadata-only' || result.metadataOnly === true) {
    result.artifacts = result.artifacts.map(item => record(item)
      ? { ...item, hasFullDefinition: false, metadataOnly: true } : item);
  }
  return result;
}

async function exportDefinitions({ discovery, fetchEndpoint, event = () => {}, maxReads = 5000, maxPages = 100 }) {
  if (!record(discovery) || !Array.isArray(discovery.endpoints) || typeof fetchEndpoint !== 'function' ||
      typeof event !== 'function' || !integer(maxReads) || !integer(maxPages)) {
    throw new TypeError('Discovery endpoints, fetchEndpoint, event and nonnegative integer limits are required.');
  }
  const reads = [];
  const gaps = new Set();
  // maxPages is a global budget for additional Query requests; supplied discovery
  // pages have already been fetched and do not consume that request budget.
  const coverage = { pages: 0, enumeratedPages: 0, catalogIdentifiers: 0, reads: 0,
    successful: 0, verifiedDefinitions: 0, metadataOnly: 0, failed: 0, skippedReads: 0 };
  const seen = new Set();
  const states = new Map();
  const gap = (endpoint, message) => gaps.add(`${endpoint.tool}: ${message}`);

  async function emit(phase, endpoint, result, counts) {
    const entry = { event: phase === 'read' ? 'read-result' : 'query-finish',
      phase, tool: endpoint.tool, status: result.status, diagnostic: result.diagnostic, counts };
    if (result.httpStatus !== undefined) entry.httpStatus = result.httpStatus;
    await event(entry);
  }

  async function fetch(endpoint, parameters) {
    try { return canonicalResult(endpoint, await fetchEndpoint(endpoint, parameters)); }
    catch (error) {
      if (error?.abortRun === true) throw error;
      // SDK exceptions can contain credentials and request configuration.
      return canonicalResult(endpoint, { status: 'failed', artifacts: [], metadataOnly: true,
        response: { format: 'omitted', body: null } });
    }
  }

  async function read(endpoint, identifier) {
    if (endpoint.category !== 'Repository' && !(endpoint.kind === 'soap' && endpoint.entity)) {
      coverage.skippedReads += 1;
      gap(endpoint, 'Enumerated identifier has no verified Read protocol; no request was invented.');
      return;
    }
    if (reads.length >= maxReads) {
      coverage.skippedReads += 1;
      gap(endpoint, 'maxReads limit reached; some enumerated identifiers were not read.');
      return;
    }
    const target = endpoint.category === 'Repository' ? ESR_READ : endpoint;
    const parameters = target === ESR_READ ? { mode: 'read', ...identifier } :
      { mode: 'read', identifier, maxItems: 1000, offset: 0 };
    const result = await fetch(target, parameters);
    const metadataOnly = result.status === 'metadata-only' || SUCCESS.has(result.status) && result.metadataOnly === true;
    const incomplete = result.truncated === true || integer(result.offset) && result.offset > 0 ||
      integer(result.actualCount) && result.actualCount > artifacts(result).length ||
      integer(result.reportedCount) && result.reportedCount > artifacts(result).length;
    const verifiedDefinition = successful(result) && !incomplete && artifacts(result).some(item =>
      record(item) && item.hasFullDefinition === true && item.metadataOnly !== true && item.definition != null);
    reads.push({ sourceTool: endpoint.tool, identifier, status: result.status, result, verifiedDefinition });
    coverage.reads += 1;
    if (verifiedDefinition) coverage.verifiedDefinitions += 1;
    if (metadataOnly) {
      coverage.metadataOnly += 1;
      gap(endpoint, 'Read payload retained as metadata-only; the full definition contract is not verified.');
    } else if (!successful(result)) {
      coverage.failed += 1;
      gap(endpoint, 'Read failed or is unsupported; some definitions remain unavailable.');
    } else {
      coverage.successful += 1;
      if (!verifiedDefinition) gap(endpoint, 'Read did not establish a verified full definition.');
    }
    if (incomplete) gap(endpoint, 'Read result is truncated; definition coverage is incomplete.');
    await emit('read', target, result, { reads: coverage.reads,
      fullDefinitions: verifiedDefinition ? 1 : 0, artifacts: artifacts(result).length });
  }

  async function inspect(endpoint, page, state, requestedOffset) {
    coverage.enumeratedPages += 1;
    const rows = artifacts(page);
    await emit('query', endpoint, page, { artifacts: rows.length,
      catalogIdentifiers: coverage.catalogIdentifiers, attempted: coverage.pages });
    if (!successful(page)) {
      gap(endpoint, page.status === 'metadata-only' || SUCCESS.has(page.status) && page.metadataOnly === true
        ? 'Enumeration is metadata-only; no verified Query contract or complete identifier catalog.'
        : 'Enumeration failed or is unsupported; the identifier catalog is incomplete.');
      return null;
    }
    const offset = integer(page.offset) ? page.offset : requestedOffset;
    const returned = integer(page.returned) ? page.returned : rows.length;
    const ids = rows.map(item => identifierFor(endpoint, record(item) ? item.identifier : null));
    const signature = JSON.stringify(ids.map(id => JSON.stringify(id)).sort());
    const repeated = rows.length > 0 && state.signatures.has(signature);
    state.signatures.add(signature);
    if (ids.some(id => id === null)) gap(endpoint, 'Missing or invalid identifiers; names are not used to invent Read IDs.');
    for (const identifier of ids) {
      if (identifier === null) continue;
      const identity = JSON.stringify([endpoint.tool, identifier]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      coverage.catalogIdentifiers += 1;
      state.identifiers += 1;
      await read(endpoint, identifier);
    }
    if (repeated) {
      gap(endpoint, 'Repeated page detected; enumeration stopped before completing the catalog.');
      return null;
    }
    if (offset !== requestedOffset || returned !== rows.length) {
      gap(endpoint, 'Inconsistent pagination counts or offset; truncated enumeration stopped.');
      return null;
    }
    if (offset > 0 && !state.offsets.has(0)) gap(endpoint, 'Initial enumeration page is missing; the catalog starts at a nonzero offset.');
    if (integer(page.reportedCount) && integer(page.actualCount) && page.reportedCount > page.actualCount) {
      gap(endpoint, 'Reported count exceeds parsed records; the enumeration response is truncated.');
    }
    const next = offset + returned;
    if (integer(page.actualCount) && page.actualCount > next) {
      if (!returned || next > 1000000) {
        gap(endpoint, 'Truncated enumeration made no progress or exceeded the supported offset limit.');
        return null;
      }
      return next;
    }
    // The fetcher marks every nonzero-offset page truncated, even the last one.
    if ((!integer(page.actualCount) && page.truncated === true) ||
        (offset === 0 && page.truncated === true && !integer(page.reportedCount)) ||
        (integer(page.reportedCount) && page.reportedCount > next)) {
      gap(endpoint, 'Truncated enumeration has no further parsed page to request.');
    }
    if (integer(page.actualCount) && state.identifiers < page.actualCount) {
      gap(endpoint, 'Unique identifier coverage is below the actual count; overlapping or missing IDs remain.');
    }
    return null;
  }

  // Group supplied pages first, so an already supplied page is not fetched again.
  for (const input of [...discovery.endpoints]) {
    if (!record(input)) continue;
    const endpoint = ENDPOINTS.find(entry => entry.tool === input.tool || entry.path === input.path);
    if (!endpoint) { gaps.add('Unregistered discovery endpoint ignored; no inferred tools or paths were requested.'); continue; }
    const enumerable = endpoint.kind === 'soap' && endpoint.entity && endpoint.category === 'Directory' ||
      endpoint.kind === 'simple-query' || endpoint.kind === 'query';
    if (!enumerable) {
      if (endpoint.kind !== 'diagnostic') gap(endpoint, 'Probe-only endpoint has no verified enumeration/full-definition contract.');
      continue;
    }
    if (!states.has(endpoint.tool)) states.set(endpoint.tool, { endpoint, pages: new Map(),
      offsets: new Set(), signatures: new Set(), identifiers: 0 });
    const state = states.get(endpoint.tool);
    const page = canonicalResult(endpoint, input);
    const offset = integer(page.offset) ? page.offset : 0;
    if (!state.pages.has(offset)) state.pages.set(offset, page);
  }

  for (const state of states.values()) {
    const { endpoint } = state;
    const supplied = [...state.pages.keys()].sort((a, b) => a - b);
    for (const start of supplied) {
      if (state.offsets.has(start)) continue;
      let offset = start;
      while (offset !== null && !state.offsets.has(offset)) {
        let page = state.pages.get(offset);
        if (!page) {
          if (coverage.pages >= maxPages) {
            gap(endpoint, 'maxPages limit reached; truncated enumeration remains incomplete.');
            break;
          }
          coverage.pages += 1;
          page = await fetch(endpoint, { mode: 'query', maxItems: 1000, offset });
          (discovery.pages ||= []).push(page);
          state.pages.set(offset, page);
        }
        state.offsets.add(offset);
        offset = await inspect(endpoint, page, state, offset);
      }
    }
  }
  if (!states.size) gaps.add('No registered enumeration endpoints were supplied; no complete identifier catalog is verified.');
  gaps.add('Dependent binaries, archives, referenced objects, credentials and target-platform compatibility are not verified; this is not a complete migration export.');
  return { reads, coverage, gaps: [...gaps], migrationReady: false, dependencies: {
    status: 'not-verified', binaries: 'not-verified', archives: 'not-verified',
    referencedObjects: 'not-verified', credentials: 'not-verified', targetCompatibility: 'not-verified'
  } };
}

module.exports = { exportDefinitions };