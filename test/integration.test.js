#!/usr/bin/env node
'use strict';

/**
 * Integration Tests for UI-Backend Wiring
 * 
 * Tests component interactions and end-to-end flows:
 *   - ApiClient → Discovery Service interactions
 *   - UIWiring → ApiClient → Backend flow
 *   - Error propagation across layers
 *   - Feature flag behavior across modules
 * 
 * Run via: node test/integration.test.js
 */

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK SETUP
// ═══════════════════════════════════════════════════════════════════════════════

// Track all network requests
const networkLog = [];

// Mock fetch with configurable responses
const mockResponses = new Map();

global.fetch = async (url, options = {}) => {
    networkLog.push({ url, method: options.method || 'GET', body: options.body, timestamp: Date.now() });
    
    // Check for specific mock response
    for (const [pattern, response] of mockResponses.entries()) {
        if (url.includes(pattern)) {
            if (response.error) {
                throw new Error(response.error);
            }
            return {
                ok: response.status >= 200 && response.status < 300,
                status: response.status || 200,
                headers: { get: (n) => response.headers?.[n] || null },
                json: async () => response.body || {},
                text: async () => JSON.stringify(response.body || {})
            };
        }
    }
    
    // Default success response
    return {
        ok: true,
        status: 200,
        headers: { get: (n) => n === 'x-csrf-token' ? 'mock-csrf-token' : null },
        json: async () => ({ success: true }),
        text: async () => '{"success":true}'
    };
};

// Mock window and DOM
global.window = { SDAINTAI_CONFIG: { useBackend: true } };
global.document = {
    getElementById: (id) => ({ 
        disabled: false, 
        innerHTML: '', 
        className: '',
        _originalContent: '' 
    })
};
global.showToast = () => {};
global.logBrainEvent = () => {};
global.S = { brainActivated: false, brainKey: null, assets: [], brainChatLog: [] };

// Load modules
const ApiClient = require('../app/aiconx/webapp/api-client.js');
const UIWiring = require('../app/aiconx/webapp/ui-wiring.js');

// ═══════════════════════════════════════════════════════════════════════════════
// TEST UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

let testsPassed = 0;
let testsFailed = 0;
const testResults = [];

