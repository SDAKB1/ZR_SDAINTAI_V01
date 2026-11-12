'use strict';

/**
 * PI/PO Artifact Extraction Utility
 *
 * Extracted from migration-alternative repo.
 * Provides a clean, focused extraction of CommunicationChannels and ICOs
 * from PI/PO systems using SOAP APIs via BTP Destinations.
 */

const cds = require('@sap/cds');
let executeHttpRequest = null;
try {
  executeHttpRequest = require('@sap-cloud-sdk/http-client').executeHttpRequest;
} catch (e) {
  // HTTP client not available in dev
  executeHttpRequest = async () => ({ data: '<?xml version="1.0"?><soapenv:Envelope></soapenv:Envelope>' });
}

// Default destination name - can be overridden
let DIR_DEST = 'PO_PJ2_DIR';
let SOURCE_SYSTEM = 'PJ2_PI';

const CC_PATH = '/CommunicationChannelInService/CommunicationChannelInImplBean';
const ICO_PATH = '/IntegratedConfigurationInService/IntegratedConfigurationInImplBean';

// ── Configuration ─────────────────────────────────────────────────────────────

function configure(options = {}) {
  if (options.destination) DIR_DEST = options.destination;
  if (options.sourceSystem) SOURCE_SYSTEM = options.sourceSystem;
}

// ── SOAP helper ───────────────────────────────────────────────────────────────

async function soapPost(path, body, destinationName = DIR_DEST) {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:rep="http://sap.com/xi/BASIS">
  <soapenv:Header/>
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;
  const r = await executeHttpRequest(
    { destinationName },
    {
      method: 'POST',
      url: path,
      data: envelope,
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' },
    },
    { fetchCsrfToken: false }
  );
  return String(r.data);
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function extractAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'g');
  const vals = [];
  let m;
  while ((m = re.exec(xml)) !== null) vals.push(m[1].trim());
  return vals;
}

function extractFirst(xml, tag) {
  return extractAll(xml, tag)[0] || '';
}

// ── Complexity scoring ────────────────────────────────────────────────────────

function scoreComplexity(xml) {
  const a = xml.toLowerCase();
  let score = 0;
  if (a.includes('java') || a.includes('abap')) score += 6;
  if (a.includes('xslt')) score += 3;
  if (a.includes('as2') || a.includes('jms')) score += 6;
  if (a.includes('jdbc') || a.includes('rfc')) score += 3;
  if (a.includes('edi') || a.includes('edifact')) score += 4;
  const tier = score >= 19 ? 'Complex' : score >= 9 ? 'Medium' : 'Simple';
  return { score: Math.min(100, Math.round((score / 30) * 100)), tier };
}

// ── Propose migration target based on transport protocol ─────────────────────

function proposeTarget(transportProtocol, adapterType) {
  const transport = (transportProtocol || '').toLowerCase();
  const adapter = (adapterType || '').toLowerCase();

  if (transport === 'rfc' || adapter.includes('rfc')) return 'RFC Receiver Adapter';
  if (transport === 'trfc' || adapter.includes('idoc')) return 'IDoc Sender/Receiver Adapter';
  if (transport === 'file' || adapter.includes('file')) return 'SFTP/FTP Adapter';
  if (transport === 'soap' || adapter.includes('soap')) return 'SOAP Adapter';
  if (transport === 'http' || adapter.includes('http') || adapter.includes('rest')) return 'HTTP/REST Adapter';
  if (adapter.includes('as2')) return 'AS2 Adapter';
  if (adapter.includes('jms')) return 'JMS Adapter';
  if (adapter.includes('jdbc')) return 'JDBC Adapter';
  if (adapter.includes('mail')) return 'Mail Adapter';
  return 'Generic Adapter';
}

// ── Extract Communication Channels ────────────────────────────────────────────

async function extractChannels(options = {}) {
  const LOG = cds.log('pipo-extract');
  const destinationName = options.destination || DIR_DEST;
  const rows = [];

  LOG.info('Querying Communication Channels...');
  const ccListXml = await soapPost(
    CC_PATH,
    '<rep:CommunicationChannelQueryRequest><CommunicationChannelID/></rep:CommunicationChannelQueryRequest>',
    destinationName
  );

  const partyIds = extractAll(ccListXml, 'PartyID');
  const componentIds = extractAll(ccListXml, 'ComponentID');
  const channelIds = extractAll(ccListXml, 'ChannelID');
  LOG.info(`Found ${channelIds.length} channels`);

  for (let i = 0; i < channelIds.length; i++) {
    const party = partyIds[i] || '';
    const comp = componentIds[i];
    const ch = channelIds[i];
    try {
      const xml = await soapPost(
        CC_PATH,
        `<rep:CommunicationChannelReadRequest>
                   <CommunicationChannelID>
                     <PartyID>${party}</PartyID>
                     <ComponentID>${comp}</ComponentID>
                     <ChannelID>${ch}</ChannelID>
                   </CommunicationChannelID>
                 </rep:CommunicationChannelReadRequest>`,
        destinationName
      );

      const { score, tier } = scoreComplexity(xml);
      const adapterType = extractFirst(xml, 'AdapterType');
      const transport = extractFirst(xml, 'TransportProtocol');

      rows.push({
        ID: cds.utils.uuid(),
        artifactType: 'CommunicationChannel',
        sourceSystem: options.sourceSystem || SOURCE_SYSTEM,
        partyId: party,
        componentId: comp,
        objectId: ch,
        namespace: '',
        lastChangedAt: extractFirst(xml, 'LastChangeDateTime') || null,
        changedBy: extractFirst(xml, 'LastChangeUserAccountID'),
        adapterType: adapterType,
        transportProto: transport,
        msgProtocol: extractFirst(xml, 'MessageProtocol'),
        direction: extractFirst(xml, 'Direction'),
        senderComponent: '',
        rcvComponent: '',
        qualityOfSvc: '',
        rawXml: xml,
        complexity: tier,
        complexityScore: score,
        proposedTarget: proposeTarget(transport, adapterType),
        migrationStatus: 'Pending',
        projectId: options.projectId || 'PO2IS',
      });
      LOG.info(`  CC [${i + 1}/${channelIds.length}] ${comp}/${ch} — ${tier}`);
    } catch (e) {
      LOG.error(`  CC ${comp}/${ch} failed: ${e.message}`);
    }
  }

  return rows;
}

