'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ENDPOINTS } = require('./pipo-endpoints');
const { exportDefinitions } = require('./definition-export');

const channel = ENDPOINTS.find(endpoint => endpoint.entity === 'CommunicationChannel');
const component = ENDPOINTS.find(endpoint => endpoint.entity === 'BusinessComponent');
const simple = ENDPOINTS.find(endpoint => endpoint.kind === 'simple-query');
const repositoryQuery = ENDPOINTS.find(endpoint => endpoint.tool === 'fetch_pi8_repository_query_ext');
const repositoryRead = ENDPOINTS.find(endpoint => endpoint.tool === 'fetch_pi8_repository_read_ext');
const row = identifier => ({ identifier, hasFullDefinition: false, metadataOnly: false });
const page = (endpoint, identifiers, actualCount = identifiers.length, offset = 0, extra = {}) => ({
  ...endpoint, status: 'ok', httpStatus: 200, metadataOnly: false, offset,
  actualCount, returned: identifiers.length, truncated: offset > 0 || actualCount > identifiers.length,
  artifacts: identifiers.map(row), ...extra
});
const full = endpoint => ({ ...endpoint, status: 'ok', httpStatus: 200, metadataOnly: false,
  actualCount: 1, returned: 1, offset: 0, truncated: false,
  artifacts: [{ type: endpoint.entity, hasFullDefinition: true, metadataOnly: false,
    definition: { configuration: 'retained-in-result-only' } }] });
const hasGap = (output, pattern) => assert.ok(output.gaps.some(gap => pattern.test(gap)), String(pattern));

test('pagination follows actual counts, deduplicates overlaps and stops on a truncated final offset', async () => {
  const discovery = { endpoints: [page(channel, ['private-one', 'private-two'], 5)] };
  const calls = [];
  const events = [];
  const output = await exportDefinitions({ discovery, event: async entry => { events.push(entry); },
    fetchEndpoint: async (endpoint, parameters) => {
      assert.equal(endpoint, channel, 'the fixed descriptor, not a discovery object, is requested');
      calls.push(parameters);
      if (parameters.mode === 'read') {
        assert.deepEqual(parameters, { mode: 'read', identifier: parameters.identifier, maxItems: 1000, offset: 0 });
        return full(endpoint);
      }
      assert.equal(parameters.maxItems, 1000);
      return parameters.offset === 2 ? page(channel, ['private-two', 'private-three'], 5, 2)
        : page(channel, ['private-four'], 5, 4);
    } });
  assert.deepEqual(calls.filter(call => call.mode === 'query').map(call => call.offset), [2, 4]);
  assert.deepEqual(output.reads.map(read => read.identifier), ['private-one', 'private-two', 'private-three', 'private-four']);
  assert.ok(output.reads.every(read => read.sourceTool === channel.tool && read.status === 'ok' && read.verifiedDefinition));
  assert.equal(output.coverage.catalogIdentifiers, 4);
  assert.equal(output.coverage.verifiedDefinitions, 4);
  assert.equal(output.coverage.pages, 2);
  assert.equal(discovery.endpoints.length, 1);
  assert.equal(discovery.pages.length, 2);
  assert.equal(events.length, 7, 'one metadata event for every page and read');
  for (const entry of events) {
    assert.deepEqual(Object.keys(entry).sort(), ['counts', 'diagnostic', 'event', 'httpStatus', 'phase', 'status', 'tool']);
    assert.ok(['query', 'read'].includes(entry.phase));
    assert.equal(entry.tool, channel.tool);
  }
  assert.doesNotMatch(JSON.stringify(events), /private-|retained-in-result-only|identifier|definition|response/);
  hasGap(output, /overlapping or missing IDs/);
  assert.equal(output.migrationReady, false);
  assert.ok(Object.values(output.dependencies).every(value => value === 'not-verified'));
});

test('Directory composite identifiers are canonicalized per endpoint without inventing name-based IDs', async () => {
  const id = { PartyID: '', ServiceID: 'svc', ChannelID: 'chan' };
  const reordered = { ChannelID: 'chan', ServiceID: 'svc', PartyID: '' };
  const discovery = { endpoints: [page(channel, [id, reordered], 2, 0, {
    artifacts: [row(id), row(reordered), { name: 'not-an-identifier' }, row({ ServiceID: 42 })], returned: 4
  }), page(component, [reordered])] };
  const calls = [];
  const output = await exportDefinitions({ discovery, fetchEndpoint: async (endpoint, parameters) => {
    calls.push({ endpoint, parameters });
    return full(endpoint);
  } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.endpoint), [channel, component]);
  assert.deepEqual(calls.map(call => call.parameters.identifier), [id, id]);
  assert.equal(output.coverage.catalogIdentifiers, 2);
  hasGap(output, /Missing or invalid identifiers/);
});

