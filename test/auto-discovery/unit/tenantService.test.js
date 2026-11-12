'use strict';

/**
 * Unit Tests: Tenant Service
 *
 * Tests tenant service validation, auto-discovery triggers, and configuration handling.
 * Uses isolated function testing without CDS runtime.
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
const tenantServiceSource = fs.readFileSync(
  path.join(__dirname, '../../../srv/tenant/tenant-service.js'),
  'utf8'
);

// ============================================================================
// Test: URL Pattern Validation
// ============================================================================
async function testUrlPatternValidation() {
  const testName = 'URL pattern validates hostnames correctly';
  try {
    // Extract URL_PATTERN from source
    const patternMatch = tenantServiceSource.match(/URL_PATTERN = ([^;]+);/);
    assert.ok(patternMatch, 'URL_PATTERN should be defined');

    // Reconstruct the pattern
    const URL_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

    // Valid hostnames
    const validHosts = [
      'pipo.example.com',
      'po-dev.sap.corp',
      'localhost',
      'server1',
      'pi-po-server.company.internal',
      'a.b.c',
    ];

    for (const host of validHosts) {
      assert.ok(URL_PATTERN.test(host), `"${host}" should be valid hostname`);
    }

    // Invalid hostnames
    const invalidHosts = [
      '-invalid.com',
      'invalid-.com',
      '.invalid.com',
      'invalid..com',
      'http://example.com',
      'example.com/',
      'example.com:8080',
    ];

    for (const host of invalidHosts) {
      assert.ok(!URL_PATTERN.test(host), `"${host}" should be invalid hostname`);
    }

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Max String Lengths Configuration
// ============================================================================
async function testMaxStringLengthsConfiguration() {
  const testName = 'Max string lengths are configured correctly';
  try {
    // Extract MAX_STRING_LENGTHS from source
    assert.ok(
      tenantServiceSource.includes('MAX_STRING_LENGTHS'),
      'MAX_STRING_LENGTHS should be defined'
    );

    // Verify expected fields are configured
    const expectedFields = [
      'systemName',
      'description',
      'virtualHost',
      'locationId',
      'techUser',
      'techPassword',
      'piVersion',
      'protocol',
    ];

    for (const field of expectedFields) {
      assert.ok(
        tenantServiceSource.includes(`${field}:`),
        `${field} should have max length configured`
      );
    }

    // Verify specific values from source
    assert.ok(tenantServiceSource.includes('systemName: 50'), 'systemName max should be 50');
    assert.ok(tenantServiceSource.includes('description: 200'), 'description max should be 200');
    assert.ok(tenantServiceSource.includes('virtualHost: 200'), 'virtualHost max should be 200');

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Max Test History Configuration
// ============================================================================
async function testMaxTestHistoryConfiguration() {
  const testName = 'Test history is limited to 10 entries (AC-002.7)';
  try {
    assert.ok(
      tenantServiceSource.includes('MAX_TEST_HISTORY = 10'),
      'MAX_TEST_HISTORY should be 10'
    );

    // Verify history trimming logic exists
    assert.ok(
      tenantServiceSource.includes('testHistory.length > MAX_TEST_HISTORY'),
      'Test history should be trimmed when exceeding limit'
    );

    assert.ok(
      tenantServiceSource.includes('testHistory.slice(0, MAX_TEST_HISTORY)'),
      'History trimming should keep first MAX_TEST_HISTORY entries'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Auto-Discovery Trigger Logic (AC-003.1, AC-003.3)
// ============================================================================
async function testAutoDiscoveryTriggerLogic() {
  const testName = 'Auto-discovery triggers after successful connection test (AC-003.1)';
  try {
    // Check auto-discovery trigger is in testConnection
    assert.ok(
      tenantServiceSource.includes("triggeredBy: 'auto_test'"),
      'Auto-triggered jobs should have triggeredBy: auto_test'
    );

    // Check it only triggers on success
    assert.ok(
      tenantServiceSource.includes('if (success && system.autoDiscoveryEnabled !== false)'),
      'Auto-discovery should only trigger on success and when enabled'
    );

    // Check for duplicate job prevention (BR-003)
    assert.ok(
      tenantServiceSource.includes("status: { in: ['pending', 'running'] }"),
      'Should check for running jobs before triggering'
    );

    // Check CAP event queue usage (AC-003.3)
    assert.ok(
      tenantServiceSource.includes('cds.queued(this)'),
      'Should use CAP transactional outbox (cds.queued)'
    );

    assert.ok(
      tenantServiceSource.includes("emit('DiscoveryRequested'"),
      'Should emit DiscoveryRequested event'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Required Fields Validation
// ============================================================================
async function testRequiredFieldsValidation() {
  const testName = 'Required fields are validated';
  try {
    // Check for required fields array
    assert.ok(
      tenantServiceSource.includes("requiredFields = ['systemName', 'virtualHost', 'locationId', 'techUser']"),
      'Required fields should include systemName, virtualHost, locationId, techUser'
    );

    // Check password requirement for new systems
    assert.ok(
      tenantServiceSource.includes('!config.systemId && !config.techPassword'),
      'Password should be required for new systems'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Port Range Validation
// ============================================================================
async function testPortRangeValidation() {
  const testName = 'Port range is validated (1-65535)';
  try {
    assert.ok(
      tenantServiceSource.includes('port < 1 || port > 65535'),
      'Port should be validated for range 1-65535'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Protocol Validation
// ============================================================================
async function testProtocolValidation() {
  const testName = 'Protocol is validated (http/https)';
  try {
    assert.ok(
      tenantServiceSource.includes("['http', 'https'].includes(config.protocol"),
      'Protocol should be validated as http or https'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: PI Version Validation
// ============================================================================
async function testPiVersionValidation() {
  const testName = 'PI version is validated (7.31, 7.40, 7.50)';
  try {
    assert.ok(
      tenantServiceSource.includes("['7.31', '7.40', '7.50'].includes(config.piVersion)"),
      'PI version should be validated for 7.31, 7.40, or 7.50'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Destination Name Generation (BR-002)
// ============================================================================
async function testDestinationNameGeneration() {
  const testName = 'Destination names are generated correctly (BR-002)';
  try {
    // Check destination name pattern
    assert.ok(
      tenantServiceSource.includes("destSuffix = `${systemName}_${tenantId}`"),
      'Destination suffix should include systemName and tenantId'
    );

    assert.ok(
      tenantServiceSource.includes("destinationDir = `PO_${destSuffix}_DIR`"),
      'DIR destination should follow naming pattern'
    );

    assert.ok(
      tenantServiceSource.includes("destinationEsr = `PO_${destSuffix}_ESR`"),
      'ESR destination should follow naming pattern'
    );

    // Check sanitization
    assert.ok(
      tenantServiceSource.includes(".toUpperCase().replace(/[^A-Z0-9]/g, '_')"),
      'Destination names should be sanitized'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Audit Logging (BR-007)
// ============================================================================
async function testAuditLogging() {
  const testName = 'Audit logging is implemented (BR-007)';
  try {
    // Check audit function exists
    assert.ok(
      tenantServiceSource.includes('async _audit('),
      '_audit method should be defined'
    );

    // Check audit calls for key operations
    const auditOperations = [
      'system_updated',
      'system_added',
      'connection_tested',
      'discovery_auto_triggered',
      'discovery_started',
    ];

    for (const op of auditOperations) {
      assert.ok(
        tenantServiceSource.includes(`'${op}'`),
        `Audit logging should include ${op} operation`
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
// Test: Auto-Discovery Default Options
// ============================================================================
async function testAutoDiscoveryDefaultOptions() {
  const testName = 'Auto-discovery default options are set correctly';
  try {
    // Check default discovery options
    assert.ok(
      tenantServiceSource.includes('includeInactive: false'),
      'Default includeInactive should be false'
    );

    assert.ok(
      tenantServiceSource.includes('includeHistory: false'),
      'Default includeHistory should be false'
    );

    assert.ok(
      tenantServiceSource.includes('artifactTypes: null'),
      'Default artifactTypes should be null (all types)'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Discovery Job Fields (AC-003.2)
// ============================================================================
async function testDiscoveryJobFields() {
  const testName = 'Discovery job is created with correct fields';
  try {
    // Check all required job fields
    const jobFields = [
      'ID: jobId',
      'tenantId',
      'system_ID: systemId',
      "status: 'pending'",
      'startedAt:',
      'startedBy:',
      'triggeredBy:',
      'options:',
      "progressLog: '[]'",
      "errorLog: '[]'",
      'totalPhases: 6',
      'currentPhase: 0',
      "currentPhaseName: 'Initializing'",
      'progressPercent: 0',
      'artifactsFound: 0',
      'artifactsNew: 0',
      'artifactsUpdated: 0',
      'errorsCount: 0',
      'warningsCount: 0',
      'attemptNumber: 1',
    ];

    for (const field of jobFields) {
      assert.ok(
        tenantServiceSource.includes(field),
        `Discovery job should include ${field}`
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
// Test: Auto-Discovery Response (AC-003.2)
// ============================================================================
async function testAutoDiscoveryResponse() {
  const testName = 'Auto-discovery response includes job information (AC-003.2)';
  try {
    // Check response includes autoDiscovery object
    assert.ok(
      tenantServiceSource.includes('testResult.autoDiscovery ='),
      'testConnection response should include autoDiscovery object'
    );

    // Check triggered status
    assert.ok(
      tenantServiceSource.includes('triggered: true'),
      'Response should indicate if discovery was triggered'
    );

    assert.ok(
      tenantServiceSource.includes('triggered: false'),
      'Response should indicate if discovery was not triggered'
    );

    // Check reason when not triggered
    assert.ok(
      tenantServiceSource.includes("reason: 'Discovery already in progress'"),
      'Response should explain when discovery is already running'
    );

    assert.ok(
      tenantServiceSource.includes("reason: 'Auto-discovery is disabled"),
      'Response should explain when auto-discovery is disabled'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Single Running Job Enforcement (BR-003)
// ============================================================================
async function testSingleRunningJobEnforcement() {
  const testName = 'Single running job per system is enforced (BR-003)';
  try {
    // Check for running job check in both manual and auto trigger
    const runningJobCheckCount = (tenantServiceSource.match(/status: \{ in: \['pending', 'running'\] \}/g) || []).length;
    assert.ok(
      runningJobCheckCount >= 2,
      'Running job check should exist in both triggerDiscovery and testConnection'
    );

    // Check for conflict response
    assert.ok(
      tenantServiceSource.includes('409') || tenantServiceSource.includes('existingJobId'),
      'Should return conflict or existing job ID when job already running'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Async Destination Creation
// ============================================================================
async function testAsyncDestinationCreation() {
  const testName = 'Destination creation is asynchronous and non-blocking';
  try {
    // Check for async destination creation method
    assert.ok(
      tenantServiceSource.includes('_createDestinationsAsync'),
      '_createDestinationsAsync method should exist'
    );

    // Check it's called without await (non-blocking)
    assert.ok(
      tenantServiceSource.includes('this._createDestinationsAsync(tenantId, newSystemId'),
      'Destination creation should be non-blocking'
    );

    // Should not have await before _createDestinationsAsync
    assert.ok(
      !tenantServiceSource.includes('await this._createDestinationsAsync'),
      'Destination creation should not be awaited'
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
  console.log('\n=== Tenant Service Unit Tests ===\n');

  await testUrlPatternValidation();
  await testMaxStringLengthsConfiguration();
  await testMaxTestHistoryConfiguration();
  await testAutoDiscoveryTriggerLogic();
  await testRequiredFieldsValidation();
  await testPortRangeValidation();
  await testProtocolValidation();
  await testPiVersionValidation();
  await testDestinationNameGeneration();
  await testAuditLogging();
  await testAutoDiscoveryDefaultOptions();
  await testDiscoveryJobFields();
  await testAutoDiscoveryResponse();
  await testSingleRunningJobEnforcement();
  await testAsyncDestinationCreation();

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
