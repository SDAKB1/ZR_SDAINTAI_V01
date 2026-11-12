'use strict';
/**
 * Test Script: PI/PO Endpoint Discovery via MCP Server
 * 
 * Tests PI/PO endpoints through the deployed MCP server (pipoMcpClient approach)
 * The MCP server acts as a proxy to PI/PO through Cloud Connector
 * 
 * Usage: 
 *   PIPO_MCP_URL=https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com \
 *   PIPO_MCP_USER=user PIPO_MCP_PASS=pass \
 *   node test-pipo-mcp-endpoints.js
 */

const https = require('https');
const http = require('http');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // MCP Server URL (deployed on BTP Cloud Foundry)
  mcpUrl: process.env.PIPO_MCP_URL || 'https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com',
  mcpUser: process.env.PIPO_MCP_USER || '',
  mcpPass: process.env.PIPO_MCP_PASS || '',
  timeout: 60000
};

// Endpoints to test via MCP proxy
const ENDPOINTS_TO_TEST = [
  // Directory SOAP Services
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
  
  // REST/HTTP Endpoints
  { path: '/AdapterFramework/ChannelAdminServlet', name: 'ChannelAdmin', type: 'rest' },
  { path: '/CPACache', name: 'CPACache', type: 'rest' },
  { path: '/mdt', name: 'MDT', type: 'rest' },
  
  // ESR Endpoints
  { path: '/rep/support/SimpleQuery', name: 'ESR-SimpleQuery', type: 'rest' },
  { path: '/rep/query/ext', name: 'ESR-QueryExt', type: 'rest' },
  { path: '/rep/query/int', name: 'ESR-QueryInt', type: 'rest' },
  { path: '/rep/read/ext', name: 'ESR-ReadExt', type: 'rest' },
  
  // Directory Query Endpoints
  { path: '/dir/query/ext', name: 'DIR-QueryExt', type: 'rest' },
  { path: '/dir/read/ext', name: 'DIR-ReadExt', type: 'rest' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// MCP CLIENT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function parseUrl(urlString) {
  const url = new URL(urlString);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname
  };
}

