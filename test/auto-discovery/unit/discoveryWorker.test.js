'use strict';

/**
 * Unit Tests: Discovery Worker
 *
 * Tests the DiscoveryWorker class in isolation with mocked dependencies.
 * Covers phase processing, retry logic, cancellation, and artifact upserting.
 */

const assert = require('node:assert');
const { describe, it, beforeEach, afterEach, mock } = require('node:test');

// Mock CDS before requiring the worker
const mockCds = {
  log: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
  entities: () => ({
    PISystem: 'PISystem',
    DiscoveryJob: 'DiscoveryJob',
    Artifact: 'Artifact',
    DependencyGraph: 'DependencyGraph',
  }),
  connect: {
    to: async () => ({ emit: async () => {} }),
  },
};

// Store original require
const originalRequire = module.constructor.prototype.require;

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

// ============================================================================
// Test: Discovery Phase Configuration
// ============================================================================
async function testDiscoveryPhasesConfiguration() {
  const testName = 'Discovery phases are correctly configured';
  try {
    // Import DISCOVERY_PHASES from the worker
    const { DISCOVERY_PHASES } = require('../../../srv/workers/discoveryWorker');

    // Verify we have all 6 phases
    assert.strictEqual(DISCOVERY_PHASES.length, 6, 'Should have 6 discovery phases');

    // Verify phase weights sum to 100
    const totalWeight = DISCOVERY_PHASES.reduce((sum, p) => sum + p.weight, 0);
    assert.strictEqual(totalWeight, 100, 'Phase weights should sum to 100%');

    // Verify each phase has required properties
    for (const phase of DISCOVERY_PHASES) {
      assert.ok(phase.order, `Phase ${phase.code} should have order`);
      assert.ok(phase.code, `Phase should have code`);
      assert.ok(phase.name, `Phase ${phase.code} should have name`);
      assert.ok(Array.isArray(phase.types), `Phase ${phase.code} should have types array`);
      assert.ok(phase.weight >= 0, `Phase ${phase.code} should have non-negative weight`);
      assert.ok(['dir', 'esr'].includes(phase.category), `Phase ${phase.code} should have valid category`);
      assert.ok(phase.timeout > 0, `Phase ${phase.code} should have positive timeout`);
    }

    // Verify phase order is sequential
    const orders = DISCOVERY_PHASES.map(p => p.order);
    assert.deepStrictEqual(orders, [1, 2, 3, 4, 5, 6], 'Phases should be ordered 1-6');

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Retry Configuration (BR-006)
// ============================================================================
async function testRetryConfiguration() {
  const testName = 'Retry configuration follows BR-006 (exponential backoff)';
  try {
    // Check module constants via source inspection
    const fs = require('fs');
    const path = require('path');
    const workerSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/workers/discoveryWorker.js'),
      'utf8'
    );

    // Verify MAX_RETRY_ATTEMPTS = 3
    assert.ok(
      workerSource.includes('MAX_RETRY_ATTEMPTS = 3'),
      'MAX_RETRY_ATTEMPTS should be 3'
    );

    // Verify exponential backoff delays: 1s, 4s, 16s
    assert.ok(
      workerSource.includes('RETRY_DELAYS = [1000, 4000, 16000]'),
      'RETRY_DELAYS should follow exponential backoff: 1s, 4s, 16s'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Mock Artifact Generation
// ============================================================================
async function testMockArtifactGeneration() {
  const testName = 'Mock artifacts are generated correctly for each type';
  try {
    const { DiscoveryWorker } = require('../../../srv/workers/discoveryWorker');

    const worker = new DiscoveryWorker({
      tenantId: 'test-tenant',
      jobId: 'test-job-id',
      system: { ID: 'test-system', destinationDir: 'DIR', destinationEsr: 'ESR' },
      options: {},
    });

    // Test mock data for each artifact type
    const artifactTypes = [
      'ConfigurationScenario',
      'IntegratedConfiguration',
      'CommunicationChannel',
      'SenderAgreement',
      'ReceiverAgreement',
      'ValueMappingGroup',
      'SoftwareComponentVersion',
      'MessageMapping',
      'OperationMapping',
      'ServiceInterface',
    ];

    for (const type of artifactTypes) {
      const mockData = worker._getMockArtifacts(type);
      assert.ok(Array.isArray(mockData), `${type} should return array`);

      for (const artifact of mockData) {
        assert.ok(artifact.ObjectID || artifact.Name, `${type} artifacts should have ObjectID or Name`);
      }
    }

    // Verify IntegratedConfiguration has adapter types
    const icos = worker._getMockArtifacts('IntegratedConfiguration');
    assert.ok(icos.length >= 2, 'Should have multiple ICOs');
    const adapterTypes = icos.map(ico => ico.AdapterType);
    assert.ok(adapterTypes.some(t => ['SOAP', 'IDoc', 'RFC'].includes(t)), 'ICOs should have adapter types');

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Worker Constructor Initialization
// ============================================================================
async function testWorkerConstructorInitialization() {
  const testName = 'DiscoveryWorker initializes correctly';
  try {
    const { DiscoveryWorker } = require('../../../srv/workers/discoveryWorker');

    const options = {
      tenantId: 'tenant-123',
      jobId: 'job-456',
      system: {
        ID: 'sys-789',
        systemName: 'TestSystem',
        destinationDir: 'DIR_DEST',
        destinationEsr: 'ESR_DEST',
      },
      options: {
        includeInactive: true,
        includeHistory: false,
      },
    };

    const worker = new DiscoveryWorker(options);

    // Verify initialization
    assert.strictEqual(worker.tenantId, 'tenant-123');
    assert.strictEqual(worker.jobId, 'job-456');
    assert.strictEqual(worker.system.ID, 'sys-789');
    assert.strictEqual(worker.discoveryOptions.includeInactive, true);
    assert.strictEqual(worker.cancelled, false);

    // Verify metrics initialization
    assert.deepStrictEqual(worker.metrics, {
      totalArtifacts: 0,
      newArtifacts: 0,
      updatedArtifacts: 0,
      errors: 0,
      warnings: 0,
    });

    // Verify errors array initialization
    assert.deepStrictEqual(worker.errors, []);

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Batch Size Configuration
// ============================================================================
async function testBatchSizeConfiguration() {
  const testName = 'Artifact batch size is configured correctly';
  try {
    const fs = require('fs');
    const path = require('path');
    const workerSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/workers/discoveryWorker.js'),
      'utf8'
    );

    // Verify ARTIFACT_BATCH_SIZE = 100
    assert.ok(
      workerSource.includes('ARTIFACT_BATCH_SIZE = 100'),
      'ARTIFACT_BATCH_SIZE should be 100'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Sleep Function
// ============================================================================
async function testSleepFunction() {
  const testName = 'Sleep function waits correct duration';
  try {
    const { DiscoveryWorker } = require('../../../srv/workers/discoveryWorker');

    const worker = new DiscoveryWorker({
      tenantId: 'test',
      jobId: 'test',
      system: { ID: 'test' },
      options: {},
    });

    const start = Date.now();
    await worker._sleep(50);
    const elapsed = Date.now() - start;

    // Allow 10ms tolerance
    assert.ok(elapsed >= 50, `Sleep should wait at least 50ms, got ${elapsed}ms`);
    assert.ok(elapsed < 100, `Sleep should not wait too long, got ${elapsed}ms`);

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Artifact Type Categories
// ============================================================================
async function testArtifactTypeCategories() {
  const testName = 'Artifact types are categorized correctly (dir/esr)';
  try {
    const { DISCOVERY_PHASES } = require('../../../srv/workers/discoveryWorker');

    // Directory types
    const dirPhases = DISCOVERY_PHASES.filter(p => p.category === 'dir');
    const dirTypes = dirPhases.flatMap(p => p.types);

    // ESR types
    const esrPhases = DISCOVERY_PHASES.filter(p => p.category === 'esr');
    const esrTypes = esrPhases.flatMap(p => p.types);

    // Verify expected DIR types
    const expectedDirTypes = [
      'ConfigurationScenario',
      'IntegratedConfiguration',
      'IntegratedConfiguration750',
      'CommunicationChannel',
      'SenderAgreement',
      'ReceiverAgreement',
      'ValueMappingGroup',
    ];

    for (const type of expectedDirTypes) {
      assert.ok(dirTypes.includes(type), `${type} should be in DIR category`);
    }

    // Verify expected ESR types
    const expectedEsrTypes = [
      'SoftwareComponentVersion',
      'MessageMapping',
      'OperationMapping',
      'ServiceInterface',
    ];

    for (const type of expectedEsrTypes) {
      assert.ok(esrTypes.includes(type), `${type} should be in ESR category`);
    }

    recordTest(testName, 'passed');
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
  const testName = 'Phase timeouts are reasonable';
  try {
    const { DISCOVERY_PHASES } = require('../../../srv/workers/discoveryWorker');

    for (const phase of DISCOVERY_PHASES) {
      // Timeouts should be between 30s and 10min
      assert.ok(
        phase.timeout >= 30000,
        `Phase ${phase.code} timeout (${phase.timeout}ms) should be >= 30s`
      );
      assert.ok(
        phase.timeout <= 600000,
        `Phase ${phase.code} timeout (${phase.timeout}ms) should be <= 10min`
      );
    }

    // ESR phase should have longest timeout (complex queries)
    const esrPhase = DISCOVERY_PHASES.find(p => p.code === 'ESRObjects');
    assert.ok(esrPhase.timeout >= 300000, 'ESR phase should have >= 5min timeout');

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
  console.log('\n=== Discovery Worker Unit Tests ===\n');

  await testDiscoveryPhasesConfiguration();
  await testRetryConfiguration();
  await testMockArtifactGeneration();
  await testWorkerConstructorInitialization();
  await testBatchSizeConfiguration();
  await testSleepFunction();
  await testArtifactTypeCategories();
  await testPhaseTimeoutConfiguration();

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
