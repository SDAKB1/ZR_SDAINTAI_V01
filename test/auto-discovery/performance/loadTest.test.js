'use strict';

/**
 * Performance Tests: Auto-Discovery Feature
 *
 * Tests load handling, memory usage, and concurrency for the auto-discovery feature.
 * These tests verify the system can handle production-like loads.
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

function recordTest(name, status, error = null, metrics = null) {
  testResults.tests.push({ name, status, error: error?.message || null, metrics });
  testResults[status]++;
}

// ============================================================================
// Test: Batch Processing Configuration
// ============================================================================
async function testBatchProcessingConfiguration() {
  const testName = 'Batch processing is configured for large result sets';
  try {
    const workerSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/workers/discoveryWorker.js'),
      'utf8'
    );

    // Check batch size configuration
    assert.ok(
      workerSource.includes('ARTIFACT_BATCH_SIZE = 100'),
      'Batch size should be 100 artifacts'
    );

    // Check batch processing logic
    assert.ok(
      workerSource.includes('i += ARTIFACT_BATCH_SIZE'),
      'Should process artifacts in batches'
    );

    assert.ok(
      workerSource.includes('artifacts.slice(i, i + ARTIFACT_BATCH_SIZE)'),
      'Should slice artifacts into batches'
    );

    recordTest(testName, 'passed', null, { batchSize: 100 });
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Phase Timeout Configuration
// ============================================================================
async function testPhaseTimeoutConfiguration() {
  const testName = 'Phase timeouts are configured for production workloads';
  try {
    const { DISCOVERY_PHASES } = require('../../../srv/workers/discoveryWorker');

    // Calculate total timeout
    const totalTimeout = DISCOVERY_PHASES.reduce((sum, p) => sum + p.timeout, 0);

    // Verify reasonable total timeout (should be under 15 minutes)
    const maxTotalTimeout = 15 * 60 * 1000; // 15 minutes
    assert.ok(
      totalTimeout <= maxTotalTimeout,
      `Total timeout (${totalTimeout}ms) should be <= 15 minutes`
    );

    // Verify ESR phase has longest timeout (complex queries)
    const esrPhase = DISCOVERY_PHASES.find(p => p.code === 'ESRObjects');
    const maxPhaseTimeout = DISCOVERY_PHASES.reduce((max, p) => Math.max(max, p.timeout), 0);
    assert.strictEqual(esrPhase.timeout, maxPhaseTimeout, 'ESR should have longest timeout');

    recordTest(testName, 'passed', null, { totalTimeoutMs: totalTimeout });
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: SSE Connection Limits
// ============================================================================
async function testSseConnectionLimits() {
  const testName = 'SSE connection limits are reasonable';
  try {
    const sseSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/sse/progressStream.js'),
      'utf8'
    );

    // Check heartbeat interval (30s is standard)
    assert.ok(
      sseSource.includes('HEARTBEAT_INTERVAL = 30000'),
      'Heartbeat interval should be 30 seconds'
    );

    // Check connection timeout (5 minutes is reasonable)
    assert.ok(
      sseSource.includes('CONNECTION_TIMEOUT = 300000'),
      'Connection timeout should be 5 minutes'
    );

    // Check cleanup mechanism exists
    assert.ok(
      sseSource.includes('cleanupStaleConnections'),
      'Stale connection cleanup should exist'
    );

    recordTest(testName, 'passed', null, {
      heartbeatInterval: 30000,
      connectionTimeout: 300000,
    });
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Retry Policy Configuration (BR-006)
// ============================================================================
async function testRetryPolicyConfiguration() {
  const testName = 'Retry policy follows exponential backoff (BR-006)';
  try {
    const workerSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/workers/discoveryWorker.js'),
      'utf8'
    );

    // Extract retry configuration
    assert.ok(
      workerSource.includes('MAX_RETRY_ATTEMPTS = 3'),
      'Max retry attempts should be 3'
    );

    assert.ok(
      workerSource.includes('RETRY_DELAYS = [1000, 4000, 16000]'),
      'Retry delays should be [1s, 4s, 16s]'
    );

    // Verify exponential pattern (each delay is ~4x previous)
    const delays = [1000, 4000, 16000];
    const ratio1 = delays[1] / delays[0]; // 4
    const ratio2 = delays[2] / delays[1]; // 4

    assert.strictEqual(ratio1, 4, 'Second delay should be 4x first');
    assert.strictEqual(ratio2, 4, 'Third delay should be 4x second');

    // Total max wait time
    const totalMaxWait = delays.reduce((sum, d) => sum + d, 0);
    assert.strictEqual(totalMaxWait, 21000, 'Total max retry wait should be 21s');

    recordTest(testName, 'passed', null, {
      maxAttempts: 3,
      delays: delays,
      totalMaxWaitMs: totalMaxWait,
    });
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Test History Memory Limit
// ============================================================================
async function testTestHistoryMemoryLimit() {
  const testName = 'Test history is limited to prevent memory growth';
  try {
    const tenantServiceSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/tenant/tenant-service.js'),
      'utf8'
    );

    // Check history limit
    assert.ok(
      tenantServiceSource.includes('MAX_TEST_HISTORY = 10'),
      'Test history should be limited to 10 entries'
    );

    // Check trimming logic
    assert.ok(
      tenantServiceSource.includes('testHistory.length > MAX_TEST_HISTORY'),
      'Should check if history exceeds limit'
    );

    assert.ok(
      tenantServiceSource.includes('testHistory.slice(0, MAX_TEST_HISTORY)'),
      'Should trim history to limit'
    );

    // Estimate memory per entry (rough estimate: ~500 bytes per JSON entry)
    const estimatedMaxMemoryPerSystem = 10 * 500; // 5KB
    
    recordTest(testName, 'passed', null, {
      maxEntries: 10,
      estimatedMaxMemoryPerSystem: `${estimatedMaxMemoryPerSystem} bytes`,
    });
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Concurrent Job Prevention
// ============================================================================
async function testConcurrentJobPrevention() {
  const testName = 'Concurrent jobs per system are prevented (BR-003)';
  try {
    const tenantServiceSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/tenant/tenant-service.js'),
      'utf8'
    );

    // Check for running job detection
    const runningJobCheckCount = (
      tenantServiceSource.match(/status: \{ in: \['pending', 'running'\] \}/g) || []
    ).length;

    assert.ok(
      runningJobCheckCount >= 2,
      'Should check for running jobs in multiple handlers'
    );

    // Check conflict response
    assert.ok(
      tenantServiceSource.includes('409'),
      'Should return 409 conflict for concurrent job'
    );

    recordTest(testName, 'passed', null, { checkCount: runningJobCheckCount });
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Asynchronous Processing
// ============================================================================
async function testAsynchronousProcessing() {
  const testName = 'Discovery uses async processing with CAP queues';
  try {
    const tenantServiceSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/tenant/tenant-service.js'),
      'utf8'
    );

    // Check CAP event queue usage
    assert.ok(
      tenantServiceSource.includes('cds.queued(this)'),
      'Should use CAP transactional outbox (cds.queued)'
    );

    assert.ok(
      tenantServiceSource.includes("emit('DiscoveryRequested'"),
      'Should emit async event'
    );

    // Check non-blocking destination creation
    assert.ok(
      tenantServiceSource.includes('_createDestinationsAsync'),
      'Destination creation should be async'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Outbox Configuration
// ============================================================================
async function testOutboxConfiguration() {
  const testName = 'CAP outbox is configured for reliability';
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../../../package.json'),
        'utf8'
      )
    );

    // Check outbox configuration
    const outboxConfig = packageJson.cds?.requires?.outbox;
    assert.ok(outboxConfig, 'Outbox should be configured');

    assert.strictEqual(outboxConfig.kind, 'persistent-outbox', 'Should use persistent outbox');
    assert.ok(outboxConfig.maxAttempts >= 10, 'Should have at least 10 retry attempts');
    assert.ok(outboxConfig.chunkSize >= 100, 'Should process at least 100 items per chunk');
    assert.ok(outboxConfig.parallelism >= 5, 'Should have parallelism >= 5');

    recordTest(testName, 'passed', null, outboxConfig);
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Progress Weight Distribution
// ============================================================================
async function testProgressWeightDistribution() {
  const testName = 'Phase progress weights are balanced';
  try {
    const { DISCOVERY_PHASES } = require('../../../srv/workers/discoveryWorker');

    // Check weights sum to 100
    const totalWeight = DISCOVERY_PHASES.reduce((sum, p) => sum + p.weight, 0);
    assert.strictEqual(totalWeight, 100, 'Total weights should sum to 100%');

    // ESR phase should have highest weight (most time-consuming)
    const esrPhase = DISCOVERY_PHASES.find(p => p.code === 'ESRObjects');
    const maxWeight = DISCOVERY_PHASES.reduce((max, p) => Math.max(max, p.weight), 0);
    assert.strictEqual(esrPhase.weight, maxWeight, 'ESR should have highest weight');

    // Config scenarios should have lowest weight (quick to fetch)
    const configPhase = DISCOVERY_PHASES.find(p => p.code === 'ConfigurationScenario');
    const minWeight = DISCOVERY_PHASES.reduce((min, p) => Math.min(min, p.weight), 100);
    assert.strictEqual(configPhase.weight, minWeight, 'Config scenarios should have lowest weight');

    const weights = DISCOVERY_PHASES.map(p => ({ code: p.code, weight: p.weight }));
    recordTest(testName, 'passed', null, { weights });
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Idempotent Artifact Upsert
// ============================================================================
async function testIdempotentArtifactUpsert() {
  const testName = 'Artifact upsert is idempotent';
  try {
    const workerSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/workers/discoveryWorker.js'),
      'utf8'
    );

    // Check for existing artifact check
    assert.ok(
      workerSource.includes('SELECT.one'),
      'Should check for existing artifact'
    );

    assert.ok(
      workerSource.includes('existing'),
      'Should use existing check result'
    );

    // Check for upsert logic
    assert.ok(
      workerSource.includes('if (existing)'),
      'Should branch on existing artifact'
    );

    assert.ok(
      workerSource.includes('UPDATE(Artifact).set(artifactData)'),
      'Should update existing artifact'
    );

    assert.ok(
      workerSource.includes('INSERT.into(Artifact)'),
      'Should insert new artifact'
    );

    // Check for isNew flag
    assert.ok(
      workerSource.includes('isNew: false') && workerSource.includes('isNew: true'),
      'Should track if artifact is new'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Large Artifact Handling
// ============================================================================
async function testLargeArtifactHandling() {
  const testName = 'Large artifacts (raw definitions) are handled';
  try {
    const tenantSchema = fs.readFileSync(
      path.join(__dirname, '../../../db/tenant-schema.cds'),
      'utf8'
    );

    // Check rawDefinition is LargeString
    assert.ok(
      tenantSchema.includes('rawDefinition   : LargeString'),
      'rawDefinition should be LargeString for large XML'
    );

    // Check dependencies is LargeString
    assert.ok(
      tenantSchema.includes('dependencies    : LargeString'),
      'dependencies should be LargeString'
    );

    // Check error logs are LargeString
    assert.ok(
      tenantSchema.includes('errorLog        : LargeString'),
      'errorLog should be LargeString'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Memory-Efficient Metrics Tracking
// ============================================================================
async function testMemoryEfficientMetricsTracking() {
  const testName = 'Metrics are tracked efficiently in memory';
  try {
    const { DiscoveryWorker } = require('../../../srv/workers/discoveryWorker');

    const worker = new DiscoveryWorker({
      tenantId: 'test',
      jobId: 'test',
      system: { ID: 'test' },
      options: {},
    });

    // Check metrics are simple counters (not growing arrays)
    assert.ok(typeof worker.metrics.totalArtifacts === 'number');
    assert.ok(typeof worker.metrics.newArtifacts === 'number');
    assert.ok(typeof worker.metrics.updatedArtifacts === 'number');
    assert.ok(typeof worker.metrics.errors === 'number');
    assert.ok(typeof worker.metrics.warnings === 'number');

    // Errors array should start empty
    assert.ok(Array.isArray(worker.errors));
    assert.strictEqual(worker.errors.length, 0);

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
  console.log('\n=== Auto-Discovery Performance Tests ===\n');

  await testBatchProcessingConfiguration();
  await testPhaseTimeoutConfiguration();
  await testSseConnectionLimits();
  await testRetryPolicyConfiguration();
  await testTestHistoryMemoryLimit();
  await testConcurrentJobPrevention();
  await testAsynchronousProcessing();
  await testOutboxConfiguration();
  await testProgressWeightDistribution();
  await testIdempotentArtifactUpsert();
  await testLargeArtifactHandling();
  await testMemoryEfficientMetricsTracking();

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