test('SimpleQuery and repository Query IDs use only the fixed ESR Read parameters and retain payloads', async () => {
  const identifier = { object_type: 'XI_TRAFO', object_key: 'mapping|urn:namespace', swc_guid: 'swc-guid',
    vc: 'SWC', sp: '-1', uc: 'false', release: '7.0' };
  const response = { format: 'xml', body: { RepositoryObject: { content: 'sanitized-payload' } } };
  const output = await exportDefinitions({ discovery: { endpoints: [page(simple, [identifier]),
    page(repositoryQuery, [identifier, { object_type: 'XI_TRAFO', object_key: 'missing-guid' }])] },
  fetchEndpoint: async (endpoint, parameters) => {
    assert.equal(endpoint, repositoryRead);
    assert.deepEqual(parameters, { mode: 'read', ...identifier });
    return { ...full(endpoint), status: 'metadata-only', metadataOnly: true, response,
      cache: { status: 'hit' } };
  } });
  assert.equal(output.reads.length, 2, 'deduplication is scoped to the source endpoint');
  assert.deepEqual(output.reads.map(read => read.sourceTool), [simple.tool, repositoryQuery.tool]);
  for (const read of output.reads) {
    assert.equal(read.verifiedDefinition, false);
    assert.deepEqual(read.result.response, response);
    assert.deepEqual(read.result.cache, { status: 'hit' });
    assert.ok(read.result.artifacts.every(item => item.hasFullDefinition === false && item.metadataOnly === true));
  }
  assert.equal(output.coverage.metadataOnly, 2);
  assert.equal(output.coverage.verifiedDefinitions, 0);
  hasGap(output, /metadata-only/);
  hasGap(output, /Missing or invalid identifiers/);
  hasGap(output, /Dependent binaries.*not verified/);
});

