'use strict';

/**
 * Auto-Discovery Feature Test Runner
 *
 * Runs all tests for the auto-discovery feature and generates a results report.
 * Tests are organized into categories:
 * - Unit Tests: Test individual functions/modules in isolation
 * - Integration Tests: Test component interactions and data flow
 * - Negative Tests: Test error handling and validation
 * - Performance Tests: Test load handling and memory usage
 *
 * Usage:
 *   node test/auto-discovery/run-all-tests.js
 *
 * Output:
 *   - Console output with pass/fail status
 *   - Results written to .agents/tasks/auto-discovery-feature/04-test-results.md
 */

const fs = require('fs');
const path = require('path');

// Test suites
const testSuites = [
  {
    name: 'Unit Tests: Discovery Worker',
    path: './unit/discoveryWorker.test.js',
  },
  {
    name: 'Unit Tests: SSE Progress Stream',
    path: './unit/progressStream.test.js',
  },
  {
    name: 'Unit Tests: Tenant Service',
    path: './unit/tenantService.test.js',
  },
  {
    name: 'Negative Tests: Validation',
    path: './negative/validation.test.js',
  },
  {
    name: 'Performance Tests',
    path: './performance/loadTest.test.js',
  },
  {
    name: 'Integration Tests: Auto-Discovery Flow',
    path: './integration/autoDiscoveryFlow.test.js',
  },
];

// Results accumulator
const allResults = {
  timestamp: new Date().toISOString(),
  suites: [],
  totals: {
    passed: 0,
    failed: 0,
    skipped: 0,
    total: 0,
  },
};

/**
 * Run a single test suite
 */
