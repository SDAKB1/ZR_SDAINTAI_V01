#!/usr/bin/env node
'use strict';

/**
 * API Client Module Unit Tests
 *
 * Tests for ApiClient (api-client.js) covering:
 *   - CSRF token management
 *   - Core HTTP methods (callAction, callFunction, fetchEntities)
 *   - Service-specific APIs (discovery, brain, documents, rapDev)
 *   - Error handling and edge cases
 *
 * Run via: node test/api-client.test.js
 */

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK SETUP
// ═══════════════════════════════════════════════════════════════════════════════

let fetchCalls = [];
let mockFetchResponse = { status: 200, body: {}, headers: {} };

// Mock fetch creator - creates a fresh mock each time
function createMockFetch(customResponse) {
    return async (url, options = {}) => {
        fetchCalls.push({ url, options });

        const response = customResponse || mockFetchResponse;
        return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            statusText: response.statusText || 'OK',
            headers: {
                get: (name) => {
                    const headers = response.headers || {};
                    return headers[name] || headers[name.toLowerCase()] || null;
                }
            },
            json: async () => response.body || {},
            text: async () => JSON.stringify(response.body || {})
        };
    };
}

global.fetch = createMockFetch();

// Mock window for browser globals
global.window = {};

// Load the module
const ApiClient = require('../app/aiconx/webapp/api-client.js');

// ═══════════════════════════════════════════════════════════════════════════════
// TEST UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

let testsPassed = 0;
let testsFailed = 0;
const testResults = [];

