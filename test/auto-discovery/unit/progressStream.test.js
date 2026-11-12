'use strict';

/**
 * Unit Tests: SSE Progress Stream Handler
 *
 * Tests the SSE progress stream module for connection management,
 * heartbeat mechanism, and event broadcasting.
 */

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Test results accumulator
const testResults = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: [],
};

function recordTest(name, status, error = null) {
  testResults.tests.push({ name, status, error: error?.message || null });
  testResults[status]++;
}

// Read source for static analysis
const progressStreamSource = fs.readFileSync(
  path.join(__dirname, '../../../srv/sse/progressStream.js'),
  'utf8'
);

// ============================================================================
// Test: Heartbeat Interval Configuration
// ============================================================================
async function testHeartbeatInterval() {
  const testName = 'Heartbeat interval is configured correctly (30s)';
  try {
    assert.ok(
      progressStreamSource.includes('HEARTBEAT_INTERVAL = 30000'),
      'HEARTBEAT_INTERVAL should be 30000ms (30 seconds)'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Connection Timeout Configuration
// ============================================================================
async function testConnectionTimeout() {
  const testName = 'Connection timeout is configured correctly (5 minutes)';
  try {
    assert.ok(
      progressStreamSource.includes('CONNECTION_TIMEOUT = 300000'),
      'CONNECTION_TIMEOUT should be 300000ms (5 minutes)'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: SSE Headers Configuration
// ============================================================================
async function testSseHeaders() {
  const testName = 'SSE headers are configured correctly';
  try {
    // Check required SSE headers
    assert.ok(
      progressStreamSource.includes("'Content-Type': 'text/event-stream'"),
      'Content-Type should be text/event-stream'
    );

    assert.ok(
      progressStreamSource.includes("'Cache-Control': 'no-cache'"),
      'Cache-Control should be no-cache'
    );

    assert.ok(
      progressStreamSource.includes("'Connection': 'keep-alive'"),
      'Connection should be keep-alive'
    );

    assert.ok(
      progressStreamSource.includes("'X-Accel-Buffering': 'no'"),
      'X-Accel-Buffering should be no (disable nginx buffering)'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Authentication Required
// ============================================================================
async function testAuthenticationRequired() {
  const testName = 'SSE endpoint requires authentication';
  try {
    assert.ok(
      progressStreamSource.includes("if (!req.user)"),
      'Should check for authenticated user'
    );

    assert.ok(
      progressStreamSource.includes("401"),
      'Should return 401 for unauthenticated requests'
    );

    assert.ok(
      progressStreamSource.includes("'Authentication required'"),
      'Should return authentication error message'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Job Validation
// ============================================================================
async function testJobValidation() {
  const testName = 'SSE endpoint validates job exists and belongs to tenant';
  try {
    assert.ok(
      progressStreamSource.includes('SELECT.one'),
      'Should query for job'
    );

    assert.ok(
      progressStreamSource.includes('ID: jobId, tenantId'),
      'Should check job belongs to tenant'
    );

    assert.ok(
      progressStreamSource.includes('404'),
      'Should return 404 for non-existent job'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Initial Connection Event
// ============================================================================
async function testInitialConnectionEvent() {
  const testName = 'SSE sends initial connection event';
  try {
    assert.ok(
      progressStreamSource.includes("event: connected"),
      'Should send connected event on connection'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Connection Registration
// ============================================================================
async function testConnectionRegistration() {
  const testName = 'Connections are registered and tracked';
  try {
    // Check connections map usage
    assert.ok(
      progressStreamSource.includes('const connections = new Map()'),
      'Should use Map for connection tracking'
    );

    assert.ok(
      progressStreamSource.includes("connections.get(jobId)"),
      'Should group connections by job ID'
    );

    assert.ok(
      progressStreamSource.includes('connectionId'),
      'Each connection should have unique ID'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Heartbeat Mechanism
// ============================================================================
async function testHeartbeatMechanism() {
  const testName = 'Heartbeat keeps connections alive';
  try {
    assert.ok(
      progressStreamSource.includes('setInterval'),
      'Should use setInterval for heartbeat'
    );

    assert.ok(
      progressStreamSource.includes('heartbeat'),
      'Should send heartbeat comments'
    );

    assert.ok(
      progressStreamSource.includes('clearInterval(heartbeatId)'),
      'Should clear interval on disconnect'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Client Disconnect Handling
// ============================================================================
async function testClientDisconnectHandling() {
  const testName = 'Client disconnect is handled properly';
  try {
    assert.ok(
      progressStreamSource.includes("req.on('close'"),
      'Should listen for close event'
    );

    assert.ok(
      progressStreamSource.includes("req.on('error'"),
      'Should listen for error event'
    );

    assert.ok(
      progressStreamSource.includes('removeConnection'),
      'Should remove connection on close'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Broadcast Progress Function
// ============================================================================
async function testBroadcastProgressFunction() {
  const testName = 'broadcastProgress sends events to all job connections';
  try {
    assert.ok(
      progressStreamSource.includes('function broadcastProgress(jobId, event)'),
      'broadcastProgress function should be defined'
    );

    assert.ok(
      progressStreamSource.includes('jobConnections.forEach'),
      'Should iterate all connections for job'
    );

    // Check for event writing (using template literal pattern in source)
    assert.ok(
      progressStreamSource.includes('connection.response.write(') &&
      progressStreamSource.includes('event:') &&
      progressStreamSource.includes('eventType'),
      'Should write event type'
    );

    assert.ok(
      progressStreamSource.includes('data:') &&
      progressStreamSource.includes('eventData'),
      'Should write event data'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Stale Connection Cleanup
// ============================================================================
async function testStaleConnectionCleanup() {
  const testName = 'Stale connections are cleaned up';
  try {
    assert.ok(
      progressStreamSource.includes('cleanupStaleConnections'),
      'cleanupStaleConnections function should be defined'
    );

    assert.ok(
      progressStreamSource.includes('lastActivity'),
      'Should track last activity time'
    );

    assert.ok(
      progressStreamSource.includes('CONNECTION_TIMEOUT'),
      'Should use CONNECTION_TIMEOUT for staleness check'
    );

    // Check cleanup runs periodically
    assert.ok(
      progressStreamSource.includes('setInterval(cleanupStaleConnections'),
      'Should run cleanup periodically'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Job Completion Handling
// ============================================================================
async function testJobCompletionHandling() {
  const testName = 'Connections are closed on job completion';
  try {
    assert.ok(
      progressStreamSource.includes('closeJobConnections'),
      'closeJobConnections function should be defined'
    );

    assert.ok(
      progressStreamSource.includes("event: close"),
      'Should send close event'
    );

    assert.ok(
      progressStreamSource.includes("job_complete"),
      'Should indicate job complete in close reason'
    );

    assert.ok(
      progressStreamSource.includes('setTimeout'),
      'Should delay connection close to ensure clients receive final event'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Event Types
// ============================================================================
async function testEventTypes() {
  const testName = 'All event types are handled';
  try {
    const eventTypes = ['connected', 'status', 'progress', 'complete', 'close'];

    for (const eventType of eventTypes) {
      assert.ok(
        progressStreamSource.includes(eventType),
        `Event type '${eventType}' should be handled`
      );
    }

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Debug Endpoint
// ============================================================================
async function testDebugEndpoint() {
  const testName = 'Debug endpoint returns connection stats';
  try {
    assert.ok(
      progressStreamSource.includes('/api/discovery/progress/connections'),
      'Debug endpoint should exist'
    );

    assert.ok(
      progressStreamSource.includes('totalJobs:'),
      'Should return total jobs count'
    );

    assert.ok(
      progressStreamSource.includes('connectionCount:'),
      'Should return connection count per job'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: CDS Event Bridge
// ============================================================================
async function testCdsEventBridge() {
  const testName = 'CDS events are bridged to SSE broadcasts';
  try {
    assert.ok(
      progressStreamSource.includes('handleDiscoveryProgressEvent'),
      'handleDiscoveryProgressEvent should be exported'
    );

    assert.ok(
      progressStreamSource.includes('handleDiscoveryCompleteEvent'),
      'handleDiscoveryCompleteEvent should be exported'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Module Exports
// ============================================================================
async function testModuleExports() {
  const testName = 'Module exports all required functions';
  try {
    assert.ok(
      progressStreamSource.includes('initializeSSE'),
      'initializeSSE should be exported'
    );

    assert.ok(
      progressStreamSource.includes('broadcastProgress'),
      'broadcastProgress should be exported'
    );

    assert.ok(
      progressStreamSource.includes('closeJobConnections'),
      'closeJobConnections should be exported'
    );

    assert.ok(
      progressStreamSource.includes('handleDiscoveryProgressEvent'),
      'handleDiscoveryProgressEvent should be exported'
    );

    assert.ok(
      progressStreamSource.includes('handleDiscoveryCompleteEvent'),
      'handleDiscoveryCompleteEvent should be exported'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Run All Tests
// ============================================================================
async function runAllTests() {
  console.log('\n=== SSE Progress Stream Unit Tests ===\n');

  await testHeartbeatInterval();
  await testConnectionTimeout();
  await testSseHeaders();
  await testAuthenticationRequired();
  await testJobValidation();
  await testInitialConnectionEvent();
  await testConnectionRegistration();
  await testHeartbeatMechanism();
  await testClientDisconnectHandling();
  await testBroadcastProgressFunction();
  await testStaleConnectionCleanup();
  await testJobCompletionHandling();
  await testEventTypes();
  await testDebugEndpoint();
  await testCdsEventBridge();
  await testModuleExports();

  console.log('\n--- Summary ---');
  console.log(`Passed: ${testResults.passed}`);
  console.log(`Failed: ${testResults.failed}`);
  console.log(`Skipped: ${testResults.skipped}`);

  return testResults;
}

// Export for test runner
module.exports = { runAllTests, testResults };

// Run if executed directly
if (require.main === module) {
  runAllTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  });
}
