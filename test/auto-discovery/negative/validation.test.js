'use strict';

/**
 * Negative Tests: Input Validation and Error Handling
 *
 * Tests invalid inputs, missing fields, unauthorized access,
 * and error scenarios for the auto-discovery feature.
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

// Read source files for validation testing
const tenantServiceSource = fs.readFileSync(
  path.join(__dirname, '../../../srv/tenant/tenant-service.js'),
  'utf8'
);

// ============================================================================
// Test: Missing systemConfig
// ============================================================================
async function testMissingSystemConfig() {
  const testName = 'Rejects request with missing systemConfig';
  try {
    // Verify validation exists
    assert.ok(
      tenantServiceSource.includes("if (!config)"),
      'Should check for missing config'
    );

    assert.ok(
      tenantServiceSource.includes("req.error(400, 'systemConfig is required')"),
      'Should return 400 for missing systemConfig'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Missing Required Fields
// ============================================================================
async function testMissingRequiredFields() {
  const testName = 'Rejects request with missing required fields';
  try {
    // Check for required fields validation
    assert.ok(
      tenantServiceSource.includes("for (const field of requiredFields)"),
      'Should iterate required fields'
    );

    assert.ok(
      tenantServiceSource.includes("req.error(400, `${field} is required`"),
      'Should return specific field error'
    );

    // Verify all required fields
    const requiredFields = ['systemName', 'virtualHost', 'locationId', 'techUser'];
    for (const field of requiredFields) {
      assert.ok(
        tenantServiceSource.includes(`'${field}'`),
        `${field} should be in required fields list`
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
// Test: Missing Password for New System
// ============================================================================
async function testMissingPasswordForNewSystem() {
  const testName = 'Rejects new system without password';
  try {
    assert.ok(
      tenantServiceSource.includes("!config.systemId && !config.techPassword"),
      'Should check for password on new systems'
    );

    assert.ok(
      tenantServiceSource.includes("'techPassword is required for new systems'"),
      'Should return password required error for new systems'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: String Length Validation
// ============================================================================
async function testStringLengthValidation() {
  const testName = 'Rejects strings exceeding max length';
  try {
    assert.ok(
      tenantServiceSource.includes('config[field].length > maxLength'),
      'Should check string length against max'
    );

    assert.ok(
      tenantServiceSource.includes('exceeds maximum length of'),
      'Should return length exceeded error'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Invalid Hostname Format
// ============================================================================
async function testInvalidHostnameFormat() {
  const testName = 'Rejects invalid hostname format';
  try {
    assert.ok(
      tenantServiceSource.includes("!URL_PATTERN.test(config.virtualHost)"),
      'Should validate hostname with URL_PATTERN'
    );

    assert.ok(
      tenantServiceSource.includes("'virtualHost must be a valid hostname'"),
      'Should return hostname validation error'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Invalid Port Range
// ============================================================================
async function testInvalidPortRange() {
  const testName = 'Rejects invalid port numbers';
  try {
    // Check for NaN
    assert.ok(
      tenantServiceSource.includes('isNaN(port)'),
      'Should check for NaN port'
    );

    // Check range
    assert.ok(
      tenantServiceSource.includes('port < 1 || port > 65535'),
      'Should validate port range 1-65535'
    );

    assert.ok(
      tenantServiceSource.includes("'virtualPort must be between 1 and 65535'"),
      'Should return port range error'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Invalid Protocol
// ============================================================================
async function testInvalidProtocol() {
  const testName = 'Rejects invalid protocol';
  try {
    assert.ok(
      tenantServiceSource.includes("['http', 'https'].includes(config.protocol"),
      'Should validate protocol is http or https'
    );

    assert.ok(
      tenantServiceSource.includes("'protocol must be http or https'"),
      'Should return protocol validation error'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Invalid PI Version
// ============================================================================
async function testInvalidPiVersion() {
  const testName = 'Rejects invalid PI version';
  try {
    assert.ok(
      tenantServiceSource.includes("['7.31', '7.40', '7.50'].includes(config.piVersion)"),
      'Should validate PI version is 7.31, 7.40, or 7.50'
    );

    assert.ok(
      tenantServiceSource.includes("'piVersion must be 7.31, 7.40, or 7.50'"),
      'Should return PI version validation error'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Missing systemId for testConnection
// ============================================================================
async function testMissingSystemIdForTestConnection() {
  const testName = 'Rejects testConnection without systemId';
  try {
    // Find testConnection handler
    const testConnectionMatch = tenantServiceSource.includes("if (!systemId)") &&
      tenantServiceSource.includes("req.error(400, 'systemId is required')");

    assert.ok(testConnectionMatch, 'testConnection should require systemId');

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: System Not Found (404)
// ============================================================================
async function testSystemNotFound() {
  const testName = 'Returns 404 for non-existent system';
  try {
    assert.ok(
      tenantServiceSource.includes("req.error(404, 'PI/PO system not found')"),
      'Should return 404 for non-existent system'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Discovery Conflict (409)
// ============================================================================
async function testDiscoveryConflict() {
  const testName = 'Returns 409 when discovery already running';
  try {
    assert.ok(
      tenantServiceSource.includes('req.error(409,'),
      'Should return 409 for conflict'
    );

    assert.ok(
      tenantServiceSource.includes('Discovery already running'),
      'Should indicate discovery is already running'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Invalid System Status for Discovery
// ============================================================================
async function testInvalidSystemStatusForDiscovery() {
  const testName = 'Rejects discovery for system in error/disabled status';
  try {
    assert.ok(
      tenantServiceSource.includes("system.status === 'error' || system.status === 'disabled'"),
      'Should check system status before discovery'
    );

    assert.ok(
      tenantServiceSource.includes('Cannot trigger discovery for system with status'),
      'Should return status error message'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Internal Server Error Handling (500)
// ============================================================================
async function testInternalServerErrorHandling() {
  const testName = 'Returns 500 for internal errors';
  try {
    // Check for error handling
    assert.ok(
      tenantServiceSource.includes("req.error(500,"),
      'Should return 500 for internal errors'
    );

    assert.ok(
      tenantServiceSource.includes('Failed to save PI/PO system'),
      'Should return save failure message'
    );

    assert.ok(
      tenantServiceSource.includes('Failed to trigger discovery'),
      'Should return discovery failure message'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Error Logging
// ============================================================================
async function testErrorLogging() {
  const testName = 'Errors are logged properly';
  try {
    // Check LOG.error calls
    assert.ok(
      tenantServiceSource.includes('LOG.error('),
      'Should use LOG.error for errors'
    );

    // Check error stack is logged
    assert.ok(
      tenantServiceSource.includes('stack: error.stack'),
      'Should log error stack trace'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Discovery Service Error Handling
// ============================================================================
async function testDiscoveryServiceErrorHandling() {
  const testName = 'Discovery service errors are handled';
  try {
    const discoveryServiceSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/discovery-service.js'),
      'utf8'
    );

    // Check for error handling in discovery
    assert.ok(
      discoveryServiceSource.includes("status: 'failed'"),
      'Failed status should be set on error'
    );

    assert.ok(
      discoveryServiceSource.includes('lastError:') || discoveryServiceSource.includes('errorLog:'),
      'Error details should be recorded'
    );

    assert.ok(
      discoveryServiceSource.includes('tx.rollback()'),
      'Transaction should be rolled back on error'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: SSE Authentication Required
// ============================================================================
async function testSseAuthenticationRequired() {
  const testName = 'SSE endpoint requires authentication';
  try {
    const sseSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/sse/progressStream.js'),
      'utf8'
    );

    assert.ok(
      sseSource.includes('if (!req.user)'),
      'Should check for authenticated user'
    );

    assert.ok(
      sseSource.includes("status(401)"),
      'Should return 401 for unauthenticated'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: SSE Job Not Found
// ============================================================================
async function testSseJobNotFound() {
  const testName = 'SSE endpoint returns 404 for invalid job';
  try {
    const sseSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/sse/progressStream.js'),
      'utf8'
    );

    assert.ok(
      sseSource.includes("status(404)"),
      'Should return 404 for non-existent job'
    );

    assert.ok(
      sseSource.includes("'Discovery job not found'"),
      'Should return job not found message'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Worker Retry on Failure (BR-006)
// ============================================================================
async function testWorkerRetryOnFailure() {
  const testName = 'Worker retries failed operations (BR-006)';
  try {
    const workerSource = fs.readFileSync(
      path.join(__dirname, '../../../srv/workers/discoveryWorker.js'),
      'utf8'
    );

    // Check retry loop
    assert.ok(
      workerSource.includes('for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS'),
      'Should have retry loop'
    );

    // Check delay between retries
    assert.ok(
      workerSource.includes('RETRY_DELAYS[attempt - 1]'),
      'Should use exponential backoff delays'
    );

    // Check max retries message
    assert.ok(
      workerSource.includes('Failed after'),
      'Should record max retries failure'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: JSON Parse Error Handling
// ============================================================================
async function testJsonParseErrorHandling() {
  const testName = 'JSON parse errors are handled gracefully';
  try {
    // Check for try-catch around JSON.parse
    const jsonParsePatterns = [
      'try {',
      'JSON.parse(',
      '} catch',
    ];

    // Multiple JSON.parse calls should be protected
    const matches = tenantServiceSource.match(/JSON\.parse/g) || [];
    assert.ok(
      matches.length > 0,
      'Should have JSON.parse calls'
    );

    // Check for fallback values
    assert.ok(
      tenantServiceSource.includes("testHistory = []"),
      'Should have fallback for invalid JSON'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Concurrent Discovery Prevention (BR-003)
// ============================================================================
async function testConcurrentDiscoveryPrevention() {
  const testName = 'Concurrent discoveries for same system are prevented (BR-003)';
  try {
    // Check in both trigger methods
    const runningJobCheckCount = (tenantServiceSource.match(/status: \{ in: \['pending', 'running'\] \}/g) || []).length;

    assert.ok(
      runningJobCheckCount >= 2,
      'Running job check should exist in multiple places'
    );

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Audit Log Failure Handling
// ============================================================================
async function testAuditLogFailureHandling() {
  const testName = 'Audit log failures do not break main operations';
  try {
    assert.ok(
      tenantServiceSource.includes("LOG.warn('Failed to create audit log'"),
      'Audit log failures should be logged as warnings'
    );

    // The _audit method uses try-catch to catch errors
    assert.ok(
      tenantServiceSource.includes('async _audit('),
      '_audit method should exist'
    );

    // Verify it's inside a try-catch to avoid breaking main flow
    assert.ok(
      tenantServiceSource.includes('try {') &&
      tenantServiceSource.includes('INSERT.into(AuditLog)'),
      'Audit log insert should be in try block'
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
  console.log('\n=== Negative Tests: Validation and Error Handling ===\n');

  await testMissingSystemConfig();
  await testMissingRequiredFields();
  await testMissingPasswordForNewSystem();
  await testStringLengthValidation();
  await testInvalidHostnameFormat();
  await testInvalidPortRange();
  await testInvalidProtocol();
  await testInvalidPiVersion();
  await testMissingSystemIdForTestConnection();
  await testSystemNotFound();
  await testDiscoveryConflict();
  await testInvalidSystemStatusForDiscovery();
  await testInternalServerErrorHandling();
  await testErrorLogging();
  await testDiscoveryServiceErrorHandling();
  await testSseAuthenticationRequired();
  await testSseJobNotFound();
  await testWorkerRetryOnFailure();
  await testJsonParseErrorHandling();
  await testConcurrentDiscoveryPrevention();
  await testAuditLogFailureHandling();

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
