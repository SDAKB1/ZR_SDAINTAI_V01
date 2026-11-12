/**
 * PI/PO 7.50 Artifact Discovery Test Script
 * Tests fetching artifacts via the Simple Query API
 *
 * Run via: node test-pipo-discovery.js
 * Or as CF task: cf run-task AICONX-srv --command "node test-pipo-discovery.js"
 */

const https = require('https');
const http = require('http');

const fs = require('fs');
const path = require('path');

// PI/PO Connection (direct test - via jump server)
// Use localhost if SSH tunnel is active, otherwise use the actual hostname
const PIPO_HOST = process.env.PIPO_HOST || 'localhost'; // Set to 'pj2sda.consultsda.com' for direct or tunnel via localhost
const PIPO_PORT_HTTP = 50000;
const PIPO_PORT_HTTPS = 50001;
const PIPO_PORT = process.env.PIPO_USE_HTTPS === 'true' ? PIPO_PORT_HTTPS : PIPO_PORT_HTTP;
const PIPO_USE_HTTPS = process.env.PIPO_USE_HTTPS === 'true';
const PIPO_USER = process.env.PIPO_USER || 'SDAINT';
const PIPO_PASS = process.env.PIPO_PASS || 'Password@1'; // Default from .env docs

// PI/PO 7.50 API Endpoints
const ENDPOINTS = {
  // Simple Query (ESR)
  simpleQuery: '/rep/support/SimpleQuery',

  // ESR Web UI entry points
  esrStart: '/rep/start/index.html',

  // DIR Web UI entry points
  dirStart: '/dir/start/index.jsp',

  // Query API (may return HmiServlet message if no params)
  repQuery: '/rep/query/ext/1',
  dirQuery: '/dir/query/ext/1',

  // Read API
  repRead: '/rep/read/ext/1',

  // Monitoring
  mdt: '/mdt/overview.do',
  nwa: '/nwa',

  // SOAP Web Services (note: these require /...InImplBean suffix)
  // Append ?wsdl for WSDL, use as-is for SOAP calls
  soap: {
    // Integration Directory SOAP Services
    CommunicationChannel:       '/CommunicationChannelInService/CommunicationChannelInImplBean',
    IntegratedConfiguration:    '/IntegratedConfigurationInService/IntegratedConfigurationInImplBean',
    ValueMapping:               '/ValueMappingInService/ValueMappingInImplBean',
    AlertRule:                  '/AlertRuleInService/AlertRuleInImplBean',
    SenderAgreement:            '/SenderAgreementInService/SenderAgreementInImplBean',
    ReceiverAgreement:          '/ReceiverAgreementInService/ReceiverAgreementInImplBean',
    InterfaceDetermination:     '/InterfaceDeterminationInService/InterfaceDeterminationInImplBean',
    ReceiverDetermination:      '/ReceiverDeterminationInService/ReceiverDeterminationInImplBean',
    // ESR SOAP Services  
    MessageMapping:             '/MessageMappingInService/MessageMappingInImplBean',
    OperationMapping:           '/OperationMappingInService/OperationMappingInImplBean',
    InterfaceMapping:           '/InterfaceMappingInService/InterfaceMappingInImplBean'
  }
};

// Object types available in Simple Query
const OBJECT_TYPES = [
  'SoftwareComponentVersion',
  'IntegratedConfiguration',
  'CommunicationChannel',
  'SenderAgreement',
  'ReceiverAgreement',
  'InterfaceDetermination',
  'ReceiverDetermination',
  'MessageMapping',
  'OperationMapping',
  'InterfaceMapping',
  'MessageType',
  'DataType',
  'ServiceInterface'
];

function makeRequest(path, method = 'GET', postData = null, options = {}) {
  return new Promise((resolve, reject) => {
    if (!PIPO_PASS) {
      reject(new Error('PIPO_PASS environment variable not set. Run with: PIPO_PASS=yourpassword node test-pipo-discovery.js'));
      return;
    }

    const auth = Buffer.from(PIPO_USER + ':' + PIPO_PASS).toString('base64');

    const reqOptions = {
      hostname: PIPO_HOST,
      port: PIPO_PORT,
      path: path,
      method: method,
      headers: {
        'Authorization': 'Basic ' + auth,
        'Accept': options.accept || 'application/xml, text/xml, text/html, */*',
        'Content-Type': options.contentType || 'application/x-www-form-urlencoded'
      },
      rejectUnauthorized: false // For self-signed certs
    };

    const protocol = PIPO_USE_HTTPS ? https : http;
    const req = protocol.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const preview = data.substring(0, 500) + (data.length > 500 ? '...' : '');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: options.fullResponse ? data : preview,
          fullBody: data,
          contentLength: data.length
        });
      });
    });

    req.on('error', reject);

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function testEndpoint(name, path) {
  try {
    console.log('\n--- Testing: ' + name + ' ---');
    const protocol = PIPO_USE_HTTPS ? 'https' : 'http';
    console.log('URL: ' + protocol + '://' + PIPO_HOST + ':' + PIPO_PORT + path);
    const result = await makeRequest(path);
    console.log('Status: ' + result.status);
    console.log('Response: ' + result.body);
    return result;
  } catch (err) {
    console.log('Error: ' + err.message);
    return { status: 'ERROR', error: err.message };
  }
}

