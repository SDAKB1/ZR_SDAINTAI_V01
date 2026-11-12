'use strict';

/**
 * Test PI/PO Import via OData Action
 * 
 * Calls the running app's OData action endpoint to trigger PI/PO import + DB persist.
 * Reads XSUAA credentials from VCAP_SERVICES (available in CF task environment).
 */

process.env.NODE_ENV = 'production';

const https = require('https');
const http  = require('http');

function httpRequest(url, opts, body) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.request(url, opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function run() {
    console.log('\n══════════════════════════════════════════════════');
    console.log('  SDAINTAI — PI/PO Import via OData Action');
    console.log('══════════════════════════════════════════════════\n');

    // ── 1. Parse VCAP_SERVICES for XSUAA credentials ──────────────────────────
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
    const xsuaa = (vcap.xsuaa || [])[0]?.credentials;
    if (!xsuaa) throw new Error('No XSUAA binding found in VCAP_SERVICES');

    const { clientid, clientsecret, url: authUrl } = xsuaa;
    console.log(`Auth URL: ${authUrl}`);
    console.log(`Client:   ${clientid}\n`);

    // ── 2. Get client credentials token ───────────────────────────────────────
    console.log('Getting XSUAA token...');
    const tokenUrl = `${authUrl}/oauth/token`;
    const creds    = Buffer.from(`${clientid}:${clientsecret}`).toString('base64');
    const tokenRes = await httpRequest(tokenUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${creds}`,
            'Content-Type':  'application/x-www-form-urlencoded',
        }
    }, 'grant_type=client_credentials');

    if (tokenRes.status !== 200) {
        throw new Error(`Token request failed: ${tokenRes.status} — ${tokenRes.body.slice(0, 200)}`);
    }
    const token = JSON.parse(tokenRes.body).access_token;
    console.log('✅  Token obtained\n');

    // ── 3. Call importPipoArtifacts OData action ───────────────────────────────
    const appUrl = process.env.APP_URL || 'https://sdaintai.cfapps.us10.hana.ondemand.com';
    const actionUrl = `${appUrl}/odata/v4/aiconx/importPipoArtifacts`;
    console.log(`Calling: POST ${actionUrl}`);

    const importRes = await httpRequest(actionUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'application/json',
            'Accept':        'application/json',
        }
    }, '{}');

    console.log(`Response: HTTP ${importRes.status}`);

    if (importRes.status !== 200 && importRes.status !== 201) {
        console.error(`❌  Import failed: ${importRes.body.slice(0, 500)}`);
        process.exit(1);
    }

    const result = JSON.parse(importRes.body);
    const artifacts = result.value || result;
    const count = Array.isArray(artifacts) ? artifacts.length : '?';

    console.log(`\n✅  Saved ${count} artifacts to HANA\n`);

    if (Array.isArray(artifacts)) {
        const ccs  = artifacts.filter(r => r.artifactType === 'CommunicationChannel');
        const icos = artifacts.filter(r => r.artifactType === 'IntegratedConfiguration');

        console.log(`  Communication Channels: ${ccs.length}`);
        for (const c of ccs) {
            console.log(`    [${c.complexity}] ${c.componentId}/${c.objectId} — ${c.transportProto}/${c.direction}`);
        }

        console.log(`\n  Integrated Configurations: ${icos.length}`);
        for (const ico of icos) {
            console.log(`    [${ico.complexity}] ${ico.senderComponent} → ${ico.rcvComponent} | ${ico.objectId}`);
        }

        const byComplexity = artifacts.reduce((acc, r) => {
            acc[r.complexity] = (acc[r.complexity] || 0) + 1; return acc;
        }, {});
        console.log('\n  Complexity breakdown:', JSON.stringify(byComplexity));
    }

    console.log('\n══════════════════════════════════════════════════\n');
    process.exit(0);
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
