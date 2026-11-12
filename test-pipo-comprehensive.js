#!/usr/bin/env node
'use strict';

/**
 * PI/PO 7.50 Comprehensive Discovery Test
 * 
 * Tests all six discovery areas:
 *   1. Integration Directory SOAP Services
 *   2. ESR Repository Interfaces
 *   3. SLD CIM Interface
 *   4. Channel Monitoring
 *   5. Message Monitoring (MDT)
 *   6. Platform Configuration
 * 
 * Run via: 
 *   node test-pipo-comprehensive.js                    # Full test
 *   node test-pipo-comprehensive.js --capabilities     # Capabilities only
 *   node test-pipo-comprehensive.js --directory        # Directory only
 *   node test-pipo-comprehensive.js --esr              # ESR only
 *   node test-pipo-comprehensive.js --monitoring       # Monitoring only
 * 
 * Environment:
 *   PIPO_HOST     - PI/PO hostname (default: localhost for tunnel)
 *   PIPO_PORT     - Port (default: 50000)
 *   PIPO_USER     - Username
 *   PIPO_PASS     - Password
 *   PIPO_USE_HTTPS - true/false
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
    host: process.env.PIPO_HOST || 'pj2sda.consultsda.com',
    port: parseInt(process.env.PIPO_PORT || '50000', 10),
    user: process.env.PIPO_USER || 'SDAINT',
    pass: process.env.PIPO_PASS,
    useHttps: process.env.PIPO_USE_HTTPS === 'true',
};

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

const ENDPOINTS = {
    // Integration Directory SOAP Services (verified paths)
    directory: {
        // Core objects
        IntegratedConfiguration:    '/IntegratedConfigurationInService/IntegratedConfigurationInImplBean',
        CommunicationChannel:       '/CommunicationChannelInService/CommunicationChannelInImplBean',
        
        // Routing and agreements
        SenderAgreement:            '/SenderAgreementInService/SenderAgreementInImplBean',
        ReceiverAgreement:          '/ReceiverAgreementInService/ReceiverAgreementInImplBean',
        InterfaceDetermination:     '/InterfaceDeterminationInService/InterfaceDeterminationInImplBean',
        ReceiverDetermination:      '/ReceiverDeterminationInService/ReceiverDeterminationInImplBean',
        
        // Value mappings
        ValueMapping:               '/ValueMappingInService/ValueMappingInImplBean',
        AlertRule:                  '/AlertRuleInService/AlertRuleInImplBean',
        
        // Business components (verify deployment)
        BusinessComponent:          '/BusinessComponentInService/BusinessComponentInImplBean',
        ConfigurationScenario:      '/ConfigurationScenarioInService/ConfigurationScenarioInImplBean',
        
        // PI 7.50 specific (may not be deployed)
        IntegratedConfiguration750: '/IntegratedConfiguration750InService/IntegratedConfiguration750InImplBean',
    },
    
    // ESR Repository Interfaces (version-sensitive, distinct formats)
    esr: {
        simpleQuery: '/rep/support/SimpleQuery',
        queryExt:    '/rep/query/ext/1',
        readExt:     '/rep/read/ext/1',
        queryInt:    '/rep/query/int/1',
        exportExt:   '/rep/export/ext/1',
        startPage:   '/rep/start/index.html',
    },
    
    // SLD Interfaces
    sld: {
        cimom:        '/sld/cimom',
        dataSupplier: '/sld/ds',
        bridge:       '/sld/bridge',
    },
    
    // Monitoring Interfaces
    monitoring: {
        channelAdmin: '/AdapterFramework/ChannelAdminServlet',
        mdt:          '/mdt/api/1.0/MessageProcessingLogs',
        mdtOverview:  '/mdt/overview.do',
        cacheAdmin:   '/rep/cache/admin',
    },
    
    // Platform/Admin
    platform: {
        nwa:          '/nwa',
        dirStart:     '/dir/start/index.jsp',
        support:      '/rep/support/admin',
    },
};

// ESR object types for testing
const ESR_OBJECT_TYPES = [
    'SoftwareComponentVersion',
    'Namespace',
    'MessageType',
    'DataType',
    'ServiceInterface',
    'MessageMapping',
    'OperationMapping',
];

// Directory object types for testing
const DIR_OBJECT_TYPES = [
    'IntegratedConfiguration',
    'CommunicationChannel',
    'SenderAgreement',
    'ReceiverAgreement',
    'ValueMappingGroup',
];

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

function makeRequest(path, method = 'GET', body = null, options = {}) {
    return new Promise((resolve, reject) => {
        if (!CONFIG.pass) {
            reject(new Error('PIPO_PASS not set'));
            return;
        }

        const auth = Buffer.from(`${CONFIG.user}:${CONFIG.pass}`).toString('base64');
        const protocol = CONFIG.useHttps ? https : http;

        const reqOptions = {
            hostname: CONFIG.host,
            port: CONFIG.port,
            path,
            method,
            headers: {
                Authorization: `Basic ${auth}`,
                Accept: options.accept || 'application/xml, text/xml, text/html, */*',
                ...(body && { 'Content-Type': options.contentType || 'application/xml' }),
            },
            rejectUnauthorized: false,
            timeout: 30000,
        };

        const req = protocol.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data,
                    preview: data.substring(0, 300).replace(/\s+/g, ' '),
                    contentLength: data.length,
                });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (body) req.write(body);
        req.end();
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function testEndpoint(label, path, options = {}) {
    const startTime = Date.now();
    try {
        const result = await makeRequest(path, options.method || 'GET', options.body, options);
        const duration = Date.now() - startTime;
        
        const status = result.status === 200 ? '✓' : 
                       result.status === 401 ? '✗ AUTH' :
                       result.status === 403 ? '✗ FORBIDDEN' :
                       result.status === 404 ? '✗ NOT FOUND' :
                       result.status === 500 ? '✗ SERVER ERROR' :
                       `? ${result.status}`;
        
        console.log(`  ${status.padEnd(15)} ${label.padEnd(35)} ${duration}ms  ${result.preview.substring(0, 80)}`);
        
        return { 
            label, 
            path, 
            success: result.status === 200,
            status: result.status,
            duration,
            preview: result.preview,
        };
    } catch (err) {
        const duration = Date.now() - startTime;
        console.log(`  ✗ ERROR       ${label.padEnd(35)} ${duration}ms  ${err.message}`);
        return { label, path, success: false, error: err.message, duration };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. TEST DIRECTORY SOAP SERVICES
// ─────────────────────────────────────────────────────────────────────────────

async function testDirectoryServices() {
    console.log('\n' + '═'.repeat(80));
    console.log('1. INTEGRATION DIRECTORY SOAP SERVICES');
    console.log('   Testing WSDL availability (append ?wsdl to each)');
    console.log('═'.repeat(80));
    
    const results = [];
    
    for (const [name, path] of Object.entries(ENDPOINTS.directory)) {
        const wsdlPath = path + '?wsdl';
        const result = await testEndpoint(name, wsdlPath);
        results.push(result);
    }
    
    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. TEST ESR INTERFACES
// ─────────────────────────────────────────────────────────────────────────────

async function testEsrInterfaces() {
    console.log('\n' + '═'.repeat(80));
    console.log('2. ESR REPOSITORY INTERFACES');
    console.log('   Version-sensitive interfaces with distinct request formats');
    console.log('═'.repeat(80));
    
    const results = [];
    
    // Test start page
    results.push(await testEndpoint('ESR Start Page', ENDPOINTS.esr.startPage));
    
    // Test Simple Query with a known object type
    for (const objType of ['SoftwareComponentVersion', 'MessageMapping']) {
        const path = `${ENDPOINTS.esr.simpleQuery}?type=${objType}&swcSelection=all`;
        results.push(await testEndpoint(`SimpleQuery ${objType}`, path));
    }
    
    // Test Query Ext API
    for (const objType of ESR_OBJECT_TYPES.slice(0, 3)) {
        const path = `${ENDPOINTS.esr.queryExt}/${objType}`;
        results.push(await testEndpoint(`Query Ext ${objType}`, path));
    }
    
    // Test Read Ext API (needs params, will likely return error without)
    results.push(await testEndpoint('Read Ext (no params)', `${ENDPOINTS.esr.readExt}/SoftwareComponentVersion`));
    
    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. TEST SLD INTERFACES
// ─────────────────────────────────────────────────────────────────────────────

async function testSldInterfaces() {
    console.log('\n' + '═'.repeat(80));
    console.log('3. SYSTEM LANDSCAPE DIRECTORY (SLD)');
    console.log('   CIM interface - may require separate host/auth');
    console.log('═'.repeat(80));
    
    const results = [];
    
    for (const [name, path] of Object.entries(ENDPOINTS.sld)) {
        results.push(await testEndpoint(`SLD ${name}`, path));
    }
    
    // Try a CIM query
    const cimRequest = `<?xml version="1.0" encoding="UTF-8"?>
<CIM CIMVERSION="2.0" DTDVERSION="2.0">
  <MESSAGE ID="1" PROTOCOLVERSION="1.0">
    <SIMPLEREQ>
      <IMETHODCALL NAME="EnumerateInstances">
        <LOCALNAMESPACEPATH>
          <NAMESPACE NAME="sld"/>
          <NAMESPACE NAME="active"/>
        </LOCALNAMESPACEPATH>
        <IPARAMVALUE NAME="ClassName">
          <CLASSNAME NAME="SAP_BusinessSystem"/>
        </IPARAMVALUE>
      </IMETHODCALL>
    </SIMPLEREQ>
  </MESSAGE>
</CIM>`;
    
    results.push(await testEndpoint('SLD CIM Query', ENDPOINTS.sld.cimom, { 
        method: 'POST', 
        body: cimRequest,
        contentType: 'application/xml',
    }));
    
    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. TEST MONITORING INTERFACES
// ─────────────────────────────────────────────────────────────────────────────

async function testMonitoringInterfaces() {
    console.log('\n' + '═'.repeat(80));
    console.log('4. MONITORING INTERFACES');
    console.log('   Channel status, MDT message logs, cache');
    console.log('═'.repeat(80));
    
    const results = [];
    
    // Channel Admin Servlet
    results.push(await testEndpoint('Channel Status', `${ENDPOINTS.monitoring.channelAdmin}?action=status`));
    
    // MDT API
    results.push(await testEndpoint('MDT Logs (JSON)', `${ENDPOINTS.monitoring.mdt}?$top=5&$format=json`, {
        accept: 'application/json',
    }));
    
    // MDT Overview
    results.push(await testEndpoint('MDT Overview', ENDPOINTS.monitoring.mdtOverview));
    
    // Cache Admin
    results.push(await testEndpoint('Cache Admin', ENDPOINTS.monitoring.cacheAdmin));
    
    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. TEST PLATFORM INTERFACES
// ─────────────────────────────────────────────────────────────────────────────

async function testPlatformInterfaces() {
    console.log('\n' + '═'.repeat(80));
    console.log('5. PLATFORM / ADMINISTRATION');
    console.log('   NWA, Directory start, Support');
    console.log('═'.repeat(80));
    
    const results = [];
    
    for (const [name, path] of Object.entries(ENDPOINTS.platform)) {
        results.push(await testEndpoint(name, path));
    }
    
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    const args = process.argv.slice(2);
    const runAll = args.length === 0;
    
    console.log('╔' + '═'.repeat(78) + '╗');
    console.log('║' + ' PI/PO 7.50 COMPREHENSIVE DISCOVERY TEST'.padEnd(78) + '║');
    console.log('╠' + '═'.repeat(78) + '╣');
    console.log(`║ Host: ${CONFIG.host}:${CONFIG.port}`.padEnd(79) + '║');
    console.log(`║ User: ${CONFIG.user}`.padEnd(79) + '║');
    console.log(`║ Protocol: ${CONFIG.useHttps ? 'HTTPS' : 'HTTP'}`.padEnd(79) + '║');
    console.log('╚' + '═'.repeat(78) + '╝');
    
    if (!CONFIG.pass) {
        console.error('\n❌ ERROR: PIPO_PASS environment variable not set');
        console.error('   Run: PIPO_PASS=yourpassword node test-pipo-comprehensive.js');
        process.exit(1);
    }
    
    const allResults = {
        timestamp: new Date().toISOString(),
        host: CONFIG.host,
        port: CONFIG.port,
        tests: {},
    };
    
    // Run requested tests
    if (runAll || args.includes('--directory')) {
        allResults.tests.directory = await testDirectoryServices();
    }
    
    if (runAll || args.includes('--esr')) {
        allResults.tests.esr = await testEsrInterfaces();
    }
    
    if (runAll || args.includes('--sld')) {
        allResults.tests.sld = await testSldInterfaces();
    }
    
    if (runAll || args.includes('--monitoring')) {
        allResults.tests.monitoring = await testMonitoringInterfaces();
    }
    
    if (runAll || args.includes('--platform')) {
        allResults.tests.platform = await testPlatformInterfaces();
    }
    
    // Summary
    console.log('\n' + '═'.repeat(80));
    console.log('SUMMARY');
    console.log('═'.repeat(80));
    
    let totalTests = 0;
    let passedTests = 0;
    
    for (const [area, results] of Object.entries(allResults.tests)) {
        const passed = results.filter(r => r.success).length;
        const total = results.length;
        totalTests += total;
        passedTests += passed;
        
        const pct = total > 0 ? Math.round(passed / total * 100) : 0;
        const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        
        console.log(`  ${area.padEnd(15)} ${passed}/${total} passed  [${bar}] ${pct}%`);
    }
    
    console.log('─'.repeat(80));
    console.log(`  TOTAL          ${passedTests}/${totalTests} passed`);
    console.log('═'.repeat(80));
    
    // Recommendations
    console.log('\nRECOMMENDATIONS:');
    
    const failedDir = allResults.tests.directory?.filter(r => !r.success) || [];
    if (failedDir.length > 0) {
        console.log(`  • ${failedDir.length} Directory SOAP services unavailable - verify deployment`);
    }
    
    const failedEsr = allResults.tests.esr?.filter(r => !r.success) || [];
    if (failedEsr.length > 0) {
        console.log(`  • ${failedEsr.length} ESR interfaces had issues - check auth/permissions`);
    }
    
    const failedSld = allResults.tests.sld?.filter(r => !r.success) || [];
    if (failedSld.length > 0) {
        console.log(`  • SLD may be on a different host - verify SLD location in NWA`);
    }
    
    const failedMon = allResults.tests.monitoring?.filter(r => !r.success) || [];
    if (failedMon.length > 0) {
        console.log(`  • ${failedMon.length} Monitoring interfaces unavailable - check MDT configuration`);
    }
    
    console.log('\nFor CAP integration, use the working endpoints above.');
    console.log('Each ?wsdl URL provides the SOAP contract; binding address for actual calls.');
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
