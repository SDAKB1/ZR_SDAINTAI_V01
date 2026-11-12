'use strict';
/**
 * Integration Test for PI/PO Discovery
 * 
 * Tests the complete discovery flow against a real PI/PO system.
 * Run with: node test/integration/discovery-test.js
 * 
 * Prerequisites:
 * - Cloud Connector configured with /rep/, /dir/, /mdt/ paths
 * - BTP destination configured for PI/PO system
 * - Valid PI/PO credentials
 */
require('dotenv').config();
const { PIPoSoapClient, ESR_OBJECT_TYPES } = require('../../srv/utils/pipoSoapClient');

// Test configuration - override with environment variables
const TEST_CONFIG = {
  destinationDir: process.env.PIPO_DEST_DIR || 'PO_PJ2_DIR',
  destinationEsr: process.env.PIPO_DEST_ESR || 'PO_PJ2_ESR',
  // For local testing without BTP destination
  directUrl: process.env.PIPO_DIRECT_URL,
  directUser: process.env.PIPO_USER,
  directPassword: process.env.PIPO_PASSWORD,
};

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logResult(name, success, details = '') {
  const icon = success ? '✓' : '✗';
  const color = success ? 'green' : 'red';
  log(`  ${icon} ${name}${details ? ': ' + details : ''}`, color);
}

/**
 * Main test runner
 */