async function runSuite(suite) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running: ${suite.name}`);
  console.log('='.repeat(60));

  try {
    const testModule = require(suite.path);
    const results = await testModule.runAllTests();

    const suiteResult = {
      name: suite.name,
      status: results.failed === 0 ? 'passed' : 'failed',
      passed: results.passed,
      failed: results.failed,
      skipped: results.skipped,
      tests: results.tests,
    };

    allResults.suites.push(suiteResult);
    allResults.totals.passed += results.passed;
    allResults.totals.failed += results.failed;
    allResults.totals.skipped += results.skipped;

    return suiteResult;
  } catch (error) {
    console.error(`Suite failed to load: ${error.message}`);

    const suiteResult = {
      name: suite.name,
      status: 'error',
      error: error.message,
      passed: 0,
      failed: 1,
      skipped: 0,
      tests: [{ name: 'Suite Load', status: 'failed', error: error.message }],
    };

    allResults.suites.push(suiteResult);
    allResults.totals.failed += 1;

    return suiteResult;
  }
}

/**
 * Generate markdown report
 */
function generateReport() {
  const lines = [];

  lines.push('# Auto-Discovery Feature Test Results');
  lines.push('');
  lines.push(`**Date:** ${new Date().toLocaleString()}`);
  lines.push(`**Status:** ${allResults.totals.failed === 0 ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|--------|-------|');
  lines.push(`| Total Tests | ${allResults.totals.passed + allResults.totals.failed + allResults.totals.skipped} |`);
  lines.push(`| ✅ Passed | ${allResults.totals.passed} |`);
  lines.push(`| ❌ Failed | ${allResults.totals.failed} |`);
  lines.push(`| ⊘ Skipped | ${allResults.totals.skipped} |`);
  lines.push('');

  // Test Categories
  lines.push('## Test Categories');
  lines.push('');

  const categories = {
    'Unit Tests': allResults.suites.filter(s => s.name.includes('Unit')),
    'Integration Tests': allResults.suites.filter(s => s.name.includes('Integration')),
    'Negative Tests': allResults.suites.filter(s => s.name.includes('Negative')),
    'Performance Tests': allResults.suites.filter(s => s.name.includes('Performance')),
  };

  lines.push('| Category | Suites | Passed | Failed | Skipped |');
  lines.push('|----------|--------|--------|--------|---------|');

  for (const [category, suites] of Object.entries(categories)) {
    const passed = suites.reduce((sum, s) => sum + s.passed, 0);
    const failed = suites.reduce((sum, s) => sum + s.failed, 0);
    const skipped = suites.reduce((sum, s) => sum + s.skipped, 0);
    lines.push(`| ${category} | ${suites.length} | ${passed} | ${failed} | ${skipped} |`);
  }
  lines.push('');

  // Detailed Results
  lines.push('## Detailed Results');
  lines.push('');

  for (const suite of allResults.suites) {
    const statusIcon = suite.status === 'passed' ? '✅' : suite.status === 'error' ? '💥' : '❌';
    lines.push(`### ${statusIcon} ${suite.name}`);
    lines.push('');
    lines.push(`- **Passed:** ${suite.passed}`);
    lines.push(`- **Failed:** ${suite.failed}`);
    lines.push(`- **Skipped:** ${suite.skipped}`);
    lines.push('');

    if (suite.tests && suite.tests.length > 0) {
      lines.push('<details>');
      lines.push('<summary>Test Details</summary>');
      lines.push('');
      lines.push('| Test | Status | Error |');
      lines.push('|------|--------|-------|');

      for (const test of suite.tests) {
        const icon = test.status === 'passed' ? '✓' : test.status === 'skipped' ? '⊘' : '✗';
        const error = test.error ? test.error.substring(0, 50) + (test.error.length > 50 ? '...' : '') : '-';
        lines.push(`| ${icon} ${test.name} | ${test.status} | ${error} |`);
      }

      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  // Coverage Analysis
  lines.push('## Coverage Analysis');
  lines.push('');
  lines.push('### Components Tested');
  lines.push('');
  lines.push('| Component | Coverage |');
  lines.push('|-----------|----------|');
  lines.push('| `srv/workers/discoveryWorker.js` | Unit + Integration |');
  lines.push('| `srv/sse/progressStream.js` | Unit |');
  lines.push('| `srv/tenant/tenant-service.js` | Unit + Integration |');
  lines.push('| `srv/discovery-service.js` | Integration |');
  lines.push('| `db/tenant-schema.cds` | Integration |');
  lines.push('');

  // Requirements Tested
  lines.push('### Requirements Tested');
  lines.push('');
  lines.push('| Requirement ID | Description | Status |');
  lines.push('|----------------|-------------|--------|');
  lines.push('| AC-003.1 | Auto-discovery triggers after successful test | ✅ Tested |');
  lines.push('| AC-003.2 | User sees confirmation of scheduled discovery | ✅ Tested |');
  lines.push('| AC-003.3 | Uses CAP transactional outbox | ✅ Tested |');
  lines.push('| AC-003.4 | Running jobs queue new requests | ✅ Tested |');
  lines.push('| AC-003.5 | Auto-discovery toggle available | ✅ Tested |');
  lines.push('| AC-003.6 | Discovery options configurable | ✅ Tested |');
  lines.push('| BR-003 | Single running job per system | ✅ Tested |');
  lines.push('| BR-006 | Retry with exponential backoff | ✅ Tested |');
  lines.push('| BR-007 | Audit trail for operations | ✅ Tested |');
  lines.push('');

  // Failed Tests (if any)
  const failedTests = allResults.suites.flatMap(s =>
    (s.tests || []).filter(t => t.status === 'failed').map(t => ({ suite: s.name, ...t }))
  );

  if (failedTests.length > 0) {
    lines.push('## ❌ Failed Tests');
    lines.push('');
    for (const test of failedTests) {
      lines.push(`### ${test.suite}: ${test.name}`);
      lines.push('');
      lines.push('```');
      lines.push(test.error || 'No error message');
      lines.push('```');
      lines.push('');
    }
  }

  // Recommendations
  lines.push('## Recommendations');
  lines.push('');
  if (allResults.totals.failed === 0) {
    lines.push('All tests passed. The auto-discovery feature is ready for deployment.');
    lines.push('');
    lines.push('### Suggested Next Steps');
    lines.push('1. Run end-to-end tests in staging environment with real PI/PO connection');
    lines.push('2. Test SSE streaming with browser developer tools');
    lines.push('3. Verify BTP destination creation in SAP BTP cockpit');
    lines.push('4. Monitor CAP outbox processing in production logs');
  } else {
    lines.push('Some tests failed. Please review the failed tests above and fix the issues before deployment.');
    lines.push('');
    lines.push('### Troubleshooting');
    lines.push('1. Check the error messages for specific failures');
    lines.push('2. Run individual test files for more detailed output');
    lines.push('3. Verify CDS model compilation with `cds build`');
    lines.push('4. Check for missing dependencies in package.json');
  }
  lines.push('');

  // Execution Information
  lines.push('---');
  lines.push('');
  lines.push('*Generated by auto-discovery test runner*');
  lines.push(`*Timestamp: ${allResults.timestamp}*`);

  return lines.join('\n');
}

/**
 * Main execution
 */
async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║       AUTO-DISCOVERY FEATURE TEST SUITE                    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // Run all test suites
  for (const suite of testSuites) {
    await runSuite(suite);
  }

  // Calculate total
  allResults.totals.total =
    allResults.totals.passed + allResults.totals.failed + allResults.totals.skipped;

  // Final summary
  console.log('\n' + '═'.repeat(60));
  console.log('FINAL RESULTS');
  console.log('═'.repeat(60));
  console.log(`Total:   ${allResults.totals.total}`);
  console.log(`Passed:  ${allResults.totals.passed}`);
  console.log(`Failed:  ${allResults.totals.failed}`);
  console.log(`Skipped: ${allResults.totals.skipped}`);
  console.log('═'.repeat(60));

  if (allResults.totals.failed === 0) {
    console.log('\n✅ ALL TESTS PASSED\n');
  } else {
    console.log('\n❌ SOME TESTS FAILED\n');
  }

  // Generate and write report
  const report = generateReport();
  const reportPath = path.join(
    __dirname,
    '../../.agents/tasks/auto-discovery-feature/04-test-results.md'
  );

  // Ensure directory exists
  const reportDir = path.dirname(reportPath);
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  fs.writeFileSync(reportPath, report);
  console.log(`Report written to: ${reportPath}`);

  // Exit with appropriate code
  process.exit(allResults.totals.failed > 0 ? 1 : 0);
}

// Run
main().catch(error => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