function resetMocks() {
    fetchCalls = [];
    mockFetchResponse = { status: 200, body: {}, headers: {} };
    ApiClient.csrfTokens = {};
    global.fetch = createMockFetch();
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected "${expected}" but got "${actual}"`);
    }
}

function assertDeepEqual(actual, expected, message) {
    const actualStr = JSON.stringify(actual);
    const expectedStr = JSON.stringify(expected);
    if (actualStr !== expectedStr) {
        throw new Error(`${message}: expected ${expectedStr} but got ${actualStr}`);
    }
}

async function runTest(name, fn) {
    resetMocks();
    const startTime = Date.now();
    try {
        await fn();
        const duration = Date.now() - startTime;
        console.log(`  ✓ ${name} (${duration}ms)`);
        testsPassed++;
        testResults.push({ name, status: 'passed', duration });
    } catch (err) {
        const duration = Date.now() - startTime;
        console.log(`  ✗ ${name} (${duration}ms)`);
        console.log(`    Error: ${err.message}`);
        testsFailed++;
        testResults.push({ name, status: 'failed', duration, error: err.message });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

async function testConfiguration() {
    console.log('\n' + '═'.repeat(70));
    console.log('CONFIGURATION TESTS');
    console.log('═'.repeat(70));

    await runTest('ApiClient has config object', () => {
        assert(ApiClient.config !== undefined, 'config should exist');
        assert(ApiClient.config.basePaths !== undefined, 'basePaths should exist');
    });

    await runTest('basePaths contains all required services', () => {
        const requiredPaths = ['discovery', 'brain', 'aiconx', 'documents', 'rapDev'];
        for (const path of requiredPaths) {
            assert(ApiClient.config.basePaths[path], `basePaths should have ${path}`);
        }
    });

    await runTest('basePaths have correct OData v4 format', () => {
        for (const [name, path] of Object.entries(ApiClient.config.basePaths)) {
            assert(path.startsWith('/odata/v4/'), `${name} should start with /odata/v4/`);
        }
    });

    await runTest('config has timeout and retry settings', () => {
        assert(typeof ApiClient.config.timeout === 'number', 'timeout should be a number');
        assert(typeof ApiClient.config.retryAttempts === 'number', 'retryAttempts should be a number');
        assert(typeof ApiClient.config.retryDelay === 'number', 'retryDelay should be a number');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: CSRF TOKEN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function testCsrfTokenManagement() {
    console.log('\n' + '═'.repeat(70));
    console.log('CSRF TOKEN MANAGEMENT TESTS');
    console.log('═'.repeat(70));

    await runTest('fetchCsrfToken makes HEAD request to $metadata', async () => {
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'test-token-123' } };
        global.fetch = createMockFetch();

        await ApiClient.fetchCsrfToken('/odata/v4/test');

        assert(fetchCalls.length === 1, 'Should make exactly one fetch call');
        assertEqual(fetchCalls[0].options.method, 'HEAD', 'Should use HEAD method');
        assert(fetchCalls[0].url.includes('$metadata'), 'Should call $metadata');
        assertEqual(fetchCalls[0].options.headers['x-csrf-token'], 'fetch', 'Should send fetch header');
    });

    await runTest('fetchCsrfToken caches token for reuse', async () => {
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'cached-token' } };
        global.fetch = createMockFetch();

        const token1 = await ApiClient.fetchCsrfToken('/odata/v4/cache-test');
        const token2 = await ApiClient.fetchCsrfToken('/odata/v4/cache-test');

        assertEqual(token1, 'cached-token', 'First call should return token');
        assertEqual(token2, 'cached-token', 'Second call should return cached token');
        assertEqual(fetchCalls.length, 1, 'Should make only one fetch call (cached)');
    });

    await runTest('invalidateCsrfToken clears cached token', async () => {
        ApiClient.csrfTokens['/odata/v4/invalidate-test'] = 'existing-token';

        ApiClient.invalidateCsrfToken('/odata/v4/invalidate-test');

        assertEqual(ApiClient.csrfTokens['/odata/v4/invalidate-test'], undefined, 'Token should be removed');
    });

    await runTest('fetchCsrfToken returns null on failure', async () => {
        mockFetchResponse = { status: 500, headers: {} };
        global.fetch = createMockFetch();

        const token = await ApiClient.fetchCsrfToken('/odata/v4/fail-test');

        assertEqual(token, null, 'Should return null on failure');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: CORE HTTP METHODS
// ═══════════════════════════════════════════════════════════════════════════════

async function testCoreHttpMethods() {
    console.log('\n' + '═'.repeat(70));
    console.log('CORE HTTP METHODS TESTS');
    console.log('═'.repeat(70));

    await runTest('callAction sends POST request with JSON body', async () => {
        mockFetchResponse = {
            status: 200,
            headers: { 'x-csrf-token': 'action-token' },
            body: { result: 'success' }
        };
        global.fetch = createMockFetch();

        await ApiClient.callAction('/odata/v4/test', 'testAction', { param1: 'value1' });

        // Skip the CSRF fetch call
        const actionCall = fetchCalls.find(c => c.url.includes('testAction'));
        assert(actionCall !== undefined, 'Should make action call');
        assertEqual(actionCall.options.method, 'POST', 'Should use POST');
        assertEqual(actionCall.options.headers['Content-Type'], 'application/json', 'Should set Content-Type');
    });

    await runTest('callFunction sends GET request with query params', async () => {
        mockFetchResponse = { status: 200, body: { value: 'function-result' } };
        global.fetch = createMockFetch();

        await ApiClient.callFunction('/odata/v4/test', 'testFunction', {
            param1: 'hello',
            param2: 123
        });

        const funcCall = fetchCalls.find(c => c.url.includes('testFunction'));
        assert(funcCall !== undefined, 'Should make function call');
        assertEqual(funcCall.options.method, 'GET', 'Should use GET');
        assert(funcCall.url.includes('param1=hello'), 'Should include param1');
        assert(funcCall.url.includes('param2=123'), 'Should include param2');
    });

    await runTest('callFunction omits null/undefined params', async () => {
        mockFetchResponse = { status: 200, body: {} };
        global.fetch = createMockFetch();

        await ApiClient.callFunction('/odata/v4/test', 'testFunction', {
            defined: 'yes',
            empty: null,
            missing: undefined
        });

        const funcCall = fetchCalls.find(c => c.url.includes('testFunction'));
        assert(funcCall.url.includes('defined=yes'), 'Should include defined param');
        assert(!funcCall.url.includes('empty'), 'Should not include null param');
        assert(!funcCall.url.includes('missing'), 'Should not include undefined param');
    });

    await runTest('fetchEntities builds OData query correctly', async () => {
        mockFetchResponse = { status: 200, body: { value: [] } };
        global.fetch = createMockFetch();

        await ApiClient.fetchEntities('/odata/v4/test', 'TestEntities', {
            $filter: "status eq 'active'",
            $select: 'id,name',
            $orderby: 'name asc',
            $top: 10,
            $skip: 5
        });

        const entityCall = fetchCalls.find(c => c.url.includes('TestEntities'));
        assert(entityCall !== undefined, 'Should make entity call');
        assert(entityCall.url.includes('$filter='), 'Should include $filter');
        assert(entityCall.url.includes('$select='), 'Should include $select');
        assert(entityCall.url.includes('$orderby='), 'Should include $orderby');
        assert(entityCall.url.includes('$top=10'), 'Should include $top');
        assert(entityCall.url.includes('$skip=5'), 'Should include $skip');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: DISCOVERY SERVICE API
// ═══════════════════════════════════════════════════════════════════════════════

async function testDiscoveryServiceApi() {
    console.log('\n' + '═'.repeat(70));
    console.log('DISCOVERY SERVICE API TESTS');
    console.log('═'.repeat(70));

    await runTest('discovery.testConnection calls correct action', async () => {
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'token' }, body: { success: true } };
        global.fetch = createMockFetch();

        await ApiClient.discovery.testConnection('system-123');

        const actionCall = fetchCalls.find(c => c.url.includes('testConnection'));
        assert(actionCall !== undefined, 'Should call testConnection');
        assert(actionCall.url.includes('/odata/v4/discovery/'), 'Should use discovery path');
    });

    await runTest('discovery.addPISystem sends all parameters', async () => {
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'token' }, body: { systemId: 'new-id' } };
        global.fetch = createMockFetch();

        const params = {
            systemName: 'TestSystem',
            description: 'Test description',
            virtualHost: 'host.example.com',
            virtualPort: 443,
            protocol: 'https',
            locationId: 'loc-1',
            techUser: 'user',
            techPassword: 'pass'
        };

        await ApiClient.discovery.addPISystem(params);

        const actionCall = fetchCalls.find(c => c.url.includes('addPISystem'));
        assert(actionCall !== undefined, 'Should call addPISystem');
        const body = JSON.parse(actionCall.options.body);
        assertEqual(body.systemName, 'TestSystem', 'Should include systemName');
        assertEqual(body.virtualHost, 'host.example.com', 'Should include virtualHost');
    });

    await runTest('discovery.startDiscovery handles options correctly', async () => {
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'token' }, body: { jobId: 'job-1' } };
        global.fetch = createMockFetch();

        await ApiClient.discovery.startDiscovery('system-123', {
            includeInactive: true,
            includeHistory: false,
            artifactTypes: ['ICO', 'Channel']
        });

        const actionCall = fetchCalls.find(c => c.url.includes('startDiscovery'));
        const body = JSON.parse(actionCall.options.body);
        assertEqual(body.systemId, 'system-123', 'Should include systemId');
        assertEqual(body.includeInactive, true, 'Should include includeInactive');
        assert(body.artifactTypes !== null, 'Should stringify artifactTypes');
    });

    await runTest('discovery.getDiscoveryProgress uses GET function call', async () => {
        mockFetchResponse = { status: 200, body: { status: 'running', progressPercent: 50 } };
        global.fetch = createMockFetch();

        await ApiClient.discovery.getDiscoveryProgress('job-123');

        const funcCall = fetchCalls.find(c => c.url.includes('getDiscoveryProgress'));
        assert(funcCall !== undefined, 'Should call getDiscoveryProgress');
        assertEqual(funcCall.options.method, 'GET', 'Should use GET');
        assert(funcCall.url.includes('jobId=job-123'), 'Should include jobId');
    });

    await runTest('discovery.batchApprove stringifies artifactIds', async () => {
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'token' }, body: { approved: 3 } };
        global.fetch = createMockFetch();

        await ApiClient.discovery.batchApprove(['id1', 'id2', 'id3'], 2, 'Batch notes');

        const actionCall = fetchCalls.find(c => c.url.includes('batchApprove'));
        const body = JSON.parse(actionCall.options.body);
        assert(typeof body.artifactIds === 'string', 'artifactIds should be stringified');
        assertEqual(body.wave, 2, 'Should include wave');
        assertEqual(body.notes, 'Batch notes', 'Should include notes');
    });

    await runTest('discovery.exportInventory handles filters', async () => {
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'token' }, body: { downloadUrl: 'url' } };
        global.fetch = createMockFetch();

        await ApiClient.discovery.exportInventory('system-123', 'csv', { status: 'approved' });

        const actionCall = fetchCalls.find(c => c.url.includes('exportInventory'));
        const body = JSON.parse(actionCall.options.body);
        assertEqual(body.systemId, 'system-123', 'Should include systemId');
        assertEqual(body.format, 'csv', 'Should include format');
        assert(body.filters !== undefined, 'Should include filters');
    });

    await runTest('discovery.getArtifacts builds correct filter', async () => {
        mockFetchResponse = { status: 200, body: { value: [] } };
        global.fetch = createMockFetch();

        await ApiClient.discovery.getArtifacts('system-123', {
            $filter: "status eq 'approved'"
        });

        const entityCall = fetchCalls.find(c => c.url.includes('Artifacts'));
        assert(entityCall.url.includes('system_ID'), 'Should include system_ID filter');
        assert(entityCall.url.includes('system-123'), 'Should include systemId value');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: BRAIN SERVICE API
// ═══════════════════════════════════════════════════════════════════════════════

async function testBrainServiceApi() {
    console.log('\n' + '═'.repeat(70));
    console.log('BRAIN SERVICE API TESTS');
    console.log('═'.repeat(70));

    await runTest('brain.toggleBrain calls correct action', async () => {
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'token' }, body: { success: true } };
        global.fetch = createMockFetch();

        await ApiClient.brain.toggleBrain('brain-key-123', true);

        const actionCall = fetchCalls.find(c => c.url.includes('toggleBrain'));
        assert(actionCall !== undefined, 'Should call toggleBrain');
        assert(actionCall.url.includes('/odata/v4/brain/'), 'Should use brain path');
        const body = JSON.parse(actionCall.options.body);
        assertEqual(body.key, 'brain-key-123', 'Should include key');
        assertEqual(body.enabled, true, 'Should include enabled');
    });

    await runTest('brain.captureEvent sends all event data', async () => {
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'token' }, body: { eventId: 'evt-1' } };
        global.fetch = createMockFetch();

        await ApiClient.brain.captureEvent(
            'key-123',
            'user_action',
            'ui-wiring',
            '{"action":"click"}',
            'User clicked button',
            'session-456'
        );

        const actionCall = fetchCalls.find(c => c.url.includes('captureEvent'));
        const body = JSON.parse(actionCall.options.body);
        assertEqual(body.key, 'key-123', 'Should include key');
        assertEqual(body.eventType, 'user_action', 'Should include eventType');
        assertEqual(body.source, 'ui-wiring', 'Should include source');
        assertEqual(body.sessionId, 'session-456', 'Should include sessionId');
    });

    await runTest('brain.migrationAdvisor passes artifact data', async () => {
        mockFetchResponse = {
            status: 200,
            headers: { 'x-csrf-token': 'token' },
            body: { tier: 'medium', complexityScore: 65 }
        };
        global.fetch = createMockFetch();

        await ApiClient.brain.migrationAdvisor('key-123', {
            objectId: 'ICO-001',
            objectType: 'IntegratedConfiguration'
        });

        const actionCall = fetchCalls.find(c => c.url.includes('migrationAdvisor'));
        const body = JSON.parse(actionCall.options.body);
        assertEqual(body.key, 'key-123', 'Should include key');
        assertEqual(body.objectId, 'ICO-001', 'Should include objectId');
    });

    await runTest('brain.getBrainStatus returns status object', async () => {
        mockFetchResponse = {
            status: 200,
            headers: { 'x-csrf-token': 'token' },
            body: { enabled: true, eventsCount: 150 }
        };
        global.fetch = createMockFetch();

        const result = await ApiClient.brain.getBrainStatus('key-123');

        assertEqual(result.enabled, true, 'Should return enabled status');
        assertEqual(result.eventsCount, 150, 'Should return events count');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: DOCUMENT SERVICE API
// ═══════════════════════════════════════════════════════════════════════════════

async function testDocumentServiceApi() {
    console.log('\n' + '═'.repeat(70));
    console.log('DOCUMENT SERVICE API TESTS');
    console.log('═'.repeat(70));

    await runTest('documents.parseDocument sends correct payload', async () => {
        mockFetchResponse = {
            status: 200,
            headers: { 'x-csrf-token': 'token' },
            body: { fields: { title: 'Test Doc' } }
        };
        global.fetch = createMockFetch();

        await ApiClient.documents.parseDocument(
            'key-123',
            'test.pdf',
            'application/pdf',
            'base64content==',
            'Migration spec'
        );

        const actionCall = fetchCalls.find(c => c.url.includes('parseDocument'));
        assert(actionCall !== undefined, 'Should call parseDocument');
        const body = JSON.parse(actionCall.options.body);
        assertEqual(body.fileName, 'test.pdf', 'Should include fileName');
        assertEqual(body.mimeType, 'application/pdf', 'Should include mimeType');
        assertEqual(body.contentBase64, 'base64content==', 'Should include contentBase64');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: RAP DEV API
// ═══════════════════════════════════════════════════════════════════════════════

async function testRapDevApi() {
    console.log('\n' + '═'.repeat(70));
    console.log('RAP DEV ORCHESTRATOR API TESTS');
    console.log('═'.repeat(70));

    await runTest('rapDev.generateBehaviorImpl sends correct params', async () => {
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'token' }, body: { runId: 'run-1' } };
        global.fetch = createMockFetch();

        await ApiClient.rapDev.generateBehaviorImpl('key-123', 'RAP_OBJ', 'spec data', 'user@example.com');

        const actionCall = fetchCalls.find(c => c.url.includes('generateBehaviorImpl'));
        const body = JSON.parse(actionCall.options.body);
        assertEqual(body.key, 'key-123', 'Should include key');
        assertEqual(body.objectId, 'RAP_OBJ', 'Should include objectId');
        assertEqual(body.spec, 'spec data', 'Should include spec');
        assertEqual(body.requestedBy, 'user@example.com', 'Should include requestedBy');
    });

    await runTest('rapDev.runAtcCheck calls ATC action', async () => {
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'token' }, body: { checkId: 'chk-1' } };
        global.fetch = createMockFetch();

        await ApiClient.rapDev.runAtcCheck('key-123', 'RAP_OBJ', 'user@example.com');

        const actionCall = fetchCalls.find(c => c.url.includes('runAtcCheck'));
        assert(actionCall !== undefined, 'Should call runAtcCheck');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEGATIVE TESTS: ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

async function testNegativeCases() {
    console.log('\n' + '═'.repeat(70));
    console.log('NEGATIVE TESTS: ERROR HANDLING');
    console.log('═'.repeat(70));

    await runTest('fetchEntities handles empty result', async () => {
        mockFetchResponse = { status: 200, body: { value: [] } };
        global.fetch = createMockFetch();

        const result = await ApiClient.fetchEntities('/odata/v4/test', 'EmptyEntities', {});

        assertDeepEqual(result.value, [], 'Should return empty array');
    });

    await runTest('callFunction with empty params', async () => {
        mockFetchResponse = { status: 200, body: { result: 'ok' } };
        global.fetch = createMockFetch();

        const result = await ApiClient.callFunction('/odata/v4/test', 'noParamsFunc', {});

        const funcCall = fetchCalls.find(c => c.url.includes('noParamsFunc'));
        // Should work without throwing
        assert(result.result === 'ok', 'Should return result');
    });

    await runTest('callAction with nested object params', async () => {
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'token' }, body: { success: true } };
        global.fetch = createMockFetch();

        await ApiClient.callAction('/odata/v4/test', 'nestedAction', {
            config: { nested: { deep: 'value' } },
            array: [1, 2, 3]
        });

        const actionCall = fetchCalls.find(c => c.url.includes('nestedAction'));
        const body = JSON.parse(actionCall.options.body);
        assertEqual(body.config.nested.deep, 'value', 'Should preserve nested objects');
        assertDeepEqual(body.array, [1, 2, 3], 'Should preserve arrays');
    });

    await runTest('callFunction URL encodes special characters', async () => {
        mockFetchResponse = { status: 200, body: {} };
        global.fetch = createMockFetch();

        await ApiClient.callFunction('/odata/v4/test', 'specialFunc', {
            query: "name eq 'test value'"
        });

        const funcCall = fetchCalls.find(c => c.url.includes('specialFunc'));
        assert(funcCall.url.includes(encodeURIComponent("name eq 'test value'")), 'Should URL encode special chars');
    });

    await runTest('Multiple CSRF tokens for different services', async () => {
        ApiClient.csrfTokens = {};

        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'token-discovery' } };
        global.fetch = createMockFetch();
        await ApiClient.fetchCsrfToken('/odata/v4/discovery');

        fetchCalls = [];
        mockFetchResponse = { status: 200, headers: { 'x-csrf-token': 'token-brain' } };
        global.fetch = createMockFetch();
        await ApiClient.fetchCsrfToken('/odata/v4/brain');

        assertEqual(ApiClient.csrfTokens['/odata/v4/discovery'], 'token-discovery', 'Should have discovery token');
        assertEqual(ApiClient.csrfTokens['/odata/v4/brain'], 'token-brain', 'Should have brain token');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('╔' + '═'.repeat(68) + '╗');
    console.log('║' + ' API CLIENT MODULE UNIT TESTS'.padEnd(68) + '║');
    console.log('║' + ' Testing: api-client.js'.padEnd(68) + '║');
    console.log('╚' + '═'.repeat(68) + '╝');

    const startTime = Date.now();

    await testConfiguration();
    await testCsrfTokenManagement();
    await testCoreHttpMethods();
    await testDiscoveryServiceApi();
    await testBrainServiceApi();
    await testDocumentServiceApi();
    await testRapDevApi();
    await testNegativeCases();

    const duration = Date.now() - startTime;

    // Summary
    console.log('\n' + '═'.repeat(70));
    console.log('TEST SUMMARY');
    console.log('═'.repeat(70));
    console.log(`  Total:  ${testsPassed + testsFailed}`);
    console.log(`  Passed: ${testsPassed} ✓`);
    console.log(`  Failed: ${testsFailed} ✗`);
    console.log(`  Duration: ${duration}ms`);
    console.log('═'.repeat(70));

    process.exit(testsFailed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal test error:', err.message);
    process.exit(1);
});