// ── Extract Integrated Configurations ─────────────────────────────────────────

async function extractICOs(options = {}) {
  const LOG = cds.log('pipo-extract');
  const destinationName = options.destination || DIR_DEST;
  const rows = [];

  LOG.info('Querying Integrated Configurations...');
  const icoListXml = await soapPost(
    ICO_PATH,
    '<rep:IntegratedConfigurationQueryRequest><IntegratedConfigurationID/></rep:IntegratedConfigurationQueryRequest>',
    destinationName
  );

  const senderParties = extractAll(icoListXml, 'SenderPartyID');
  const senderComponents = extractAll(icoListXml, 'SenderComponentID');
  const interfaceNames = extractAll(icoListXml, 'InterfaceName');
  const interfaceNSs = extractAll(icoListXml, 'InterfaceNamespace');
  LOG.info(`Found ${interfaceNames.length} ICOs`);

  for (let i = 0; i < interfaceNames.length; i++) {
    const sp = senderParties[i] || '';
    const sc = senderComponents[i] || '';
    const inf = interfaceNames[i];
    const ns = interfaceNSs[i] || '';
    try {
      const xml = await soapPost(
        ICO_PATH,
        `<rep:IntegratedConfigurationReadRequest>
                   <IntegratedConfigurationID>
                     <SenderPartyID>${sp}</SenderPartyID>
                     <SenderComponentID>${sc}</SenderComponentID>
                     <InterfaceName>${inf}</InterfaceName>
                     <InterfaceNamespace>${ns}</InterfaceNamespace>
                   </IntegratedConfigurationID>
                 </rep:IntegratedConfigurationReadRequest>`,
        destinationName
      );

      const { score, tier } = scoreComplexity(xml);
      const rcv = extractFirst(xml, 'ReceiverComponentID');

      rows.push({
        ID: cds.utils.uuid(),
        artifactType: 'IntegratedConfiguration',
        sourceSystem: options.sourceSystem || SOURCE_SYSTEM,
        partyId: sp,
        componentId: sc,
        objectId: inf,
        namespace: ns,
        lastChangedAt: extractFirst(xml, 'LastChangeDateTime') || null,
        changedBy: extractFirst(xml, 'LastChangeUserAccountID'),
        adapterType: '',
        transportProto: '',
        msgProtocol: '',
        direction: '',
        senderComponent: sc,
        rcvComponent: rcv,
        qualityOfSvc: extractFirst(xml, 'QualityOfService'),
        rawXml: xml,
        complexity: tier,
        complexityScore: score,
        proposedTarget: 'Integration Flow (iFlow)',
        migrationStatus: 'Pending',
        projectId: options.projectId || 'PO2IS',
      });
      LOG.info(`  ICO [${i + 1}/${interfaceNames.length}] ${sc}/${inf} → ${rcv} — ${tier}`);
    } catch (e) {
      LOG.error(`  ICO ${sc}/${inf} failed: ${e.message}`);
    }
  }

  return rows;
}

// ── Main import function ──────────────────────────────────────────────────────

async function importAll(PipoArtifacts, options = {}) {
  const LOG = cds.log('pipo-extract');

  const channels = await extractChannels(options);
  const icos = await extractICOs(options);
  const rows = [...channels, ...icos];

  // Upsert — delete existing artifacts then insert fresh
  const projectId = options.projectId || 'PO2IS';
  const sourceSystem = options.sourceSystem || SOURCE_SYSTEM;

  LOG.info(`Persisting ${rows.length} artifacts to DB...`);
  await DELETE.from(PipoArtifacts).where({ projectId, sourceSystem });
  if (rows.length > 0) await INSERT.into(PipoArtifacts).entries(rows);

  LOG.info(`Done — ${rows.length} artifacts saved`);
  return SELECT.from(PipoArtifacts).where({ projectId });
}

module.exports = {
  configure,
  extractChannels,
  extractICOs,
  importAll,
  scoreComplexity,
  proposeTarget,
  soapPost,
  extractAll,
  extractFirst,
};
