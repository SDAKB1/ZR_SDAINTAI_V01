'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fetchPipo, parseArgs, defaultParameters, decodeResult, endpointResult } = require('./fetch-pipo');
const { ENDPOINTS } = require('./pipo-endpoints');
const { endpointSchema } = require('./endpoint-fetcher');
const { summarizeDiscovery } = require('./discovery-report');
const { MAX_PAYLOAD_BYTES, REQUEST_TIMEOUT } = require('./cap-cache-client');

const toolNames = ['call_rfc', 'get_rfc_metadata', 'get_pi8_status', 'list_pi8_esr_objects'];
const status = { reachable: false, system: 'PI8', destinations: {} };
const objects = { verified: true, totalCount: 243, returned: 1, items: [{ name: 'ExampleInterface' }] };

async function fixture(t, options = {}) {
  const calls = [];
  const env = { PIPO_MCP_USER: randomUUID(), PIPO_MCP_PASS: randomUUID() };
  const authorization = 'Basic ' + Buffer.from(`${env.PIPO_MCP_USER}:${env.PIPO_MCP_PASS}`).toString('base64');
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      calls.push({ path: req.url, hasAuth: Boolean(req.headers.authorization) });
      res.writeHead(options.httpError ? 502 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(options.httpError ? { error: 'upstream failure' } :
        req.url.endsWith('/ping') ? status : objects));
      return;
    }
    if (options.unauthorized || req.headers.authorization !== authorization) {
      res.writeHead(401);
      res.end(options.errorBody || 'Authentication required.');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end(); // The production server is stateless, with no GET/SSE stream.
      return;
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    calls.push({ method: body.method, params: body.params });
    if (body.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (body.method === 'initialize') {
      result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'offline-pipo', version: '1.0.0' } };
    } else if (body.method === 'tools/list') {
      const available = options.toolNames || toolNames;
      const names = body.params?.cursor ? available.slice(2) : available.slice(0, 2);
      result = { tools: names.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) };
      if (!body.params?.cursor) result.nextCursor = 'second-page';
    } else if (body.method === 'tools/call') {
      if (body.params.name === options.httpFailureTool) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(env.PIPO_MCP_PASS);
        return;
      }
      const data = body.params.name === 'get_pi8_status' ? status : objects;
      result = options.resultFor ? options.resultFor(body.params.name, env, body.params.arguments) :
        options.toolError ? { isError: true, content: [{ type: 'text', text: 'internal server details' }] } :
        { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } else {
      res.writeHead(400).end();
      return;
    }
    const message = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    res.writeHead(200, { 'Content-Type': options.sse ? 'text/event-stream' : 'application/json' });
    res.end(options.sse ? `event: message\ndata: ${message}\n\n` : message);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  env.PIPO_MCP_URL = `http://127.0.0.1:${server.address().port}/mcp`;
  return { env, calls };
}

test('MCP initializes, discovers every page and calls only the read-only PI8 tools', async (t) => {
  const { env, calls } = await fixture(t);
  const output = await fetchPipo({ env });
  assert.deepEqual(output.tools.map((tool) => tool.name), toolNames);
  assert.deepEqual(output.status, status);
  assert.deepEqual(output.objects, objects);
  assert.equal(output.discovery.endpoints.length, 23);
  assert.ok(output.discovery.endpoints.every((endpoint) => endpoint.status === 'unavailable'));
  assert.equal(summarizeDiscovery(output).source, 'legacy');
  assert.equal(summarizeDiscovery(output).coverage.unavailable, 23);
  assert.equal(calls[0].method, 'initialize');
  assert.equal(calls.filter((call) => call.method === 'tools/list').length, 2);
  assert.deepEqual(calls.filter((call) => call.method === 'tools/call').map((call) => call.params), [
    { name: 'get_pi8_status', arguments: {} }, { name: 'list_pi8_esr_objects', arguments: {} }
  ]);
});

test('tools-only discovers schemas without executing any tools', async (t) => {
  const { env, calls } = await fixture(t);
  const output = await fetchPipo({ env, toolsOnly: true });
  assert.equal(output.tools.length, 4);
  assert.deepEqual(output.tools[0].inputSchema, { type: 'object' });
  assert.equal(calls.some((call) => call.method === 'tools/call'), false);
});