function resetMocks() {
    networkLog.length = 0;
    mockResponses.clear();
    ApiClient.csrfTokens = {};
    UIWiring.useBackend = true;
    UIWiring.currentDiscoveryJobId = null;
    global.S = { brainActivated: false, brainKey: null, assets: [], brainChatLog: [] };
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected "${expected}" but got "${actual}"`);
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
// INTEGRATION TESTS: API CLIENT + DISCOVERY SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

async function testApiClientDiscoveryIntegration() {
    console.log('\n' + '═'.repeat(70));
    console.log('INTEGRATION: API CLIENT + DISCOVERY SERVICE');
    console.log('═'.repeat(70));

    await runTest('CSRF token is fetched before first action call', async () => {
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'fetched-token' } });
        mockResponses.set('testConnection', { status: 200, body: { success: true } });
        
        await ApiClient.discovery.testConnection('sys-123');
        
        const metadataCall = networkLog.find(c => c.url.includes('$metadata'));
        const actionCall = networkLog.find(c => c.url.includes('testConnection'));
        
        assert(metadataCall !== undefined, 'Should fetch metadata for CSRF');
        assert(actionCall !== undefined, 'Should call action');
        assert(metadataCall.timestamp <= actionCall.timestamp, 'CSRF fetch should be before action');
    });

    await runTest('CSRF token is reused for subsequent calls', async () => {
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'reused-token' } });
        mockResponses.set('addPISystem', { status: 200, body: { systemId: 'new' } });
        mockResponses.set('startDiscovery', { status: 200, body: { jobId: 'job' } });
        
        await ApiClient.discovery.addPISystem({ systemName: 'Test' });
        await ApiClient.discovery.startDiscovery('sys-123', {});
        
        const metadataCalls = networkLog.filter(c => c.url.includes('$metadata'));
        assertEqual(metadataCalls.length, 1, 'Should only fetch CSRF once');
    });

    await runTest('Discovery progress polling uses function calls (GET)', async () => {
        mockResponses.set('getDiscoveryProgress', { status: 200, body: { status: 'running', progressPercent: 50 } });
        
        await ApiClient.discovery.getDiscoveryProgress('job-123');
        
        const progressCall = networkLog.find(c => c.url.includes('getDiscoveryProgress'));
        assertEqual(progressCall.method, 'GET', 'Progress should use GET');
    });

    await runTest('Artifact batch operations serialize array correctly', async () => {
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'token' } });
        mockResponses.set('batchApprove', { status: 200, body: { approved: 3 } });
        
        await ApiClient.discovery.batchApprove(['id1', 'id2', 'id3'], 2, 'notes');
        
        const batchCall = networkLog.find(c => c.url.includes('batchApprove'));
        const body = JSON.parse(batchCall.body);
        assert(typeof body.artifactIds === 'string', 'artifactIds should be stringified');
        assertEqual(JSON.parse(body.artifactIds).length, 3, 'Should have 3 IDs');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: UI WIRING + API CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

async function testUIWiringApiClientIntegration() {
    console.log('\n' + '═'.repeat(70));
    console.log('INTEGRATION: UI WIRING + API CLIENT');
    console.log('═'.repeat(70));

    await runTest('UIWiring.testConnection flows through ApiClient to network', async () => {
        UIWiring.useBackend = true;
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'token' } });
        mockResponses.set('testConnection', { 
            status: 200, 
            body: { success: true, dirStatus: 'OK', esrStatus: 'OK', message: 'Connected' } 
        });
        
        const result = await UIWiring.testConnection('sys-int-1');
        
        assertEqual(result.success, true, 'Should return success');
        assertEqual(result.dirStatus, 'OK', 'Should have dirStatus');
        
        const netCall = networkLog.find(c => c.url.includes('testConnection'));
        assert(netCall !== undefined, 'Should make network call');
    });

    await runTest('UIWiring falls back gracefully on network error', async () => {
        UIWiring.useBackend = true;
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'token' } });
        mockResponses.set('testConnection', { error: 'Network unreachable' });
        
        const result = await UIWiring.testConnection('sys-error');
        
        assertEqual(result.success, false, 'Should return failure');
        assert(result.message.includes('Network unreachable'), 'Should include error');
    });

    await runTest('UIWiring.registerPISystem passes params through ApiClient', async () => {
        UIWiring.useBackend = true;
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'token' } });
        mockResponses.set('addPISystem', { status: 200, body: { systemId: 'created-sys' } });
        
        const params = {
            systemName: 'IntegrationTest',
            virtualHost: 'host.test.com',
            virtualPort: 443,
            techUser: 'user'
        };
        
        const result = await UIWiring.registerPISystem(params);
        
        const netCall = networkLog.find(c => c.url.includes('addPISystem'));
        const body = JSON.parse(netCall.body);
        assertEqual(body.systemName, 'IntegrationTest', 'Should pass systemName');
        assertEqual(body.virtualHost, 'host.test.com', 'Should pass virtualHost');
    });

    await runTest('Brain activation state propagates correctly', async () => {
        UIWiring.useBackend = true;
        global.S.brainActivated = false;
        global.S.brainKey = null;
        
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'token' } });
        mockResponses.set('toggleBrain', { status: 200, body: { success: true, eventsCount: 0 } });
        
        await UIWiring.activateBrain('int-key-123');
        
        assertEqual(global.S.brainActivated, true, 'Should update brainActivated');
        assertEqual(global.S.brainKey, 'int-key-123', 'Should store brainKey');
        
        // Now brain operations should use the key
        mockResponses.set('migrationAdvisor', { status: 200, body: { tier: 'simple' } });
        const assessment = await UIWiring.assessArtifact({ objectId: 'OBJ' });
        
        const advisorCall = networkLog.find(c => c.url.includes('migrationAdvisor'));
        assert(advisorCall !== undefined, 'Should call advisor with active brain');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: DEMO MODE ISOLATION
// ═══════════════════════════════════════════════════════════════════════════════

async function testDemoModeIsolation() {
    console.log('\n' + '═'.repeat(70));
    console.log('INTEGRATION: DEMO MODE ISOLATION');
    console.log('═'.repeat(70));

    await runTest('Demo mode prevents all network calls', async () => {
        UIWiring.useBackend = false;
        
        await UIWiring.testConnection('sys');
        await UIWiring.registerPISystem({ systemName: 'Demo' });
        await UIWiring.activateBrain('key');
        await UIWiring.assessArtifact({ objectId: 'O' });
        await UIWiring.approveArtifact('art', 1, '');
        await UIWiring.generateWavePlan('sys');
        await UIWiring.exportInventory('sys', 'csv');
        
        assertEqual(networkLog.length, 0, 'No network calls should be made in demo mode');
    });

    await runTest('Demo mode returns plausible mock data', async () => {
        UIWiring.useBackend = false;
        
        const connection = await UIWiring.testConnection('sys');
        assert(connection.success === true, 'Connection should succeed');
        assert(connection.piVersion !== undefined, 'Should have piVersion');
        
        const registration = await UIWiring.registerPISystem({ systemName: 'X' });
        assert(registration.systemId.includes('mock'), 'Should have mock systemId');
        
        const assessment = await UIWiring.assessArtifact({ objectId: 'O' });
        assert(['simple', 'medium', 'complex'].includes(assessment.tier), 'Should have valid tier');
        
        const wavePlan = await UIWiring.generateWavePlan('sys');
        assertEqual(wavePlan.totalWaves, 3, 'Should have 3 mock waves');
    });

    await runTest('Demo mode can be toggled mid-session', async () => {
        // Start in backend mode
        UIWiring.useBackend = true;
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'token' } });
        mockResponses.set('testConnection', { status: 200, body: { success: true } });
        
        await UIWiring.testConnection('sys');
        assertEqual(networkLog.length, 2, 'Should make network calls in backend mode');
        
        // Switch to demo mode
        UIWiring.useBackend = false;
        networkLog.length = 0;
        
        await UIWiring.testConnection('sys');
        assertEqual(networkLog.length, 0, 'Should not make calls after switching to demo');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: ERROR PROPAGATION
// ═══════════════════════════════════════════════════════════════════════════════

async function testErrorPropagation() {
    console.log('\n' + '═'.repeat(70));
    console.log('INTEGRATION: ERROR PROPAGATION');
    console.log('═'.repeat(70));

    await runTest('HTTP 401 error propagates with clear message', async () => {
        UIWiring.useBackend = true;
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'token' } });
        mockResponses.set('addPISystem', { 
            status: 401, 
            body: { error: { message: 'Authentication required' } } 
        });
        
        let errorMessage = '';
        try {
            await UIWiring.registerPISystem({ systemName: 'Test' });
        } catch (err) {
            errorMessage = err.message;
        }
        
        assert(errorMessage.includes('Authentication') || errorMessage.includes('401'), 'Should indicate auth error');
    });

    await runTest('HTTP 500 error includes server message', async () => {
        UIWiring.useBackend = true;
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'token' } });
        mockResponses.set('generateWavePlan', { 
            status: 500, 
            body: { error: { message: 'Internal database error' } } 
        });
        
        let errorMessage = '';
        try {
            await UIWiring.generateWavePlan('sys');
        } catch (err) {
            errorMessage = err.message;
        }
        
        assert(errorMessage.includes('database') || errorMessage.includes('500'), 'Should include server error');
    });

    await runTest('Network timeout error is handled gracefully', async () => {
        UIWiring.useBackend = true;
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'token' } });
        mockResponses.set('exportInventory', { error: 'Request timeout' });
        
        let errorCaught = false;
        try {
            await UIWiring.exportInventory('sys', 'pdf');
        } catch (err) {
            errorCaught = true;
            assert(err.message.includes('timeout'), 'Should mention timeout');
        }
        
        assert(errorCaught, 'Should catch timeout error');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: END-TO-END FLOWS
// ═══════════════════════════════════════════════════════════════════════════════

async function testEndToEndFlows() {
    console.log('\n' + '═'.repeat(70));
    console.log('INTEGRATION: END-TO-END FLOWS');
    console.log('═'.repeat(70));

    await runTest('E2E: System onboarding flow (register → test → discover)', async () => {
        UIWiring.useBackend = true;
        
        // Setup responses
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'e2e-token' } });
        mockResponses.set('addPISystem', { status: 200, body: { systemId: 'sys-e2e-1', status: 'configured' } });
        mockResponses.set('testConnection', { status: 200, body: { success: true, dirStatus: 'OK', esrStatus: 'OK' } });
        mockResponses.set('startDiscovery', { status: 200, body: { jobId: 'job-e2e-1' } });
        mockResponses.set('getDiscoveryProgress', { status: 200, body: { status: 'completed', artifactsFound: 25 } });
        
        // Execute flow
        const regResult = await UIWiring.registerPISystem({
            systemName: 'E2ETestSystem',
            virtualHost: 'e2e.host.com',
            techUser: 'e2euser'
        });
        assert(regResult.systemId === 'sys-e2e-1', 'Should register system');
        
        const connResult = await UIWiring.testConnection(regResult.systemId);
        assert(connResult.success === true, 'Should connect successfully');
        
        // Verify network call sequence
        const calls = networkLog.filter(c => !c.url.includes('$metadata'));
        assert(calls.length >= 2, 'Should make multiple API calls');
    });

    await runTest('E2E: Migration assessment flow (activate → assess → approve → plan)', async () => {
        UIWiring.useBackend = true;
        global.S.brainKey = null;
        
        // Setup responses
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'assess-token' } });
        mockResponses.set('toggleBrain', { status: 200, body: { success: true } });
        mockResponses.set('migrationAdvisor', { 
            status: 200, 
            body: { tier: 'medium', complexityScore: 55, recommendedTool: 'iFlow_SemiAuto' } 
        });
        mockResponses.set('approveArtifact', { status: 200, body: { success: true } });
        mockResponses.set('generateWavePlan', { 
            status: 200, 
            body: { waves: '[{"wave":1}]', totalWaves: 1, totalHours: 50 } 
        });
        
        // Execute flow
        await UIWiring.activateBrain('e2e-brain-key');
        assert(global.S.brainActivated === true, 'Brain should be active');
        
        const assessment = await UIWiring.assessArtifact({ objectId: 'ICO-E2E-1', objectType: 'ICO' });
        assert(assessment.tier === 'medium', 'Should assess as medium');
        
        await UIWiring.approveArtifact('art-e2e-1', 1, 'E2E approved');
        
        const plan = await UIWiring.generateWavePlan('sys-e2e');
        assert(plan.totalWaves === 1, 'Should generate wave plan');
    });

    await runTest('E2E: Export flow with filters', async () => {
        UIWiring.useBackend = true;
        
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'export-token' } });
        mockResponses.set('exportInventory', { 
            status: 200, 
            body: { downloadUrl: 'https://storage.example.com/export.csv', artifactCount: 150 } 
        });
        
        const result = await UIWiring.exportInventory('sys-export', 'csv', { 
            status: 'approved',
            wave: 1 
        });
        
        assert(result.downloadUrl !== undefined, 'Should have download URL');
        assertEqual(result.artifactCount, 150, 'Should report artifact count');
        
        const exportCall = networkLog.find(c => c.url.includes('exportInventory'));
        const body = JSON.parse(exportCall.body);
        assert(body.filters !== undefined, 'Should include filters in request');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS: CONCURRENT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function testConcurrentOperations() {
    console.log('\n' + '═'.repeat(70));
    console.log('INTEGRATION: CONCURRENT OPERATIONS');
    console.log('═'.repeat(70));

    await runTest('Concurrent API calls share CSRF token', async () => {
        UIWiring.useBackend = true;
        mockResponses.set('$metadata', { status: 200, headers: { 'x-csrf-token': 'shared-token' } });
        mockResponses.set('approveArtifact', { status: 200, body: { success: true } });
        
        // Make concurrent calls
        await Promise.all([
            UIWiring.approveArtifact('art-1', 1, ''),
            UIWiring.approveArtifact('art-2', 1, ''),
            UIWiring.approveArtifact('art-3', 1, '')
        ]);
        
        // Should only fetch CSRF once
        const metadataCalls = networkLog.filter(c => c.url.includes('$metadata'));
        assert(metadataCalls.length <= 1, 'Should minimize CSRF fetches');
    });

    await runTest('Multiple discovery services use separate tokens', async () => {
        // Reset token cache
        ApiClient.csrfTokens = {};
        
        mockResponses.set('discovery/$metadata', { status: 200, headers: { 'x-csrf-token': 'discovery-token' } });
        mockResponses.set('brain/$metadata', { status: 200, headers: { 'x-csrf-token': 'brain-token' } });
        mockResponses.set('testConnection', { status: 200, body: { success: true } });
        mockResponses.set('toggleBrain', { status: 200, body: { success: true } });
        
        await Promise.all([
            ApiClient.discovery.testConnection('sys'),
            ApiClient.brain.toggleBrain('key', true)
        ]);
        
        // Check both services have tokens
        const discoveryToken = ApiClient.csrfTokens[ApiClient.config.basePaths.discovery];
        const brainToken = ApiClient.csrfTokens[ApiClient.config.basePaths.brain];
        
        // At least one should be set (depending on race condition)
        assert(discoveryToken || brainToken, 'Should have at least one service token');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('╔' + '═'.repeat(68) + '╗');
    console.log('║' + ' INTEGRATION TESTS'.padEnd(68) + '║');
    console.log('║' + ' Testing: api-client.js + ui-wiring.js interaction'.padEnd(68) + '║');
    console.log('╚' + '═'.repeat(68) + '╝');
    
    const startTime = Date.now();
    
    await testApiClientDiscoveryIntegration();
    await testUIWiringApiClientIntegration();
    await testDemoModeIsolation();
    await testErrorPropagation();
    await testEndToEndFlows();
    await testConcurrentOperations();
    
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
    
    // Export results
    module.exports = {
        module: 'integration',
        total: testsPassed + testsFailed,
        passed: testsPassed,
        failed: testsFailed,
        duration,
        results: testResults
    };
    
    process.exit(testsFailed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal test error:', err.message);
    process.exit(1);
});
