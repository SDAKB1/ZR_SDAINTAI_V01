'use strict';
/**
 * Test Script: PI/PO Endpoint Discovery via Direct HTTP/SOAP
 * 
 * Tests all PI/PO endpoints using direct HTTP requests (pipoSoapClient approach)
 * Run from jump server or with VPN access to pj2sda.consultsda.com
 * 
 * Usage: node test-pipo-soap-endpoints.js
 */

const http = require('http');
const https = require('https');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  host: process.env.PIPO_HOST || 'pj2sda.consultsda.com',
  port: parseInt(process.env.PIPO_PORT || '50000'),
  user: process.env.PIPO_USER || 'SDAINT',
  pass: process.env.PIPO_PASS || 'Password@1',
  protocol: process.env.PIPO_PROTOCOL || 'http',
  timeout: 30000
};

// All endpoints to test
const ENDPOINTS = {
  // Directory SOAP Services
  soapServices: [
    { path: '/AlertRuleInService/AlertRuleInImplBean', name: 'AlertRule', type: 'soap' },
    { path: '/BPMFacadeBeanImplService/BPMFacadeBeanImplBean', name: 'BPMFacade', type: 'soap' },
    { path: '/BusinessComponentInService/BusinessComponentInImplBean', name: 'BusinessComponent', type: 'soap' },
    { path: '/CommunicationChannelInService/CommunicationChannelInImplBean', name: 'CommunicationChannel', type: 'soap' },
    { path: '/ConfigurationScenarioInService/ConfigurationScenarioInImplBean', name: 'ConfigurationScenario', type: 'soap' },
    { path: '/IntegratedConfiguration750InService/IntegratedConfiguration750InImplBean', name: 'ICO750', type: 'soap' },
    { path: '/IntegratedConfigurationInService/IntegratedConfigurationInImplBean', name: 'ICO', type: 'soap' },
    { path: '/IntegrationProcessInService/IntegrationProcessInImplBean', name: 'IntegrationProcess', type: 'soap' },
    { path: '/InterfaceDeterminationInService/InterfaceDeterminationInImplBean', name: 'InterfaceDetermination', type: 'soap' },
    { path: '/ReceiverAgreementInService/ReceiverAgreementInImplBean', name: 'ReceiverAgreement', type: 'soap' },
    { path: '/ReceiverDeterminationInService/ReceiverDeterminationInImplBean', name: 'ReceiverDetermination', type: 'soap' },
    { path: '/ReceiverRuleInService/ReceiverRuleInImplBean', name: 'ReceiverRule', type: 'soap' },
    { path: '/SenderAgreementInService/SenderAgreementInImplBean', name: 'SenderAgreement', type: 'soap' },
    { path: '/ValueMappingInService/ValueMappingInImplBean', name: 'ValueMapping', type: 'soap' },
  ],
  
  // REST/HTTP Endpoints
  restEndpoints: [
    { path: '/AdapterFramework/ChannelAdminServlet', name: 'ChannelAdmin', type: 'get' },
    { path: '/CPACache', name: 'CPACache', type: 'get' },
    { path: '/mdt', name: 'MDT', type: 'get' },
    { path: '/mdt/index.jsp', name: 'MDT-Index', type: 'get' },
  ],
  
  // ESR Query Endpoints
  esrEndpoints: [
    { path: '/rep/support/SimpleQuery', name: 'ESR-SimpleQuery', type: 'get' },
    { path: '/rep/query/ext', name: 'ESR-QueryExt', type: 'get' },
    { path: '/rep/query/int', name: 'ESR-QueryInt', type: 'get' },
    { path: '/rep/read/ext', name: 'ESR-ReadExt', type: 'get' },
  ],
  
  // Directory Query Endpoints
  dirEndpoints: [
    { path: '/dir/query/ext', name: 'DIR-QueryExt', type: 'get' },
    { path: '/dir/read/ext', name: 'DIR-ReadExt', type: 'get' },
  ]
};

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const client = CONFIG.protocol === 'https' ? https : http;
    const startTime = Date.now();
    
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          responseTime: Date.now() - startTime
        });
      });
    });
    
    req.on('error', (err) => {
      reject({ error: err.message, responseTime: Date.now() - startTime });
    });
    
    req.setTimeout(CONFIG.timeout, () => {
      req.destroy();
      reject({ error: 'TIMEOUT', responseTime: CONFIG.timeout });
    });
    
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