test('MCP supports the SSE responses used by the PIPO server', async (t) => {
  const { env } = await fixture(t, { sse: true });
  const output = await fetchPipo({ env });
  assert.deepEqual(output.objects, objects);
});

test('MCP tool errors fail instead of returning an apparent success', async (t) => {
  const { env } = await fixture(t, { toolError: true });
  await assert.rejects(fetchPipo({ env }), /Tool get_pi8_status failed/);
});

test('MCP error envelopes preserve only safe endpoint diagnostics and cannot report success', () => {
  const endpoint = ENDPOINTS.find(e => e.tool === 'fetch_pi8_message_diagnostics');
  for (const httpStatus of [401, 403, 503]) {
    const payload = { status: 'failed', httpStatus, failureLayer: 'source', failureCode: 'SOAP_FAULT',
      path: 'synthetic-private-path', response: { body: 'synthetic-private-body' },
      headers: { authorization: 'synthetic-private-header' }, artifacts: [{ definition: 'synthetic-private-definition' }],
      warnings: ['synthetic-private-warning'] };
    for (const envelope of [
      { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] },
      { isError: true, structuredContent: payload }
    ]) {
      const output = endpointResult(endpoint, envelope, {});
      assert.equal(output.status, 'failed');
      assert.equal(output.httpStatus, httpStatus);
      assert.equal(output.failureLayer, 'source');
      assert.equal(output.failureCode, 'SOAP_FAULT');
      assert.equal(output.path, '/mdt');
      assert.deepEqual(output.artifacts, []);
      assert.deepEqual(output.response, { format: 'omitted', body: null });
      assert.doesNotMatch(JSON.stringify(output), /synthetic-private/);
    }
  }
  const needs = endpointResult(endpoint, { isError: true,
    structuredContent: { status: 'needs_parameters', httpStatus: 200, failureLayer: 'source' } }, {});
  assert.equal(needs.status, 'needs_parameters');
  assert.equal(needs.httpStatus, 200);
  for (const payload of [{ status: 'ok', httpStatus: 200, artifacts: [{ name: 'synthetic-private-artifact' }] },
    { status: 'failed', httpStatus: 'synthetic-private-status', failureLayer: 'synthetic-private-layer' }]) {
    const output = endpointResult(endpoint, { isError: true, structuredContent: payload }, {});
    assert.equal(output.status, 'failed');
    assert.equal(output.failureLayer, 'mcp');
    assert.deepEqual(output.artifacts, []);
    assert.doesNotMatch(JSON.stringify(output), /synthetic-private/);
  }
});

test('discovery reports source 403 from the real MCP error-envelope shape', async t => {
  const endpoint = ENDPOINTS.find(e => e.tool === 'fetch_pi8_cpa_cache');
  const { env } = await fixture(t, { toolNames: [endpoint.tool], resultFor: () => ({ isError: true,
    content: [{ type: 'text', text: JSON.stringify({ status: 'failed', httpStatus: 403, failureLayer: 'source',
      response: { body: 'synthetic-private-body' }, artifacts: [] }) }] }) });
  const output = await fetchPipo({ env, tool: endpoint.tool });
  const result = output.discovery.endpoints[0];
  assert.equal(result.status, 'failed');
  assert.equal(result.httpStatus, 403);
  assert.equal(result.diagnostic.code, 'FORBIDDEN');
  assert.equal(result.diagnostic.layer, 'source');
  assert.equal(result.diagnostic.roleAssessment.effectivePermissionsVerified, false);
  assert.doesNotMatch(JSON.stringify(output), /synthetic-private-body/);
});

test('REST accepts a base URL or MCP URL and never sends Basic Auth', async (t) => {
  const { env, calls } = await fixture(t);
  for (const url of [env.PIPO_MCP_URL, env.PIPO_MCP_URL.replace(/mcp$/, '')]) {
    const output = await fetchPipo({ env: { ...env, PIPO_MCP_URL: url }, rest: true });
    assert.deepEqual(output, { mode: 'rest', status, objects });
  }
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/pi8/ping', '/api/pi8/objects', '/api/pi8/ping', '/api/pi8/objects'
  ]);
  assert.equal(calls.some((call) => call.hasAuth), false);
});

test('REST rejects upstream HTTP errors', async (t) => {
  const { env } = await fixture(t, { httpError: true });
  await assert.rejects(fetchPipo({ env, rest: true }), /HTTP 502/);
});