async function runTests() {
  log('\n════════════════════════════════════════════════════════════════', 'cyan');
  log('  PI/PO Discovery Integration Tests', 'cyan');
  log('════════════════════════════════════════════════════════════════\n', 'cyan');
  
  const results = {
    passed: 0,
    failed: 0,
    skipped: 0,
    tests: [],
  };
  
  // Initialize client
  let client;
  try {
    if (TEST_CONFIG.directUrl) {
      log('Using direct connection (no BTP destination)', 'yellow');
      client = new PIPoSoapClient({
        directUrl: TEST_CONFIG.directUrl,
        directUser: TEST_CONFIG.directUser,
        directPassword: TEST_CONFIG.directPassword,
      });
    } else {
      log('Using BTP destination connection', 'yellow');
      client = new PIPoSoapClient({
        destinationDir: TEST_CONFIG.destinationDir,
        destinationEsr: TEST_CONFIG.destinationEsr,
      });
    }
  } catch (error) {
    log(`\nFailed to initialize client: ${error.message}`, 'red');
    process.exit(1);
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: Connection Test
  // ═══════════════════════════════════════════════════════════════════════════
  log('\n[Test 1] Connection Test', 'blue');
  try {
    const connectionResult = await client.testConnection();
    
    if (connectionResult.success) {
      logResult('Directory API', true, `Version ${connectionResult.piVersion || 'unknown'}`);
      logResult('ESR API', connectionResult.esrStatus === 'ok');
      logResult('SLD API', connectionResult.sldStatus === 'ok' || connectionResult.sldStatus === 'skipped', connectionResult.sldStatus);
      
      results.passed++;
      results.tests.push({ name: 'Connection Test', status: 'passed', details: connectionResult });
    } else {
      logResult('Connection', false, connectionResult.message);
      results.failed++;
      results.tests.push({ name: 'Connection Test', status: 'failed', error: connectionResult.message });
    }
  } catch (error) {
    logResult('Connection', false, error.message);
    results.failed++;
    results.tests.push({ name: 'Connection Test', status: 'failed', error: error.message });
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: Query Integrated Configurations (ICOs)
  // ═══════════════════════════════════════════════════════════════════════════
  log('\n[Test 2] Query Integrated Configurations', 'blue');
  let icoCount = 0;
  try {
    const icos = await client.queryIntegratedConfigurations({ maxResults: 100 });
    icoCount = icos?.length || 0;
    
    logResult('ICO Query', true, `Found ${icoCount} ICOs`);
    
    if (icoCount > 0) {
      log(`    Sample: ${icos[0].name || icos[0].objectId || 'unnamed'}`, 'cyan');
    }
    
    results.passed++;
    results.tests.push({ name: 'ICO Query', status: 'passed', count: icoCount });
  } catch (error) {
    logResult('ICO Query', false, error.message);
    results.failed++;
    results.tests.push({ name: 'ICO Query', status: 'failed', error: error.message });
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 3: Query Communication Channels
  // ═══════════════════════════════════════════════════════════════════════════
  log('\n[Test 3] Query Communication Channels', 'blue');
  let channelCount = 0;
  try {
    const channels = await client.queryCommunicationChannels({ maxResults: 100 });
    channelCount = channels?.length || 0;
    
    logResult('Channel Query', true, `Found ${channelCount} channels`);
    
    if (channelCount > 0) {
      const sample = channels[0];
      log(`    Sample: ${sample.channelName || sample.name || 'unnamed'} (${sample.adapterType || 'unknown'})`, 'cyan');
    }
    
    results.passed++;
    results.tests.push({ name: 'Channel Query', status: 'passed', count: channelCount });
  } catch (error) {
    logResult('Channel Query', false, error.message);
    results.failed++;
    results.tests.push({ name: 'Channel Query', status: 'failed', error: error.message });
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 4: Query Sender Agreements
  // ═══════════════════════════════════════════════════════════════════════════
  log('\n[Test 4] Query Sender Agreements', 'blue');
  try {
    const agreements = await client.querySenderAgreements({ maxResults: 50 });
    const count = agreements?.length || 0;
    
    logResult('Sender Agreements', true, `Found ${count} agreements`);
    results.passed++;
    results.tests.push({ name: 'Sender Agreements', status: 'passed', count });
  } catch (error) {
    logResult('Sender Agreements', false, error.message);
    results.failed++;
    results.tests.push({ name: 'Sender Agreements', status: 'failed', error: error.message });
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 5: Query Receiver Agreements
  // ═══════════════════════════════════════════════════════════════════════════
  log('\n[Test 5] Query Receiver Agreements', 'blue');
  try {
    const agreements = await client.queryReceiverAgreements({ maxResults: 50 });
    const count = agreements?.length || 0;
    
    logResult('Receiver Agreements', true, `Found ${count} agreements`);
    results.passed++;
    results.tests.push({ name: 'Receiver Agreements', status: 'passed', count });
  } catch (error) {
    logResult('Receiver Agreements', false, error.message);
    results.failed++;
    results.tests.push({ name: 'Receiver Agreements', status: 'failed', error: error.message });
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 6: Query Value Mappings
  // ═══════════════════════════════════════════════════════════════════════════
  log('\n[Test 6] Query Value Mappings', 'blue');
  try {
    const mappings = await client.queryValueMappings({ maxResults: 50 });
    const count = mappings?.length || 0;
    
    logResult('Value Mappings', true, `Found ${count} mappings`);
    results.passed++;
    results.tests.push({ name: 'Value Mappings', status: 'passed', count });
  } catch (error) {
    logResult('Value Mappings', false, error.message);
    results.failed++;
    results.tests.push({ name: 'Value Mappings', status: 'failed', error: error.message });
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 7: Query ESR Objects (Software Component Versions)
  // ═══════════════════════════════════════════════════════════════════════════
  log('\n[Test 7] Query ESR Software Component Versions', 'blue');
  let swcvCount = 0;
  try {
    const swcvs = await client.queryEsrSimple('SoftwareComponentVersion', { maxResults: 50 });
    swcvCount = swcvs?.length || 0;
    
    logResult('SWCV Query', true, `Found ${swcvCount} SWCVs`);
    
    if (swcvCount > 0) {
      log(`    Sample: ${swcvs[0].name || swcvs[0].objectId || 'unnamed'}`, 'cyan');
    }
    
    results.passed++;
    results.tests.push({ name: 'SWCV Query', status: 'passed', count: swcvCount });
  } catch (error) {
    logResult('SWCV Query', false, error.message);
    results.failed++;
    results.tests.push({ name: 'SWCV Query', status: 'failed', error: error.message });
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 8: Query Message Mappings (ESR)
  // ═══════════════════════════════════════════════════════════════════════════
  log('\n[Test 8] Query Message Mappings (ESR)', 'blue');
  try {
    const mappings = await client.queryEsrSimple('MessageMapping', { maxResults: 50 });
    const count = mappings?.length || 0;
    
    logResult('Message Mappings', true, `Found ${count} mappings`);
    results.passed++;
    results.tests.push({ name: 'Message Mappings', status: 'passed', count });
  } catch (error) {
    logResult('Message Mappings', false, error.message);
    results.failed++;
    results.tests.push({ name: 'Message Mappings', status: 'failed', error: error.message });
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 9: Pagination Test
  // ═══════════════════════════════════════════════════════════════════════════
  log('\n[Test 9] Pagination Test', 'blue');
  if (icoCount > 0) {
    try {
      // Get first page
      const page1 = await client.queryIntegratedConfigurations({ maxResults: 5 });
      logResult('Page 1', page1.length > 0, `${page1.length} items`);
      
      // Get second page (if more items exist)
      if (icoCount > 5) {
        const page2 = await client.queryIntegratedConfigurations({ maxResults: 5, startIndex: 5 });
        logResult('Page 2', page2.length > 0, `${page2.length} items`);
      }
      
      results.passed++;
      results.tests.push({ name: 'Pagination', status: 'passed' });
    } catch (error) {
      logResult('Pagination', false, error.message);
      results.failed++;
      results.tests.push({ name: 'Pagination', status: 'failed', error: error.message });
    }
  } else {
    logResult('Pagination', false, 'Skipped (no ICOs found)');
    results.skipped++;
    results.tests.push({ name: 'Pagination', status: 'skipped' });
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 10: Large Inventory Handling
  // ═══════════════════════════════════════════════════════════════════════════
  log('\n[Test 10] Large Inventory Test (with timeout handling)', 'blue');
  try {
    const startTime = Date.now();
    const largeQuery = await client.queryIntegratedConfigurations({ maxResults: 1000, timeout: 60000 });
    const duration = Date.now() - startTime;
    
    logResult('Large Query', true, `${largeQuery.length} items in ${duration}ms`);
    results.passed++;
    results.tests.push({ name: 'Large Inventory', status: 'passed', count: largeQuery.length, durationMs: duration });
  } catch (error) {
    if (error.message.includes('timeout')) {
      logResult('Large Query', false, 'Timeout occurred (expected for very large inventories)');
    } else {
      logResult('Large Query', false, error.message);
    }
    results.failed++;
    results.tests.push({ name: 'Large Inventory', status: 'failed', error: error.message });
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════
  log('\n════════════════════════════════════════════════════════════════', 'cyan');
  log('  Test Summary', 'cyan');
  log('════════════════════════════════════════════════════════════════', 'cyan');
  log(`  Passed:  ${results.passed}`, 'green');
  log(`  Failed:  ${results.failed}`, results.failed > 0 ? 'red' : 'green');
  log(`  Skipped: ${results.skipped}`, 'yellow');
  log(`  Total:   ${results.passed + results.failed + results.skipped}`, 'cyan');
  log('════════════════════════════════════════════════════════════════\n', 'cyan');
  
  // Calculate totals
  const totalArtifacts = results.tests.reduce((sum, t) => sum + (t.count || 0), 0);
  if (totalArtifacts > 0) {
    log(`  Total artifacts discovered: ${totalArtifacts}`, 'green');
  }
  
  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  log(`\nUnexpected error: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});
