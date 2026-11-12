'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { fetchPipo } = require('./fetch-pipo');

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
      const names = body.params?.cursor ? toolNames.slice(2) : toolNames.slice(0, 2);
      result = { tools: names.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) };
      if (!body.params?.cursor) result.nextCursor = 'second-page';
    } else if (body.method === 'tools/call') {
      const data = body.params.name === 'get_pi8_status' ? status : objects;
      result = options.toolError ? { isError: true, content: [{ type: 'text', text: 'internal server details' }] } :
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

test('invalid configuration is rejected before connecting', async () => {
  await assert.rejects(fetchPipo({ env: {} }), /Set PIPO_MCP_USER/);
  await assert.rejects(fetchPipo({ rest: true, toolsOnly: true }), /requires MCP mode/);
  await assert.rejects(fetchPipo({ env: { PIPO_MCP_URL: 'http://example.com/mcp' } }), /Use HTTPS/);
  await assert.rejects(fetchPipo({ env: { PIPO_MCP_URL: 'https://example.com/mcp?token=unused' } }), /query parameters/);
});