'use strict';

process.env.NODE_ENV = 'production';

const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

async function probe(dest, path, label) {
    try {
        const r = await executeHttpRequest(
            { destinationName: dest },
            { method: 'GET', url: path, headers: { Accept: 'application/xml,text/xml,*/*' } }
        );
        console.log(`\n[${label}] ${path}`);
        console.log('  status:', r.status);
        console.log('  content-type:', r.headers['content-type']);
        console.log('  location:', r.headers['location'] || '(none)');
        console.log('  body[0:400]:', String(r.data).replace(/\s+/g, ' ').slice(0, 400));
    } catch (e) {
        console.log(`\n[${label}] ${path}`);
        console.log('  ERROR:', e.message);
        if (e.response) {
            console.log('  status:', e.response.status);
            console.log('  content-type:', e.response.headers?.['content-type']);
            console.log('  location:', e.response.headers?.['location'] || '(none)');
            console.log('  body[0:400]:', String(e.response.data).replace(/\s+/g, ' ').slice(0, 400));
        }
    }
}

async function run() {
    console.log('=== PIPO Header Diagnostic ===');

    // ESR paths
    await probe('PO_PJ2_ESR', '/rep/query/ext/1/SoftwareComponentVersion', 'ESR query');
    await probe('PO_PJ2_ESR', '/rep/read/ext/1/SoftwareComponentVersion',  'ESR read');

    // DIR paths
    await probe('PO_PJ2_DIR', '/dir/query/ext/1/IntegratedConfiguration',  'DIR query');
    await probe('PO_PJ2_DIR', '/dir/read/ext/1/IntegratedConfiguration',   'DIR read');

    // SOAP Web Services - note the /...InImplBean suffix required for WSDL access
    // These are the Integration Directory SOAP APIs (different from HMI REST APIs above)
    await probe('PO_PJ2_DIR', '/CommunicationChannelInService/CommunicationChannelInImplBean?wsdl',           'DIR SOAP CC WSDL');
    await probe('PO_PJ2_DIR', '/IntegratedConfigurationInService/IntegratedConfigurationInImplBean?wsdl',     'DIR SOAP ICO WSDL');
    await probe('PO_PJ2_DIR', '/ValueMappingInService/ValueMappingInImplBean?wsdl',                           'DIR SOAP VM WSDL');
    await probe('PO_PJ2_DIR', '/AlertRuleInService/AlertRuleInImplBean?wsdl',                                 'DIR SOAP Alert WSDL');
    await probe('PO_PJ2_DIR', '/AdapterFramework/',                                                            'DIR AdapterFW');

    console.log('\n=== Done ===');
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
