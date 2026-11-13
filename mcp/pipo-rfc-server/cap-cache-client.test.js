'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { fetchPipo, defaultParameters, readParametersFile } = require('./fetch-pipo');
const { ENDPOINTS } = require('./pipo-endpoints');
const { createCapCacheClient, MAX_PAYLOAD_BYTES } = require('./cap-cache-client');
const { createReadThroughCache } = require('../../srv/utils/pipoDiscoveryCache');

async function fixture(t, options = {}) {
  const calls = [];
  let loads = 0;
  const env = { PIPO_CAP_TOKEN: randomUUID(), PIPO_CAP_USER: randomUUID(), PIPO_CAP_PASS: randomUUID(),
    // Invalid MCP configuration proves that cache mode never inspects or connects it.
    PIPO_MCP_URL: 'not-an-mcp-url' };
  if (options.basic) delete env.PIPO_CAP_TOKEN;
  const authorization = options.basic ?
    'Basic ' + Buffer.from(`${env.PIPO_CAP_USER}:${env.PIPO_CAP_PASS}`).toString('base64') : `Bearer ${env.PIPO_CAP_TOKEN}`;
  const entries = new Map();
  const cache = createReadThroughCache({ store: {
    read: async (id) => entries.get(id), check: async () => {},
    write: async (entry) => { entries.set(entry.ID, entry); }
  }, load: async ({ tool }) => {
    loads++;
    if (options.failedTool === tool) return { status: 'failed', response: { body: env.PIPO_CAP_PASS } };
    return { status: 'ok', artifacts: [{ name: 'Fixture', type: 'ServiceInterface' }],
      note: env.PIPO_CAP_TOKEN || env.PIPO_CAP_PASS, tool };
  } });
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    calls.push({ path: req.url, method: req.method, body, authenticated: req.headers.authorization === authorization,
      contentType: req.headers['content-type'] });
    if (options.httpError || req.headers.authorization !== authorization) {
      res.writeHead(options.httpError || 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: env.PIPO_CAP_TOKEN || env.PIPO_CAP_PASS }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (options.raw !== undefined) { res.end(options.raw); return; }
    const envelope = await cache.fetchEndpoint({ ...body, parameters: JSON.parse(body.parameters),
      source: { url: 'https://fixture.invalid/mcp', identity: 'fixture-user', version: '1' },
      context: { user: { id: 'fixture-user' } } });
    res.end(JSON.stringify(envelope));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  env.PIPO_CAP_URL = `http://127.0.0.1:${server.address().port}`;
  return { env, calls, getLoads: () => loads };
}

test('CAP posts all 23 registry tools with Bearer auth, decodes results and records second-call hits', async (t) => {
  const { env, calls, getLoads } = await fixture(t);
  const first = await fetchPipo({ cache: true, env });
  const second = await fetchPipo({ cache: true, env });
  assert.equal(first.mode, 'cache');
  assert.equal(first.tools, undefined);
  assert.equal(first.discovery.endpoints.length, 23);
  assert.ok(first.discovery.endpoints.every((endpoint) => endpoint.cache.hit === false));
  assert.ok(second.discovery.endpoints.every((endpoint) => endpoint.cache.hit === true));
  assert.equal(getLoads(), 23);
  assert.equal(calls.length, 46);
  for (const [index, call] of calls.entries()) {
    const endpoint = ENDPOINTS[index % 23];
    assert.equal(call.path, '/odata/v4/pipo-discovery/fetchEndpoint');
    assert.equal(call.method, 'POST');
    assert.equal(call.authenticated, true); // Bearer wins over Basic when both are configured.
    assert.equal(call.contentType, 'application/json');
    assert.equal(call.body.tool, endpoint.tool);
    assert.equal(typeof call.body.parameters, 'string');
    assert.deepEqual(JSON.parse(call.body.parameters), defaultParameters(endpoint));
    assert.equal(call.body.forceRefresh, false);
    assert.equal(Object.hasOwn(call.body, 'ttlSeconds'), false);
    assert.equal(first.discovery.endpoints[index % 23].category, endpoint.category);
  }
  assert.ok(!JSON.stringify(first).includes(env.PIPO_CAP_TOKEN));
});

test('cache mode works when loading the MCP SDK is prohibited', async (t) => {
  const { env, calls } = await fixture(t);
  const script = `const Module = require('node:module');
    const load = Module._load;
    Module._load = function(name, ...args) {
      if (name.startsWith('@modelcontextprotocol/')) throw new Error('MCP must not load');
      return load.call(this, name, ...args);
    };
    require(${JSON.stringify(require.resolve('./fetch-pipo'))}).fetchPipo({ cache: true })
      .then(output => console.log(output.discovery.endpoints.length))
      .catch(() => { process.exitCode = 1; });`;
  const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, ...env } });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.equal(stdout.trim(), '23');
  assert.equal(calls.length, 23);
});