test('CLI authentication failure exits nonzero without echoing server error bodies', async (t) => {
  const errorBody = randomUUID();
  const { env } = await fixture(t, { unauthorized: true, errorBody });
  const child = spawn(process.execPath, [require.resolve('./fetch-pipo')], { env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /PIPO fetch failed/);
  assert.ok(!stderr.includes(errorBody) && !stderr.includes(env.PIPO_MCP_PASS));
});

test('CLI writes counts to stderr while preserving valid artifact JSON on stdout', async (t) => {
  const { env } = await fixture(t);
  const child = spawn(process.execPath, [require.resolve('./fetch-pipo'), '--rest'], {
    env: { ...process.env, ...env }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const output = JSON.parse(stdout);
  assert.deepEqual(output.objects, objects);
  assert.equal(output.summary.catalogIdentifiers, 1);
  assert.equal(output.summary.reportedTotal, 243);
  assert.match(stderr, /Extracted catalog identifiers: 1; service interfaces: 0/);
  assert.match(stderr, /ESR: 1 catalog identifiers/);
  assert.ok(!stderr.includes('ExampleInterface'));
});

test('invalid configuration is rejected before connecting', async () => {
  await assert.rejects(fetchPipo({ env: {} }), /Set PIPO_MCP_USER/);
  await assert.rejects(fetchPipo({ rest: true, toolsOnly: true }), /requires MCP mode/);
  await assert.rejects(fetchPipo({ env: { PIPO_MCP_URL: 'http://example.com/mcp' } }), /Use HTTPS/);
  await assert.rejects(fetchPipo({ env: { PIPO_MCP_URL: 'https://example.com/mcp?token=unused' } }), /query parameters/);
});

function expandedPayload(endpoint) {
  const query = defaultParameters(endpoint).mode === 'query';
  const diagnostic = endpoint.kind === 'diagnostic';
  return { status: 'ok', httpStatus: 200, metadataOnly: !query && !diagnostic,
    artifacts: [{ name: 'Fixture artifact', category: endpoint.category,
      type: diagnostic ? 'DiagnosticSnapshot' : query ? endpoint.entity || 'ServiceInterface' : 'WSDL',
      hasFullDefinition: false }] };
}

test('expanded discovery calls all 23 fixed tools with safe defaults, without legacy tools or RFC', async (t) => {
  const names = [...toolNames, ...ENDPOINTS.map((endpoint) => endpoint.tool)];
  const { env, calls } = await fixture(t, { toolNames: names, resultFor(name) {
    const endpoint = ENDPOINTS.find((entry) => entry.tool === name);
    const payload = expandedPayload(endpoint);
    return ENDPOINTS.indexOf(endpoint) % 2 ? { content: [], structuredContent: payload } :
      { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  } });
  const output = await fetchPipo({ env });
  assert.equal(REQUEST_TIMEOUT, 60000);
  assert.equal(calls.filter((call) => call.method === 'tools/list').length, 2);
  assert.deepEqual(calls.filter((call) => call.method === 'tools/call').map((call) => call.params),
    ENDPOINTS.map((endpoint) => ({ name: endpoint.tool, arguments: defaultParameters(endpoint) })));
  for (const [index, endpoint] of ENDPOINTS.entries()) {
    const result = output.discovery.endpoints[index];
    assert.equal(result.tool, endpoint.tool);
    assert.equal(result.path, endpoint.path);
    assert.equal(result.category, endpoint.category);
    assert.equal(result.kind, endpoint.kind);
    const parameters = defaultParameters(endpoint);
    assert.equal(endpointSchema(endpoint).safeParse(parameters).success, true, endpoint.tool);
    if (endpoint.kind === 'read' || endpoint.kind === 'query') assert.equal(parameters.mode, 'metadata');
    if (endpoint.kind === 'simple-query' || endpoint.entity) assert.equal(parameters.mode, 'query');
    if (endpoint.kind === 'query' || endpoint.kind === 'simple-query' || endpoint.entity) {
      assert.equal(parameters.maxItems, 1000);
      assert.equal(parameters.offset, 0);
    }
  }
  assert.equal(output.objects, undefined);
  assert.equal(output.status, undefined);
  assert.equal(output.discovery.artifacts, undefined);
  const summary = summarizeDiscovery(output);
  assert.equal(summary.source, 'endpoints');
  assert.equal(summary.coverage.total, 23);
  assert.equal(summary.coverage.successful, 23);
  assert.equal(summary.catalogIdentifiers, 14);
  assert.equal(summary.metadataDocuments, 6);
  assert.equal(summary.diagnosticSnapshots, 3);
});

test('missing expanded tools are unavailable, and one available tool suppresses the legacy batch', async (t) => {
  const endpoint = ENDPOINTS[1];
  const { env, calls } = await fixture(t, { toolNames: [...toolNames, endpoint.tool],
    resultFor: () => ({ content: [], structuredContent: expandedPayload(endpoint) }) });
  const output = await fetchPipo({ env });
  assert.deepEqual(calls.filter((call) => call.method === 'tools/call').map((call) => call.params.name), [endpoint.tool]);
  assert.equal(output.discovery.endpoints.filter((entry) => entry.status === 'unavailable').length, 22);
  assert.equal(output.objects, undefined);
});

test('expanded tool, parse and payload failures are isolated and cannot forge endpoint identity or echo credentials', async (t) => {
  const { env, calls } = await fixture(t, { toolNames: ENDPOINTS.map((endpoint) => endpoint.tool),
    httpFailureTool: ENDPOINTS[3].tool,
    resultFor(name, credentials) {
      const index = ENDPOINTS.findIndex((endpoint) => endpoint.tool === name);
      if (index === 0) return { isError: true, content: [{ type: 'text', text: credentials.PIPO_MCP_PASS }] };
      if (index === 1) return { content: [], structuredContent: {
        status: 'failed', path: credentials.PIPO_MCP_PASS, category: credentials.PIPO_MCP_USER,
        response: { body: credentials.PIPO_MCP_PASS }, artifacts: [{ name: credentials.PIPO_MCP_PASS }] } };
      if (index === 2) return { content: [{ type: 'text', text: '{invalid secret JSON' }] };
      return { content: [], structuredContent: { ...expandedPayload(ENDPOINTS[index]),
        note: credentials.PIPO_MCP_PASS, password: credentials.PIPO_MCP_PASS,
        pair: { Name: 'Authorization', Value: credentials.PIPO_MCP_PASS },
        path: 'untrusted', category: 'untrusted' } };
    } });
  const output = await fetchPipo({ env });
  assert.equal(calls.filter((call) => call.method === 'tools/call').length, 23);
  for (const [index, endpoint] of output.discovery.endpoints.entries()) {
    assert.equal(endpoint.path, ENDPOINTS[index].path);
    assert.equal(endpoint.category, ENDPOINTS[index].category);
    if (index < 4) {
      assert.equal(endpoint.status, 'failed');
      assert.deepEqual(endpoint.response, { format: 'omitted', body: null });
      assert.deepEqual(endpoint.artifacts, []);
    }
  }
  assert.equal(summarizeDiscovery(output).coverage.failed, 4);
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes(env.PIPO_MCP_USER) && !serialized.includes(env.PIPO_MCP_PASS));
  assert.ok(!serialized.includes('invalid secret JSON'));
});

test('single known tools accept SOAP identifiers and ESR read arguments without calling other tools', async (t) => {
  const { env, calls } = await fixture(t, { toolNames: ENDPOINTS.map((endpoint) => endpoint.tool),
    resultFor: () => ({ content: [], structuredContent: { status: 'ok', artifacts: [] } }) });
  const cases = [
    { tool: ENDPOINTS[1].tool, parameters: { mode: 'read', identifier: { Name: 'Fixture' } } },
    { tool: 'fetch_pi8_repository_read_ext', parameters: { mode: 'read', object_type: 'ifmmessif',
      object_key: 'fixture-key', swc_guid: 'fixture-guid' } }
  ];
  for (const options of cases) {
    const output = await fetchPipo({ ...options, env });
    assert.equal(output.discovery.endpoints.length, 1);
  }
  assert.deepEqual(calls.filter((call) => call.method === 'tools/call').map((call) => call.params),
    cases.map(({ tool, parameters }) => ({ name: tool,
      arguments: { ...defaultParameters(ENDPOINTS.find((endpoint) => endpoint.tool === tool)), ...parameters } })));
});

test('decoding is bounded and failures never retain an upstream body', () => {
  assert.throws(() => decodeResult('x'.repeat(MAX_PAYLOAD_BYTES + 1)), /oversized/);
  assert.throws(() => decodeResult({ structuredContent: { text: 'x'.repeat(MAX_PAYLOAD_BYTES) } }), /5 MB/);
  assert.throws(() => decodeResult({ content: [{ type: 'text', text: '{invalid-private-value' }] }),
    (error) => !error.message.includes('invalid-private-value'));
  const failed = endpointResult(ENDPOINTS[0], { status: 'arbitrary-private-status', body: 'private-body' }, {});
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.response, { format: 'omitted', body: null });
  assert.ok(!JSON.stringify(failed).includes('private-'));
});

test('CLI options strictly validate modes, registry names and cache policy', () => {
  assert.deepEqual(parseArgs(['--cache', '--ttl-seconds=0', '--force-refresh']),
    { cache: true, ttlSeconds: 0, forceRefresh: true });
  assert.equal(parseArgs(['--cache', '--ttl-seconds=604800']).ttlSeconds, 604800);
  for (const args of [['--ttl-seconds=1'], ['--force-refresh'], ['--cache', '--rest'],
    ['--cache', '--tools-only'], ['--cache', '--ttl-seconds=604801'], ['--cache', '--ttl-seconds=-1'],
    ['--cache', '--ttl-seconds=1.5'], ['--cache', '--ttl-seconds=NaN'], ['--tool=call_rfc'],
    ['--tool=/CPACache'], ['--parameters-file=fixture.json'], ['--tool=fetch_pi8_cpa_cache', '--rest'],
    ['--export', '--tool=fetch_pi8_communication_channel', '--input-file=catalog.json'],
    ['--cache', '--export', '--tool=fetch_pi8_communication_channel', '--input-file=catalog.json'],
    ['--cache', '--cache']]) assert.throws(() => parseArgs(args));
});

async function exportSeed(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pipo-export-integration-'));
  const channel = ENDPOINTS.find(endpoint => endpoint.entity === 'CommunicationChannel');
  const simple = ENDPOINTS.find(endpoint => endpoint.kind === 'simple-query');
  const seed = { discovery: { endpoints: [
    { tool: channel.tool, status: 'ok', metadataOnly: false, actualCount: 2, returned: 2, offset: 0,
      artifacts: ['one', 'two'].map(ChannelID => ({ type: 'CommunicationChannel', identifier: { ChannelID } })) },
    { tool: simple.tool, status: 'ok', metadataOnly: false, actualCount: 1, returned: 1, offset: 0,
      artifacts: [{ type: 'ifmmessif', identifier: { object_type: 'ifmmessif', object_key: 'key', swc_guid: 'guid',
        vc: 'SWC', sp: '-1', uc: 'false', release: '7.0' } }] }
  ] } };
  const inputFile = path.join(directory, 'catalog.json');
  await fs.writeFile(inputFile, '\uFEFF' + JSON.stringify(seed), 'utf16le');
  return { directory, inputFile, channel };
}

test('existing UTF16 catalog drives Directory and ESR Reads with safe role diagnostics, without repeating queries', async t => {
  const { inputFile, channel } = await exportSeed(t);
  const { env, calls } = await fixture(t, { toolNames: ENDPOINTS.map(endpoint => endpoint.tool),
    resultFor(name, credentials, parameters) {
      assert.equal(parameters.mode, 'read');
      const payload = name === channel.tool
        ? parameters.identifier.ChannelID === 'one'
          ? { status: 'ok', metadataOnly: false, artifacts: [{ type: 'CommunicationChannel', hasFullDefinition: true,
            definition: { ChannelID: 'one', Password: credentials.PIPO_MCP_PASS } }] }
          : { status: 'failed', httpStatus: 403, response: { body: credentials.PIPO_MCP_PASS }, diagnostic: { reason: credentials.PIPO_MCP_PASS } }
        : { status: 'metadata-only', metadataOnly: true, httpStatus: 200, artifacts: [], response: { format: 'xml', body: { object: 'retained' } } };
      return { structuredContent: payload };
    } });
  const output = await fetchPipo({ env, export: true, inputFile, roles: { PO_PJ2_DIR: [] } });
  assert.equal(output.export.reads.length, 3);
  assert.equal(output.export.coverage.verifiedDefinitions, 1);
  assert.equal(output.export.coverage.metadataOnly, 1);
  assert.equal(output.export.coverage.failed, 1);
  const forbidden = output.export.reads[1].result;
  assert.equal(forbidden.httpStatus, 403);
  assert.equal(forbidden.diagnostic.layer, 'source');
  assert.deepEqual(forbidden.diagnostic.roleAssessment.candidates, [
    { role: 'SAP_XI_API_DISPLAY_J2EE', evidence: 'documented', present: false }
  ]);
  assert.equal(output.export.reads[2].verifiedDefinition, false);
  assert.equal(output.export.migrationReady, false);
  assert.equal(calls.filter(call => call.method === 'tools/call').length, 3);
  assert.deepEqual(calls.filter(call => call.method === 'tools/call').at(-1).params.arguments,
    { mode: 'read', object_type: 'ifmmessif', object_key: 'key', swc_guid: 'guid',
      vc: 'SWC', sp: '-1', uc: 'false', release: '7.0' });
  assert.doesNotMatch(JSON.stringify(output), new RegExp(env.PIPO_MCP_PASS));
});

test('client output omits opaque adapter Attributes even when an upstream server has not sanitized them', () => {
  const encoded = Buffer.from('<Attribute><Name>logonPassword</Name><Value>synthetic-opaque-adapter</Value></Attribute>').toString('base64');
  const endpoint = ENDPOINTS.find(entry => entry.tool === 'fetch_pi8_repository_read_ext');
  for (const attributes of [{ Attributes: encoded }, { 'c:Attributes': { '#text': encoded } }, { Attributes: [encoded] }]) {
    const output = endpointResult(endpoint, { status: 'metadata-only', metadataOnly: true, artifacts: [],
      response: { format: 'xml', body: { ChannelTemplate: { Direction: 'O', ...attributes } } } }, {});
    assert.equal(output.response.body.ChannelTemplate.Direction, 'O');
    assert.ok(!JSON.stringify(output).includes(encoded));
    assert.match(JSON.stringify(output), /OMITTED: opaque adapter attributes/);
  }
});

test('export CLI writes a self-contained run with verifiable artifact hashes and JSON-only stdout', async t => {
  const { directory, inputFile, channel } = await exportSeed(t);
  const encoded = Buffer.from('<Attribute><Name>logonPassword</Name><Value>synthetic-run-adapter</Value></Attribute>').toString('base64');
  const { env } = await fixture(t, { toolNames: ENDPOINTS.map(endpoint => endpoint.tool),
    resultFor(name) { return { structuredContent: name === channel.tool
      ? { status: 'ok', metadataOnly: false, artifacts: [{ type: 'CommunicationChannel', hasFullDefinition: true,
        definition: { ChannelID: 'fixture', settings: 'safe' } }] }
      : { status: 'metadata-only', metadataOnly: true, httpStatus: 200, artifacts: [],
        response: { format: 'xml', body: { object: 'retained', ChannelTemplate: { Direction: 'O', Attributes: encoded } } } } }; } });
  const outputDir = path.join(directory, 'runs');
  const child = spawn(process.execPath, [require.resolve('./fetch-pipo'), '--export',
    `--input-file=${inputFile}`, `--output-dir=${outputDir}`], { env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  const lifecycle = stderr.split('\n').filter(line => line.startsWith('[pipo-discovery] '))
    .map(line => JSON.parse(line.slice('[pipo-discovery] '.length))).filter(entry => entry.event.startsWith('run-'));
  assert.deepEqual(lifecycle.map(entry => entry.event), ['run-start', 'run-finish']);
  assert.equal(JSON.parse(stdout).export.reads.length, 3);
  assert.ok(!stdout.includes(encoded) && !stderr.includes(encoded));
  assert.match(stderr, /Definition reads: 3; verified definitions: 2/);
  const [runId] = await fs.readdir(outputDir);
  const runPath = path.join(outputDir, runId);
  const manifest = JSON.parse(await fs.readFile(path.join(runPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.migrationReady, false);
  const { createHash } = require('node:crypto');
  for (const file of manifest.files) {
    const bytes = await fs.readFile(path.join(runPath, file.filename));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.hash);
    assert.ok(!bytes.toString('utf8').includes(encoded), 'opaque adapter settings must not reach any run file');
  }
  assert.ok(manifest.files.some(file => file.filename.startsWith('artifacts/Directory/CommunicationChannel/')));
  const events = (await fs.readFile(path.join(runPath, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(entry => entry.phase === 'read' && entry.counts.fullDefinitions === 1));
  assert.ok(events.every(entry => entry.event !== 'unknown'));
});