async function testSimpleQuery(objectType) {
  try {
    console.log('\n--- Simple Query: ' + objectType + ' ---');
    // POST form data to Simple Query
    const formData = 'type=' + objectType + '&swcSelection=all&action=Submit';
    const path = ENDPOINTS.simpleQuery + '?type=' + objectType;

    const result = await makeRequest(path, 'POST', formData);
    console.log('Status: ' + result.status);

    // Check if we got actual data
    if (result.body.includes('<?xml') || result.body.includes('<result')) {
      console.log('Got XML data!');
    } else if (result.body.includes('HmiServlet')) {
      console.log('Got HmiServlet health check (no data)');
    } else if (result.body.includes('Error') || result.body.includes('error')) {
      console.log('Got error response');
    }
    console.log('Preview: ' + result.body.substring(0, 300));
    return result;
  } catch (err) {
    console.log('Error: ' + err.message);
    return { status: 'ERROR', error: err.message };
  }
}

async function main() {
  console.log('==============================================');
  console.log('PI/PO 7.50 Discovery Test');
  console.log('Host: ' + PIPO_HOST + ':' + PIPO_PORT);
  console.log('User: ' + PIPO_USER);
  console.log('==============================================');

  // Test basic connectivity
  await testEndpoint('PI/PO Start Page', '/dir/start/index.jsp');

  // Test Simple Query for different object types
  for (const objType of ['SoftwareComponentVersion', 'IntegratedConfiguration', 'CommunicationChannel']) {
    await testSimpleQuery(objType);
  }

  // Test REP Query API
  await testEndpoint('REP Query API', '/rep/query/ext/1/SoftwareComponentVersion');

  // Test with query params
  await testEndpoint('REP Query with params', '/rep/query/ext/1/SoftwareComponentVersion?released=true');

  console.log('\n==============================================');
  console.log('Test Complete');
  console.log('==============================================');
}

main().catch(console.error);

// =============================================================================
// EXTRACTION FUNCTIONS - Extract all PI/PO content
// =============================================================================

/**
 * Extract all artifacts of a specific type and save to file
 */
async function extractArtifacts(objectType, outputDir = './pipo-extract') {
  console.log(`\n=== Extracting ${objectType} ===`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    // Use Simple Query to get all artifacts of this type
    const formData = `type=${objectType}&swcSelection=all&action=Submit`;
    const queryPath = ENDPOINTS.simpleQuery + '?type=' + objectType;

    const result = await makeRequest(queryPath, 'POST', formData, { fullResponse: true });

    if (result.status === 200) {
      const filename = path.join(outputDir, `${objectType}.xml`);
      fs.writeFileSync(filename, result.fullBody, 'utf8');
      console.log(`✓ Saved ${result.contentLength} bytes to ${filename}`);
      return { type: objectType, status: 'success', file: filename, size: result.contentLength };
    } else {
      console.log(`✗ Failed with status ${result.status}`);
      return { type: objectType, status: 'failed', error: `HTTP ${result.status}` };
    }
  } catch (err) {
    console.log(`✗ Error: ${err.message}`);
    return { type: objectType, status: 'error', error: err.message };
  }
}

/**
 * Extract ALL PI/PO content (all object types)
 */
async function extractAll() {
  console.log('==============================================');
  console.log('PI/PO 7.50 FULL EXTRACTION');
  console.log(`Host: ${PIPO_HOST}:${PIPO_PORT} (${PIPO_USE_HTTPS ? 'HTTPS' : 'HTTP'})`);
  console.log(`User: ${PIPO_USER}`);
  console.log('==============================================');

  if (!PIPO_PASS) {
    console.error('\n❌ ERROR: PIPO_PASS not set!');
    console.error('Run with: PIPO_PASS=yourpassword node test-pipo-discovery.js extract');
    process.exit(1);
  }

  const outputDir = './pipo-extract';
  const results = [];

  // Extract each object type
  for (const objType of OBJECT_TYPES) {
    const result = await extractArtifacts(objType, outputDir);
    results.push(result);

    // Small delay to avoid overwhelming the server
    await new Promise(r => setTimeout(r, 500));
  }

  // Summary
  console.log('\n==============================================');
  console.log('EXTRACTION SUMMARY');
  console.log('==============================================');

  const successful = results.filter(r => r.status === 'success');
  const failed = results.filter(r => r.status !== 'success');

  console.log(`\n✓ Successful: ${successful.length}`);
  for (const r of successful) {
    console.log(`  - ${r.type}: ${r.size} bytes`);
  }

  if (failed.length > 0) {
    console.log(`\n✗ Failed: ${failed.length}`);
    for (const r of failed) {
      console.log(`  - ${r.type}: ${r.error}`);
    }
  }

  // Save summary
  const summaryFile = path.join(outputDir, '_extraction-summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify({
    extractedAt: new Date().toISOString(),
    host: PIPO_HOST,
    port: PIPO_PORT,
    user: PIPO_USER,
    results: results
  }, null, 2));
  console.log(`\nSummary saved to ${summaryFile}`);

  return results;
}

/**
 * Test connectivity first, then offer extraction
 */
async function testAndExtract() {
  // Test basic connectivity
  console.log('Testing connectivity...');
  const testResult = await makeRequest('/dir/start/index.jsp');

  if (testResult.status === 200) {
    console.log('✓ Connection successful!');
    console.log('\nTo extract all content, run:');
    console.log(`  PIPO_PASS=yourpassword node test-pipo-discovery.js extract`);
  } else if (testResult.status === 401) {
    console.log('✗ Authentication failed (401). Check username/password.');
  } else if (testResult.status === 403) {
    console.log('✗ Access forbidden (403). User may lack required roles.');
    console.log('  Required: SAP_XI_API_DISPLAY_USER role');
  } else {
    console.log(`✗ Unexpected status: ${testResult.status}`);
  }
}

// CLI handling
const args = process.argv.slice(2);
if (args.includes('extract')) {
  extractAll().catch(console.error);
} else if (args.includes('test')) {
  testAndExtract().catch(console.error);
}