test('legacy and incomplete ESR catalogs retain counts but skip Reads instead of inventing version context', async () => {
  const base = { object_type: 'XI_TRAFO', object_key: 'mapping|urn:namespace', swc_guid: 'swc-guid' };
  const context = { vc: 'SWC', sp: '-1', uc: 'false', release: '7.0' };
  const identifiers = [base, ...Object.keys(context).map((missing, index) => ({ ...base,
    object_key: `mapping${index}|urn:namespace`, ...Object.fromEntries(Object.entries(context).filter(([key]) => key !== missing)) })),
  { ...base, object_key: 'invalid|urn:namespace', ...context, release: '7.0\n' }];
  let calls = 0;
  const output = await exportDefinitions({ discovery: { endpoints: [page(simple, identifiers)] },
    fetchEndpoint: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(output.coverage.catalogIdentifiers, identifiers.length);
  assert.equal(output.coverage.skippedReads, identifiers.length);
  assert.equal(output.coverage.reads, 0);
  assert.equal(output.reads.length, 0);
  hasGap(output, /version context.*rerun discovery/);
});

test('maxReads and maxPages are global request budgets across endpoints', async () => {
  const calls = [];
  const output = await exportDefinitions({ maxReads: 1, maxPages: 1,
    discovery: { endpoints: [page(channel, ['first'], 3), page(component, ['second'], 3)] },
    fetchEndpoint: async (endpoint, parameters) => {
      calls.push(parameters.mode);
      return parameters.mode === 'query' ? page(endpoint, ['next'], 3, parameters.offset) : full(endpoint);
    } });
  assert.deepEqual(calls, ['read', 'query']);
  assert.equal(output.coverage.pages, 1);
  assert.equal(output.coverage.reads, 1);
  assert.equal(output.coverage.skippedReads, 2);
  hasGap(output, /maxReads limit/);
  hasGap(output, /maxPages limit/);
});

test('zero budgets make no new requests and still report pending reads and pages', async () => {
  let calls = 0;
  const output = await exportDefinitions({ maxReads: 0, maxPages: 0,
    discovery: { endpoints: [page(channel, ['first'], 2)] },
    fetchEndpoint: async () => { calls += 1; return full(channel); } });
  assert.equal(calls, 0);
  assert.equal(output.reads.length, 0);
  hasGap(output, /maxReads/);
  hasGap(output, /maxPages/);
});

test('repeated pages stop even if the server changes ID order and claims a large count', async () => {
  let queries = 0;
  const output = await exportDefinitions({ discovery: { endpoints: [page(channel, ['one', 'two'], 10000)] },
    fetchEndpoint: async (endpoint, parameters) => {
      if (parameters.mode === 'read') return full(endpoint);
      queries += 1;
      return page(endpoint, ['two', 'one'], 10000, parameters.offset);
    } });
  assert.equal(queries, 1);
  assert.equal(output.reads.length, 2);
  hasGap(output, /Repeated page/);
});

test('empty, inconsistent and reported-only truncated pages leave explicit gaps without looping', async () => {
  let calls = 0;
  const output = await exportDefinitions({ maxReads: 0, discovery: { endpoints: [
    page(channel, [], 5), page(component, ['one'], 1, 0, { reportedCount: 3, truncated: true }),
    page(repositoryQuery, [], 5, 0, { returned: 2 })
  ] }, fetchEndpoint: async () => { calls += 1; } });
  assert.equal(calls, 0);
  hasGap(output, /no progress/);
  hasGap(output, /Reported count exceeds/);
  hasGap(output, /Inconsistent pagination/);
});

test('failed enumeration and metadata-only contracts never yield name-derived reads', async () => {
  let calls = 0;
  const output = await exportDefinitions({ discovery: { endpoints: [
    page(channel, ['ignored-id'], 1, 0, { status: 'failed', metadataOnly: true, httpStatus: 503 }),
    page(component, ['ignored-id'], 1, 0, { status: 'metadata-only', metadataOnly: true }),
    { ...simple, status: 'needs_parameters', artifacts: [{ name: 'not-an-id' }] }
  ] }, fetchEndpoint: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(output.reads.length, 0);
  hasGap(output, /Enumeration failed/);
  hasGap(output, /Enumeration is metadata-only/);
});

test('read failures and thrown page requests are retained safely with explicit gaps', async () => {
  const events = [];
  const discovery = { endpoints: [page(channel, ['throw-read', 'failed-read'], 3)] };
  const output = await exportDefinitions({ discovery, event: entry => { events.push(entry); },
    fetchEndpoint: async (endpoint, parameters) => {
      if (parameters.mode === 'query' || parameters.identifier === 'throw-read') throw new Error('PRIVATE_EXCEPTION_MARKER');
      return { ...endpoint, status: 'failed', httpStatus: 500, metadataOnly: true, artifacts: [] };
    } });
  assert.equal(output.reads.length, 2);
  assert.ok(output.reads.every(read => read.status === 'failed' && !read.verifiedDefinition));
  assert.equal(output.coverage.failed, 2);
  assert.equal(output.coverage.metadataOnly, 0);
  assert.equal(discovery.endpoints.length, 1, 'continuation pages must not inflate distinct endpoint coverage');
  assert.equal(discovery.pages.length, 1);
  assert.equal(discovery.pages[0].status, 'failed');
  hasGap(output, /Read failed/);
  hasGap(output, /Enumeration failed/);
  assert.doesNotMatch(JSON.stringify(output) + JSON.stringify(events), /PRIVATE_EXCEPTION_MARKER/);
});

test('supplied continuation pages are reused and final offset truncation alone is not a gap', async () => {
  const calls = [];
  const output = await exportDefinitions({ discovery: { endpoints: [page(channel, ['last'], 2, 1),
    page(channel, ['first'], 2)] }, fetchEndpoint: async (endpoint, parameters) => {
    calls.push(parameters.mode);
    return full(endpoint);
  } });
  assert.deepEqual(calls, ['read', 'read']);
  assert.equal(output.coverage.catalogIdentifiers, 2);
  assert.equal(output.coverage.pages, 0);
  assert.equal(output.gaps.length, 1, 'only unverified dependencies remain');
});

test('unregistered tools and probe-only protocols cannot choose request targets', async () => {
  let calls = 0;
  const directoryQuery = ENDPOINTS.find(endpoint => endpoint.tool === 'fetch_pi8_directory_query_ext');
  const output = await exportDefinitions({ discovery: { endpoints: [
    { tool: 'unregistered-tool', path: '/unregistered', status: 'ok', artifacts: [row('one')] },
    { ...repositoryRead, status: 'metadata-only' }, page(directoryQuery, ['cannot-read'])
  ] }, fetchEndpoint: async () => { calls += 1; } });
  assert.equal(calls, 0);
  hasGap(output, /Unregistered/);
  hasGap(output, /Probe-only/);
  hasGap(output, /no verified Read protocol/);
});

test('unverified, truncated and HTTP-failed Read results are never verified definitions', async () => {
  const results = [
    { ...full(channel), artifacts: [] },
    { ...full(channel), truncated: true },
    { ...full(channel), httpStatus: 500 }
  ];
  const output = await exportDefinitions({ discovery: { endpoints: [page(channel, ['one', 'two', 'three'])] },
    fetchEndpoint: async () => results.shift() });
  assert.ok(output.reads.every(read => read.verifiedDefinition === false));
  hasGap(output, /did not establish/);
  hasGap(output, /Read result is truncated/);
  hasGap(output, /Read failed/);
});

test('invalid budgets are rejected before fetching; event failures are not swallowed as endpoint failures', async () => {
  let calls = 0;
  const options = { discovery: { endpoints: [page(channel, ['one'])] },
    fetchEndpoint: async () => { calls += 1; return full(channel); } };
  for (const limit of [-1, 1.5, Infinity, '2']) {
    await assert.rejects(exportDefinitions({ ...options, maxReads: limit }), TypeError);
    await assert.rejects(exportDefinitions({ ...options, maxPages: limit }), TypeError);
  }
  await assert.rejects(exportDefinitions({ ...options, event: async () => { throw new Error('event-write-failed'); } }),
    /event-write-failed/);
  assert.equal(calls, 0);
});