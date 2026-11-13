'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveEndpoint, readMcpConfig, createDiscoveryClient } = require('./pipoDiscoveryClient');
const { sourceUrl } = require('./pipoDiscoveryCache');

const tool = 'fetch_pi8_repository_simple_query';
const endpoint = { tool, path: '/rep/support/SimpleQuery', category: 'Repository', kind: 'simple-query' };
const registry = { ENDPOINTS: [endpoint], getEndpoint: name => name === tool ? endpoint : undefined };
const config = readMcpConfig({ PIPO_MCP_URL: 'https://mcp.example.test', PIPO_MCP_USER: 'reader', PIPO_MCP_PASS: 'synthetic-password' });
const success = { tool, status: 'ok', httpStatus: 200, artifacts: [] };
const input = { tool, parameters: { offset: 2 }, context: { connection: config } };

test('CAP-local registry exactly matches all 23 MCP descriptors without a runtime MCP dependency', () => {
    const capRegistry = require('./pipoEndpoints');
    const mcpRegistry = require('../../mcp/pipo-rfc-server/pipo-endpoints');
    assert.equal(capRegistry.ENDPOINTS.length, 23);
    assert.deepEqual(capRegistry.ENDPOINTS, mcpRegistry.ENDPOINTS);
    assert.ok(Object.isFrozen(capRegistry.ENDPOINTS));
    for (const descriptor of capRegistry.ENDPOINTS) {
        assert.ok(Object.isFrozen(descriptor));
        if (descriptor.wsdlPaths) assert.ok(Object.isFrozen(descriptor.wsdlPaths));
        assert.equal(resolveEndpoint(descriptor.tool), descriptor);
        assert.equal(capRegistry.getEndpoint(descriptor.path), descriptor);
        assert.deepEqual(capRegistry.getEndpoint(descriptor.tool), mcpRegistry.getEndpoint(descriptor.tool));
    }
});

test('registry is lazy and authoritative; neither generic RFC nor invented fetch tools are allowed', () => {
    assert.equal(resolveEndpoint(tool, () => registry), endpoint);
    for (const name of ['call_rfc', 'get_rfc_metadata', 'fetch_pi8_invented', endpoint.path, '__proto__']) {
        assert.throws(() => resolveEndpoint(name, () => registry), { code: 'PIPO_UNKNOWN_ENDPOINT' });
    }
    assert.throws(() => resolveEndpoint(tool, () => { throw new Error('not yet present'); }), { code: 'PIPO_REGISTRY_UNAVAILABLE' });
    assert.throws(() => resolveEndpoint(tool, () => ({ ENDPOINTS: [], getEndpoint: () => endpoint })), { code: 'PIPO_UNKNOWN_ENDPOINT' });
});

test('source configuration requires HTTPS or exact localhost, without embedded credentials', () => {
    assert.equal(sourceUrl('https://mcp.example.test/'), 'https://mcp.example.test/mcp');
    assert.equal(sourceUrl('https://mcp.example.test/pipo/mcp/'), 'https://mcp.example.test/pipo/mcp');
    assert.equal(sourceUrl('http://localhost:5000'), 'http://localhost:5000/mcp');
    assert.equal(sourceUrl('http://[::1]:5000/mcp'), 'http://[::1]:5000/mcp');
    for (const url of ['http://remote.example.test', 'http://localhost.evil.test', 'file:///mcp',
        'https://synthetic-user:synthetic-password@mcp.example.test', 'https://mcp.example.test?token=synthetic-token', 'https://mcp.example.test#fragment']) {
        assert.throws(() => sourceUrl(url), { statusCode: 503 });
    }
    assert.throws(() => readMcpConfig({ PIPO_MCP_URL: 'https://mcp.example.test' }), { statusCode: 503 });
    assert.deepEqual(config.source, { url: 'https://mcp.example.test/mcp', identity: 'reader', version: '' });
    assert.equal(readMcpConfig({ PIPO_MCP_URL: config.url, PIPO_MCP_USER: 'reader', PIPO_MCP_PASS: 'synthetic-password', PIPO_CACHE_SOURCE_VERSION: '2' }).source.version, '2');
    assert.equal('password' in config.source, false);
});

function clientFixture(result, { connectError = false, callError = false, closeError = false } = {}) {
    const calls = [];
    let closed = 0;
    const client = createDiscoveryClient({
        getRegistry: () => registry,
        createConnection: connection => {
            assert.equal(connection, config);
            return { transport: {}, client: {
                async connect() { if (connectError) throw new Error('private SDK error'); },
                async callTool(args) { calls.push(args); if (callError) throw new Error('private SDK error'); return result; },
                async close() { closed++; if (closeError) throw new Error('private close error'); }
            } };
        }
    });
    return { client, calls, closed: () => closed };
}

test('MCP client calls exactly the registered discovery tool and decodes structured/text envelopes', async () => {
    for (const envelope of [{ structuredContent: success }, { content: [{ type: 'text', text: JSON.stringify(success) }] }]) {
        const f = clientFixture(envelope);
        assert.deepEqual(await f.client.fetchEndpoint(input), success);
        assert.deepEqual(f.calls, [{ name: tool, arguments: input.parameters }]);
        assert.equal(f.closed(), 1);
    }
});

test('SDK, HTTP, SOAP and malformed responses return sanitized per-endpoint failures and close connections', async () => {
    const cases = [
        [{ isError: true, content: [{ type: 'text', text: 'private SDK error' }] }],
        [{ structuredContent: { status: 'failed', httpStatus: 403, response: { body: 'private SDK error' } } }],
        [{ structuredContent: { status: 'ok', httpStatus: 500 } }],
        [{ structuredContent: { status: 'unsupported', warnings: ['private SDK error'] } }],
        [{ structuredContent: { status: 'ok', response: '<soap:Fault>private SDK error</soap:Fault>' } }],
        [{ structuredContent: { status: 'ok', response: { body: 'synthetic-password' } } }],
        [{ structuredContent: { status: 'ok', tool: 'fetch_pi8_other' } }],
        [{ content: [{ type: 'text', text: 'not JSON: private SDK error' }] }],
        [{ content: [] }],
        [undefined, { connectError: true }],
        [undefined, { callError: true }]
    ];
    for (const [result, options] of cases) {
        const f = clientFixture(result, options);
        const response = await f.client.fetchEndpoint(input);
        assert.ok(['failed', 'unsupported'].includes(response.status));
        assert.equal(response.path, endpoint.path);
        assert.equal(response.category, endpoint.category);
        assert.doesNotMatch(JSON.stringify(response), /private SDK error|synthetic-password/);
        assert.equal(f.closed(), 1);
    }
    const f = clientFixture({ structuredContent: success }, { closeError: true });
    assert.deepEqual(await f.client.fetchEndpoint(input), success);
});