function makeRequest(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = parseUrl(urlString);
    const client = parsed.protocol === 'https:' ? https : http;
    const startTime = Date.now();
    
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path + (options.queryString || ''),
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: CONFIG.timeout
    };
    
    const req = client.request(reqOptions, (res) => {
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
    
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function getAuthHeader() {
  if (CONFIG.mcpUser && CONFIG.mcpPass) {
    return 'Basic ' + Buffer.from(`${CONFIG.mcpUser}:${CONFIG.mcpPass}`).toString('base64');
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MCP SERVER TEST FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Test MCP server health endpoint
 */
async function testMcpHealth() {
  try {
    const result = await makeRequest(`${CONFIG.mcpUrl}/health`, {
      headers: { 'Accept': 'application/json' }
    });
    
    return {
      name: 'MCP-Health',
      status: result.statusCode,
      success: result.statusCode === 200,
      responseTime: result.responseTime,
      body: result.body
    };
  } catch (err) {
    return {
      name: 'MCP-Health',
      status: 'ERROR',
      success: false,
      error: err.error,
      responseTime: err.responseTime
    };
  }
}

/**
 * Test MCP ping endpoint (tests connectivity to PI/PO through Cloud Connector)
 */
async function testMcpPing() {
  try {
    const headers = { 'Accept': 'application/json' };
    const auth = getAuthHeader();
    if (auth) headers['Authorization'] = auth;
    
    const result = await makeRequest(`${CONFIG.mcpUrl}/api/pi8/ping`, { headers });
    
    let parsed = null;
    try {
      parsed = JSON.parse(result.body);
    } catch (e) {
      // Body not JSON
    }
    
    return {
      name: 'MCP-PI8-Ping',
      status: result.statusCode,
      success: result.statusCode === 200,
      responseTime: result.responseTime,
      destinations: parsed?.destinations || null,
      body: result.body.substring(0, 500)
    };
  } catch (err) {
    return {
      name: 'MCP-PI8-Ping',
      status: 'ERROR',
      success: false,
      error: err.error,
      responseTime: err.responseTime
    };
  }
}

/**
 * Test MCP objects endpoint (tests ESR/DIR enumeration)
 */
async function testMcpObjects() {
  try {
    const headers = { 'Accept': 'application/json' };
    const auth = getAuthHeader();
    if (auth) headers['Authorization'] = auth;
    
    const result = await makeRequest(`${CONFIG.mcpUrl}/api/pi8/objects`, { headers });
    
    let parsed = null;
    try {
      parsed = JSON.parse(result.body);
    } catch (e) {
      // Body not JSON
    }
    
    return {
      name: 'MCP-PI8-Objects',
      status: result.statusCode,
      success: result.statusCode === 200,
      responseTime: result.responseTime,
      objectCount: parsed?.objects?.length || 0,
      body: result.body.substring(0, 500)
    };
  } catch (err) {
    return {
      name: 'MCP-PI8-Objects',
      status: 'ERROR',
      success: false,
      error: err.error,
      responseTime: err.responseTime
    };
  }
}

/**
 * Test MCP tool call (if MCP protocol is supported)
 */
async function testMcpToolCall(toolName, args = {}) {
  try {
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
    const auth = getAuthHeader();
    if (auth) headers['Authorization'] = auth;
    
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    });
    
    const result = await makeRequest(`${CONFIG.mcpUrl}/mcp`, {
      method: 'POST',
      headers,
      body
    });
    
    let parsed = null;
    try {
      parsed = JSON.parse(result.body);
    } catch (e) {
      // Body not JSON
    }
    
    return {
      name: `MCP-Tool-${toolName}`,
      status: result.statusCode,
      success: result.statusCode === 200 && !parsed?.error,
      responseTime: result.responseTime,
      result: parsed?.result || null,
      error: parsed?.error || null,
      body: result.body.substring(0, 500)
    };
  } catch (err) {
    return {
      name: `MCP-Tool-${toolName}`,
      status: 'ERROR',
      success: false,
      error: err.error,
      responseTime: err.responseTime
    };
  }
}

/**
 * Test proxied endpoint through MCP (if proxy endpoint exists)
 */
async function testMcpProxyEndpoint(endpoint) {
  try {
    const headers = { 'Accept': 'application/json, application/xml, text/html' };
    const auth = getAuthHeader();
    if (auth) headers['Authorization'] = auth;
    
    // Try proxy endpoint format
    const proxyUrl = `${CONFIG.mcpUrl}/api/proxy${endpoint.path}`;
    
    const result = await makeRequest(proxyUrl, { headers });
    
    return {
      name: `MCP-Proxy-${endpoint.name}`,
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
      name: `MCP-Proxy-${endpoint.name}`,
      path: endpoint.path,
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
  console.log('  PI/PO ENDPOINT TEST - via MCP Server (pipoMcpClient approach)');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  MCP URL: ${CONFIG.mcpUrl}`);
  console.log(`  Auth: ${CONFIG.mcpUser ? 'Configured' : 'None'}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const results = {
    mcpCore: [],
    mcpTools: [],
    mcpProxy: []
  };

  // Test MCP server core endpoints
  console.log('▶ Testing MCP Server Core Endpoints...');
  
  const healthResult = await testMcpHealth();
  results.mcpCore.push(healthResult);
  console.log(`  ${healthResult.success ? '✅' : '❌'} ${healthResult.name}: ${healthResult.status} (${healthResult.responseTime}ms)`);
  
  const pingResult = await testMcpPing();
  results.mcpCore.push(pingResult);
  console.log(`  ${pingResult.success ? '✅' : '❌'} ${pingResult.name}: ${pingResult.status} (${pingResult.responseTime}ms)`);
  if (pingResult.destinations) {
    console.log(`      Destinations: ${JSON.stringify(pingResult.destinations)}`);
  }
  
  const objectsResult = await testMcpObjects();
  results.mcpCore.push(objectsResult);
  console.log(`  ${objectsResult.success ? '✅' : '❌'} ${objectsResult.name}: ${objectsResult.status} - ${objectsResult.objectCount} objects (${objectsResult.responseTime}ms)`);

  // Test MCP tool calls
  console.log('\n▶ Testing MCP Tool Calls...');
  
  const tools = [
    { name: 'list_tools', args: {} },
    { name: 'ping_pipo', args: {} },
    { name: 'query_icos', args: {} },
    { name: 'query_channels', args: {} },
    { name: 'call_rfc', args: { system: 'SDAINTAI', rfc_name: 'RFC_PING' } }
  ];
  
  for (const tool of tools) {
    const result = await testMcpToolCall(tool.name, tool.args);
    results.mcpTools.push(result);
    console.log(`  ${result.success ? '✅' : '❌'} ${result.name}: ${result.status} (${result.responseTime}ms)`);
    if (result.error) {
      console.log(`      Error: ${JSON.stringify(result.error).substring(0, 100)}`);
    }
  }

  // Test proxy endpoints (if supported)
  console.log('\n▶ Testing MCP Proxy Endpoints (if available)...');
  
  const proxyEndpoints = ENDPOINTS_TO_TEST.slice(0, 5); // Test first 5
  for (const endpoint of proxyEndpoints) {
    const result = await testMcpProxyEndpoint(endpoint);
    results.mcpProxy.push(result);
    console.log(`  ${result.success ? '✅' : '❌'} ${result.name}: ${result.status} (${result.responseTime}ms)`);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════');
  
  const allResults = [...results.mcpCore, ...results.mcpTools, ...results.mcpProxy];
  const successCount = allResults.filter(r => r.success).length;
  const totalCount = allResults.length;
  
  console.log(`  Total: ${successCount}/${totalCount} tests successful`);
  console.log(`  MCP Core: ${results.mcpCore.filter(r => r.success).length}/${results.mcpCore.length}`);
  console.log(`  MCP Tools: ${results.mcpTools.filter(r => r.success).length}/${results.mcpTools.length}`);
  console.log(`  MCP Proxy: ${results.mcpProxy.filter(r => r.success).length}/${results.mcpProxy.length}`);

  // Failed tests
  const failed = allResults.filter(r => !r.success);
  if (failed.length > 0) {
    console.log('\n  Failed Tests:');
    failed.forEach(f => {
      console.log(`    ❌ ${f.name}: ${f.status} - ${f.error || 'see details'}`);
    });
  }

  // Write detailed results to file
  const outputPath = './test-pipo-mcp-results.json';
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

module.exports = { runAllTests, testMcpHealth, testMcpPing, testMcpObjects, testMcpToolCall };