test('CAP endpoint failures stay local while later endpoints still run', async (t) => {
  const { env, calls } = await fixture(t, { failedTool: ENDPOINTS[0].tool });
  const output = await fetchPipo({ cache: true, env });
  assert.equal(calls.length, 23);
  const failure = output.discovery.endpoints[0];
  assert.equal(failure.status, 'failed');
  assert.equal(failure.path, ENDPOINTS[0].path);
  assert.deepEqual(failure.response, { format: 'omitted', body: null });
  assert.deepEqual(failure.artifacts, []);
  assert.ok(output.discovery.endpoints.slice(1).every((endpoint) => endpoint.status === 'ok'));
  assert.ok(!JSON.stringify(output).includes(env.PIPO_CAP_PASS));
});

test('local mock Basic auth, TTL zero and force refresh reach CAP unchanged', async (t) => {
  const { env, calls, getLoads } = await fixture(t, { basic: true });
  const tool = ENDPOINTS[1].tool;
  for (const policy of [{ ttlSeconds: 60 }, { ttlSeconds: 60, forceRefresh: true }, { ttlSeconds: 0 }]) {
    const output = await fetchPipo({ cache: true, env, tool, ...policy });
    assert.equal(output.discovery.endpoints[0].cache.hit, false);
  }
  assert.equal(getLoads(), 3);
  assert.deepEqual(calls.map((call) => [call.authenticated, call.body.ttlSeconds, call.body.forceRefresh]),
    [[true, 60, false], [true, 60, true], [true, 0, false]]);
});

test('CAP URL accepts base, service or exact action without doubling the endpoint', async (t) => {
  const { env, calls } = await fixture(t);
  for (const suffix of ['', '/odata/v4/pipo-discovery/', '/odata/v4/pipo-discovery/fetchEndpoint']) {
    await fetchPipo({ cache: true, tool: ENDPOINTS[0].tool, env: { ...env, PIPO_CAP_URL: env.PIPO_CAP_URL + suffix } });
  }
  assert.ok(calls.every((call) => call.path === '/odata/v4/pipo-discovery/fetchEndpoint'));
});

test('CAP authentication, configuration and DB HTTP errors abort immediately with no direct fallback', async (t) => {
  for (const code of [401, 403, 400, 503, 500]) {
    const { env, calls } = await fixture(t, { httpError: code });
    await assert.rejects(fetchPipo({ cache: true, env }), (error) =>
      error.message.includes(`HTTP ${code}`) && !error.message.includes(env.PIPO_CAP_TOKEN));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/odata/v4/pipo-discovery/fetchEndpoint');
  }
});

test('cache CLI fails closed and never prints credentials or error bodies', async (t) => {
  const { env, calls } = await fixture(t, { httpError: 503 });
  const child = spawn(process.execPath, [require.resolve('./fetch-pipo'), '--cache'], { env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /PIPO fetch failed/);
  assert.ok(!stderr.includes(env.PIPO_CAP_TOKEN) && !stderr.includes(env.PIPO_CAP_PASS));
  assert.equal(calls.length, 1);
});

test('invalid CAP configuration never makes a request', () => {
  for (const url of [undefined, 'not-a-url', 'http://example.com', 'http://localhost.example.com',
    'https://user:pass@example.com', 'https://example.com?token=unused', 'https://example.com#fragment']) {
    assert.throws(() => createCapCacheClient({ PIPO_CAP_URL: url, PIPO_CAP_TOKEN: 'fixture' }));
  }
  assert.throws(() => createCapCacheClient({ PIPO_CAP_URL: 'https://example.com' }), /Set PIPO_CAP_TOKEN/);
  assert.throws(() => createCapCacheClient({ PIPO_CAP_URL: 'https://example.com', PIPO_CAP_TOKEN: 'invalid\r\nvalue' }),
    /Invalid PIPO_CAP_TOKEN/);
});

test('malformed and chunked oversized CAP envelopes fail closed', async (t) => {
  for (const raw of ['{private-invalid-json', '{}', JSON.stringify({ result: '{}', cache: {} }),
    JSON.stringify({ text: 'x'.repeat(MAX_PAYLOAD_BYTES) })]) {
    const { env, calls } = await fixture(t, { raw });
    await assert.rejects(fetchPipo({ cache: true, env }), (error) => !error.message.includes('private-invalid-json'));
    assert.equal(calls.length, 1);
  }
});

test('parameter files are bounded JSON objects; single-tool cache requests retain read arguments', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pipo-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'parameters.json');
  const { env, calls } = await fixture(t);
  for (const parameters of [{ mode: 'read', identifier: { Name: 'Fixture' } },
    { mode: 'read', object_type: 'ifmmessif', object_key: 'fixture-key', swc_guid: 'fixture-guid' }]) {
    await writeFile(path, JSON.stringify(parameters));
    const tool = parameters.identifier ? ENDPOINTS[1].tool : 'fetch_pi8_repository_read_ext';
    await fetchPipo({ cache: true, env, tool, parametersFile: path });
    assert.deepEqual(JSON.parse(calls.at(-1).body.parameters),
      { ...defaultParameters(ENDPOINTS.find((endpoint) => endpoint.tool === tool)), ...parameters });
  }
  for (const content of ['[]', 'null', '"string"', '{private-parse-error', ' '.repeat(65537)]) {
    await writeFile(path, content);
    await assert.rejects(readParametersFile(path), (error) =>
      error.message.includes('JSON object') && !error.message.includes('private-parse-error'));
  }
  assert.equal(calls.length, 2);
});