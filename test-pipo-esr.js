'use strict';

/**
 * Test PI/PO ESR Artifact Extraction
 * 
 * Tests various methods to extract ESR artifacts (MessageMappings, OperationMappings, etc.)
 * from PI/PO systems via BTP Destinations.
 */

process.env.NODE_ENV = 'production';

const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const DIR = process.env.PIPO_DEST_DIR || 'PO_PJ2_DIR';
const ESR = process.env.PIPO_DEST_ESR || 'PO_PJ2_ESR';

// ── helpers ───────────────────────────────────────────────────────────────────

async function soapPost(dest, path, body) {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:rep="http://sap.com/xi/BASIS">
  <soapenv:Header/>
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;
    const r = await executeHttpRequest(
        { destinationName: dest },
        { method: 'POST', url: path, data: envelope,
          headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' } },
        { fetchCsrfToken: false }
    );
    return r.data;
}

async function formPost(dest, path, formBody) {
    const r = await executeHttpRequest(
        { destinationName: dest },
        { method: 'POST', url: path, data: formBody,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/xml,application/xml' } },
        { fetchCsrfToken: false }
    );
    return r.data;
}

async function restGet(dest, path) {
    const r = await executeHttpRequest(
        { destinationName: dest },
        { method: 'GET', url: path, headers: { Accept: 'application/xml,text/xml' } }
    );
    return r.data;
}

function preview(xml, len = 500) { return String(xml).replace(/\s+/g, ' ').slice(0, len); }
function countTags(xml, tag) { return (String(xml).match(new RegExp(`<${tag}[\\s>/]`, 'g')) || []).length; }

function extractAll(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'g');
    const vals = []; let m;
    while ((m = re.exec(xml)) !== null) vals.push(m[1]);
    return vals;
}

// ── ESR SOAP via DesignTimeObjectsInService ───────────────────────────────────
const ESR_SOAP_PATH = '/DesignTimeObjectsInService/DesignTimeObjectsInImplBean';

async function esrSoapQuery(objectType) {
    return soapPost(DIR, ESR_SOAP_PATH,
        `<rep:DesignTimeObjectsQueryRequest>
           <ObjectType>${objectType}</ObjectType>
         </rep:DesignTimeObjectsQueryRequest>`);
}

// ── DIR SOAP paths ────────────────────────────────────────────────────────────
const CC_PATH = '/CommunicationChannelInService/CommunicationChannelInImplBean';
const ICO_PATH = '/IntegratedConfigurationInService/IntegratedConfigurationInImplBean';

async function ccRead(partyId, componentId, channelId) {
    return soapPost(DIR, CC_PATH,
        `<rep:CommunicationChannelReadRequest>
           <CommunicationChannelID>
             <PartyID>${partyId}</PartyID>
             <ComponentID>${componentId}</ComponentID>
             <ChannelID>${channelId}</ChannelID>
           </CommunicationChannelID>
         </rep:CommunicationChannelReadRequest>`);
}

async function icoRead(senderParty, senderComponent, senderInterface, senderNS) {
    return soapPost(DIR, ICO_PATH,
        `<rep:IntegratedConfigurationReadRequest>
           <IntegratedConfigurationID>
             <SenderPartyID>${senderParty}</SenderPartyID>
             <SenderComponentID>${senderComponent}</SenderComponentID>
             <InterfaceName>${senderInterface}</InterfaceName>
             <InterfaceNamespace>${senderNS}</InterfaceNamespace>
           </IntegratedConfigurationID>
         </rep:IntegratedConfigurationReadRequest>`);
}

// ── run ───────────────────────────────────────────────────────────────────────

async function run() {
    console.log('\n══════════════════════════════════════════════════');
    console.log('  SDAINTAI — ESR Artifact Extraction Test');
    console.log('══════════════════════════════════════════════════\n');
    console.log(`DIR Destination: ${DIR}`);
    console.log(`ESR Destination: ${ESR}\n`);

    // ── 1. ESR SimpleQuery via POST ───────────────────────────────────────────
    console.log('── ESR SimpleQuery (POST) ────────────────────────');
    const ESR_TYPES = [
        'SoftwareComponentVersion', 'MessageType', 'DataType', 'ServiceInterface',
        'MessageMapping', 'OperationMapping', 'InterfaceMapping', 'ValueMappingGroup', 'ImportedArchive',
    ];
    const esrCounts = {};
    for (const type of ESR_TYPES) {
        try {
            const xml = await formPost(ESR, '/rep/support/SimpleQuery',
                `type=${encodeURIComponent(type)}&swcSelection=all`);
            const isHtml = String(xml).includes('<html') || String(xml).includes('HMI');
            const count = isHtml ? 0 : countTags(xml, 'Object');
            esrCounts[type] = count;
            console.log(`${isHtml ? '⚠️ ' : '✅'} ESR → ${type}: ${isHtml ? 'HTML (auth issue?)' : count + ' objects'}`);
            if (!isHtml && count > 0) console.log(`    ${preview(xml, 300)}`);
        } catch (e) {
            esrCounts[type] = -1;
            console.error(`❌  ESR → ${type}: ${e.message.slice(0, 120)}`);
        }
    }

    // ── 2. ESR SimpleQuery via DIR destination ────────────────────────────────
    console.log('\n── ESR SimpleQuery via DIR dest ──────────────────');
    for (const type of ['MessageMapping', 'OperationMapping', 'SoftwareComponentVersion']) {
        try {
            const xml = await formPost(DIR, '/rep/support/SimpleQuery',
                `type=${encodeURIComponent(type)}&swcSelection=all`);
            const isHtml = String(xml).includes('<html') || String(xml).includes('HMI');
            const count = isHtml ? 0 : countTags(xml, 'Object');
            console.log(`${isHtml ? '⚠️ ' : '✅'} DIR → ${type}: ${isHtml ? 'HTML' : count + ' objects'}`);
        } catch (e) {
            console.error(`❌  DIR → ${type}: ${e.message.slice(0, 120)}`);
        }
    }

    // ── 3. CC Detail Read (first 3) ───────────────────────────────────────────
    console.log('\n── CC Detail Read (first 3) ──────────────────────');
    try {
        const listXml = await soapPost(DIR, CC_PATH,
            `<rep:CommunicationChannelQueryRequest><CommunicationChannelID/></rep:CommunicationChannelQueryRequest>`);

        const partyIds     = extractAll(listXml, 'PartyID');
        const componentIds = extractAll(listXml, 'ComponentID');
        const channelIds   = extractAll(listXml, 'ChannelID');

        console.log(`Found ${channelIds.length} channels total`);

        for (let i = 0; i < Math.min(3, channelIds.length); i++) {
            const party = partyIds[i] || '';
            const comp  = componentIds[i];
            const ch    = channelIds[i];
            console.log(`\n  [${i+1}] ${comp}/${ch}`);
            try {
                const detail = await ccRead(party, comp, ch);
                const isFault = String(detail).includes('Fault');
                console.log(`  ${isFault ? '⚠️  SOAP Fault' : '✅  OK'}`);
                console.log(`  ${preview(detail, 400)}`);
            } catch (e) {
                console.error(`  ❌  ${e.message.slice(0, 100)}`);
            }
        }
    } catch (e) {
        console.error(`❌  CC list: ${e.message.slice(0, 120)}`);
    }

    // ── 4. ICO Detail Read (first 3) ──────────────────────────────────────────
    console.log('\n── ICO Detail Read (first 3) ─────────────────────');
    try {
        const listXml = await soapPost(DIR, ICO_PATH,
            `<rep:IntegratedConfigurationQueryRequest><IntegratedConfigurationID/></rep:IntegratedConfigurationQueryRequest>`);

        const senderParties     = extractAll(listXml, 'SenderPartyID');
        const senderComponents  = extractAll(listXml, 'SenderComponentID');
        const interfaceNames    = extractAll(listXml, 'InterfaceName');
        const interfaceNSs      = extractAll(listXml, 'InterfaceNamespace');

        console.log(`Found ${interfaceNames.length} ICOs total`);

        for (let i = 0; i < Math.min(3, interfaceNames.length); i++) {
            const sp  = senderParties[i] || '';
            const sc  = senderComponents[i] || '';
            const inf = interfaceNames[i];
            const ns  = interfaceNSs[i] || '';
            console.log(`\n  [${i+1}] ${sc}/${inf}`);
            try {
                const detail = await icoRead(sp, sc, inf, ns);
                const isFault = String(detail).includes('Fault');
                console.log(`  ${isFault ? '⚠️  SOAP Fault' : '✅  OK'}`);
                console.log(`  ${preview(detail, 400)}`);
            } catch (e) {
                console.error(`  ❌  ${e.message.slice(0, 100)}`);
            }
        }
    } catch (e) {
        console.error(`❌  ICO list: ${e.message.slice(0, 120)}`);
    }

    console.log('\n══════════════════════════════════════════════════\n');
    process.exit(0);
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