function getAuthHeader() {
  return 'Basic ' + Buffer.from(`${CONFIG.user}:${CONFIG.pass}`).toString('base64');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function testGetEndpoint(endpoint) {
  const options = {
    hostname: CONFIG.host,
    port: CONFIG.port,
    path: endpoint.path,
    method: 'GET',
    headers: {
      'Authorization': getAuthHeader(),
      'Accept': 'text/html, application/xml, */*'
    }
  };
  
  try {
    const result = await makeRequest(options);
    return {
      name: endpoint.name,
      path: endpoint.path,
      status: result.statusCode,
      success: result.statusCode >= 200 && result.statusCode < 400,
      responseTime: result.responseTime,
      contentLength: result.body.length,
      contentType: result.headers['content-type'],
      preview: result.body.substring(0, 200).replace(/\s+/g, ' ')
    };
  } catch (err) {
    return {
      name: endpoint.name,
      path: endpoint.path,
      status: 'ERROR',
      success: false,
      error: err.error,
      responseTime: err.responseTime
    };
  }
}

async function testSoapEndpoint(endpoint) {
  // Build SOAP query envelope
  const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bas="http://sap.com/xi/BASIS">
  <soapenv:Header/>
  <soapenv:Body>
    <bas:${endpoint.name}QueryRequest/>
  </soapenv:Body>
</soapenv:Envelope>`;

  const options = {
    hostname: CONFIG.host,
    port: CONFIG.port,
    path: endpoint.path,
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': `http://sap.com/xi/BASIS/${endpoint.name}QueryRequest`,
      'Accept': 'text/xml, application/xml'
    }
  };
  
  try {
    const result = await makeRequest(options, soapEnvelope);
    
    // Check for SOAP fault
    const hasFault = result.body.includes('Fault') || result.body.includes('fault');
    const hasData = result.body.includes('Response') || result.body.includes('response');
    
    return {
      name: endpoint.name,
      path: endpoint.path,
      status: result.statusCode,
      success: result.statusCode === 200 && !hasFault,
      hasData: hasData,
      hasFault: hasFault,
      responseTime: result.responseTime,
      contentLength: result.body.length,
      preview: result.body.substring(0, 300).replace(/\s+/g, ' ')
    };
  } catch (err) {
    return {
      name: endpoint.name,
      path: endpoint.path,
      status: 'ERROR',
      success: false,
      error: err.error,
      responseTime: err.responseTime
    };
  }
}

async function testSimpleQuery(objectType) {
  const path = `/rep/support/SimpleQuery?type=${objectType}&swcSelection=all`;
  
  const options = {
    hostname: CONFIG.host,
    port: CONFIG.port,
    path: path,
    method: 'GET',
    headers: {
      'Authorization': getAuthHeader(),
      'Accept': 'text/html, application/xml, */*'
    }
  };
  
  try {
    const result = await makeRequest(options);
    
    // Count items in response (rough estimate from HTML table rows)
    const rowMatches = result.body.match(/<tr/g);
    const itemCount = rowMatches ? Math.max(0, rowMatches.length - 1) : 0;
    
    return {
      name: `SimpleQuery-${objectType}`,
      path: path,
      status: result.statusCode,
      success: result.statusCode === 200,
      itemCount: itemCount,
      responseTime: result.responseTime,
      contentLength: result.body.length
    };
  } catch (err) {
    return {
      name: `SimpleQuery-${objectType}`,
      path: path,
      status: 'ERROR',
      success: false,
      error: err.error,
      responseTime: err.responseTime
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

async function runAllTests() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  PI/PO ENDPOINT TEST - Direct HTTP/SOAP (pipoSoapClient approach)');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Host: ${CONFIG.host}:${CONFIG.port}`);
  console.log(`  User: ${CONFIG.user}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const results = {
    soap: [],
    rest: [],
    esr: [],
    dir: [],
    simpleQuery: []
  };

  // Test SOAP Services
  console.log('▶ Testing Directory SOAP Services...');
  for (const endpoint of ENDPOINTS.soapServices) {
    const result = await testSoapEndpoint(endpoint);
    results.soap.push(result);
    const status = result.success ? '✅' : '❌';
    console.log(`  ${status} ${result.name}: ${result.status} (${result.responseTime}ms)`);
  }

  // Test REST Endpoints
  console.log('\n▶ Testing REST/HTTP Endpoints...');
  for (const endpoint of ENDPOINTS.restEndpoints) {
    const result = await testGetEndpoint(endpoint);
    results.rest.push(result);
    const status = result.success ? '✅' : '❌';
    console.log(`  ${status} ${result.name}: ${result.status} (${result.responseTime}ms)`);
  }

  // Test ESR Endpoints
  console.log('\n▶ Testing ESR Endpoints...');
  for (const endpoint of ENDPOINTS.esrEndpoints) {
    const result = await testGetEndpoint(endpoint);
    results.esr.push(result);
    const status = result.success ? '✅' : '❌';
    console.log(`  ${status} ${result.name}: ${result.status} (${result.responseTime}ms)`);
  }

  // Test Directory Endpoints
  console.log('\n▶ Testing Directory Query Endpoints...');
  for (const endpoint of ENDPOINTS.dirEndpoints) {
    const result = await testGetEndpoint(endpoint);
    results.dir.push(result);
    const status = result.success ? '✅' : '❌';
    console.log(`  ${status} ${result.name}: ${result.status} (${result.responseTime}ms)`);
  }

  // Test SimpleQuery for key object types
  console.log('\n▶ Testing ESR SimpleQuery for Object Types...');
  const objectTypes = ['ServiceInterface', 'MessageMapping', 'OperationMapping', 'DataType', 'MessageType'];
  for (const objType of objectTypes) {
    const result = await testSimpleQuery(objType);
    results.simpleQuery.push(result);
    const status = result.success ? '✅' : '❌';
    console.log(`  ${status} ${result.name}: ${result.status} - ${result.itemCount} items (${result.responseTime}ms)`);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════');
  
  const allResults = [...results.soap, ...results.rest, ...results.esr, ...results.dir, ...results.simpleQuery];
  const successCount = allResults.filter(r => r.success).length;
  const totalCount = allResults.length;
  
  console.log(`  Total: ${successCount}/${totalCount} endpoints successful`);
  console.log(`  SOAP Services: ${results.soap.filter(r => r.success).length}/${results.soap.length}`);
  console.log(`  REST Endpoints: ${results.rest.filter(r => r.success).length}/${results.rest.length}`);
  console.log(`  ESR Endpoints: ${results.esr.filter(r => r.success).length}/${results.esr.length}`);
  console.log(`  DIR Endpoints: ${results.dir.filter(r => r.success).length}/${results.dir.length}`);
  console.log(`  SimpleQuery: ${results.simpleQuery.filter(r => r.success).length}/${results.simpleQuery.length}`);

  // Failed endpoints
  const failed = allResults.filter(r => !r.success);
  if (failed.length > 0) {
    console.log('\n  Failed Endpoints:');
    failed.forEach(f => {
      console.log(`    ❌ ${f.name}: ${f.status} - ${f.error || f.preview?.substring(0, 50) || 'unknown error'}`);
    });
  }

  // Write detailed results to file
  const outputPath = './test-pipo-soap-results.json';
  require('fs').writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n  Detailed results saved to: ${outputPath}`);

  return results;
}

// Run if executed directly
if (require.main === module) {
  runAllTests()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Test failed:', err);
      process.exit(1);
    });
}

module.exports = { runAllTests, testSoapEndpoint, testGetEndpoint, testSimpleQuery };
