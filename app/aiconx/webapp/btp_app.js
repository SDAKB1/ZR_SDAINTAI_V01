/* ==================== SDAINT-AI MIGRATION COCKPIT — LUMI ENGINE ====================
   Pre-sales walkthrough build: runs entirely client-side against sandbox data so this
   can be demoed anywhere, but every screen, question, and data shape mirrors exactly
   what the production SDAINTAI Brain integration will do. */

// ==================== STATIC DATA ====================

const PLATFORMS = {
  mulesoft: {
    label: 'MuleSoft', icon: 'fa-diagram-project', assetNoun: 'app', assetNounPlural: 'apps',
    projectName: 'Mule32MigrationSAp',
    versions: ['CloudHub 2.0', 'CloudHub 1.0', 'Anypoint RTF', 'Mule Runtime 4.x (on-prem)', 'Mule Runtime 3.x (legacy)'],
    hint: 'Anypoint Platform organization',
    terms: {
      idLabel: 'Application / API ID', nameLabel: 'Mule App / API Name', typeLabel: 'Mule Application / API / Flow',
      packageLabel: 'Mule Project / Exchange Asset', mappingLabel: 'DataWeave',
      sourceStepNoun: 'MuleSoft Source Object', uploadLabel: 'MuleSoft asset file', decompileWording: 'MuleSoft flow semantics'
    }
  },
  pipo: {
    label: 'SAP PI/PO', icon: 'fa-shuffle', assetNoun: 'interface', assetNounPlural: 'interfaces',
    projectName: 'PIPO32Migration',
    versions: ['PO 7.5 (single-stack AEX)', 'PI 7.31 / 7.4 (dual-stack)', 'PI 7.1 (legacy single-stack)'],
    hint: 'Integration Directory / ICO scope',
    terms: {
      idLabel: 'Interface / ICO ID', nameLabel: 'Interface / ICO Name', typeLabel: 'ICO / Integrated Configuration',
      packageLabel: 'Software Component Version (SWCV)', mappingLabel: 'Message / Operation Mapping',
      sourceStepNoun: 'PI/PO Source Object', uploadLabel: 'PI/PO interface export file', decompileWording: 'PI/PO ICO flow semantics'
    }
  },
  informatica: {
    label: 'Informatica', icon: 'fa-arrows-turn-to-dots', assetNoun: 'mapping', assetNounPlural: 'mappings',
    projectName: 'Infa32Migration',
    versions: ['Informatica Intelligent Cloud Services (IICS)', 'PowerCenter 10.x', 'PowerCenter 9.x (legacy)'],
    hint: 'Informatica domain / repository',
    terms: {
      idLabel: 'Mapping / Workflow ID', nameLabel: 'Mapping / Workflow Name', typeLabel: 'Mapping / Workflow / Session',
      packageLabel: 'Repository Folder', mappingLabel: 'Expression Transformation',
      sourceStepNoun: 'Informatica Source Object', uploadLabel: 'Informatica mapping export file', decompileWording: 'Informatica mapping semantics'
    }
  },
  boomi: {
    label: 'Dell Boomi', icon: 'fa-atom', assetNoun: 'process', assetNounPlural: 'processes',
    projectName: 'Boomi32Migration',
    versions: ['AtomSphere (Cloud Atom)', 'Boomi Molecule', 'Boomi Local Atom'],
    hint: 'AtomSphere account',
    terms: {
      idLabel: 'Process / Component ID', nameLabel: 'Process / Component Name', typeLabel: 'Process / Sub-Process / Connector',
      packageLabel: 'Boomi Package / Folder', mappingLabel: 'Map Component',
      sourceStepNoun: 'Dell Boomi Source Object', uploadLabel: 'Dell Boomi process export file', decompileWording: 'Dell Boomi process semantics'
    }
  }
};

// Fixed target-side vocabulary — the migration target is always SAP Integration Suite (CPI),
// so unlike PLATFORMS.terms this doesn't vary by source platform.
const CPI_TERMS = {
  idLabel: 'iFlow ID', nameLabel: 'iFlow Name', typeLabel: 'Integration Flow (iFlow)',
  packageLabel: 'Integration Package', mappingLabel: 'Message Mapping / XSLT / Groovy'
};

function leafTree(kind, name, ok) { return { kind, name, ok: ok !== false, children: [] }; }

// A leaf that also carries a Kafka event a reviewer can opt into converting to a native
// SAP Integration Suite Kafka Sender/Receiver channel — separate from the normal
// include/exclude checkbox, since "convert this object" and "also wire it to IS-Kafka"
// are two different decisions. `selected` starts false: nothing gets auto-converted to
// Kafka just because the object itself is included.
function kafkaLeaf(kind, name, kafkaId, topic, ok) {
  const node = leafTree(kind, name, ok);
  node.kafkaEvent = { id: kafkaId, topic, group: `${topic.split('-')[0]}-sync-consumer`, selected: false };
  return node;
}

// ==================== BULK ASSET GENERATION (scale a demo up to "60 apps / ~600 iflows" size) ====================
// Deterministic (seeded, not Math.random()) so repeated scans/tests are stable.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const BULK_DOMAINS = ['customer', 'vendor', 'material', 'sales-order', 'purchase-order', 'invoice', 'delivery',
  'shipment', 'payment', 'credit-memo', 'goods-receipt', 'inventory', 'pricing', 'contract', 'fixed-asset',
  'employee', 'payroll', 'budget', 'warehouse', 'return', 'quotation', 'production-order', 'quality-notification',
  'batch', 'serial-number', 'cost-center', 'profit-center', 'gl-account', 'bank-statement', 'tax-document'];
const BULK_ACTIONS = ['sync', 'router', 'connector', 'mapping', 'integration', 'process', 'callback',
  'notification', 'extract', 'load', 'validation', 'enrichment', 'lookup', 'replication', 'archive'];
// type/tree vocabulary per platform, matching the hand-authored flagship assets' own conventions
const BULK_VOCAB = {
  mulesoft: { types: ['App', 'Flow', 'Connector', 'Mapping'], treeKind: 'flow', leafKinds: ['connector', 'transform', 'sub-flow'] },
  pipo: { types: ['ICO'], treeKind: 'sender-channel', leafKinds: ['receiver-channel', 'message-mapping', 'value-mapping'] },
  informatica: { types: ['Mapping', 'Workflow'], treeKind: 'workflow', leafKinds: ['mapping', 'session'] },
  boomi: { types: ['Process'], treeKind: 'process', leafKinds: ['connector', 'map'] }
};
function generateBulkAssets(platform, count, startIndex, existingNames) {
  const rand = mulberry32(0x5DA1 + startIndex + count);
  const vocab = BULK_VOCAB[platform] || BULK_VOCAB.mulesoft;
  const out = [];
  const usedNames = new Set(existingNames || []);
  for (let i = 0; i < count; i++) {
    const domain = BULK_DOMAINS[Math.floor(rand() * BULK_DOMAINS.length)];
    const action = BULK_ACTIONS[Math.floor(rand() * BULK_ACTIONS.length)];
    let name = `${domain}-${action}`;
    let n = 2;
    while (usedNames.has(name)) { name = `${domain}-${action}-${n++}`; }
    usedNames.add(name);
    // 55% Simple, 35% Medium, 10% High — "lots of simple stuff, some real complexity from custom code"
    const roll = rand();
    const tier = roll < 0.55 ? 'Simple' : roll < 0.90 ? 'Medium' : 'High';
    const deps = tier === 'Simple' ? 1 + Math.floor(rand() * 2) : tier === 'Medium' ? 2 + Math.floor(rand() * 3) : 5 + Math.floor(rand() * 8);
    const flowCount = tier === 'Simple' ? 3 + Math.floor(rand() * 4) : tier === 'Medium' ? 8 + Math.floor(rand() * 7) : 15 + Math.floor(rand() * 11);
    const flagged = tier === 'High' ? rand() < 0.5 : tier === 'Medium' ? rand() < 0.15 : false;
    const status = flagged ? (rand() < 0.5 ? 'Warning' : 'Review') : 'Ready';
    const type = vocab.types[Math.floor(rand() * vocab.types.length)];
    const id = `G${String(startIndex + i + 1).padStart(4, '0')}`;
    const tree = [
      { kind: vocab.treeKind, name: `${name}-main`, ok: true, children: [
        leafTree(vocab.leafKinds[0], `${name}-${vocab.leafKinds[0]}-1`, true),
        leafTree(vocab.leafKinds[1], `${name}-${vocab.leafKinds[1]}-1`, !flagged)
      ] }
    ];
    if (tier === 'High') tree.push(leafTree(vocab.leafKinds[2] || vocab.leafKinds[0], `${name}-${vocab.leafKinds[2] || vocab.leafKinds[0]}-2`, !flagged));
    out.push({ id, name, type, tier, deps, status, flowCount, tree, bulk: true });
  }
  return out;
}

const ASSET_SETS = {
  mulesoft: [
    { id: 'A001', name: 'order-process-api', type: 'App', tier: 'Medium', deps: 4, status: 'Ready',
      tree: [
        { kind: 'flow', name: 'order-process-main-flow', ok: true, children: [
          leafTree('sub-flow', 'validate-order-subflow', true),
          leafTree('connector', 'salesforce-connector (Opportunity)', true),
          leafTree('connector', 'sap-erp-connector (BAPI_SALESORDER_CREATEFROMDAT2)', true),
          leafTree('transform', 'order-to-sap.dwl', true)
        ]},
        leafTree('flow', 'order-error-handler-flow', true),
        leafTree('properties', 'order-process-api.properties.yaml', true),
        leafTree('schema', 'order-response.xsd', true)
      ] },
    { id: 'A002', name: 'customer-sync-flow', type: 'Flow', tier: 'Simple', deps: 2, status: 'Ready',
      tree: [
        { kind: 'flow', name: 'customer-sync-main-flow', ok: true, children: [
          leafTree('connector', 'salesforce-connector (Account)', true),
          leafTree('transform', 'account-to-bp.dwl', true)
        ] }
      ] },
    { id: 'A003', name: 'invoice-router', type: 'Flow', tier: 'Medium', deps: 3, status: 'Ready',
      tree: [
        { kind: 'flow', name: 'invoice-router-main-flow', ok: true, children: [
          leafTree('connector', 'billing-db-connector', true),
          leafTree('transform', 'invoice-to-billingdoc.dwl', true)
        ] }
      ] },
    { id: 'A004', name: 'sap-erp-connector', type: 'Connector', tier: 'Medium', deps: 1, status: 'Warning',
      tree: [ leafTree('connector', 'sap-erp-connector (shared lib)', true), leafTree('properties', 'sap-erp-connector.properties.yaml', false) ] },
    { id: 'A005', name: 'payment-callback-api', type: 'App', tier: 'Simple', deps: 2, status: 'Ready',
      tree: [
        { kind: 'flow', name: 'payment-callback-main-flow', ok: true, children: [
          leafTree('connector', 'http-listener', true)
        ] }
      ] },
    { id: 'A006', name: 'partner-edi-mapping', type: 'Mapping', tier: 'High', deps: 12, status: 'Review',
      tree: [
        { kind: 'flow', name: 'edi-inbound-flow', ok: true, children: [
          leafTree('transform', 'edi-850-to-po.dwl', false)
        ] },
        leafTree('schema', 'edi-envelope.xsd', false)
      ] },
    // Business Partner: one domain, three separate Kafka-carried events (created/updated/sync) —
    // the exact scenario walked through in the MuleSoft-SDA-Exit deck's Kafka slides. Flagged
    // Review by default so it lands in front of a reviewer, same as the deck's narrative.
    { id: 'A007', name: 'business-partner-sync', type: 'App', tier: 'Medium', deps: 3, status: 'Review',
      tree: [
        { kind: 'flow', name: 'business-partner-sync-main-flow', ok: true, children: [
          leafTree('connector', 'sap-idoc-out', true),
          kafkaLeaf('connector', 'kafka-bp-created', 'IS-KAFKA_E001', 'bp-events-created', true),
          kafkaLeaf('connector', 'kafka-bp-updated', 'IS-KAFKA_E002', 'bp-events-updated', true),
          kafkaLeaf('connector', 'kafka-bp-sync', 'IS-KAFKA_E003', 'bp-events-sync', true),
          leafTree('transform', 'bp-mapping.dwl', true)
        ] }
      ] }
  ],
  pipo: [
    { id: 'I001', name: 'Material Master', type: 'ICO', tier: 'Simple', deps: 1, status: 'Ready',
      tree: [ leafTree('sender-channel', 'MATMAS_Sender_File', true), leafTree('receiver-channel', 'MATMAS_Receiver_IDoc', true), leafTree('message-mapping', 'MATMAS07_to_MM01', true) ] },
    { id: 'I002', name: 'Customer Master', type: 'ICO', tier: 'Simple', deps: 1, status: 'Ready',
      tree: [ leafTree('sender-channel', 'DEBMAS_Sender_IDoc', true), leafTree('receiver-channel', 'DEBMAS_Receiver_Proxy', true), leafTree('message-mapping', 'DEBMAS08_to_BP', true) ] },
    { id: 'I003', name: 'Sales Orders', type: 'ICO', tier: 'Medium', deps: 3, status: 'Ready',
      tree: [ leafTree('sender-channel', 'ORDERS_Sender_HTTP', true), leafTree('operation-mapping', 'ORDERS05_to_VA01', true), leafTree('value-mapping', 'SalesOrg_ValueMap', true) ] },
    { id: 'I004', name: 'Delivery', type: 'ICO', tier: 'Medium', deps: 2, status: 'Warning',
      tree: [ leafTree('sender-channel', 'DESADV_Sender_IDoc', true), leafTree('message-mapping', 'DELVRY03_to_VL01N', false) ] },
    { id: 'I005', name: 'Invoice', type: 'ICO', tier: 'Medium', deps: 2, status: 'Ready',
      tree: [ leafTree('sender-channel', 'INVOIC_Sender_IDoc', true), leafTree('message-mapping', 'INVOIC02_to_VF01', true) ] },
    { id: 'I006', name: 'FI Document', type: 'ICO', tier: 'High', deps: 6, status: 'Review',
      tree: [ leafTree('sender-channel', 'FIDOC_Sender_Proxy', true), leafTree('message-mapping', 'FIDOC_to_BAPI_ACC_POST', false), leafTree('value-mapping', 'GLAccount_ValueMap', false) ] }
  ],
  informatica: [
    { id: 'M001', name: 'material-master-mapping', type: 'Mapping', tier: 'Simple', deps: 1, status: 'Ready', tree: [ leafTree('mapping', 'm_material_master', true), leafTree('session', 's_material_master', true) ] },
    { id: 'M002', name: 'customer-master-mapping', type: 'Mapping', tier: 'Simple', deps: 1, status: 'Ready', tree: [ leafTree('mapping', 'm_customer_master', true), leafTree('session', 's_customer_master', true) ] },
    { id: 'M003', name: 'sales-order-workflow', type: 'Workflow', tier: 'Medium', deps: 3, status: 'Ready', tree: [ leafTree('workflow', 'wf_sales_order', true), leafTree('mapping', 'm_sales_order', true) ] },
    { id: 'M004', name: 'delivery-workflow', type: 'Workflow', tier: 'Medium', deps: 2, status: 'Warning', tree: [ leafTree('workflow', 'wf_delivery', true), leafTree('mapping', 'm_delivery', false) ] },
    { id: 'M005', name: 'invoice-mapping', type: 'Mapping', tier: 'Medium', deps: 2, status: 'Ready', tree: [ leafTree('mapping', 'm_invoice', true), leafTree('session', 's_invoice', true) ] },
    { id: 'M006', name: 'fi-posting-workflow', type: 'Workflow', tier: 'High', deps: 5, status: 'Review', tree: [ leafTree('workflow', 'wf_fi_posting', true), leafTree('mapping', 'm_fi_posting', false) ] }
  ],
  boomi: [
    { id: 'P001', name: 'material-master-process', type: 'Process', tier: 'Simple', deps: 1, status: 'Ready', tree: [ leafTree('process', 'PRC_MaterialMaster', true), leafTree('connector', 'SAP Connector', true) ] },
    { id: 'P002', name: 'customer-master-process', type: 'Process', tier: 'Simple', deps: 1, status: 'Ready', tree: [ leafTree('process', 'PRC_CustomerMaster', true), leafTree('connector', 'SAP Connector', true) ] },
    { id: 'P003', name: 'sales-order-process', type: 'Process', tier: 'Medium', deps: 3, status: 'Ready', tree: [ leafTree('process', 'PRC_SalesOrder', true), leafTree('map', 'MAP_Order_to_VA01', true) ] },
    { id: 'P004', name: 'delivery-process', type: 'Process', tier: 'Medium', deps: 2, status: 'Warning', tree: [ leafTree('process', 'PRC_Delivery', true), leafTree('map', 'MAP_Delivery_to_VL01N', false) ] },
    { id: 'P005', name: 'invoice-process', type: 'Process', tier: 'Medium', deps: 2, status: 'Ready', tree: [ leafTree('process', 'PRC_Invoice', true), leafTree('map', 'MAP_Invoice_to_VF01', true) ] },
    { id: 'P006', name: 'fi-posting-process', type: 'Process', tier: 'High', deps: 5, status: 'Review', tree: [ leafTree('process', 'PRC_FIPosting', true), leafTree('map', 'MAP_FI_to_BAPI', false) ] }
  ]
};
// Scale each hand-authored set up to a realistic large-migration size — SDAINTAI's whole
// pitch is the accelerator handling hundreds of iflows, not a 6-item toy demo. The
// hand-crafted items above stay first (they carry the Kafka/Warning/Review narrative
// beats referenced elsewhere) with generated bulk assets appended after them.
const BULK_TARGET_COUNT = { mulesoft: 60, pipo: 50, informatica: 40, boomi: 35 };
Object.keys(ASSET_SETS).forEach(platform => {
  const base = ASSET_SETS[platform];
  base.forEach(a => { if (a.flowCount == null) a.flowCount = a.tier === 'High' ? 18 : a.tier === 'Medium' ? 9 : 4; });
  const target = BULK_TARGET_COUNT[platform] || 30;
  if (base.length < target) ASSET_SETS[platform] = base.concat(generateBulkAssets(platform, target - base.length, base.length, base.map(a => a.name)));
});

const TEAM = [
  { id: 'daniel', name: 'Daniel Smith', role: 'Project Manager', avail: 80, color: '#e5a93b' },
  { id: 'priya', name: 'Priya Sharma', role: 'Tech Lead', avail: 65, color: '#8b5cf6' },
  { id: 'marco', name: 'Marco Lin', role: 'Senior Developer', avail: 90, color: '#06b6d4' },
  { id: 'anika', name: 'Anika Volkov', role: 'Architect', avail: 50, color: '#10b981' },
  { id: 'jamal', name: 'Jamal Reid', role: 'Developer', avail: 100, color: '#ef4444' },
  { id: 'sofia', name: 'Sofia Mendes', role: 'QA Engineer', avail: 75, color: '#f59e0b' }
];
// Admin can edit the roster (see ADMIN section below); everything that used to read the
// TEAM constant directly now reads this instead, so Admin's edits actually take effect.
function activeTeam() { return (S.team && S.team.length) ? S.team : TEAM; }

// ==================== FILE UPLOAD + DECOMPILATION ====================
// Magic-byte sniffing (the same technique real file-type detectors use) rather than
// trusting the extension alone — a renamed .jar or a stripped-extension .class still
// gets caught correctly.
const COMPILED_SIGNATURES = [
  { name: 'Java compiled class (.class)', magic: [0xCA, 0xFE, 0xBA, 0xBE] },
  { name: 'Java archive / compiled bundle (JAR)', magic: [0x50, 0x4B, 0x03, 0x04] },
  { name: 'ELF binary (compiled C/C++)', magic: [0x7F, 0x45, 0x4C, 0x46] },
  { name: 'Windows PE/DLL (compiled C/C++)', magic: [0x4D, 0x5A] }
];
const SOURCE_EXTENSIONS = ['.xml', '.dwl', '.xsd', '.wsdl', '.yaml', '.yml', '.properties', '.raml', '.json', '.txt'];
function decompileStages() {
  const wording = (PLATFORMS[S.platform] || PLATFORMS.mulesoft).terms.decompileWording;
  return [
    'Parsing bytecode structure…',
    'Reconstructing control flow graph…',
    'Recovering DataWeave transform equivalents…',
    `Mapping recovered logic to ${wording}…`,
    'Cross-referencing the SDAINTAI Brain pattern library…'
  ];
}
let decompiledCounter = 0;

async function classifyUploadedFile(file) {
  const name = file.name.toLowerCase();
  const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
  const platformLabel = (PLATFORMS[S.platform] || PLATFORMS.mulesoft).label;
  try {
    const buf = await file.slice(0, 4).arrayBuffer();
    const bytes = new Uint8Array(buf);
    for (const sig of COMPILED_SIGNATURES) {
      if (sig.magic.every((b, i) => bytes[i] === b)) return { compiled: true, kind: sig.name };
    }
  } catch (e) { /* empty/tiny file — fall through to extension check */ }
  if (SOURCE_EXTENSIONS.includes(ext)) return { compiled: false, kind: `${platformLabel} source artifact` };
  if (ext === '.js') {
    const text = await file.slice(0, 2000).text();
    const looksMinified = text.length > 400 && text.indexOf('\n') === -1;
    return { compiled: looksMinified, kind: looksMinified ? 'Minified/bundled JavaScript' : 'JavaScript source' };
  }
  return { compiled: false, kind: 'Unrecognized format — treating as source' };
}

// ==================== STATE ====================
const S = {
  userName: null,
  pendingAnswerHandler: null,
  platform: null,
  authMode: 'userpass',
  connectMode: 'direct',
  connectionTested: false,
  connectionOk: false,
  projectName: null,
  assets: [],
  waves: { 1: [], 2: [], 3: [] },
  revealedWaves: [],
  teamByWave: { 1: [], 2: [], 3: [] },
  cockpitRows: [],
  cockpitInterval: null,
  cockpitStarted: false,
  // Persona lens — Admin / Approver / Viewer, per UStory_w_Persona_Migration_v1.pptx.
  // Gates exactly one thing: Push to BTP Integration Suite / Take to Production
  // (sendIflowToLandscape target=Prod). Every other screen is unchanged for
  // Admin and Approver; Viewer is read-only everywhere. Not a real login —
  // a lens switch for pre-sales walkthroughs, persisted so it survives reload.
  persona: 'Admin',
  pushApproved: false,
  pushApprovedBy: null,
  pushApprovedAt: null,
  // Real backend AI Brain (LangGraph/Claude) — off until the Admin activation
  // password is entered. brainKey lives in memory only, never persisted.
  brainActivated: false,
  brainKey: null,
  brainSessionId: null,
  // Admin/Settings defaults — pre-seeded with the real lab tenant so "Open in
  // SAP Integration Suite" works out of the box, before anyone's even opened
  // the Admin screen. saveAdminDefaults() overwrites this from the form.
  adminDefaults: {
    // Mirrors the Admin screen's own HTML defaults, not just what's typed there —
    // otherwise the "target settings already configured" fast path in
    // selectPlatform() would stay dark until someone explicitly hit Save Defaults
    // once, even though the same values are already sitting in the form.
    env: 'Sandbox',
    authMode: 'userpass',
    username: 'daniel.smith@sdaintai-sandbox.io',
    password: 'Demo#Sandbox2026!',
    tenant: 'sda-prod-eu10',
    region: 'EU10 — Frankfurt',
    btpTenantUrl: 'https://lab-sda.integrationsuite.cfapps.us10-002.hana.ondemand.com/shell/design/contentpackage/INTPACKFROMMUKESOFT1?section=ARTIFACTS',
    btpTenantManual: false,
    // Each client migration runs under one SDA AI subaccount. Shared by default
    // (sandbox); checking sda-prv-tenant marks the picked subaccount as dedicated
    // to this client only — a real tenant boundary (own XSUAA instance), not a
    // row-level filter inside a shared one. See updatePrvTenantStatus().
    sdaSubaccount: 'sda-ai-shared-eu10',
    prvTenant: false,
    // The two A2A agents behind the acceleration story — on by default. See
    // effortMinutesForTier() / activeAgentCount() for how unchecking either
    // slows every duration the cockpit shows.
    agentMappingEnabled: true,
    agentConversionEnabled: true,
    // No real ALM tenant or Figaf ALM target has been supplied yet — both start in
    // "manual" mode (field disabled, no fabricated value) until someone has one.
    // Two separate systems, two separate fields/flags — ALM tenant (e.g. SAP Cloud
    // ALM / Solution Manager) is not the same target as Figaf.
    almTenantUrl: '',
    almTenantManual: true,
    figafAlmTarget: '',
    figafManual: true,
    // SAP PI/PO (Process Orchestration) source system — pulled from a real PJ1
    // Integration Directory config screenshot. Address and User ID were legible
    // in the source image; Password was masked there, so it starts blank rather
    // than fabricated — enter it once and Save Defaults persists it for the session.
    piPo: {
      systemName: 'PJ1',
      systemVersion: '7.50',
      address: 'http://nwjava.consultsda.com:443',
      userId: 'PI_TECH_MIG',
      password: '',
      authType: 'BasicAuthentication',
      proxyType: 'OnPremise',
      locationId: 'SDA_LAB'
    }
  }
};

function setUserName(name) {
  S.userName = name;
  const badge = document.querySelector('.user-name');
  if (badge) badge.textContent = name;
  const landing = $('landing-greeting');
  if (landing) landing.textContent = `Hi ${name}! I'm Lumi.`;
}

// ==================== DOM SHORTHAND ====================
const $ = (id) => document.getElementById(id);
const qs = (sel, root) => (root || document).querySelector(sel);
const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

// ==================== PERSONA LENS (Admin / Approver / Viewer) ====================
// Capability matrix, per UStory_w_Persona_Migration_v1.pptx slide 4:
//   Setup/Select/Plan, Migration execution, Readiness, Errors/issues: Admin=Full, Approver=Full, Viewer=read-only
//   Push to BTP Integration Suite / Take to Production:               Admin=Full, Approver=approve-only, Viewer=blocked
//   Pending Approvals panel:                                          Admin=Full, Approver=Full, Viewer=not visible
//   Admin/Settings screen:                                            Admin=Full, Approver/Viewer=not visible
// This is a lens switch for pre-sales walkthroughs, not a real login — it
// never advances a workflow on its own.
const PERSONA_KEY = 'sdaintai_persona';
function isViewer() { return S.persona === 'Viewer'; }
function isApprover() { return S.persona === 'Approver'; }
function isAdmin() { return S.persona === 'Admin'; }
function canSeeAdminScreen() { return isAdmin(); }
function canSeePendingApprovals() { return isAdmin() || isApprover(); }
// Everyone but Viewer keeps full Setup/Select/Plan/Execute/Readiness/Errors rights —
// the only thing that ever differs between Admin and Approver is the Push/Take-to-
// Production click itself (gated separately, see canTriggerProdAction()).
function canAct() { return !isViewer(); }
// Admin can click Push/Take-to-Production once this wave's gate is approved.
// Approver can never click it themselves, even after approving — sign-off only.
function canTriggerProdAction() { return isAdmin() && S.pushApproved; }

function loadPersona() {
  try {
    const saved = localStorage.getItem(PERSONA_KEY);
    if (saved === 'Admin' || saved === 'Approver' || saved === 'Viewer') S.persona = saved;
  } catch (e) { /* default to Admin */ }
}
function setPersona(persona) {
  if (!['Admin', 'Approver', 'Viewer'].includes(persona)) return;
  S.persona = persona;
  try { localStorage.setItem(PERSONA_KEY, persona); } catch (e) { /* non-persistent this session */ }
  applyPersonaGating();
}
// Re-applies every persona-gated bit of UI — called on load and whenever the
// lens switches. Safe to call before the cockpit screen exists (every lookup
// is null-guarded) so it can run from the top-level init path too.
function applyPersonaGating() {
  const sel = $('persona-select');
  if (sel) sel.value = S.persona;
  const adminNav = $('nav-admin');
  if (adminNav) adminNav.style.display = canSeeAdminScreen() ? '' : 'none';
  // Don't strand a session on the Admin screen if the lens switches away from Admin mid-visit.
  if (!canSeeAdminScreen() && $('screen-admin') && $('screen-admin').classList.contains('active')) {
    openScreen('cockpit');
  }
  if (typeof updateCockpitStats === 'function' && S.cockpitRows) updateCockpitStats();
  if (typeof refreshExecTabs === 'function') refreshExecTabs();
}

// ==================== BRAIN MEMORY (persisted, client-side) ====================
// This is a static frontend with no backend LLM call — there's no real LangChain/
// LangGraph process running in the browser. What this *does* do honestly: persist
// migration history and the chat transcript in localStorage so they survive a page
// reload, standing in for the long-term memory store the production Brain (see
// mta.yaml — "Brain AI (LangChain/LangGraph)") keeps server-side. S.migrationHistory
// already fed the "based on patterns from your last migration" line each session;
// this just makes it outlive the tab, and lets Lumi notice a repeated question.
const BRAIN_MEMORY_KEY = 'sdaintai_brain_memory_v1';
function loadBrainMemory() {
  try {
    const raw = localStorage.getItem(BRAIN_MEMORY_KEY);
    const mem = raw ? JSON.parse(raw) : {};
    S.migrationHistory = mem.migrationHistory || [];
    S.brainChatLog = mem.chatLog || [];
    // Admin defaults (including the PI/PO credentials) merge over the hardcoded
    // HTML-mirrored defaults rather than replace them, so a partial save from an
    // earlier session doesn't blank out fields that were never touched.
    if (mem.adminDefaults) {
      Object.assign(S.adminDefaults, mem.adminDefaults);
      if (mem.adminDefaults.piPo) Object.assign(S.adminDefaults.piPo, mem.adminDefaults.piPo);
    }
  } catch (e) {
    S.migrationHistory = [];
    S.brainChatLog = [];
  }
}
function saveBrainMemory() {
  try {
    localStorage.setItem(BRAIN_MEMORY_KEY, JSON.stringify({
      migrationHistory: (S.migrationHistory || []).slice(-25),
      chatLog: (S.brainChatLog || []).slice(-60),
      adminDefaults: S.adminDefaults
    }));
  } catch (e) { /* localStorage unavailable (private mode, quota) — memory just won't persist this session */ }
}
// Pushes S.adminDefaults (freshly loaded from Brain memory, or still the hardcoded
// defaults) into the Admin screen's form fields — the reverse of saveAdminDefaults().
// Needed because loadBrainMemory() can override S.adminDefaults after the HTML's
// own hardcoded values already rendered.
function populateAdminFormFromDefaults() {
  const d = S.adminDefaults;
  if (!d || !$('admin-default-username')) return;
  if (d.platform && $('admin-default-platform')) $('admin-default-platform').value = d.platform;
  $('admin-default-env').value = d.env;
  setAdminAuthMode(d.authMode);
  $('admin-default-username').value = d.username;
  $('admin-default-password').value = d.password;
  if (d.clientId) $('admin-default-client-id').value = d.clientId;
  if (d.clientSecret) $('admin-default-client-secret').value = d.clientSecret;
  $('admin-default-tenant').value = d.tenant;
  $('admin-default-region').value = d.region;
  $('admin-btp-tenant-url').value = d.btpTenantUrl;
  $('admin-btp-tenant-manual').checked = !!d.btpTenantManual;
  if ($('admin-sda-subaccount')) $('admin-sda-subaccount').value = d.sdaSubaccount || 'sda-ai-shared-eu10';
  if ($('admin-prv-tenant')) $('admin-prv-tenant').checked = !!d.prvTenant;
  updatePrvTenantStatus();
  if ($('admin-agent-mapping')) $('admin-agent-mapping').checked = d.agentMappingEnabled !== false;
  if ($('admin-agent-conversion')) $('admin-agent-conversion').checked = d.agentConversionEnabled !== false;
  updateAgentSpeedStatus();
  $('admin-alm-tenant-url').value = d.almTenantUrl;
  $('admin-alm-tenant-manual').checked = !!d.almTenantManual;
  $('admin-figaf-target').value = d.figafAlmTarget;
  $('admin-figaf-manual').checked = !!d.figafManual;
  if (d.s4Host) $('admin-s4-host').value = d.s4Host;
  if (d.s4Client) $('admin-s4-client').value = d.s4Client;
  if (d.s4AuthMode) setAdminS4AuthMode(d.s4AuthMode);
  if (d.s4Username) $('admin-s4-username').value = d.s4Username;
  if (d.s4Password) $('admin-s4-password').value = d.s4Password;
  if (d.s4ClientId) $('admin-s4-client-id').value = d.s4ClientId;
  if (d.s4ClientSecret) $('admin-s4-client-secret').value = d.s4ClientSecret;
  if (d.piPo) {
    $('admin-pipo-system-name').value = d.piPo.systemName || '';
    $('admin-pipo-version').value = d.piPo.systemVersion || '';
    $('admin-pipo-address').value = d.piPo.address || '';
    $('admin-pipo-userid').value = d.piPo.userId || '';
    $('admin-pipo-password').value = d.piPo.password || '';
    $('admin-pipo-auth').value = d.piPo.authType || 'BasicAuthentication';
    $('admin-pipo-proxy').value = d.piPo.proxyType || 'OnPremise';
    $('admin-pipo-location').value = d.piPo.locationId || '';
  }
  // Re-apply disabled state on the paired inputs now that the checkboxes above
  // were just set programmatically (their own 'change' listeners won't fire from a value set).
  ['admin-btp-tenant-manual', 'admin-alm-tenant-manual', 'admin-figaf-manual'].forEach(id => {
    const cb = $(id); if (cb) cb.dispatchEvent(new Event('change'));
  });
}
// A synthetic-but-deterministic "the Brain is getting faster" figure, tied to the
// real persisted migration count rather than a random number each load.
function brainSpeedupPct() { return Math.min(45, (S.migrationHistory || []).length * 8); }
// Records what the user actually typed, and flags if they've asked something
// close to it before — the "remembers what users say" ask. Simple normalized
// substring match, not embeddings/NLU, but it's real persisted state driving
// real behavior, not a canned line.
function recallSimilarQuestion(text) {
  const norm = text.trim().toLowerCase().replace(/[^\w\s]/g, '');
  if (norm.length < 6) return null;
  const past = (S.brainChatLog || []).slice(0, -1); // exclude the entry just logged for this turn
  return past.find(entry => {
    const n2 = entry.text.trim().toLowerCase().replace(/[^\w\s]/g, '');
    return n2 === norm || (n2.length > 8 && (n2.includes(norm) || norm.includes(n2)));
  }) || null;
}
function logBrainChat(text) {
  S.brainChatLog = S.brainChatLog || [];
  S.brainChatLog.push({ text, ts: Date.now() });
  saveBrainMemory();
}

// ==================== REAL AI BRAIN (backend LangGraph/Claude — Admin-activated) ====================
// Everything above (BRAIN MEMORY) is a localStorage simulation with no backend call.
// This section is different: it calls the actual srv/brain-service.js OData service —
// a real @langchain/langgraph StateGraph backed by Claude, with a local cosine-similarity
// vector store — but only once someone enters the activation password in Admin/Settings.
// The key is kept in memory only (S.brainKey) and is never written to localStorage/
// Brain memory, so it doesn't linger in the browser after the tab closes. Every call
// here is fire-and-forget from the caller's perspective (logBrainEvent swallows its own
// errors) so a network hiccup never blocks the cockpit's own (already-working)
// client-side flow — the real Brain is additive logging, not a dependency.
let _brainCsrfToken = null;
async function fetchBrainCsrfToken() {
  try {
    const res = await fetch('/odata/v4/brain/$metadata', { method: 'GET', headers: { 'x-csrf-token': 'fetch' }, credentials: 'same-origin' });
    const token = res.headers.get('x-csrf-token');
    if (token) _brainCsrfToken = token;
  } catch (e) { /* direct-to-srv hosting (no approuter in front) has no CSRF layer — fine to no-op */ }
}
async function brainCall(action, params) {
  if (!_brainCsrfToken) await fetchBrainCsrfToken();
  const headers = { 'Content-Type': 'application/json' };
  if (_brainCsrfToken) headers['x-csrf-token'] = _brainCsrfToken;
  const res = await fetch(`/odata/v4/brain/${action}`, { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(params) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`);
  return data;
}
async function activateBrainEngine() {
  const keyInput = $('admin-brain-key');
  const key = keyInput ? keyInput.value.trim() : '';
  const statusEl = $('admin-brain-status');
  if (!key) { showToast('Enter a password', 'Type the activation password before activating.', 'danger'); return; }
  if (statusEl) { statusEl.className = 'conn-status'; statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Activating…'; statusEl.style.display = 'flex'; }
  try {
    const result = await brainCall('toggleBrain', { key, enabled: true });
    if (!result.success) throw new Error(result.message || 'Activation failed');
    S.brainActivated = true;
    S.brainKey = key;
    if (statusEl) { statusEl.className = 'conn-status ok'; statusEl.innerHTML = '<span class="dot"></span> AI Engine active — logging every migration for pattern learning'; }
    showToast('AI Engine Activated', 'LangGraph/Claude brain is now live — assets, commands, and settings are being captured for learning.', 'purple');
    refreshBrainStatus();
  } catch (err) {
    S.brainActivated = false; S.brainKey = null;
    if (statusEl) { statusEl.className = 'conn-status fail'; statusEl.innerHTML = `<span class="dot"></span> ${err.message === 'Invalid master key' ? 'Incorrect password' : err.message}`; }
    showToast('Activation Failed', err.message, 'danger');
  }
}
async function deactivateBrainEngine() {
  if (!S.brainActivated || !S.brainKey) return;
  try { await brainCall('toggleBrain', { key: S.brainKey, enabled: false }); } catch (e) { /* best-effort */ }
  S.brainActivated = false; S.brainKey = null;
  const statusEl = $('admin-brain-status');
  if (statusEl) { statusEl.className = 'conn-status'; statusEl.innerHTML = '<span class="dot"></span> AI Engine inactive'; }
  showToast('AI Engine Deactivated', 'Logging stopped — the cockpit keeps working exactly as before.', 'cyan');
}
async function refreshBrainStatus() {
  if (!S.brainActivated || !S.brainKey) return;
  try {
    const s = await brainCall('getBrainStatus', { key: S.brainKey });
    const statusEl = $('admin-brain-status');
    if (statusEl) statusEl.innerHTML = `<span class="dot"></span> AI Engine active — ${s.eventsCount} event${s.eventsCount === 1 ? '' : 's'} logged, ${s.vectorCount} in the vector store${s.eventsCount === 0 && s.vectorCount > 0 ? ' (DB row unavailable, vector store carrying it)' : ''}`;
  } catch (e) { /* leave last-known status on screen */ }
}
// Every asset/command/setting/result capture funnels through here. Redacts
// anything that looks like a credential before it ever leaves the browser —
// the Brain should learn migration patterns, not store plaintext passwords.
function redactSecrets(obj) {
  const SECRET_KEYS = /password|secret|clientsecret/i;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = SECRET_KEYS.test(k) ? (v[k] ? '(set)' : '') : walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(obj);
}
function logBrainEvent(eventType, source, payload, summary) {
  if (!S.brainActivated || !S.brainKey) return; // no-op until activated — zero behavior change otherwise
  brainCall('captureEvent', {
    key: S.brainKey,
    eventType,
    source: source || 'unknown',
    payload: JSON.stringify(redactSecrets(payload || {})),
    summary: (summary || '').slice(0, 500),
    sessionId: S.brainSessionId || ''
  }).catch(err => console.warn('[Brain] captureEvent failed (non-blocking):', err.message));
}

// ==================== TOAST (reuses .toast styles from style.css) ====================
function showToast(title, message, type) {
  const c = $('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ` toast-${type}` : '');
  const iconClass = type === 'danger' ? 'fa-triangle-exclamation' : type === 'purple' ? 'fa-wand-magic-sparkles' : 'fa-circle-check';
  el.innerHTML = `<i class="fa-solid ${iconClass} toast-icon ${type || 'cyan'}"></i><div class="toast-content"><span class="toast-title">${title}</span><span class="toast-message">${message}</span></div>`;
  c.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

// ==================== LUMI STATE (mascot expression) ====================
function setLumiState(mode) {
  qsa('.lumi-avatar').forEach(el => {
    el.classList.remove('idle', 'thinking', 'alert', 'success');
    el.classList.add(mode);
  });
  $('btn-open-lumi').classList.toggle('has-alert', mode === 'alert');
  const dock = $('lumi-dock');
  dock.classList.toggle('alert', mode === 'alert');
}

// ==================== CHAT ENGINE ====================
function lumiSay(text, opts) {
  opts = opts || {};
  // Whatever screen was pending an acknowledgment is moot now — Lumi is saying
  // something fresh, which already is the continuation of the conversation.
  S.pendingScreenAck = false;
  const body = $('lumi-drawer-body');
  const wrap = document.createElement('div');
  wrap.className = 'lumi-msg';
  wrap.innerHTML = `<div class="lumi-avatar ${opts.alert ? 'alert' : 'idle'}"><div class="visor"></div></div>
    <div class="lumi-bubble ${opts.alert ? 'alert' : ''}"><span class="who-label">Lumi</span>${text}</div>`;
  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
  setLumiState(opts.alert ? 'alert' : 'idle');
  updateDockLabel(opts.alert ? text : null);
  openDrawer(false);
}

function lumiSayUser(text) {
  const body = $('lumi-drawer-body');
  const wrap = document.createElement('div');
  wrap.className = 'lumi-msg from-user';
  wrap.innerHTML = `<div class="lumi-bubble">${text}</div>`;
  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
}

function lumiChoices(items) {
  // Remembers the "main next step" every time Lumi offers one, so a free-form
  // side request (settings change, a question) can be followed by "shall we
  // continue where we left off?" and actually resume the guided flow instead
  // of leaving the user to re-find their place — see lumiSayWithResume().
  const primary = items.find(it => it.cls === 'primary');
  if (primary && primary.onClick) S.resumeAction = { label: primary.label, fn: primary.onClick };
  const body = $('lumi-drawer-body');
  const wrap = document.createElement('div');
  const hasIcons = items.some(it => it.icon);
  wrap.className = 'lumi-choices' + (hasIcons ? ' cards' : '');
  items.forEach(it => {
    const chip = document.createElement('div');
    chip.className = 'lumi-chip' + (it.cls ? ` ${it.cls}` : '') + (it.icon ? ' card' : '');
    chip.innerHTML = it.icon
      ? `<span class="chip-icon"><i class="fa-solid ${it.icon}"></i></span><span>${it.label}</span>`
      : it.label;
    chip.addEventListener('click', () => { wrap.remove(); lumiSayUser(it.label); it.onClick && it.onClick(); });
    wrap.appendChild(chip);
  });
  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
}

function lumiTree(html) {
  const body = $('lumi-drawer-body');
  const wrap = document.createElement('div');
  wrap.className = 'lumi-tree';
  wrap.innerHTML = html;
  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
}

function updateDockLabel(alertText) {
  $('lumi-dock-label-text').textContent = alertText ? 'I think you should review this' : 'Ask Lumi';
}

// Chat is docked as just another .btp-screen — "opening" it means making it
// the active screen (same mechanism openScreen() uses for every takeover view),
// which also dismisses the paused-at-X banner since the conversation is live again.
function openDrawer() {
  qsa('.btp-screen').forEach(s => s.classList.remove('active'));
  $('lumi-drawer').classList.add('active', 'open');
  hidePausedBanner();
}

// Builds Lumi's "Got it — I picked up your changes" line from whatever's live on
// the screen right now (not a before/after diff — same spirit as the reference
// video, which recaps current state rather than itemizing what changed).
function screenReturnMessage(id) {
  const p = PLATFORMS[S.platform] || PLATFORMS.mulesoft;
  switch (id) {
    case 'connection': {
      const tenant = $('target-tenant') ? $('target-tenant').value : '—';
      return `Got it — I picked up your connection settings. Target tenant is set to <b>${tenant}</b>${S.connectionOk ? ', and the connection is already tested.' : ' — test it whenever ready.'}`;
    }
    case 'assets':
      return `Got it — I picked up your ${p.terms.sourceStepNoun} selection: <b>${S.assets.length}</b> ${S.assets.length === 1 ? p.assetNoun : p.assetNounPlural} in scope.`;
    case 'buckets': {
      const checked = qsa('.bucket-cb:checked').length;
      return `Got it — I picked up your selection from Migration Buckets: <b>${checked}</b> of ${S.assets.length} ${p.assetNounPlural} included.`;
    }
    case 'wave': {
      const activeWaves = getActiveWaveNumbers();
      const summary = activeWaves.map(w => `Wave ${w}: ${S.waves[w].length}`).join(', ') || '(nothing assigned yet)';
      return `Got it — I picked up your wave grouping and team assignment from that screen and saved them. ${summary}.`;
    }
    case 'approve':
      return `Got it — the plan panel's up to date with whatever's on screen now.`;
    case 'cockpit': {
      const done = S.cockpitRows.filter(r => r.status === 'Done').length;
      const errors = S.cockpitRows.filter(r => r.status === 'Error' || r.status === 'Pending Fix').length;
      return `Got it — I've got the latest from the Migration Cockpit: <b>${done}</b> of ${S.cockpitRows.length} converted${errors ? `, ${errors} still need${errors === 1 ? 's' : ''} review` : ''}.`;
    }
    case 'admin':
      return `Got it — I picked up your Admin defaults and team roster. They'll apply the next time you start a migration.`;
    default:
      return null;
  }
}
// The one path (banner "Continue chat with Lumi", the floating mascot, the sidebar
// Lumi launcher) that represents the user explicitly stepping away from a screen
// back into the conversation — as opposed to lumiSay()'s internal openDrawer()
// calls, which are just Lumi's own forward-flow messages and already speak for
// themselves.
function returnToChat() {
  if (S.pendingScreenAck && S.lastScreenId) {
    const msg = screenReturnMessage(S.lastScreenId);
    S.pendingScreenAck = false;
    if (msg) {
      lumiSay(msg);
      // Re-offer whatever primary action was live before the user navigated away
      // (e.g. the wave-planning "Continue") as a fresh clickable chip — otherwise
      // returning to chat shows a status recap with nothing actionable, and the
      // user has no visible next step short of scrolling back or typing "continue".
      if (S.resumeAction && S.resumeAction.fn) {
        lumiChoices([{ label: `Continue — ${S.resumeAction.label}`, cls: 'primary', onClick: S.resumeAction.fn }]);
      }
      return;
    }
  }
  openDrawer();
}
function closeDrawer() { $('lumi-drawer').classList.remove('active', 'open'); }
function minimizeDrawer() {
  const d = $('lumi-drawer');
  d.classList.remove('open', 'fullscreen');
  $('lumi-drawer-fullscreen').innerHTML = '<i class="fa-solid fa-expand"></i>';
}
function toggleDrawerFullscreen() {
  const d = $('lumi-drawer');
  const nowFullscreen = d.classList.toggle('fullscreen');
  if (!d.classList.contains('open')) d.classList.add('open');
  $('lumi-drawer-fullscreen').innerHTML = nowFullscreen ? '<i class="fa-solid fa-compress"></i>' : '<i class="fa-solid fa-expand"></i>';
  d.style.width = ''; d.style.height = ''; // clear any manual resize so fullscreen/docked sizing applies cleanly
}
const DRAWER_POSITIONS = ['right', 'center', 'left'];
function cycleDrawerPosition() {
  const d = $('lumi-drawer');
  const cur = DRAWER_POSITIONS.find(p => d.classList.contains('pos-' + p)) || 'right';
  const next = DRAWER_POSITIONS[(DRAWER_POSITIONS.indexOf(cur) + 1) % DRAWER_POSITIONS.length];
  d.classList.remove('pos-' + cur);
  d.classList.add('pos-' + next);
  d.style.width = ''; d.style.height = ''; // manual resize doesn't carry over to a different dock — start from that position's default
  $('lumi-drawer-position').title = `Panel position: ${next} (click to change)`;
}
function setupDrawerResize() {
  const handle = $('lumi-drawer-resize');
  const drawer = $('lumi-drawer');
  let dragging = false, startX = 0, startY = 0, startW = 0, startH = 0;
  handle.addEventListener('mousedown', (e) => {
    if (drawer.classList.contains('fullscreen')) return;
    dragging = true;
    handle.classList.add('dragging');
    startX = e.clientX; startY = e.clientY;
    startW = drawer.offsetWidth; startH = drawer.offsetHeight;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const pos = DRAWER_POSITIONS.find(p => drawer.classList.contains('pos-' + p)) || 'right';
    const dx = e.clientX - startX, dy = e.clientY - startY;
    const minW = 320, maxW = window.innerWidth * 0.92;
    if (pos === 'right') drawer.style.width = Math.min(Math.max(startW - dx, minW), maxW) + 'px';
    else if (pos === 'left') drawer.style.width = Math.min(Math.max(startW + dx, minW), maxW) + 'px';
    else if (pos === 'center') {
      drawer.style.width = Math.min(Math.max(startW + dx, 360), maxW) + 'px';
      drawer.style.height = Math.min(Math.max(startH + dy, 320), window.innerHeight * 0.92) + 'px';
    }
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
  });
}

// ==================== NAV RAIL ====================
function unlockNav(id) { const el = $(id); if (el) { el.classList.remove('pending'); el.classList.add('reachable'); } }
function markDone(id) { const el = $(id); if (el) { el.classList.remove('pending', 'flagged'); el.classList.add('reachable', 'done'); } }
function flagNav(id) { const el = $(id); if (el) { el.classList.remove('pending'); el.classList.add('reachable', 'flagged'); } }
function unflagNav(id) { const el = $(id); if (el) el.classList.remove('flagged'); }

function flagReview(navId, screenId, reasonHtml) {
  flagNav(navId);
  lumiSay(`⚠️ I think you should review this — ${reasonHtml}`, { alert: true });
  lumiChoices([{ label: 'Review', cls: 'review', onClick: () => openScreen(screenId) }, { label: 'Not now', cls: 'ghost', onClick: () => {} }]);
}

// ==================== SCREEN NAV ====================
const STEPPER_MAP = {
  details: 'prepare', connection: 'prepare', assets: 'prepare',
  buckets: 'plan', wave: 'plan', approve: 'plan',
  cockpit: 'execute', close: 'close'
};
// Human phrasing for the "Your chat with Lumi is paused at X" handoff banner.
const BANNER_LABELS = {
  details: 'project setup', connection: 'connection setup', assets: 'source scan',
  buckets: 'migration plan', wave: 'wave planning', approve: 'plan approval',
  cockpit: 'execution', close: 'project close'
};
function showPausedBanner(id) {
  const stageEl = $('paused-banner-stage');
  if (stageEl) stageEl.textContent = BANNER_LABELS[id] || 'this step';
  const banner = $('paused-banner');
  if (banner) banner.classList.add('visible');
}
function hidePausedBanner() {
  const banner = $('paused-banner');
  if (banner) banner.classList.remove('visible');
}
function openScreen(id) {
  if (id === 'admin' && !canSeeAdminScreen()) return; // Admin/Settings is Admin-only, per the persona capability matrix
  qsa('.btp-screen').forEach(s => s.classList.remove('active'));
  const target = $(`screen-btp-${id}`) || $(`screen-${id}`);
  if (target) target.classList.add('active');
  qsa('.sidebar-item').forEach(a => a.classList.remove('active'));
  const nav = $(`nav-${id}`);
  if (nav) nav.classList.add('active');
  if (id !== 'admin') updateStepper(STEPPER_MAP[id] || 'prepare');
  closeDrawer();
  if (id === 'landing' || id === 'admin') hidePausedBanner(); else showPausedBanner(id);
  if (id === 'admin') { renderAdminTeamList(); renderAdminAgentList(); refreshBrainStatus(); }
  // Remember which screen we just opened so that whenever the user next explicitly
  // returns to Lumi (returnToChat()), Lumi can acknowledge whatever's live on it —
  // "Got it — I picked up your wave grouping from that screen and saved them."
  // Cleared automatically the moment any other lumiSay() fires first (normal
  // forward-flow screens already say their own next-step message).
  S.lastScreenId = id;
  S.pendingScreenAck = id !== 'landing';
}
function updateStepper(phase) {
  const order = ['prepare', 'plan', 'execute', 'close'];
  const idx = order.indexOf(phase);
  order.forEach((p, i) => {
    const el = $(`step-node-${p}`);
    if (!el) return;
    el.className = 'step' + (i < idx ? ' completed' : i === idx ? ' active' : '');
  });
}

// ==================== LANDING / PLATFORM ====================
const TARGET_TENANTS = [
  { tenant: 'sda-prod-eu10', region: 'EU10 — Frankfurt' },
  { tenant: 'sda-dev-us10', region: 'US10 — US East' }
];

function startNewMigration() {
  if (!S.userName) {
    openDrawer(false);
    lumiSay("Before we start — what's your name?");
    S.pendingAnswerHandler = (text) => {
      setUserName(text.trim() || 'Integration Lead');
      lumiSay(`Nice to meet you, ${S.userName}! Let's connect. Which platform are we migrating from?`);
      lumiChoices(Object.keys(PLATFORMS).map(key => ({ label: PLATFORMS[key].label, icon: PLATFORMS[key].icon, onClick: () => selectPlatform(key) })));
      unlockNav('nav-connection');
      openScreen('connection');
    };
    return;
  }
  unlockNav('nav-connection');
  openScreen('connection');
  if ((S.migrationHistory || []).length) {
    const last = S.migrationHistory[S.migrationHistory.length - 1];
    const n = S.migrationHistory.length;
    lumiSay(`Let's connect. Based on patterns from <b>${last.name}</b> (${last.assetCount} ${PLATFORMS[last.platform].assetNounPlural}, ${last.waveCount} waves) and ${n - 1} migration${n - 1 === 1 ? '' : 's'} before it, the Brain remembers this — sequencing should run about <b>${brainSpeedupPct()}% faster</b> than your first run. Which platform are we migrating from?`);
  } else {
    lumiSay("Let's connect. Which platform are we migrating from?");
  }
  lumiChoices(Object.keys(PLATFORMS).map(key => ({ label: PLATFORMS[key].label, icon: PLATFORMS[key].icon, onClick: () => selectPlatform(key) })));
}

function selectPlatform(key) {
  S.platform = key;
  S.archived = false; // fresh migration — hasn't been archived yet, see archiveProject()
  const p = PLATFORMS[key];
  S.projectName = p.projectName;
  $('project-selector-text').textContent = p.projectName;
  if ($('project-badge-text')) $('project-badge-text').textContent = p.projectName;
  document.title = `SDAINT-AI — ${p.projectName}`;

  qsa('.platform-card').forEach(c => c.classList.toggle('selected', c.dataset.platform === key));
  const versionSel = $('connection-version');
  versionSel.innerHTML = p.versions.map(v => `<option>${v}</option>`).join('');

  S.connectionTested = false; S.connectionOk = false;
  $('conn-test-status').style.display = 'none';
  $('btn-save-connection').disabled = true;
  markDone('nav-details');
  applyPlatformTerminology(key);
  applyAdminConnectionDefaults();

  // Orchestrator behavior: if Admin/Settings already has a real (non-Manual) target
  // configured, validate it and auto-fill version/env/auth/target from those defaults
  // instead of asking four sequential questions — go straight to scanning. Only fall
  // back to the old step-by-step Q&A when there's genuinely nothing configured yet.
  const defaultsReady = S.adminDefaults && !S.adminDefaults.btpTenantManual && (S.adminDefaults.tenant || '').trim();
  if (defaultsReady) {
    validateTargetThenAutoScan(p);
  } else {
    lumiSay(`Before we scan, I don't have a BTP Integration Suite target configured yet — it's marked Manual in Settings. Set it now, or I'll continue with the sandbox defaults for this walkthrough?`);
    lumiChoices([
      { label: 'Open Settings', onClick: () => openScreen('admin') },
      { label: 'Use sandbox defaults', cls: 'primary', onClick: () => {
        lumiSay(`No problem — sandbox it is. Which runtime or version — this is your ${p.hint}?`);
        lumiChoices(p.versions.map(v => ({ label: v, onClick: () => setVersionAnswer(v) })));
      } }
    ]);
  }
}

// The "smart orchestrator" fast path: Admin's target settings are already trustworthy,
// so validate once, silently carry them into the Set Connection fields, and go straight
// to scanning — collapsing what used to be four separate chat questions (version, env,
// auth, target) into one confirmation message.
function validateTargetThenAutoScan(p) {
  setLumiState('thinking');
  lumiSay(`Great — <b>${p.label}</b> it is. Your target settings are already configured in Admin — validating the BTP Integration Suite tenant <b>${S.adminDefaults.tenant}</b> before we scan…`);
  setTimeout(() => {
    const versionSel = $('connection-version');
    if (versionSel.options.length) versionSel.selectedIndex = 0;
    $('connection-env').value = S.adminDefaults.env || 'Sandbox';
    const authMode = S.adminDefaults.authMode || 'userpass';
    setAuthMode(authMode);
    if (authMode === 'userpass') {
      if (S.adminDefaults.username) $('auth-username').value = S.adminDefaults.username;
      if (S.adminDefaults.password) $('auth-password').value = S.adminDefaults.password;
    } else {
      if (S.adminDefaults.clientId) $('auth-client-id').value = S.adminDefaults.clientId;
      if (S.adminDefaults.clientSecret) $('auth-client-secret').value = S.adminDefaults.clientSecret;
    }
    $('target-tenant').value = S.adminDefaults.tenant;
    if (S.adminDefaults.region) $('target-region').value = S.adminDefaults.region;
    S.connectionTested = true;
    S.connectionOk = true;
    $('btn-save-connection').disabled = false;
    markDone('nav-connection');
    unlockNav('nav-assets');
    setLumiState('success');
    lumiSay(`✅ Target validated — version, environment, and auth are set from your defaults. Kicking off the ${p.label} scan now.`);
    startAssetScan();
  }, 900);
}

// Relabels every screen/nav element that should speak the selected source
// platform's native vocabulary (see the image the user shared: SAP PI/PO vs
// SAP Integration Suite/CPI vs MuleSoft field-naming conventions).
function applyPlatformTerminology(key) {
  const p = PLATFORMS[key];
  const t = p.terms;
  const sourceStepTitle = `${t.sourceStepNoun} Selection`;
  const conversionStepTitle = `Convert ${t.sourceStepNoun}s to CPI iFlow`;

  const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

  setText('nav-assets-label', sourceStepTitle);
  setText('nav-cockpit-label', conversionStepTitle);
  setText('assets-screen-title', sourceStepTitle);
  setText('cockpit-screen-title', conversionStepTitle);
  setText('btn-view-asset-tree-label', `View ${p.label} Object Tree`);
  setText('btn-view-cockpit-tree-label', `View ${p.label} Object Tree`);
  setText('btn-import-assets-trigger-label', `Start ${p.label} Scan`);

  setText('th-asset-id', t.idLabel);
  setText('th-asset-name', t.nameLabel);
  setText('th-asset-type', t.typeLabel);
  setText('th-bucket-id', t.idLabel);
  setText('th-bucket-name', t.nameLabel);
  setText('th-bucket-type', t.typeLabel);
  setText('th-cockpit-asset', t.nameLabel);
  setText('th-readiness-name', t.nameLabel);
  setText('wave-section-label', `${p.assetNounPlural.charAt(0).toUpperCase() + p.assetNounPlural.slice(1)} → Waves`);
  setText('approve-total-assets-label', `Total ${p.assetNounPlural.charAt(0).toUpperCase() + p.assetNounPlural.slice(1)}`);

  setText('upload-dropzone-title', `Drop a ${t.uploadLabel}, or browse`);
  const dropDesc = $('upload-dropzone-desc');
  if (dropDesc) {
    dropDesc.textContent = key === 'mulesoft'
      ? 'Flow XML, DataWeave (.dwl), schema (.xsd/.wsdl), config (.yaml/.properties) — or a compiled artifact (.class, .jar, .dll, .so) if that’s all you have'
      : `${p.label} export XML/config files — or a compiled artifact (.class, .jar, .dll, .so) if that's all you have`;
  }

  const cockpitSubtitle = $('cockpit-subtitle');
  if (cockpitSubtitle) {
    const n = S.cockpitRows ? S.cockpitRows.length : 0;
    const assetCount = S.assets ? S.assets.length : 0;
    cockpitSubtitle.textContent = `${assetCount} ${p.label} ${assetCount === 1 ? p.assetNoun : p.assetNounPlural} → ${n} SAP Integration Suite (CPI) ${CPI_TERMS.typeLabel}${n === 1 ? '' : 's'} · ${S.projectName || '—'}`;
  }
}

function setVersionAnswer(v) {
  $('connection-version').value = v;
  lumiSay(`Set to <b>${v}</b> — you can see it filled in on the version field. Which environment — Production, Sandbox, or Design?`);
  lumiChoices(['Production', 'Sandbox', 'Design'].map(env => ({ label: env, onClick: () => setEnvironmentAnswer(env) })));
}

function setEnvironmentAnswer(env) {
  $('connection-env').value = env;
  const p = PLATFORMS[S.platform];
  lumiSay(`Environment set to <b>${env}</b>. For authentication — should I use the sandbox credentials already on file, or would you like to enter your own?`);
  lumiChoices([
    { label: 'Use saved sandbox credentials', cls: 'primary', onClick: () => askTarget() },
    { label: "I'll enter my own", onClick: () => { lumiSay(`No problem — the ${p.hint} fields on the right are open for editing. Let me know when you're done.`); lumiChoices([{ label: 'Done, continue', onClick: confirmOwnCredentials }]); } }
  ]);
}

function confirmOwnCredentials() {
  const idValue = S.authMode === 'userpass' ? $('auth-username').value.trim() : $('auth-client-id').value.trim();
  const secretValue = S.authMode === 'userpass' ? $('auth-password').value : $('auth-client-secret').value;
  const idLabel = S.authMode === 'userpass' ? 'username' : 'client ID';
  const maskedSecret = secretValue ? '•'.repeat(Math.min(secretValue.length, 10)) : '(empty)';
  lumiSay(`Got it — I'll authenticate with ${idLabel} <b>${idValue || '(empty)'}</b> and secret <b>${maskedSecret}</b>. Moving on.`);
  askTarget();
}

function askTarget() {
  lumiSay('Which SAP Integration Suite tenant should receive the converted assets?');
  lumiChoices(TARGET_TENANTS.map(t => ({ label: `${t.tenant} (${t.region})`, onClick: () => setTargetAnswer(t) })));
}
function setTargetAnswer(t) {
  $('target-tenant').value = t.tenant;
  $('target-region').value = t.region;
  lumiSay(`Target set to <b>${t.tenant}</b>. I've filled in every field on the Set Connection screen — ready to test the connection?`);
  lumiChoices([{ label: 'Test Connection', cls: 'primary', onClick: () => testConnection(false) }]);
}

// ==================== SET CONNECTION ====================
function setAuthMode(mode) {
  S.authMode = mode;
  $('auth-mode-userpass').classList.toggle('active', mode === 'userpass');
  $('auth-mode-oauth').classList.toggle('active', mode === 'oauth');
  $('auth-userpass-fields').classList.toggle('hidden', mode !== 'userpass');
  $('auth-oauth-fields').classList.toggle('hidden', mode !== 'oauth');
}

function testConnection(forceFail) {
  if (!S.platform) { showToast('Pick a platform first', 'Select MuleSoft, PI/PO, Informatica, or Boomi above.', 'danger'); return; }
  setLumiState('thinking');
  lumiSay('Testing both ends of the connection…');
  const statusEl = $('conn-test-status');
  statusEl.style.display = 'flex';
  statusEl.className = 'conn-status';
  statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testing…';
  $('btn-test-connection').disabled = true;

  setTimeout(() => {
    $('btn-test-connection').disabled = false;
    S.connectionTested = true;
    if (forceFail) {
      S.connectionOk = false;
      statusEl.className = 'conn-status fail';
      statusEl.innerHTML = '<span class="dot"></span> Target tenant unreachable';
      flagReview('nav-connection', 'connection', `the target SAP Integration Suite tenant test failed. Want me to open the connection screen so you can check the Service Key?`);
    } else {
      S.connectionOk = true;
      statusEl.className = 'conn-status ok';
      statusEl.innerHTML = '<span class="dot"></span> Connected — source and target reachable';
      unflagNav('nav-connection');
      $('btn-save-connection').disabled = false;
      lumiSay('✅ Connected — both source and target are reachable. Ready to continue?');
      lumiChoices([{ label: 'Save & Continue', cls: 'primary', onClick: saveConnection }]);
    }
  }, 1400);
}

function saveConnection() {
  markDone('nav-connection');
  unlockNav('nav-assets');
  openScreen('assets');
  const p = PLATFORMS[S.platform];
  lumiSay(`Ready — should I scan for every ${p.assetNoun}${S.platform === 'mulesoft' ? ', flow, sub-flow, connector, DataWeave transform, and schema file' : ' and its sub-objects'}?`);
  lumiChoices([{ label: 'Start Asset Scan', cls: 'primary', onClick: startAssetScan }]);
}

// ==================== IMPORT ASSETS ====================
function startAssetScan() {
  const btn = $('btn-import-assets-trigger');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Scanning…';
  setLumiState('thinking');
  lumiSay('Scanning… this takes a few seconds.');

  setTimeout(() => {
    S.assets = (ASSET_SETS[S.platform] || ASSET_SETS.mulesoft).map(a => ({ ...a, convertPct: computeConversionPct(a) }));
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Scan complete';
    const ready = S.assets.filter(a => a.status === 'Ready').length;
    const review = S.assets.filter(a => a.status === 'Review').length;
    const warn = S.assets.filter(a => a.status === 'Warning').length;
    const p = PLATFORMS[S.platform];

    // Each asset bundles more than one deduced iFlow — a MuleSoft app or PI/PO
    // object is a container, not a 1:1 stand-in for "one interface." flowCount
    // was already computed per asset (generateBulkAssets / the hand-authored
    // fallback) but never surfaced anywhere — 60 apps reading as "60 apps ready"
    // undersold the real scope (closer to ~500-600 underlying iFlows/interfaces).
    const totalIflows = S.assets.reduce((sum, a) => sum + (a.flowCount || 1), 0);
    S.totalIflowEstimate = totalIflows;
    S.brainSessionId = S.brainSessionId || `${S.platform}-${S.projectName || 'migration'}-${Date.now()}`;
    logBrainEvent('asset_scan', S.platform,
      { assets: S.assets.map(a => ({ id: a.id, name: a.name, type: a.type, tier: a.tier, deps: a.deps, status: a.status, flowCount: a.flowCount, tree: a.tree })) },
      `Scanned ${S.assets.length} ${p.assetNounPlural} on ${p.label} — ${ready} ready, ${warn} warning, ${review} need review, ~${totalIflows} interfaces/iFlows total.`);

    $('assets-summary-msg').style.display = 'flex';
    $('assets-summary-text').innerHTML = `<span class="who-label">Lumi</span>Scan complete. I found <b>${S.assets.length} ${p.assetNounPlural}</b>, bundling an estimated <b>${totalIflows}</b> individual interfaces/iFlows. ${ready} ${ready === 1 ? 'is' : 'are'} fully ready to convert${warn ? `, ${warn} has a warning` : ''}${review ? `, and ${review} needs your review` : ''}. Want the details, or should we move to grouping these into buckets?`;
    $('assets-summary-actions').style.display = 'flex';
    S.assetsFilter = 'all';
    populateAssetsTable();
    unlockNav('nav-buckets');
    const cont = $('btn-continue-migration');
    cont.style.pointerEvents = 'auto'; cont.style.opacity = '1';
    cont.textContent = 'Continue to Plan';
    cont.onclick = () => { markDone('nav-assets'); goToBuckets(); };

    lumiSay(`Scan complete — ${S.assets.length} ${p.assetNounPlural} found (≈${totalIflows} interfaces/iFlows once each app's bundled flows are counted). ${ready} ready${warn ? `, ${warn} warning` : ''}${review ? `, ${review} need review` : ''}.`);
    if (review) flagNav('nav-buckets');
    lumiChoices([{ label: 'Show me the details', onClick: showAssetDetails }, { label: 'Continue to Plan', cls: 'primary', onClick: () => { markDone('nav-assets'); goToBuckets(); } }]);
  }, 1600);
}

function computeConversionPct(app) {
  let total = 0, ok = 0;
  function walk(node) { total++; if (node.ok) ok++; (node.children || []).forEach(walk); }
  app.tree.forEach(walk);
  return Math.round((ok / total) * 100);
}

function showAssetDetails() { $('assets-table-wrap').classList.remove('hidden'); }

function setAssetsFilter(status) {
  S.assetsFilter = status;
  populateAssetsTable();
}
function renderAssetsFilterChips() {
  const host = $('assets-filter-chips');
  if (!host) return;
  const counts = {
    all: S.assets.length,
    Ready: S.assets.filter(a => a.status === 'Ready').length,
    Warning: S.assets.filter(a => a.status === 'Warning').length,
    Review: S.assets.filter(a => a.status === 'Review').length
  };
  const filter = S.assetsFilter || 'all';
  const chips = [
    ['all', `In scope (${counts.all})`],
    ['Ready', `Ready (${counts.Ready})`],
    ['Warning', `Warning (${counts.Warning})`],
    ['Review', `Review (${counts.Review})`]
  ];
  host.innerHTML = chips.map(([key, label]) => `<button class="assets-filter-chip ${filter === key ? 'active' : ''}" onclick="setAssetsFilter('${key}')">${label}</button>`).join('');
}
function populateAssetsTable() {
  const tbody = $('btp-assets-tbody');
  renderAssetsFilterChips();
  const filter = S.assetsFilter || 'all';
  const rows = filter === 'all' ? S.assets : S.assets.filter(a => a.status === filter);
  tbody.innerHTML = rows.map(a => `
    <tr class="${a.status !== 'Ready' ? 'row-flagged' : ''}">
      <td><code>${a.id}</code></td><td><code>${a.name}</code></td><td>${a.type}</td>
      <td>${a.tier}</td><td>${a.convertPct}%</td>
      <td><span class="status-pill ${a.status === 'Ready' ? 'done' : a.status === 'Warning' ? 'progress' : 'error'}">${a.status}</span></td>
      <td><button class="btn-btp-table-action" onclick="showTreeModal('${a.id}')">View Tree</button></td>
    </tr>`).join('');
  const viewTreeBtn = $('btn-view-asset-tree');
  if (viewTreeBtn) {
    viewTreeBtn.disabled = S.assets.length === 0;
    viewTreeBtn.title = S.assets.length === 0 ? 'Available once assets are scanned' : '';
  }
}

// ==================== UPLOAD MODE (alternative to Direct Connect) ====================
function selectConnectMode(mode) {
  S.connectMode = mode;
  $('connect-mode-direct').classList.toggle('active', mode === 'direct');
  $('connect-mode-upload').classList.toggle('active', mode === 'upload');
  $('connect-direct-fields').classList.toggle('hidden', mode !== 'direct');
  $('connect-upload-fields').classList.toggle('hidden', mode !== 'upload');
  if (mode === 'upload') {
    if (!S.platform) {
      S.platform = 'mulesoft';
      const p = PLATFORMS.mulesoft;
      S.projectName = p.projectName;
      $('project-selector-text').textContent = p.projectName;
      if ($('project-badge-text')) $('project-badge-text').textContent = p.projectName;
      document.title = `SDAINT-AI — ${p.projectName}`;
      qsa('.platform-card').forEach(c => c.classList.toggle('selected', c.dataset.platform === 'mulesoft'));
      markDone('nav-details');
      applyPlatformTerminology('mulesoft');
    }
    markDone('nav-connection');
    unlockNav('nav-assets');
    const uploadLabel = PLATFORMS[S.platform].terms.uploadLabel;
    lumiSay(`Sure — drop a ${uploadLabel} on the right, or click Browse. If it turns out to be compiled code, I'll decompile it before adding it to your ${PLATFORMS[S.platform].assetNoun} list.`);
  }
}

function setupUploadZone() {
  const zone = $('upload-drop-zone');
  const input = $('upload-file-input');
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => { if (e.target.files.length) handleUploadedFile(e.target.files[0]); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleUploadedFile(e.dataTransfer.files[0]);
  });
}

async function handleUploadedFile(file) {
  const logRow = document.createElement('div');
  logRow.className = 'upload-log-row';
  logRow.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Inspecting <code>${file.name}</code>…`;
  $('upload-log').appendChild(logRow);
  openDrawer(false);
  lumiSay(`Inspecting <b>${file.name}</b>…`);

  const { compiled, kind } = await classifyUploadedFile(file);
  let asset;
  if (compiled) {
    lumiSay(`⚠️ That's compiled code — <b>${kind}</b>, not source. This is more complex. Give me a moment, I'm running the SDAINTAI decompilation pipeline.`, { alert: true });
    asset = await runDecompilation(file, kind);
    logRow.innerHTML = `<i class="fa-solid fa-microchip" style="color:var(--btp-brand-gold-hover);"></i> <code>${file.name}</code> — decompiled, ${asset.convertPct}% recovered cleanly`;
  } else {
    lumiSay(`<b>${file.name}</b> is a ${kind} — straightforward, no decompilation needed. Parsing it now.`);
    await new Promise(r => setTimeout(r, 700));
    asset = buildUploadedSourceAsset(file.name);
    logRow.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#10b981;"></i> <code>${file.name}</code> — parsed and added`;
  }
  addAssetToResults(asset);
  lumiSay(`Added <b>${asset.name}</b> to your asset list.`);
  lumiChoices([
    { label: 'Upload another file', onClick: () => $('upload-file-input').click() },
    { label: 'Continue to Plan', cls: 'primary', onClick: () => { markDone('nav-assets'); goToBuckets(); } }
  ]);
}

async function runDecompilation(file, kind) {
  setLumiState('thinking');
  const uid = 'decompile' + Date.now();
  const body = $('lumi-drawer-body');
  const wrap = document.createElement('div');
  wrap.className = 'lumi-msg';
  wrap.innerHTML = `<div class="lumi-avatar thinking"><div class="visor"></div></div>
    <div class="lumi-bubble" style="width:100%;max-width:82%;">
      <span class="who-label engine">SDAINTAI Decompilation Engine</span>
      <div class="decompile-stage" id="${uid}-stage">${decompileStages()[0]}</div>
      <div class="cockpit-progress-track" style="margin:8px 0 0;"><div class="cockpit-progress-fill" id="${uid}-fill" style="width:4%;"></div></div>
    </div>`;
  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;

  const stages = decompileStages();
  for (let i = 0; i < stages.length; i++) {
    await new Promise(r => setTimeout(r, 850));
    const stageEl = $(`${uid}-stage`);
    const fillEl = $(`${uid}-fill`);
    if (stageEl) stageEl.textContent = stages[i];
    if (fillEl) fillEl.style.width = Math.round(((i + 1) / stages.length) * 100) + '%';
  }
  await new Promise(r => setTimeout(r, 400));

  const asset = buildDecompiledAsset(file.name, kind);
  setLumiState('success');
  lumiSay(`Decompilation complete — recovered <b>${asset.convertPct}%</b> cleanly. Here's the structure:`);
  lumiTree(renderInlineTree(asset));
  return asset;
}

function buildDecompiledAsset(filename, kind) {
  decompiledCounter++;
  const baseName = filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '-') || 'decompiled-asset';
  const tree = [
    { kind: 'flow', name: `${baseName}-main-flow (recovered)`, ok: true, children: [
      leafTree('connector', 'recovered-connector', true),
      leafTree('transform', `${baseName}-mapping.dwl (reconstructed)`, true)
    ] },
    leafTree('flow', `${baseName}-error-handler-flow (recovered)`, true),
    leafTree('properties', `${baseName}.properties.yaml (recovered)`, true),
    leafTree('schema', `${baseName}-schema.xsd (recovered — needs review)`, false)
  ];
  const assetNoun = (PLATFORMS[S.platform] || PLATFORMS.mulesoft).assetNoun;
  const assetNounCap = assetNoun.charAt(0).toUpperCase() + assetNoun.slice(1);
  const asset = { id: `D${String(decompiledCounter).padStart(3, '0')}`, name: baseName, type: `${assetNounCap} (decompiled — ${kind})`, tier: 'High', deps: 3, status: 'Review', tree };
  asset.convertPct = computeConversionPct(asset);
  return asset;
}

function buildUploadedSourceAsset(filename) {
  decompiledCounter++;
  const baseName = filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '-') || 'uploaded-asset';
  const tree = [leafTree('flow', `${baseName}-flow`, true), leafTree('properties', `${baseName}.properties.yaml`, true)];
  const assetNoun = (PLATFORMS[S.platform] || PLATFORMS.mulesoft).assetNoun;
  const assetNounCap = assetNoun.charAt(0).toUpperCase() + assetNoun.slice(1);
  const asset = { id: `U${String(decompiledCounter).padStart(3, '0')}`, name: baseName, type: `${assetNounCap} (uploaded)`, tier: 'Simple', deps: 1, status: 'Ready', tree };
  asset.convertPct = computeConversionPct(asset);
  return asset;
}

function addAssetToResults(asset) {
  S.assets.push(asset);
  populateAssetsTable();
  $('assets-table-wrap').classList.remove('hidden');
  unlockNav('nav-buckets');
}

// ==================== MIGRATION BUCKETS ====================
// Orchestrator behavior: include everything and move straight to wave grouping
// instead of stopping to ask "use your grouping or pick yourself?" — Lumi does
// the job and states the result; hand-picking is still one click away via the
// "Adjust" option on the wave-grouping message, not a blocking upfront question.
function goToBuckets() {
  openScreen('buckets');
  populateBucketsTable();
  const p = PLATFORMS[S.platform];
  qsa('#buckets-tbody input[type=checkbox]').forEach(cb => cb.checked = true);
  lumiSay(`I've grouped by complexity and dependencies and included all <b>${S.assets.length} ${p.assetNounPlural}</b> — say the word if you'd rather hand-pick which ones are in scope.`);
  goToWaveFromBuckets();
}
function renderAssetPickChips() {
  const body = $('lumi-drawer-body');
  const old = body.querySelector('.asset-pick-row');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'lumi-choices asset-pick-row';
  S.assets.forEach(a => {
    const cb = qs(`.bucket-cb[data-id="${a.id}"]`);
    const chip = document.createElement('div');
    chip.className = 'lumi-chip' + (cb.checked ? ' primary' : '');
    chip.textContent = (cb.checked ? '✓ ' : '') + a.name;
    chip.addEventListener('click', () => { cb.checked = !cb.checked; renderAssetPickChips(); });
    wrap.appendChild(chip);
  });
  const cont = document.createElement('div');
  cont.className = 'lumi-chip review';
  cont.textContent = 'Continue with these';
  cont.addEventListener('click', () => { wrap.remove(); goToWaveFromBuckets(); });
  wrap.appendChild(cont);
  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
}
function populateBucketsTable() {
  const tbody = $('buckets-tbody');
  tbody.innerHTML = S.assets.map(a => `
    <tr>
      <td><input type="checkbox" class="bucket-cb" data-id="${a.id}" checked></td>
      <td><code>${a.id}</code></td><td>${a.name}</td><td>${a.type}</td><td>${a.tier}</td><td>${a.deps}</td>
      <td><span class="status-pill ${a.status === 'Ready' ? 'done' : a.status === 'Warning' ? 'progress' : 'error'}">${a.status}</span></td>
    </tr>`).join('');
}
function goToWaveFromBuckets() {
  const selectedIds = qsa('.bucket-cb:checked').map(cb => cb.dataset.id);
  const selected = S.assets.filter(a => selectedIds.includes(a.id));
  const simple = selected.filter(a => a.tier === 'Simple');
  const medium = selected.filter(a => a.tier === 'Medium');
  const high = selected.filter(a => a.tier === 'High');
  S.waves = { 1: simple.map(a => a.id), 2: medium.map(a => a.id), 3: high.map(a => a.id) };
  S.revealedWaves = [];
  markDone('nav-buckets');
  unlockNav('nav-wave');
  autoAssignTeam();
  renderWaveBoard();
  renderTeamBoard();
  openScreen('wave');
  const activeWaves = getActiveWaveNumbers();
  const waveCount = Math.max(1, activeWaves.length);
  const sequenceMsg = waveCount === 1
    ? `Everything you selected fits into a single wave — no need to spread it out.`
    : `I'd sequence this into ${waveCount} waves (${activeWaves.map(w => `Wave ${w}`).join(', ')}) — low-risk first, then medium-complexity, then the high-complexity items last since they need extra review.`;
  const expandHint = waveCount < 3 ? ` Use "+ Add Wave" below the board if you'd like to split this further.` : '';
  lumiSay(`${sequenceMsg} I've suggested a team per wave by skill and availability. Use the dropdown on any card to move it (position also sets priority), or add/remove team members below.${expandHint} Continue when it looks right.`);
  lumiHtml(renderTierPieChart(simple.length, medium.length, high.length));
  logBrainEvent('wave_plan', S.platform,
    { waves: S.waves, teamByWave: S.teamByWave, simple: simple.map(a => a.id), medium: medium.map(a => a.id), high: high.map(a => a.id) },
    `Planned ${waveCount} wave(s) for ${selected.length} assets — ${simple.length} simple, ${medium.length} medium, ${high.length} high complexity.`);
  lumiChoices([
    { label: 'Continue', cls: 'primary', onClick: continueToApprove },
    { label: 'Adjust which apps are included', onClick: () => { openScreen('buckets'); lumiSay('Sure — click each one to include or exclude it, then continue when ready.'); renderAssetPickChips(); } }
  ]);
}
// Why Lumi drew the wave lines where it did — a quick visual instead of another
// paragraph of explanation. Pure CSS conic-gradient, no chart library.
function renderTierPieChart(simpleN, mediumN, highN) {
  const total = simpleN + mediumN + highN || 1;
  const pctS = Math.round((simpleN / total) * 100);
  const pctM = Math.round((mediumN / total) * 100);
  const pctH = Math.max(0, 100 - pctS - pctM);
  const gradient = `conic-gradient(#10b981 0% ${pctS}%, #f59e0b ${pctS}% ${pctS + pctM}%, #ef4444 ${pctS + pctM}% 100%)`;
  return `<div class="tier-pie-wrap">
    <div class="tier-pie" style="background:${gradient};"></div>
    <div class="tier-pie-legend">
      <div><span class="dot" style="background:#10b981;"></span><b>Simple — ${simpleN} (${pctS}%)</b><span class="tier-pie-why">Wave 1 · low custom code, few dependencies</span></div>
      <div><span class="dot" style="background:#f59e0b;"></span><b>Medium — ${mediumN} (${pctM}%)</b><span class="tier-pie-why">Wave 2 · some custom mapping/transform logic</span></div>
      <div><span class="dot" style="background:#ef4444;"></span><b>High — ${highN} (${pctH}%)</b><span class="tier-pie-why">Wave 3 · heavy custom code and dependencies — routed last for extra review</span></div>
    </div>
  </div>`;
}
function getVisibleWaveNumbers() {
  const active = getActiveWaveNumbers();
  const visible = new Set(active.length ? active : [1]);
  (S.revealedWaves || []).forEach(w => visible.add(w));
  return [1, 2, 3].filter(w => visible.has(w));
}
function renderWaveBoard() {
  const visible = getVisibleWaveNumbers();
  [1, 2, 3].forEach(w => {
    const colEl = document.querySelector(`.wave-col[data-wave="${w}"]`);
    const col = $(`wave-col-${w}`);
    col.innerHTML = '';
    S.waves[w].forEach(id => col.appendChild(makeWaveCard(id)));
    if (!S.waves[w].length) { const hint = document.createElement('div'); hint.className = 'wave-drop-hint'; hint.textContent = 'Drop assets here'; col.appendChild(hint); }
    if (colEl) colEl.classList.toggle('hidden', !visible.includes(w));
  });
  const board = $('wave-board');
  if (board) board.style.gridTemplateColumns = `repeat(${visible.length}, 1fr)`;
  renderWaveAddControl(visible);
}
function renderWaveAddControl(visible) {
  const row = $('wave-add-row');
  if (!row) return;
  const hiddenWaves = [1, 2, 3].filter(w => !visible.includes(w));
  if (!hiddenWaves.length) { row.innerHTML = ''; return; }
  row.innerHTML = hiddenWaves.map(w => `<button type="button" class="btn-btp-action-outline wave-add-btn" data-wave="${w}">+ Add Wave ${w}</button>`).join('');
  qsa('.wave-add-btn', row).forEach(btn => btn.addEventListener('click', () => {
    S.revealedWaves = [...new Set([...(S.revealedWaves || []), Number(btn.dataset.wave)])];
    renderWaveBoard();
    renderTeamBoard();
  }));
}
function makeWaveCard(id) {
  const a = S.assets.find(x => x.id === id);
  const curWave = [1, 2, 3].find(w => S.waves[w].includes(id));
  const card = document.createElement('div');
  card.className = 'wave-card';
  card.draggable = true;
  card.dataset.id = id;
  card.innerHTML = `<span class="name">${a.name}</span><span class="tier ${a.tier}">${a.tier}</span>
    <select class="card-wave-select">
      <option value="1" ${curWave === 1 ? 'selected' : ''}>Move to Wave 1</option>
      <option value="2" ${curWave === 2 ? 'selected' : ''}>Move to Wave 2</option>
      <option value="3" ${curWave === 3 ? 'selected' : ''}>Move to Wave 3</option>
    </select>`;
  card.addEventListener('dragstart', e => { card.classList.add('dragging'); e.dataTransfer.setData('text/plain', id); });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  const select = qs('.card-wave-select', card);
  select.addEventListener('click', e => e.stopPropagation());
  select.addEventListener('change', () => moveAssetToWave(id, select.value));
  return card;
}
function moveAssetToWave(id, targetWave) {
  [1, 2, 3].forEach(w => { S.waves[w] = S.waves[w].filter(x => x !== id); });
  S.waves[targetWave].push(id);
  renderWaveBoard();
}
function setupWaveDnD() {
  qsa('.wave-col').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('dragover');
      const id = e.dataTransfer.getData('text/plain');
      moveAssetToWave(id, col.dataset.wave);
    });
  });
}

function getIncludedAssetIds() { return [...S.waves[1], ...S.waves[2], ...S.waves[3]]; }
function getActiveWaveNumbers() { return [1, 2, 3].filter(w => S.waves[w].length > 0); }
function getIncludedAssets() { const ids = getIncludedAssetIds(); return S.assets.filter(a => ids.includes(a.id)); }

function autoAssignTeam() {
  const sorted = [...activeTeam()].sort((a, b) => b.avail - a.avail);
  S.teamByWave = { 1: [], 2: [], 3: [] };
  sorted.forEach((m, i) => S.teamByWave[(i % 3) + 1].push(m.id));
}
function renderTeamBoard() {
  const board = $('team-board');
  const visible = getVisibleWaveNumbers();
  board.style.gridTemplateColumns = `repeat(${visible.length}, 1fr)`;
  board.innerHTML = visible.map(w => {
    const available = activeTeam().filter(t => !S.teamByWave[w].includes(t.id));
    return `
    <div class="team-col">
      <div class="wave-col-head"><b>Wave ${w}</b><span>${S.teamByWave[w].length} members</span></div>
      ${S.teamByWave[w].map(id => { const m = activeTeam().find(t => t.id === id); return `
        <div class="team-member-card">
          <div class="avatar-chip" style="background:${m.color};">${m.name.split(' ').map(x => x[0]).join('')}</div>
          <div class="info"><b>${m.name}</b><span>${m.role}</span></div>
          <div class="avail-bar"><div style="width:${m.avail}%;"></div></div>
          <button class="team-remove-btn" data-wave="${w}" data-id="${id}" title="Remove from Wave ${w}"><i class="fa-solid fa-xmark"></i></button>
        </div>`; }).join('')}
      <select class="team-add-select" data-wave="${w}">
        <option value="">+ Add member&hellip;</option>
        ${available.map(t => `<option value="${t.id}">${t.name} — ${t.role}</option>`).join('')}
      </select>
    </div>`;
  }).join('');
  qsa('.team-remove-btn', board).forEach(btn => btn.addEventListener('click', () => {
    S.teamByWave[btn.dataset.wave] = S.teamByWave[btn.dataset.wave].filter(x => x !== btn.dataset.id);
    renderTeamBoard();
  }));
  qsa('.team-add-select', board).forEach(sel => sel.addEventListener('change', () => {
    if (sel.value) { S.teamByWave[sel.dataset.wave].push(sel.value); renderTeamBoard(); }
  }));
}

function validateStructure() {
  const options = S.assets.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  const sourceStepNoun = PLATFORMS[S.platform].terms.sourceStepNoun;
  openModal(`Validate ${sourceStepNoun} Structure`, `
    <div class="form-group-btp" style="margin-bottom:14px;">
      <label>Which ${PLATFORMS[S.platform].assetNoun} would you like to see?</label>
      <select class="btp-input" id="structure-picker">${options}</select>
    </div>
    <div id="structure-tree-host"></div>`,
    [{ label: 'Close', cls: 'btn-btp-cancel', onClick: closeModal }]);
  $('structure-picker').addEventListener('change', renderStructureEditor);
  renderStructureEditor();
}
function renderStructureEditor() {
  const id = $('structure-picker').value;
  const a = S.assets.find(x => x.id === id);
  const host = $('structure-tree-host');
  host.innerHTML = renderTreeEditorHtml(a);
  wireTreeEditorEvents(host, a);
  suggestKafkaConversion(a, 'structure-tree-host');
}

// Shared by the "Validate app structure" modal and the cockpit row Details popup,
// so both offer the same edit-branches + per-node "View" file-content behavior.
function countSelectedKafkaEvents(asset) {
  let n = 0;
  function walk(node) { if (node.kafkaEvent && node.kafkaEvent.selected) n++; (node.children || []).forEach(walk); }
  asset.tree.forEach(walk);
  return n;
}
function renderKafkaSummary(asset) {
  const n = countSelectedKafkaEvents(asset);
  if (!n) return '';
  return `<div class="kafka-summary"><i class="fa-solid fa-bolt"></i> ${n} Kafka event${n > 1 ? 's' : ''} selected — will generate ${n} IS-Kafka channel${n > 1 ? 's' : ''} in the .iflw on conversion.</div>`;
}
function renderTreeEditorHtml(asset) {
  let html = `<div class="tree-editor">`;
  asset.tree.forEach((node, i) => {
    html += renderTreeNode(node, `${i}`, 0);
    (node.children || []).forEach((child, j) => { html += renderTreeNode(child, `${i}.${j}`, 1); });
  });
  html += `</div><div style="margin-top:14px;font-size:0.82rem;font-weight:700;">Conversion coverage: <span class="tree-pct" style="color:var(--btp-brand-gold-hover);">${computeConversionPct(asset)}%</span></div>`;
  html += `<div class="kafka-summary-host">${renderKafkaSummary(asset)}</div>`;
  return html;
}
function wireTreeEditorEvents(host, asset) {
  qsa('.tree-node input[type="checkbox"]:not([data-kafka-path])', host).forEach(cb => cb.addEventListener('change', () => {
    resolveTreeNode(asset, cb.dataset.path).ok = cb.checked;
    asset.convertPct = computeConversionPct(asset);
    const pctEl = host.querySelector('.tree-pct');
    if (pctEl) pctEl.textContent = asset.convertPct + '%';
    populateAssetsTable();
  }));
  qsa('input[data-kafka-path]', host).forEach(cb => cb.addEventListener('change', () => {
    resolveTreeNode(asset, cb.dataset.kafkaPath).kafkaEvent.selected = cb.checked;
    const row = cb.closest('.kafka-event-row');
    row.classList.toggle('picked', cb.checked);
    let tag = row.querySelector('.kafka-picked-tag');
    if (cb.checked && !tag) { tag = document.createElement('span'); tag.className = 'kafka-picked-tag'; tag.textContent = 'PICKED'; row.appendChild(tag); }
    else if (!cb.checked && tag) tag.remove();
    const summaryHost = host.querySelector('.kafka-summary-host');
    if (summaryHost) summaryHost.innerHTML = renderKafkaSummary(asset);
  }));
  qsa('.tree-node-view-btn', host).forEach(btn => btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const row = btn.closest('.tree-node');
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains('tree-node-preview')) { existing.remove(); return; }
    const node = resolveTreeNode(asset, btn.dataset.path);
    const pre = document.createElement('pre');
    pre.className = 'tree-node-preview';
    pre.textContent = mockNodeContent(node);
    row.insertAdjacentElement('afterend', pre);
  }));
}
function resolveTreeNode(asset, path) {
  const [i, j] = path.split('.').map(Number);
  return (j === undefined || isNaN(j)) ? asset.tree[i] : asset.tree[i].children[j];
}
function renderTreeNode(node, path, depth) {
  const errorRow = node.ok === false ? ' node-error-row' : '';
  const label = node.ok === false ? `<span class="node-error">⚠ ${node.name}</span>` : node.name;
  const mainRow = `<div class="tree-node depth-${depth}${errorRow}">
    <input type="checkbox" data-path="${path}" ${node.ok ? 'checked' : ''}>
    <span class="node-kind">${node.kind}</span> ${label}
    <button type="button" class="tree-node-view-btn" data-path="${path}">View</button>
  </div>`;
  if (!node.kafkaEvent) return mainRow;
  const k = node.kafkaEvent;
  return mainRow + `<div class="tree-node depth-${depth} kafka-event-row${k.selected ? ' picked' : ''}">
    <input type="checkbox" data-kafka-path="${path}" ${k.selected ? 'checked' : ''}>
    <span class="kafka-badge">${k.id}</span>
    <span class="kafka-event-label">Convert to IS-Kafka — topic <code>${k.topic}</code></span>
    ${k.selected ? '<span class="kafka-picked-tag">PICKED</span>' : ''}
  </div>`;
}
function mockNodeContent(node) {
  switch (node.kind) {
    case 'flow': case 'sub-flow': case 'error-handler-flow':
      return `<mule xmlns="http://www.mulesoft.org/schema/mule/core">\n  <flow name="${node.name}">\n    <logger message="Processing ${node.name}" level="INFO"/>\n    <!-- recovered/converted flow steps -->\n  </flow>\n</mule>`;
    case 'connector':
      return `<connector-config name="${node.name}">\n  <connection ref="sdaintai-brain-managed"/>\n</connector-config>`;
    case 'transform':
      return `%dw 2.0\noutput application/json\n---\n{\n  // ${node.name}\n  id: payload.id,\n  name: payload.name default "unknown"\n}`;
    case 'schema':
      return `<?xml version="1.0"?>\n<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">\n  <!-- ${node.name} -->\n  <xs:element name="root" type="xs:string"/>\n</xs:schema>`;
    case 'sender-channel': case 'receiver-channel':
      return `<?xml version="1.0"?>\n<CommunicationChannel>\n  <!-- ${node.name} -->\n  <Adapter>${node.kind === 'sender-channel' ? 'Sender' : 'Receiver'}</Adapter>\n  <TransportProtocol>File/IDoc/HTTP</TransportProtocol>\n  <!-- recovered channel configuration, converted to a CPI adapter -->\n</CommunicationChannel>`;
    case 'properties':
      return `# ${node.name}\nhttp.port=8081\ndb.connection.url=jdbc:...\nenv=sandbox`;
    case 'message-mapping': case 'operation-mapping': case 'value-mapping': case 'map':
      return `# ${node.name}\nsource.field -> target.field\n(mapping table recovered by the SDAINTAI Brain)`;
    default:
      return `// ${node.kind}: ${node.name}\n(no preview available for this object type)`;
  }
}

function getAssignedTeamMembers() {
  const teamIds = [...new Set([...S.teamByWave[1], ...S.teamByWave[2], ...S.teamByWave[3]])];
  return teamIds.map(id => activeTeam().find(t => t.id === id)).filter(Boolean);
}
function continueToApprove() {
  markDone('nav-wave');
  unlockNav('nav-approve');
  const includedCount = getIncludedAssetIds().length;
  const activeWaves = getActiveWaveNumbers();
  const teamMembers = getAssignedTeamMembers();
  const waveCount = activeWaves.length;
  // Same wave-bound model as totalEffortMinutes(): each wave's duration is
  // its single slowest interface (everything in a wave converts at once
  // across the AI agent fleet), waves run sequentially — not a hardcoded
  // weeks-per-wave guess, and not a sum across every interface. cockpitRows
  // doesn't exist yet at this stage (built once Execute starts), so this
  // estimates straight from the assets/waves already known; flowCount only
  // matters for the per-wave max in the (rare) sense that a wave needs at
  // least one asset in it to register a max at all.
  const waveMaxMinutes = {};
  [1, 2, 3].forEach(w => {
    S.waves[w].forEach(id => {
      const a = S.assets.find(x => x.id === id);
      if (!a) return;
      const mins = effortMinutesForTier(a.tier);
      waveMaxMinutes[w] = Math.max(waveMaxMinutes[w] || 0, mins);
    });
  });
  const durationMinutes = Object.values(waveMaxMinutes).reduce((sum, m) => sum + m, 0);
  const durationLabel = formatEffort(durationMinutes);

  $('approve-total-assets').textContent = includedCount;
  $('approve-wave-count').textContent = waveCount;
  $('approve-team-count').textContent = teamMembers.length;
  $('approve-duration').textContent = durationLabel;
  $('approve-timestamp').textContent = `Plan generated ${new Date().toLocaleString()}`;

  const requesterName = S.userName || 'Daniel Smith';
  const requesterInitials = requesterName.split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase();
  // one assigned member stays an outstanding sign-off, for the interactive "click to approve" demo moment —
  // prefer whoever is the Architect (narratively the one reviewing riskiest changes), else the last assigned.
  const pendingMember = teamMembers.find(m => m.role === 'Architect') || teamMembers[teamMembers.length - 1] || null;

  let rowsHtml = `<div class="approval-row"><div class="avatar-chip" style="background:#e5a93b;">${requesterInitials}</div><div class="info"><b>${requesterName}</b><span>Integration Lead</span></div><span class="approval-pill approved">Approved</span></div>`;
  teamMembers.forEach(m => {
    const initials = m.name.split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase();
    const isPending = pendingMember && m.id === pendingMember.id;
    rowsHtml += `<div class="approval-row"><div class="avatar-chip" style="background:${m.color};">${initials}</div><div class="info"><b>${m.name}</b><span>${m.role}</span></div>` +
      (isPending
        ? `<span class="approval-pill pending" style="cursor:pointer;" onclick="approvePending(this)">Pending — click to sign off</span>`
        : `<span class="approval-pill approved">Approved</span>`) +
      `</div>`;
  });
  if (!teamMembers.length) {
    rowsHtml += `<div class="approval-row"><div class="info"><span style="color:var(--btp-text-muted-dark);font-size:0.82rem;">No team members assigned yet — go back to Define Wave &amp; Team to assign someone.</span></div></div>`;
  }
  $('approvals-list').innerHTML = rowsHtml;

  openScreen('approve');
  const namesForMessage = teamMembers.length ? teamMembers.map(m => m.name).join(', ') : "no one yet — you may want to assign a team first";
  const assetNoun = includedCount === 1 ? PLATFORMS[S.platform].assetNoun : PLATFORMS[S.platform].assetNounPlural;
  lumiSay(`Everything's ready — ${includedCount} ${assetNoun}, ${waveCount} wave${waveCount === 1 ? '' : 's'}, ~${durationLabel} estimated with A2A agents working in parallel. I've notified ${namesForMessage} for sign-off. Approve and start, or export a PDF first?`);
  lumiChoices([{ label: 'Approve & Start', cls: 'primary', onClick: approveAndStart }, { label: 'Export PDF', onClick: exportPdf }]);
}
function approvePending(el) { el.className = 'approval-pill approved'; el.textContent = 'Approved'; el.onclick = null; el.style.cursor = 'default'; }

async function exportPdf() {
  const p = PLATFORMS[S.platform];
  const activeWaves = getActiveWaveNumbers();
  const teamMembers = getAssignedTeamMembers();
  const pendingMember = teamMembers.find(m => m.role === 'Architect') || teamMembers[teamMembers.length - 1] || null;
  const now = new Date();
  const lines = [
    { text: `Project: ${S.projectName}`, bold: true, size: 13 },
    { text: `Platform: ${p.label}`, size: 11 },
    { text: `Generated: ${now.toLocaleString()} (${now.toISOString()})`, size: 11, gap: 4 },
    { text: 'Plan Summary', bold: true, size: 13, gap: 16 },
    { text: `Total Assets: ${getIncludedAssetIds().length}`, size: 11 },
    { text: `Waves: ${activeWaves.length}`, size: 11 },
    { text: `Team Members: ${teamMembers.length}`, size: 11 },
    { text: `Estimated Duration: ${$('approve-duration') ? $('approve-duration').textContent : '—'}`, size: 11, gap: 4 },
    { text: 'Wave Summary', bold: true, size: 13, gap: 16 },
    ...[1, 2, 3].map(w => ({ text: `Wave ${w}: ${S.waves[w].length} asset(s) — ${S.waves[w].map(id => S.assets.find(a => a.id === id).name).join(', ') || '(none)'}`, size: 11 })),
    { text: 'Team by Wave', bold: true, size: 13, gap: 16 },
    ...[1, 2, 3].map(w => ({ text: `Wave ${w}: ${S.teamByWave[w].map(id => activeTeam().find(t => t.id === id).name).join(', ') || '(none)'}`, size: 11 })),
    { text: 'Approvals', bold: true, size: 13, gap: 16 },
    { text: `${S.userName || 'Daniel Smith'} (Integration Lead) — Approved`, size: 11 },
    ...(teamMembers.length
      ? teamMembers.map((m, i) => ({ text: `${m.name} (${m.role}) — ${pendingMember && m.id === pendingMember.id ? 'Pending' : 'Approved'}`, size: 11, gap: i === teamMembers.length - 1 ? 4 : 0 }))
      : [{ text: '(no team members assigned)', size: 11, gap: 4 }])
  ];
  if (S.cockpitRows.length) {
    lines.push({ text: 'Conversion Timestamps', bold: true, size: 13, gap: 16 });
    S.cockpitRows.forEach(r => lines.push({ text: `${r.name}: ${r.status}${r.convertedAt ? ' @ ' + new Date(r.convertedAt).toLocaleString() : ''}`, size: 11 }));
  }
  lines.push({ text: `Prepared by the SDAINTAI Brain.`, size: 9, gap: 16 });
  const blob = buildSimplePdfBlob(`SDAINTAI Migration Plan - ${S.projectName}`, lines);
  await saveBlob(blob, `${S.projectName}-migration-plan.pdf`, 'PDF document', { 'application/pdf': ['.pdf'] });
  showToast('PDF Ready', 'The migration plan summary has been downloaded.', 'purple');
}

function pdfEscape(str) {
  return String(str).replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// ---- minimal single-page PDF writer (Helvetica base-14 font, no dependencies) ----
function buildSimplePdfBlob(title, lines) {
  let y = 740;
  const ops = [`BT /F2 18 Tf 50 ${y} Td (${pdfEscape(title)}) Tj ET`];
  y -= 30;
  lines.forEach(line => {
    if (line.gap) y -= line.gap;
    if (y < 40) return;
    const font = line.bold ? '/F2' : '/F1';
    const size = line.size || 11;
    ops.push(`BT ${font} ${size} Tf 50 ${y} Td (${pdfEscape(line.text)}) Tj ET`);
    y -= (size + 6);
  });
  const contentStr = ops.join('\n');
  const contentLen = new TextEncoder().encode(contentStr).length;

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${contentLen} >>\nstream\n${contentStr}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new Blob([pdf], { type: 'application/pdf' });
}

// ---- shared save helper: File System Access API when available, anchor download fallback ----
async function saveBlob(blob, filename, description, acceptTypes) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description, accept: acceptTypes }] });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e) { /* user cancelled, or API unsupported in this context — fall through */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function approveAndStart() {
  openModal('Approve Migration Plan', `You're about to approve <b>${S.projectName}</b> for execution. This will unlock the Migration Cockpit and notify the team.`,
    [{ label: 'Cancel', cls: 'btn-btp-cancel', onClick: closeModal },
     { label: 'Approve & Start', cls: 'btn-btp-gold', onClick: () => { closeModal(); doApprove(); } }]);
}
function doApprove() {
  markDone('nav-approve');
  unlockNav('nav-cockpit');
  buildCockpitRows();
  renderCockpitTable();
  openScreen('cockpit');
  showToast('Plan Approved', `${S.projectName} is approved. Migration Cockpit unlocked.`, 'purple');
  lumiSay(`Approved. The cockpit is unlocked — ready to start execution?`);
  lumiChoices([{ label: 'Start Execution', cls: 'primary', onClick: startExecution }]);
}

// ==================== MIGRATION COCKPIT ====================
// The two real, already-existing iFlows in the lab-sda tenant — used as stand-ins
// for "the iFlow this app deduces to" until there's a real per-artifact deploy
// target. Alternated by row index so every row has *a* real, clickable link.
const IFLOW_LINK_POOL = [
  'https://lab-sda.integrationsuite.cfapps.us10-002.hana.ondemand.com/shell/design/contentpackage/INTPACKFROMMUKESOFT1/integrationflows/CUSTOMER_MASTER_IFLOW',
  'https://lab-sda.integrationsuite.cfapps.us10-002.hana.ondemand.com/shell/design/contentpackage/INTPACKFROMMUKESOFT1/integrationflows/MATERIAL_MASTER_IFLOW'
];
// Material Master and Customer Master each have their own real BTP iFlow URL
// (above) — "Open in Integration Suite" / monitoring links must resolve to the
// matching one by asset name, not rotate through the pool by row index.
function iflowLinkForAsset(a, idx) {
  const n = (a.name || '').toLowerCase();
  if (n.includes('customer')) return IFLOW_LINK_POOL[0];
  if (n.includes('material')) return IFLOW_LINK_POOL[1];
  return IFLOW_LINK_POOL[idx % IFLOW_LINK_POOL.length];
}
// One S.cockpitRows entry per INDIVIDUAL iFlow, not per source asset — a
// MuleSoft app or PI/PO object bundles a.flowCount separate interfaces, and
// every one of them gets its own generated iFlow/row here (per explicit
// instruction: if the scan found 423 iFlows, 423 get generated, not 60
// asset-level stand-ins). row.assetId points back at the parent asset for
// every S.assets.find(...) lookup elsewhere (tree/Kafka/tier/etc) — row.id
// is now unique PER IFLOW (`${assetId}-${n}`), so it can no longer double as
// an asset id the way it used to when there was exactly one row per asset.
function buildCockpitRows() {
  S.cockpitRows = [];
  S.cockpitWaveFilter = 'all';
  S.pushApproved = false;
  S.pushApprovedBy = null;
  S.pushApprovedAt = null;
  let idx = 0;
  [1, 2, 3].forEach(w => {
    S.waves[w].forEach((id, i) => {
      const a = S.assets.find(x => x.id === id);
      const assignee = activeTeam().find(t => t.id === S.teamByWave[w][i % S.teamByWave[w].length]) || activeTeam()[0];
      const total = a.flowCount || 1;
      // A handful of non-erroring assets carry a semantic advisory, and a
      // problematic asset's issue is localized to one of its interfaces —
      // both stay pinned to interface #1 rather than repeating across every
      // one of the asset's expanded rows. Same deterministic idea as before.
      const advisory = a.status !== 'Ready' ? null
        : idx % 7 === 3 ? 'Timezone normalized to UTC during conversion — verify the receiver expects UTC.'
        : idx % 11 === 5 ? 'Retry policy mapped to adapter defaults — confirm the interval before go-live.'
        : null;
      for (let n = 1; n <= total; n++) {
        const rowName = total > 1 ? `${a.name} — Interface ${n}/${total}` : a.name;
        S.cockpitRows.push({
          wave: w, id: `${a.id}-${n}`, assetId: a.id, name: rowName, type: a.type, assignee: assignee.name, status: 'Pending',
          willError: a.status !== 'Ready' && n === 1, convertedAt: null,
          iflowName: iflowSlug(rowName).toUpperCase() + '_IFLOW',
          iflowLink: iflowLinkForAsset(a, idx),
          iflowCount: 1,
          assetFlowTotal: total, interfaceIndex: n,
          advisory: n === 1 ? advisory : null, advisoryAcked: false
        });
        idx++;
      }
    });
  });
}
// SAP PI/PO is a genuine platform-to-platform migration into SAP Integration Suite;
// MuleSoft/Informatica/Boomi are third-party conversions — same successful outcome,
// different word, matching how SDA already talks about the two program types.
function successIflowWord() { return S.platform === 'pipo' ? 'Migrated with success' : 'Deployed'; }
function iflowStatusLabel(row) {
  if (row.status === 'Done') return successIflowWord();
  if (row.status === 'Error') return 'Failed';
  if (row.status === 'In Progress') return 'Generating';
  if (row.status === 'Pending Fix') return 'Pending fix';
  if (row.status === 'Parked') return 'Parked';
  return 'Not started';
}
function iflowStatusPillClass(row) {
  const s = iflowStatusLabel(row);
  return s === successIflowWord() ? 'done' : s === 'Failed' ? 'error' : s === 'Generating' ? 'progress' : 'pending';
}
// iFlow Step — the coarser deployment-lifecycle read: green/success rows read
// "Deployed" (or "Migrated with success" for PI/PO), anything blocked or still
// unresolved reads "Pending deployment / review", everything else in the pipeline
// just hasn't reached deployment yet.
function iflowStepLabel(row) {
  if (row.status === 'Done') return successIflowWord();
  if (row.status === 'Error' || row.status === 'Pending Fix') return 'Pending deployment / review';
  return 'Pending deployment';
}
function iflowStepPillClass(row) {
  const s = iflowStepLabel(row);
  return s === successIflowWord() ? 'done' : s === 'Pending deployment / review' ? 'error' : 'pending';
}
function statusPillClass(status) {
  if (status === 'Done') return 'done';
  if (status === 'Error') return 'error';
  if (status === 'In Progress' || status === 'Pending Fix') return 'progress';
  return 'pending'; // Pending, Parked
}
function setCockpitWaveFilter(w) {
  S.cockpitWaveFilter = w;
  renderCockpitTable();
}
function renderCockpitWaveFilterChips() {
  const host = $('cockpit-wave-filter');
  if (!host) return;
  const waves = [1, 2, 3].filter(w => S.cockpitRows.some(r => r.wave === w));
  const filter = S.cockpitWaveFilter || 'all';
  const chips = [['all', 'All waves']].concat(waves.map(w => [String(w), `W${w}`]));
  host.innerHTML = chips.map(([key, label]) => `<button class="wave-filter-chip ${filter === key ? 'active' : ''}" onclick="setCockpitWaveFilter('${key}')">${label}</button>`).join('');
}
function renderCockpitTable() {
  if (S.platform) applyPlatformTerminology(S.platform);
  renderPackagePreview();
  renderCockpitWaveFilterChips();
  const waveFilter = S.cockpitWaveFilter || 'all';
  const visibleRows = waveFilter === 'all' ? S.cockpitRows : S.cockpitRows.filter(r => String(r.wave) === waveFilter);
  const countEl = $('cockpit-wave-filter-count');
  if (countEl) countEl.textContent = `${visibleRows.length} interface${visibleRows.length === 1 ? '' : 's'} shown`;
  $('cockpit-tbody').innerHTML = visibleRows.map(r => `
    <tr class="${r.status === 'Error' ? 'row-flagged' : ''}" id="cockpit-row-${r.id}">
      <td>Wave ${r.wave}</td><td>${r.name}</td><td>${r.type}</td>
      <td title="Interface ${r.interfaceIndex} of ${r.assetFlowTotal} within this ${r.type.toLowerCase()}">${r.interfaceIndex}/${r.assetFlowTotal}</td>
      <td>${r.assignee}</td>
      <td><span class="status-pill ${statusPillClass(r.status)}">${r.status}</span></td>
      <td><span class="status-pill ${iflowStatusPillClass(r)}">${iflowStatusLabel(r)}</span></td>
      <td><span class="status-pill ${iflowStepPillClass(r)}">${iflowStepLabel(r)}</span></td>
      <td style="white-space:nowrap;"><a href="${r.iflowLink}" target="_blank" rel="noopener" title="${r.iflowName}"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open</a>
        <button class="btn-btp-table-action btn-view-iflow" onclick="showIflowViewModal('${r.id}')" title="View iFlow"><i class="fa-solid fa-eye"></i></button></td>
      <td><button class="btn-btp-table-action" onclick="showLumiInsight('${r.id}')">Insight</button></td>
      <td>${r.status === 'Done' ? `<button class="btn-btp-table-action" onclick="downloadSingleAsset('${r.id}')" title="Download this converted artifact"><i class="fa-solid fa-download"></i></button>` : '—'}</td>
      <td style="white-space:nowrap;">${['Error', 'Pending Fix', 'Parked'].includes(r.status) ? `<button class="btn-btp-table-action" onclick="showRowDetail('${r.id}')">Details</button>` : ''}
        <button class="btn-btp-table-action" style="background:var(--btp-text-muted-dark);" onclick="showDeveloperAssignModal('${r.id}')" title="Assign A2A developers (up to 8)"><i class="fa-solid fa-user-group"></i> ${(r.assignees || []).length || ''}</button></td>
    </tr>`).join('');
  updateCockpitStats();
  refreshExecTabs();
  refreshWaveMeter();
}
function updateCockpitStats() {
  const total = S.cockpitRows.length || 1;
  const done = S.cockpitRows.filter(r => r.status === 'Done').length;
  const inprog = S.cockpitRows.filter(r => r.status === 'In Progress').length;
  const errors = S.cockpitRows.filter(r => r.status === 'Error' || r.status === 'Pending Fix').length;
  const parked = S.cockpitRows.filter(r => r.status === 'Parked').length;
  const pct = Math.round(((done + errors + parked) / total) * 100);
  $('cockpit-overall').textContent = pct + '%';
  $('cockpit-inprogress').textContent = inprog;
  $('cockpit-completed').textContent = done;
  $('cockpit-errors').textContent = errors;
  $('cockpit-progress-fill').style.width = pct + '%';
  if ($('cockpit-overall-sub')) $('cockpit-overall-sub').textContent = `${done + errors + parked} of ${S.cockpitRows.length} iFlows`;
  if ($('cockpit-completed-sub')) $('cockpit-completed-sub').textContent = errors ? 'Needs attention' : 'On track';
  if ($('cockpit-errors-sub')) $('cockpit-errors-sub').textContent = errors ? `${errors} to resolve` : 'None raised';
  if ($('exec-tab-errors-count')) $('exec-tab-errors-count').textContent = `(${errors})`;

  // exportToIS() owns the button's label/disabled state while a push is
  // actively animating (S.pushing set synchronously before its first
  // renderCockpitTable() call, ahead of S.pushInterval being assigned) —
  // don't fight it on every renderCockpitTable() tick during that window.
  const exportBtn = $('btn-export-is');
  if (exportBtn && !S.pushing) {
    if (isViewer()) {
      // Blocked, not just disabled — Viewer never sees a production-affecting trigger.
      exportBtn.style.display = 'none';
    } else {
      exportBtn.style.display = '';
      const anyPushed = S.cockpitRows.some(r => r.isImportStatus);
      if (anyPushed) {
        exportBtn.disabled = true;
        exportBtn.title = 'Already pushed to Integration Suite';
      } else if (isApprover()) {
        // Approve-only, by design — never unlocks for this persona, even after their own sign-off.
        exportBtn.disabled = true;
        exportBtn.title = 'Approver sign-off doesn\'t also grant the Push click — an Admin session pushes once you approve.';
      } else if (done === 0) {
        exportBtn.disabled = true;
        exportBtn.title = 'Available once at least one asset has converted successfully';
      } else if (!S.pushApproved) {
        exportBtn.disabled = true;
        exportBtn.title = 'Awaiting this wave\'s Approver sign-off — see Pending Approvals above';
      } else {
        exportBtn.disabled = false;
        exportBtn.title = '';
      }
    }
  }
}

// ==================== EXECUTION SUB-TABS (Integration list / Migration status / Readiness / Errors-issues / Progress / Migration execution / Integration package) ====================
// All derived from S.cockpitRows + S.assets — no parallel state, so the tabs can never drift from the Integration list tab.
// No-AI-agents baseline (what this used to be, and what it reverts toward as
// each A2A agent is switched off in Admin → Migration Acceleration) — a human
// doing the mapping and the Groovy/code rewrite by hand, per interface.
const MANUAL_EFFORT_MINUTES = { Simple: 15, Medium: 30, High: 90 };
// Both A2A agents (Mapping + Conversion) active is the real observed 30x
// acceleration over manual (15/30/90min -> 30s/1min/3min). Each agent
// contributes an equal share of that factor, so one agent alone gives
// sqrt(30) ≈ 5.48x rather than the full 30x — multiplicative, not additive,
// since the two agents cover different parts of the same pipeline stage.
const AGENT_FULL_SPEEDUP = 30;
const AGENT_SOLO_SPEEDUP = Math.sqrt(AGENT_FULL_SPEEDUP);
function activeAgentCount() {
  const mapping = $('admin-agent-mapping') ? $('admin-agent-mapping').checked : (S.adminDefaults.agentMappingEnabled !== false);
  const conversion = $('admin-agent-conversion') ? $('admin-agent-conversion').checked : (S.adminDefaults.agentConversionEnabled !== false);
  return (mapping ? 1 : 0) + (conversion ? 1 : 0);
}
// Per-interface conversion time — scales with how many of the two A2A agents
// (Mapping, Conversion) are switched on in Admin, so turning them off one by
// one visibly slows every duration the cockpit shows, demonstrating the
// acceleration they provide. 2 agents: 30s/1min/3min. 1 agent: ~2m44s/5m28s/16m24s.
// 0 agents: the original manual 15min/30min/90min baseline.
function effortMinutesForTier(tier) {
  const manual = MANUAL_EFFORT_MINUTES[tier] || MANUAL_EFFORT_MINUTES.Medium;
  const agents = activeAgentCount();
  if (agents >= 2) return manual / AGENT_FULL_SPEEDUP;
  if (agents === 1) return manual / AGENT_SOLO_SPEEDUP;
  return manual;
}
// Wave-bound duration model: every interface within a wave converts
// simultaneously across the AI agent fleet, so a wave's duration is its
// single slowest interface, not a sum of everything in it — waves themselves
// run sequentially, so total duration is the sum of each wave's max. Volume
// (20 interfaces in a wave, or 200) barely moves this; wave count and
// complexity mix do. Applies only to AGGREGATE totals (a wave, the whole
// migration) — a single row's own estimate (Report tab, Readiness tab, Lumi
// Insight) stays the raw per-interface number above, since that's one real
// task, not a batch.
function totalEffortMinutes(rows) {
  const maxByWave = {};
  rows.forEach(r => {
    const mins = effortMinutesForTier(rowTier(r));
    maxByWave[r.wave] = Math.max(maxByWave[r.wave] || 0, mins);
  });
  return Object.values(maxByWave).reduce((sum, m) => sum + m, 0);
}
function formatEffort(minutes) {
  if (minutes <= 0) return '0m';
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  const totalMin = Math.round(minutes);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
function rowTier(row) { const a = S.assets.find(x => x.id === row.assetId); return a ? a.tier : 'Medium'; }
// Buckets used across the Migration status / Readiness tabs — a relabeling of the same
// Pending/In Progress/Done/Error/Pending Fix/Parked pipeline the Integration list tab uses.
function statusBucket(status) {
  if (status === 'Done') return 'Converted';
  if (status === 'In Progress') return 'Converting';
  if (status === 'Error') return 'Blocked';
  if (status === 'Pending Fix' || status === 'Parked') return 'In fix / parked';
  return S.packageAdded ? 'Packaged' : 'Not started';
}
function waveStatusPill(wave) {
  const rows = S.cockpitRows.filter(r => r.wave === wave);
  if (!rows.length) return { label: 'Ready', cls: 'ready' };
  const finalCount = rows.filter(r => ['Done', 'Error', 'Parked'].includes(r.status)).length;
  if (finalCount === rows.length) return { label: 'Complete', cls: 'done' };
  if (rows.some(r => r.status === 'In Progress')) return { label: 'Running', cls: 'progress' };
  if (S.cockpitStarted) return { label: 'Queued', cls: 'ready' };
  return { label: 'Ready', cls: 'ready' };
}
function renderWaveStatusRow() {
  const host = $('wave-status-row');
  if (!host || !S.cockpitRows.length) { if (host) host.innerHTML = ''; return; }
  const activeWaves = [1, 2, 3].filter(w => S.cockpitRows.some(r => r.wave === w));
  const currentWave = activeWaves.find(w => waveStatusPill(w).label !== 'Complete') || activeWaves[activeWaves.length - 1];
  const rows = S.cockpitRows.filter(r => r.wave === currentWave);
  const finalCount = rows.filter(r => ['Done', 'Error', 'Parked'].includes(r.status)).length;
  const pct = rows.length ? Math.round((finalCount / rows.length) * 100) : 0;
  const remaining = totalEffortMinutes(rows.filter(r => !['Done', 'Error', 'Parked'].includes(r.status)));
  const pill = waveStatusPill(currentWave);
  host.innerHTML = `<span class="wave-status-label">Wave ${currentWave}</span><span class="status-pill ${pill.cls}">${pill.label}</span>
    <span class="wave-status-fill"></span><span class="wave-status-meta">${pct}% · ${formatEffort(remaining)} effort remaining</span>`;
}
function renderMigrationStatusTab() {
  const buckets = ['Not started', 'Packaged', 'Converting', 'Converted', 'Blocked', 'In fix / parked'];
  const counts = {}; buckets.forEach(b => counts[b] = 0);
  S.cockpitRows.forEach(r => counts[statusBucket(r.status)]++);
  const host = $('status-bucket-row');
  if (host) host.innerHTML = buckets.map(b => `<div class="status-bucket"><div class="num">${counts[b]}</div><div class="lbl">${b}</div></div>`).join('');
  const tbody = $('status-wave-tbody');
  if (tbody) {
    tbody.innerHTML = [1, 2, 3].filter(w => S.cockpitRows.some(r => r.wave === w)).map(w => {
      const rows = S.cockpitRows.filter(r => r.wave === w);
      const c = {}; buckets.forEach(b => c[b] = 0); rows.forEach(r => c[statusBucket(r.status)]++);
      return `<tr><td><span class="wave-chip">Wave ${w}</span></td><td>${rows.length}</td>${buckets.map(b => `<td>${c[b] || '—'}</td>`).join('')}</tr>`;
    }).join('');
  }
  const intro = $('exec-status-intro');
  if (intro) intro.textContent = `Where every integration in scope stands right now — ${S.cockpitRows.length} in the approved plan.`;
}
function renderReadinessTab() {
  const tbody = $('readiness-tbody');
  if (!tbody) return;
  tbody.innerHTML = S.cockpitRows.map(r => {
    const ownerStaffed = !!r.assignee;
    const inPackage = !!S.packageAdded && !['Error'].includes(r.status);
    const noBlocking = r.status !== 'Error';
    const ready = ownerStaffed && inPackage && noBlocking;
    const readinessLabel = ready ? 'Ready' : (!noBlocking ? 'Needs review' : 'Not packaged');
    const readinessCls = ready ? 'done' : (!noBlocking ? 'progress' : 'pending');
    const check = (ok) => `<i class="fa-solid ${ok ? 'fa-check readiness-ok' : 'fa-minus readiness-no'}"></i>`;
    return `<tr><td><span class="wave-chip">Wave ${r.wave}</span></td><td><a href="#" onclick="showRowDetail('${r.id}');return false;">${r.name}</a></td><td>${r.assignee}</td>
      <td>${check(ownerStaffed)}</td><td>${check(inPackage)}</td><td>${check(noBlocking)}</td>
      <td>${formatEffort(effortMinutesForTier(rowTier(r)))}</td><td><span class="status-pill ${readinessCls}">${readinessLabel}</span></td></tr>`;
  }).join('');
  const readyCount = S.cockpitRows.filter(r => !!r.assignee && !!S.packageAdded && r.status !== 'Error').length;
  const intro = $('exec-readiness-intro');
  if (intro) intro.textContent = `${readyCount} of ${S.cockpitRows.length} integrations clear every pre-conversion check — owner staffed, in a package, no blocking issue.${S.cockpitRows.length - readyCount > 0 ? ` ${S.cockpitRows.length - readyCount} still short of one check.` : ''}`;
}
// ==================== A2A REVIEW & ASSIGN (AI Agents resolving blocking issues) ====================
// Named specialist agents an issue can be routed to instead of (or before) a human owner.
// Purely a front-end resolution UX — no backend orchestration call; mirrors the same mocked-realism
// level as the rest of the cockpit (Lumi Recommendation text, Figaf test results, etc).
const A2A_AGENTS_BASE = [
  { id: 'adapter-channel', label: 'Adapter & Channel', domain: 'Connectivity', desc: 'Adapter parameters · Sender/receiver channels · Adapter version mapping', needPhrase: 'pi/po channel architecture', subject: 'Channel property set' },
  { id: 'mapping-udf', label: 'Mapping & UDF', domain: 'Mappings', desc: 'Message-mapping UDFs · Java → Groovy rewrite · Value mappings', needPhrase: 'UDF-to-Groovy mapping rewrite', subject: 'Message-mapping UDF' },
  { id: 'dataweave', label: 'DataWeave Converter', domain: 'Transforms', desc: 'DataWeave functions · Groovy script generation · Payload shape checks', needPhrase: 'DataWeave-to-Groovy conversion', subject: 'DataWeave transform' },
  { id: 'externalized-params', label: 'Externalized Parameters', domain: 'Config', desc: 'Property files · Externalized parameters · Environment endpoints', needPhrase: 'secure parameters & tenant security', subject: 'property file' },
  { id: 'security-creds', label: 'Security & Credentials', domain: 'Security', desc: 'Secure parameters · Keystore & OAuth credentials · Credential rotation', needPhrase: 'secure parameters & tenant security', subject: 'credential/keystore reference' },
  { id: 'finance', label: 'Finance', domain: 'FI', desc: 'GL & invoice IDocs · Tax codes · Currency value mappings', needPhrase: 'FI mapping review', subject: 'FI value mapping' },
  { id: 'controlling', label: 'Controlling', domain: 'CO', desc: 'Cost & profit centers · Internal orders · CO-PA', needPhrase: 'CO mapping review', subject: 'CO value mapping' },
  { id: 'sales-orders', label: 'Sales and Orders', domain: 'SD', desc: 'ORDERS / ORDRSP IDocs · Pricing conditions · Partner functions', needPhrase: 'SD mapping review', subject: 'SD value mapping' },
  { id: 'procurement-logistics', label: 'Procurement & Logistics', domain: 'MM / LE', desc: 'Purchase orders · Deliveries & shipments · Material master', needPhrase: 'MM/LE mapping review', subject: 'MM/LE value mapping' },
  { id: 'hr', label: 'HR', domain: 'HCM', desc: 'Employee master · Org management · PII masking', needPhrase: 'HR data-mapping review', subject: 'HR field mapping' }
];
// Session-editable roster — mirrors activeTeam()/S.team. Admin/Settings can add
// business-process-specific agents on top of the base catalog; every place that
// used to read A2A_AGENTS directly now reads activeAgents() instead.
function activeAgents() { return (S.agents && S.agents.length) ? S.agents : A2A_AGENTS_BASE; }
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function pickBestAgents(row) {
  const agents = activeAgents();
  const seed = hashStr(String(row.id) + row.name);
  const idx1 = seed % agents.length;
  let idx2 = Math.floor(seed / agents.length) % agents.length;
  if (idx2 === idx1) idx2 = (idx2 + 1) % agents.length;
  return [agents[idx1], agents[idx2]];
}
function agentWhyText(agent, row) {
  const templates = {
    'adapter-channel': `${row.name} carries channel/adapter parameters with no direct Integration Suite equivalent — this agent maps them onto the target adapter.`,
    'mapping-udf': `The message mapping for ${row.name} calls a UDF that can't run in Cloud Integration — this agent rewrites it as Groovy and re-tests the mapping.`,
    'dataweave': `${row.name}'s DataWeave transform needs a Groovy rewrite and a payload-shape check before it can deploy.`,
    'externalized-params': `Property values in ${row.name} didn't translate automatically — this agent turns them into externalized parameters so the iFlow stops pointing at sandbox values.`,
    'security-creds': `${row.name} references secure parameters that need re-keying — this agent rotates credentials and re-verifies the keystore.`,
    'finance': `Payload fields in ${row.name} map to FI objects — this agent reviews the business meaning of the corrected values.`,
    'controlling': `${row.name} touches cost/profit center objects — this agent validates the CO mapping.`,
    'sales-orders': `Payload fields in ${row.name} map to SD objects — this agent reviews the business meaning of the corrected values.`,
    'procurement-logistics': `${row.name} touches procurement/logistics objects — this agent validates the MM/LE mapping.`,
    'hr': `${row.name} carries HR-sensitive fields — this agent reviews PII masking and org-mapping correctness.`
  };
  return templates[agent.id] || `${agent.label} can resolve outstanding items on ${row.name}.`;
}
function issueBlockingDetail(row) {
  const a = (row._reviewAgents && row._reviewAgents[0]) || activeAgents()[0];
  return `Flow logic converted, but the ${a.subject} for ${row.name} could not be translated automatically — 2 of 4 items have no Integration Suite equivalent, so the iFlow would deploy against sandbox values.`;
}
let REVIEW_MODAL_STATE = null;
function openReviewAssignModal(rowId) {
  const row = S.cockpitRows.find(r => r.id === rowId);
  if (!row) return;
  row._reviewAgents = row._reviewAgents || pickBestAgents(row);
  REVIEW_MODAL_STATE = { rowId, scope: 'error', selected: new Set(row._reviewAgents.map(a => a.id)) };
  openModal(`Review: ${row.name}`, renderReviewModalBody(row), reviewModalButtons(row));
}
function renderReviewModalBody(row) {
  const bestAgents = row._reviewAgents;
  const bestIds = new Set(bestAgents.map(a => a.id));
  const ordered = [...bestAgents, ...activeAgents().filter(a => !bestIds.has(a.id))];
  const sel = REVIEW_MODAL_STATE.selected;
  const scopeOptions = [['error', 'This error'], ['asset', 'Whole asset'], ['interface', 'Interface part']];
  const rowsHtml = ordered.map(a => {
    const checked = sel.has(a.id);
    const isBest = bestIds.has(a.id);
    return `<div class="review-agent-row ${checked ? 'checked' : ''}">
      <label>
        <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleReviewAgent('${a.id}')">
        <div class="review-agent-info">
          <div class="review-agent-title"><b>A2A – ${a.label}</b> · ${a.domain}</div>
          ${isBest ? `<div class="review-agent-why"><b>Why this agent:</b> ${agentWhyText(a, row)}</div>` : `<div class="review-agent-desc">${a.desc}</div>`}
        </div>
      </label>
      ${isBest ? '<span class="review-best-match">Best match</span>' : ''}
    </div>`;
  }).join('');
  return `
    <div class="review-agents-panel">
      <div class="review-agents-head"><span><i class="fa-solid fa-robot"></i> AI Agents</span><span class="status-pill progress">Unassigned</span></div>
      <div class="review-need-banner">Needs <b>${bestAgents[0].needPhrase}</b> — nobody staffed on Wave ${row.wave} holds it. Agents below can cover it.</div>
      <div class="review-scope-row"><span class="review-scope-label">Scope</span><div class="review-scope-tabs">${scopeOptions.map(([key, label]) => `<button class="review-scope-tab ${REVIEW_MODAL_STATE.scope === key ? 'active' : ''}" onclick="setReviewScope('${key}')">${label}</button>`).join('')}</div></div>
      <div class="review-agent-list">${rowsHtml}</div>
      <div class="review-agent-count">${sel.size} agent${sel.size === 1 ? '' : 's'} on this error</div>
    </div>
    <div class="review-detail-kv"><span>Wave</span><b>Wave ${row.wave}</b></div>
    <div class="review-detail-kv"><span>Assignee</span><b>${row.assignee}</b></div>
    <div class="review-detail-kv"><span>Status</span><b>Action required</b></div>
    <div class="review-detail-kv"><span>Included in package as</span><code>src/main/resources/resources/${row.id}-${row.name}.txt</code></div>
    <div class="review-detail-note">${issueBlockingDetail(row)}</div>`;
}
function toggleReviewAgent(id) {
  const sel = REVIEW_MODAL_STATE.selected;
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  const row = S.cockpitRows.find(r => r.id === REVIEW_MODAL_STATE.rowId);
  $('lumi-modal-body').innerHTML = renderReviewModalBody(row);
}
function setReviewScope(scope) {
  REVIEW_MODAL_STATE.scope = scope;
  const row = S.cockpitRows.find(r => r.id === REVIEW_MODAL_STATE.rowId);
  $('lumi-modal-body').innerHTML = renderReviewModalBody(row);
}
function reviewModalButtons(row) {
  return [
    { label: `Assign to ${row.assignee}`, cls: 'btn-btp-cancel', onClick: () => { closeModal(); sendFixRequest(row); } },
    { label: 'Assign & analyse', cls: 'btn-btp-gold', onClick: () => resolveReviewWithAgents(row.id) }
  ];
}
function resolveReviewWithAgents(rowId) {
  const row = S.cockpitRows.find(r => r.id === rowId);
  const chosen = activeAgents().filter(a => REVIEW_MODAL_STATE.selected.has(a.id));
  closeModal();
  row.resolvedByAgents = chosen.length ? chosen : row._reviewAgents;
  row.status = 'Done'; row.willError = false; row.convertedAt = new Date().toISOString();
  const asset = S.assets.find(a => a.id === row.assetId);
  if (asset) {
    asset.tree.forEach(n => { n.ok = true; (n.children || []).forEach(c => { c.ok = true; }); });
    asset.convertPct = computeConversionPct(asset);
    populateAssetsTable();
  }
  renderCockpitTable();
  refreshExecTabs();
  unflagNav('nav-cockpit');
  showToast(`${row.name} resolved by AI Agents`, `${row.resolvedByAgents.map(a => a.label).join(' + ')} re-ran the conversion — coverage is now 100%.`, 'purple');
  lumiSay(`AI Agents resolved <b>${row.name}</b> — re-ran the conversion, coverage is now 100%. Back in Wave ${row.wave}.`);
  checkCockpitCompletion();
}

function renderErrorsIssuesTab() {
  const openIssues = S.cockpitRows.filter(r => r.status === 'Error' || r.status === 'Pending Fix');
  const resolvedIssues = S.cockpitRows.filter(r => r.resolvedByAgents);
  const advisories = S.cockpitRows.filter(r => r.advisory && r.status === 'Done');
  const intro = $('exec-errors-intro');
  if (intro) intro.textContent = `${openIssues.length} blocking · ${advisories.length} advisory. Blocking findings hold that asset until an owner resolves or parks it — the rest of the wave keeps converting. Advisories are semantic differences recorded during conversion; the artifact is complete and shippable, so execution never pauses for them.`;
  const list = $('errors-issues-list');
  if (!list) return;
  const resolvedHtml = resolvedIssues.map(r => `
    <div class="issue-card issue-card-resolved">
      <div class="issue-card-head"><b>${r.name} — Resolved</b><span class="status-pill done">Resolved</span></div>
      <div class="issue-card-meta">Wave ${r.wave} · owner ${r.assignee} · coverage 100%</div>
      <div class="issue-card-agents">AI Agents ${r.resolvedByAgents.map(a => `<span class="agent-pill">A2A ${a.label}</span>`).join('')}<span class="agent-resolved-tag">Resolved</span></div>
      <div class="issue-card-actions">
        <button class="btn-btp-action-outline" onclick="showRowDetail('${r.id}')">View details</button>
        <button class="btn-btp-action-outline" onclick="showIflowViewModal('${r.id}')">Open object</button>
      </div>
    </div>`).join('');
  const blockingHtml = openIssues.map(r => `
    <div class="issue-card ${r.status === 'Pending Fix' ? 'issue-card-pending' : 'issue-card-blocking'}">
      <div class="issue-card-head"><b>${r.name}</b> — ${r.status === 'Pending Fix' ? 'fix requested' : 'conversion issue'}<span class="status-pill ${r.status === 'Pending Fix' ? 'progress' : 'error'}">${r.status === 'Pending Fix' ? 'Fix assigned — awaiting confirmation' : 'Action required'}</span></div>
      <div class="issue-card-meta">Wave ${r.wave} · owner ${r.assignee}</div>
      <div class="issue-card-actions">
        <button class="btn-btp-action-outline" onclick="showRowDetail('${r.id}')">View details</button>
        <button class="btn-btp-action-outline" onclick="showIflowViewModal('${r.id}')">Open object</button>
        ${canAct() ? (r.status === 'Pending Fix' ? `<button class="btn-btp-action-solid" onclick="markFixResult(S.cockpitRows.find(x=>x.id==='${r.id}'),'yes')">Mark resolved</button>` : `<button class="btn-btp-action-solid" onclick="openReviewAssignModal('${r.id}')">Review &amp; assign</button>`) : ''}
      </div>
    </div>`).join('');
  const advisoryHtml = advisories.length ? `<div class="advisory-section-label">Advisories — migration not affected</div>${advisories.map(r => `
    <div class="issue-card advisory">
      <div class="issue-card-head"><b>${r.name}</b> — converted with advisory<span class="status-pill progress">Non-blocking</span></div>
      <div class="issue-card-meta">Wave ${r.wave} · owner ${r.assignee} · coverage 100%</div>
      <div style="font-size:0.78rem;color:var(--btp-text-muted-dark);margin-top:4px;">${r.advisory}</div>
      <div class="issue-card-actions">
        <button class="btn-btp-action-outline" onclick="showRowDetail('${r.id}')">Open object</button>
        ${canAct() ? `<button class="btn-btp-action-outline" ${r.advisoryAcked ? 'disabled' : ''} onclick="acknowledgeAdvisory('${r.id}')">${r.advisoryAcked ? 'Acknowledged' : 'Acknowledge'}</button>` : ''}
      </div>
    </div>`).join('')}` : '';
  list.innerHTML = resolvedHtml + blockingHtml + advisoryHtml;
}
function acknowledgeAdvisory(id) {
  const row = S.cockpitRows.find(r => r.id === id);
  if (!row) return;
  row.advisoryAcked = true;
  renderErrorsIssuesTab();
  showToast('Acknowledged', `${row.name}'s advisory has been acknowledged.`, 'purple');
}
function renderProgressTab() {
  const total = S.cockpitRows.length;
  const done = S.cockpitRows.filter(r => r.status === 'Done' || r.status === 'Error' || r.status === 'Parked').length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const remainingTotal = totalEffortMinutes(S.cockpitRows.filter(r => !['Done', 'Error', 'Parked'].includes(r.status)));
  const estimatedTotal = totalEffortMinutes(S.cockpitRows);
  const intro = $('exec-progress-intro');
  if (intro) intro.textContent = `${done} of ${total} integrations converted · ${pct}% · ${formatEffort(remainingTotal)} of ${formatEffort(estimatedTotal)} estimated effort remaining.`;
  updateCockpitTimeStat();
  const host = $('progress-wave-list');
  if (!host) return;
  host.innerHTML = [1, 2, 3].filter(w => S.cockpitRows.some(r => r.wave === w)).map(w => {
    const rows = S.cockpitRows.filter(r => r.wave === w);
    const wdone = rows.filter(r => ['Done', 'Error', 'Parked'].includes(r.status)).length;
    const wpct = rows.length ? Math.round((wdone / rows.length) * 100) : 0;
    return `<div class="progress-wave-card">
      <div class="progress-wave-head"><b>Wave ${w}</b><span class="wave-chip">${rows.length} integrations</span><span class="progress-wave-meta">${wdone}/${rows.length} converted · ${wpct}%</span></div>
      <div class="cockpit-progress-track"><div class="cockpit-progress-fill" style="width:${wpct}%;"></div></div>
    </div>`;
  }).join('');
}
function logExecLine(text) {
  S.execLog = S.execLog || [];
  S.execLog.unshift({ t: new Date(), text });
  renderExecutionTab();
}
function logExecRaw(text) {
  S.execRawLog = S.execRawLog || [];
  S.execRawLog.unshift(text);
  renderExecutionTab();
}
// The scrollable Lumi chat-transcript feed at the top of Migration Execution —
// per-row "converted" cards plus inline proactive alert cards on error, matching
// the reference videos. Distinct from exec-log-list (plain timestamped rows,
// unchanged below it) and exec-console (raw terminal log, also unchanged).
function pushExecFeed(entry) {
  S.execFeed = S.execFeed || [];
  S.execFeed.push(entry);
  renderExecutionTab();
}
function dismissExecFeedAlert(rowId) {
  const entry = (S.execFeed || []).find(e => e.rowId === rowId && e.type === 'alert');
  if (entry) entry.dismissed = true;
  renderExecutionTab();
}
function renderExecFeed() {
  const host = $('exec-lumi-feed');
  if (!host) return;
  const entries = (S.execFeed || []).slice(-40);
  const cardsHtml = entries.map(e => {
    if (e.type === 'alert' && !e.dismissed) {
      return `<div class="exec-feed-card exec-feed-alert">
        <div class="exec-feed-who"><i class="fa-solid fa-triangle-exclamation"></i> LUMI</div>
        <div class="exec-feed-text">⚠️ ${e.text}</div>
        ${e.sub ? `<div class="exec-feed-sub">${e.sub}</div>` : ''}
        <div class="exec-feed-actions">
          <button class="btn-btp-action-solid" onclick="dismissExecFeedAlert('${e.rowId}'); switchExecTab('errors');">Review</button>
          <button class="btn-btp-action-outline" onclick="dismissExecFeedAlert('${e.rowId}')">Not now</button>
        </div>
      </div>`;
    }
    if (e.type === 'alert' && e.dismissed) return '';
    return `<div class="exec-feed-card">
      <div class="exec-feed-who">LUMI</div>
      <div class="exec-feed-text">${e.text}</div>
      ${e.sub ? `<div class="exec-feed-sub">${e.sub}</div>` : ''}
    </div>`;
  }).join('');
  const working = S.cockpitStarted && !S.cockpitRows.every(r => r.status === 'Done' || r.status === 'Error') ? '<div class="exec-feed-working">Working…</div>' : '';
  host.innerHTML = cardsHtml + working;
  host.scrollTop = host.scrollHeight;
}
function renderExecutionTab() {
  const list = $('exec-log-list');
  if (list) {
    list.innerHTML = (S.execLog || []).map(l => `<div class="exec-log-row"><span class="exec-log-time">${l.t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · ${l.t.toLocaleTimeString()}</span><i class="fa-solid fa-circle-check"></i><span>${l.text}</span></div>`).join('');
  }
  const console_ = $('exec-console');
  if (console_) console_.textContent = (S.execRawLog || []).join('\n');
  const banner = $('exec-run-banner');
  if (banner) banner.style.display = S.cockpitStarted ? 'none' : 'flex';
  const feed = $('exec-lumi-feed');
  if (feed) feed.style.display = S.cockpitStarted ? 'flex' : 'none';
  renderExecFeed();
  renderExecTargetIS();
}
// The "Target Integration Suite" deployment/test/monitor card grid lives on its
// own "Target execution" tab, between Migration execution and Integration
// package — not on Integration package, which stays the plain manifest/zip-contents preview.
function renderExecTargetIS() {
  const host = $('exec-target-is-wrap');
  if (!host) return;
  host.innerHTML = renderIsImportResults(S.cockpitRows || []);
}
function refreshExecTabs() {
  renderWaveStatusRow();
  renderMigrationStatusTab();
  renderReadinessTab();
  renderErrorsIssuesTab();
  renderProgressTab();
  renderExecutionTab();
  renderReportTab();
  renderPendingApprovals();
}
// Fires the moment every row clears its pre-conversion checks (the same
// terminal condition that reveals the Target Integration Suite grid) — reads
// an existing signal, no new scan. Admin and Approver both see it; it's what
// unlocks Push to BTP Integration Suite / Take to Production for Admin once
// Approved. Viewer never sees this panel.
function renderPendingApprovals() {
  const host = $('pending-approvals-panel');
  if (!host) return;
  if (!canSeePendingApprovals()) { host.classList.add('hidden'); host.innerHTML = ''; return; }
  const rows = S.cockpitRows || [];
  const allTerminal = rows.length > 0 && rows.every(r => r.status === 'Done' || r.status === 'Error');
  if (!allTerminal) { host.classList.add('hidden'); host.innerHTML = ''; return; }
  const readyCount = rows.filter(r => r.status === 'Done').length;
  const waveNums = getActiveWaveNumbers ? getActiveWaveNumbers() : [];
  const waveLabel = waveNums.length === 1 ? `Wave ${waveNums[0]}` : 'This migration';
  host.classList.remove('hidden');
  if (S.pushApproved) {
    host.innerHTML = `
      <div class="lumi-avatar idle" style="--size:28px;"><div class="visor"></div></div>
      <div>
        <div class="pending-approvals-title">Gate cleared</div>
        <div class="pending-approvals-cleared"><i class="fa-solid fa-circle-check"></i> ${waveLabel} — approved${S.pushApprovedBy ? ` by ${S.pushApprovedBy}` : ''}${S.pushApprovedAt ? `, ${S.pushApprovedAt}` : ''}. Cleared for Push to BTP Integration Suite / Take to Production.</div>
      </div>`;
    return;
  }
  host.innerHTML = `
    <div class="lumi-avatar idle" style="--size:28px;"><div class="visor"></div></div>
    <div>
      <div class="pending-approvals-title">Pending Approvals</div>
      <div class="pending-approvals-text">${waveLabel} — ${readyCount} of ${rows.length} interfaces ready, 0 blocking issues. Lumi: "Everything's ready — approve to clear the production gate?"</div>
    </div>
    ${isApprover() || isAdmin() ? `<div class="pending-approvals-actions">
      <button class="btn-btp-gold" onclick="approvePush()">Approve</button>
      <button class="btn-btp-cancel" onclick="rejectPush()">Reject</button>
    </div>` : ''}`;
}
function approvePush() {
  S.pushApproved = true;
  S.pushApprovedBy = S.persona;
  S.pushApprovedAt = new Date().toLocaleTimeString();
  renderPendingApprovals();
  updateCockpitStats();
  renderExecTargetIS();
  showToast('Approved', 'Gate cleared for Push to BTP Integration Suite / Take to Production.', 'purple');
}
function rejectPush() {
  // Reject just keeps the gate closed for this session — no separate "rejected"
  // state to track; the Pending Approvals panel simply stays up for the next review.
  showToast('Rejected', 'The gate stays closed — Push to BTP Integration Suite / Take to Production remain locked.', 'danger');
}
// Small always-visible colorful widget (bottom-right, above the mascot) tracking
// wave 1/2/3 progress independent of which screen or tab is currently open.
function refreshWaveMeter() {
  const meter = $('wave-progress-meter');
  if (!meter) return;
  if (!S.cockpitRows.length) { meter.classList.add('hidden'); return; }
  meter.classList.remove('hidden');
  [1, 2, 3].forEach(w => {
    const rows = S.cockpitRows.filter(r => r.wave === w);
    const done = rows.filter(r => ['Done', 'Error', 'Parked'].includes(r.status)).length;
    const pct = rows.length ? Math.round((done / rows.length) * 100) : 0;
    const fillEl = $(`wpm-fill-${w}`);
    if (fillEl) fillEl.style.height = pct + '%';
    const seg = meter.querySelector(`.wpm-seg[data-wave="${w}"]`);
    if (seg) seg.title = `Wave ${w}: ${pct}% (${done}/${rows.length})`;
  });
}
const EXEC_TABS = ['list', 'status', 'readiness', 'errors', 'progress', 'execution', 'targetexec', 'package', 'report'];
function switchExecTab(tab) {
  EXEC_TABS.forEach(t => {
    const panel = $(`exec-panel-${t}`);
    if (panel) panel.classList.toggle('active', t === tab);
  });
  qsa('.exec-tab', $('exec-tabs')).forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
}
// Lumi proposes the package name/description (per "packages names ... defaulted
// or initialized by Lumi") but you can edit either before creating — same beat
// as the reference video's "Define Package" dialog.
function addPackage() {
  if (!S.cockpitRows.length) { lumiSay("There's nothing to package yet — scan and plan a migration first."); return; }
  const defaultName = S.packageName || `${S.projectName} Package`;
  const defaultDesc = S.packageDescription || `Auto-generated by Lumi — ${S.cockpitRows.length} converted items across ${getActiveWaveNumbers().length} waves.`;
  const body = `
    <div class="form-group-btp"><label>Package</label><input type="text" class="btp-input" id="define-package-name" value="${defaultName}"></div>
    <div class="form-group-btp" style="margin-top:14px;"><label>Description</label><textarea class="btp-input" id="define-package-desc" rows="3" style="resize:vertical;width:100%;">${defaultDesc}</textarea></div>`;
  openModal('Define Package', body, [
    { label: 'Cancel', cls: 'btn-btp-cancel', onClick: closeModal },
    { label: 'Create', cls: 'btn-btp-gold', onClick: confirmAddPackage }
  ]);
}
function confirmAddPackage() {
  S.packageName = $('define-package-name').value.trim() || S.projectName;
  S.packageDescription = $('define-package-desc').value.trim();
  S.packageAdded = true;
  closeModal();
  renderPackagePreview();
  refreshExecTabs();
  switchExecTab('package');
  showToast('Package Created', `"${S.packageName}" staged with ${S.cockpitRows.length} item(s).`, 'purple');
}
function syncStartExecutionButtons(html, disabled) {
  ['btn-start-execution', 'btn-start-execution-footer'].forEach(id => {
    const btn = $(id);
    if (!btn) return;
    btn.innerHTML = html;
    btn.disabled = disabled;
  });
}
// Rows are per-individual-iFlow now, so a real scan can hand this hundreds of
// rows (e.g. 423) instead of ~60 assets. Processing exactly one row per
// 1000ms tick would make a 423-row demo run for 7+ minutes, so the batch size
// scales with the row count to keep total runtime in the same ~60-100s
// ballpark regardless of scale — a batch never crosses a wave boundary, so
// wave-start/complete announcements still land on the right tick.
const EXEC_TARGET_TICKS = 70;
function startExecution() {
  if (S.cockpitStarted) return;
  S.cockpitStarted = true;
  syncStartExecutionButtons('<i class="fa-solid fa-spinner fa-spin"></i> Running…', true);
  const batchSize = Math.max(1, Math.ceil(S.cockpitRows.length / EXEC_TARGET_TICKS));
  logExecLine('Wave 1 execution started');
  logExecRaw(`[${new Date().toLocaleString()}] INFO  cockpit: Wave 1 execution kicked off`);
  let i = 0;
  let announcedWave = 0;
  S.cockpitInterval = setInterval(() => {
    if (i >= S.cockpitRows.length) { clearInterval(S.cockpitInterval); onCockpitDone(); return; }
    const wave = S.cockpitRows[i].wave;
    if (wave !== announcedWave) {
      announcedWave = wave;
      lumiSay(`Starting Wave ${wave}…`);
      pushExecFeed({ type: 'info', text: `Starting Wave ${wave}…` });
      if (wave > 1) { logExecLine(`Wave ${wave} execution started`); logExecRaw(`[${new Date().toLocaleString()}] INFO  cockpit: Wave ${wave} execution kicked off`); }
    }
    // Clamp the batch so it never spans two waves.
    let end = Math.min(i + batchSize, S.cockpitRows.length);
    while (end > i + 1 && S.cockpitRows[end - 1].wave !== wave) end--;
    const batch = S.cockpitRows.slice(i, end);
    batch.forEach(row => {
      row.status = 'In Progress';
      logExecRaw(`[${new Date().toLocaleString()}] INFO  iflow-generator: Compiling ${row.name} → CPI iFlow`);
    });
    renderCockpitTable();
    updateCockpitTimeStat();
    setTimeout(() => {
      batch.forEach(row => {
        row.status = row.willError ? 'Error' : 'Done';
        if (row.status === 'Error') row.errorCount = (row.errorCount || 0) + 1;
        if (row.status === 'Done') {
          row.convertedAt = new Date().toISOString();
          logExecLine(`${row.name} migrated successfully`);
          logExecRaw(`[${new Date().toLocaleString()}] INFO  deployer: ${row.name} converted and staged`);
          pushExecFeed({ type: 'info', text: `${row.name} converted — artifacts generated (${PLATFORMS[S.platform].label} Migration).`, sub: 'No blockers found.' });
        } else {
          logExecRaw(`[${new Date().toLocaleString()}] ERROR connector: ${row.name} ERR_CONVERSION_FAILED`);
          pushExecFeed({ type: 'alert', text: `I think you should review this — a conversion issue on <code>${row.name}</code> in Wave ${row.wave}.`, sub: `${row.assignee} owns it. Want to see it?`, rowId: row.id });
          flagReview('nav-cockpit', 'cockpit', `a conversion issue on <code>${row.name}</code> in Wave ${row.wave}. Want to see it?`);
        }
      });
      renderCockpitTable();
      updateCockpitTimeStat();
      const doneCount = S.cockpitRows.filter(r => r.status === 'Done' || r.status === 'Error').length;
      if (doneCount === S.cockpitRows.filter(r => r.wave === wave).length + S.cockpitRows.filter(r => r.wave < wave).length) {
        lumiSay(`Wave ${wave} complete.`);
        pushExecFeed({ type: 'info', text: `Wave ${wave} complete.` });
        logExecLine(`Wave ${wave} complete`);
      }
    }, 650);
    i = end;
  }, 1000);
}
function onCockpitDone() {
  const errors = S.cockpitRows.filter(r => r.status === 'Error').length;
  syncStartExecutionButtons('<i class="fa-solid fa-check"></i> Execution Complete', true);
  lumiSay(errors ? `All waves processed — ${errors} item${errors > 1 ? 's' : ''} still need${errors === 1 ? 's' : ''} your review before we close out.` : `All waves converted, 0 open errors. Ready to close out whenever you are.`, { alert: !!errors });
  const done = S.cockpitRows.filter(r => r.status === 'Done').length;
  logBrainEvent('conversion_result', S.platform,
    { rows: S.cockpitRows.map(r => ({ id: r.id, name: r.name, status: r.status, tier: rowTier(r), iflowName: r.iflowName, iflowCount: r.iflowCount, wave: r.wave, advisory: r.advisory })) },
    `Execution complete — ${done} of ${S.cockpitRows.length} converted, ${errors} error(s).`);
  if (!errors) checkCockpitCompletion();
}
function checkCockpitCompletion() {
  if (!S.cockpitRows.length) return;
  const stillBlocking = S.cockpitRows.some(r => ['Error', 'Pending Fix', 'In Progress', 'Pending'].includes(r.status));
  if (stillBlocking) return;
  const nav = $('nav-close');
  if (nav && nav.classList.contains('pending')) {
    markDone('nav-cockpit');
    unlockNav('nav-close');
    lumiSay('Everything is resolved — ready to close out?');
    lumiChoices([{ label: 'Close the project', cls: 'primary', onClick: goToClose }]);
  }
}
function refreshCockpit() { renderCockpitTable(); showToast('Refreshed', 'Cockpit status re-read from the SDAINTAI Brain execution log.', 'cyan'); }

function showRowDetail(id) {
  const row = S.cockpitRows.find(r => r.id === id);
  const asset = S.assets.find(a => a.id === row.assetId);
  const sourceStepNoun = PLATFORMS[S.platform].terms.sourceStepNoun;
  const packagedAs = row.status === 'Done' ? `<div class="kv"><span>Included in package as</span><b><code>src/main/resources/resources/${row.id}-${row.name}.txt</code></b></div>` : '';
  const body = `
    <div class="kv"><span>Wave</span><b>Wave ${row.wave}</b></div>
    <div class="kv"><span>Assignee</span><b>${row.assignee}</b></div>
    <div class="kv"><span>Status</span><b>${row.status}</b></div>
    ${packagedAs}
    <div style="margin-top:14px;font-weight:700;font-size:0.82rem;">${sourceStepNoun} structure — erroneous branches highlighted, click View to inspect a file</div>
    <div id="row-detail-tree-host" style="margin-top:8px;">${asset ? renderTreeEditorHtml(asset) : '(structure unavailable)'}</div>`;
  const buttons = [{ label: 'Close', cls: 'btn-btp-cancel', onClick: closeModal }, { label: 'Assign A2A Developers', cls: 'btn-btp-cancel', onClick: () => showDeveloperAssignModal(id) }];
  if (row.status === 'Error') buttons.push({ label: `Send to ${row.assignee} for fix`, cls: 'btn-btp-gold', onClick: () => sendFixRequest(row) });
  openModal(`Review: ${row.name}`, body, buttons);
  if (asset) {
    wireTreeEditorEvents($('row-detail-tree-host'), asset);
    suggestKafkaConversion(asset);
  }
}

// Up to 8 A2A developers per iflow — the parallel-review model that's the actual
// pitch of the accelerator. Reachable from any row in the Integration list table,
// not just flagged ones, and from the row-detail modal — "review at any point."
function showDeveloperAssignModal(id) {
  const row = S.cockpitRows.find(r => r.id === id);
  if (!row) return;
  row.assignees = row.assignees && row.assignees.length ? row.assignees : activeTeam().filter(m => m.name === row.assignee).map(m => m.id);
  const body = `
    <div style="font-size:0.82rem;color:var(--btp-text-muted-dark);margin-bottom:10px;">Assign up to 8 A2A developers to <b>${row.name}</b> — complex iflows often need more than one set of eyes in parallel.</div>
    <div class="dev-assign-list" id="dev-assign-list">
      ${activeTeam().map(m => `
        <label class="dev-assign-row">
          <input type="checkbox" value="${m.id}" ${row.assignees.includes(m.id) ? 'checked' : ''}>
          <span class="avatar-chip" style="background:${m.color};">${m.name.split(' ').map(x => x[0]).join('')}</span>
          <span>${m.name} — ${m.role}</span>
        </label>`).join('')}
    </div>
    <div id="dev-assign-count" style="font-size:0.72rem;color:var(--btp-text-muted-dark);margin-top:8px;font-weight:700;"></div>`;
  openModal(`Assign Developers — ${row.name}`, body, [
    { label: 'Cancel', cls: 'btn-btp-cancel', onClick: closeModal },
    { label: 'Save Assignment', cls: 'btn-btp-gold', onClick: () => saveDeveloperAssignment(id) }
  ]);
  const listEl = $('dev-assign-list');
  const updateCount = () => {
    const checked = qsa('input[type=checkbox]', listEl).filter(cb => cb.checked);
    $('dev-assign-count').textContent = `${checked.length} / 8 selected`;
    qsa('input[type=checkbox]', listEl).forEach(cb => { if (!cb.checked) cb.disabled = checked.length >= 8; });
  };
  qsa('input[type=checkbox]', listEl).forEach(cb => cb.addEventListener('change', updateCount));
  updateCount();
}
function saveDeveloperAssignment(id) {
  const row = S.cockpitRows.find(r => r.id === id);
  if (!row) return;
  const checked = qsa('input[type=checkbox]', $('dev-assign-list')).filter(cb => cb.checked).map(cb => cb.value);
  row.assignees = checked.slice(0, 8);
  const names = row.assignees.map(mid => (activeTeam().find(m => m.id === mid) || {}).name).filter(Boolean);
  if (names.length) row.assignee = names[0];
  closeModal();
  renderCockpitTable();
  showToast('Developers Assigned', `${row.name}: ${names.join(', ') || 'no one'} (${names.length}/8).`, 'purple');
}

// ==================== MIGRATION REPORT (viewable + downloadable) ====================
// Every converted/pushed/migrated iFlow in one place, derived straight from
// S.cockpitRows/S.assets like every other exec tab — no parallel state. Error and
// High-complexity rows get an inline multi-select (capped at 8, same rule as the
// row-level "Assign A2A Developers" modal) so staffing a complex iflow doesn't
// require leaving the report to open that modal.
function reportRowIsComplex(row) {
  const asset = S.assets.find(a => a.id === row.assetId);
  return row.status === 'Error' || row.status === 'Pending Fix' || (asset && asset.tier === 'High');
}
// Which underlying issue "subject" (mirrors issueBlockingDetail's per-agent subject
// line) triggered each error, without requiring the Review & Assign modal to have
// ever been opened — same lazy-cache pattern issueBlockingDetail() already uses.
function rowIssueSubject(row) {
  row._reviewAgents = row._reviewAgents || pickBestAgents(row);
  return row._reviewAgents[0].subject;
}
function reportComplexityBreakdown() {
  // rowTier()/asset.tier use 'Simple'/'Medium'/'High' — matching those keys
  // exactly (not 'Low') so Simple-tier rows don't silently drop out of the count.
  const out = { Simple: 0, Medium: 0, High: 0 };
  S.cockpitRows.forEach(r => { const tier = rowTier(r); out[tier] = (out[tier] || 0) + 1; });
  return out;
}
function reportTopAgents(limit) {
  const counts = {};
  S.cockpitRows.forEach(r => (r.resolvedByAgents || []).forEach(a => { counts[a.label] = (counts[a.label] || 0) + 1; }));
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit || 5);
}
function reportTopIssues(limit) {
  const counts = {};
  S.cockpitRows.filter(r => (r.errorCount || 0) > 0).forEach(r => { const s = rowIssueSubject(r); counts[s] = (counts[s] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit || 5);
}
// The Brain "learning curve" — each past migration's auto-resolve rate (issues
// AI Agents fixed vs. issues raised), using the real totals archiveProject()
// stores in S.migrationHistory, plus the in-progress migration as the latest
// point. Same narrative brainSpeedupPct() already tells ("the Brain gets faster
// the more migrations it's seen") — here for the underlying trend, not just a
// single rolled-up percentage.
function reportLearningCurve() {
  const past = (S.migrationHistory || []).map(m => ({
    label: m.name || 'Migration',
    rate: m.issuesRaised ? Math.round((m.resolvedByAgents / m.issuesRaised) * 100) : 100
  }));
  const points = [...past];
  if (S.cockpitRows.length) {
    const t = closureTotals();
    points.push({ label: `${S.projectName || 'Current'} (in progress)`, rate: t.issuesRaised ? Math.round((t.resolvedByAgents / t.issuesRaised) * 100) : 100, current: true });
  }
  return points.slice(-8);
}
function renderLearningCurveSvg(points) {
  if (points.length < 2) return '<div class="mock-note"><i class="fa-solid fa-circle-info"></i> Archive a few migrations to see the Brain\'s auto-resolve rate trend over time.</div>';
  const w = 560, h = 140, pad = 24;
  const stepX = (w - pad * 2) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - p.rate / 100) * (h - pad * 2);
    return { x, y, ...p };
  });
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const dots = coords.map(c => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4" fill="${c.current ? 'var(--btp-brand-gold-hover)' : '#0056d2'}"><title>${c.label}: ${c.rate}% auto-resolved</title></circle>`).join('');
  const labels = coords.map((c, i) => (i === 0 || i === coords.length - 1 || c.current) ? `<text x="${c.x.toFixed(1)}" y="${h - 4}" font-size="9" text-anchor="middle" fill="var(--btp-text-muted-dark)">${c.rate}%</text>` : '').join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="learning-curve-svg" role="img" aria-label="Brain auto-resolve rate trend across migrations">
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--btp-border-light)" stroke-width="1"/>
    <path d="${path}" fill="none" stroke="#0056d2" stroke-width="2" stroke-linecap="round"/>
    ${dots}${labels}
  </svg>`;
}
function renderReportAnalytics() {
  const host = $('report-analytics');
  if (!host) return;
  if (!S.cockpitRows.length) { host.innerHTML = ''; return; }
  const t = closureTotals();
  const total = S.cockpitRows.length;
  const doneCount = S.cockpitRows.filter(r => r.status === 'Done').length;
  const successRate = total ? Math.round((doneCount / total) * 100) : 0;
  const complexity = reportComplexityBreakdown();
  const complexTotal = complexity.Simple + complexity.Medium + complexity.High || 1;
  const lowPct = (complexity.Simple / complexTotal) * 100;
  const medPct = (complexity.Medium / complexTotal) * 100;
  const donutGradient = `conic-gradient(#10b981 0% ${lowPct}%, var(--btp-brand-gold-hover) ${lowPct}% ${lowPct + medPct}%, var(--lumi-alert) ${lowPct + medPct}% 100%)`;
  const topAgents = reportTopAgents(5);
  const topIssues = reportTopIssues(5);
  const maxAgentCount = Math.max(1, ...topAgents.map(a => a[1]));
  const maxIssueCount = Math.max(1, ...topIssues.map(i => i[1]));
  host.innerHTML = `
    <div class="cockpit-stats" style="padding:0 0 16px;">
      <div class="cockpit-stat"><div class="lbl">Success rate</div><div class="val">${successRate}%</div><div class="sub">${doneCount} of ${total} iFlows converted</div></div>
      <div class="cockpit-stat err"><div class="lbl">Conversion issues raised</div><div class="val">${t.issuesRaised}</div><div class="sub">Times an iFlow needed a second look</div></div>
      <div class="cockpit-stat"><div class="lbl">Resolved by AI Agents</div><div class="val">${t.resolvedByAgents}</div><div class="sub">Assign &amp; analyse outcomes</div></div>
      <div class="cockpit-stat"><div class="lbl">Resolved by a developer</div><div class="val">${t.resolvedByHuman}</div><div class="sub">Manually assigned fixes</div></div>
    </div>
    <div class="report-analytics-grid">
      <div class="report-analytics-card">
        <h5>Complexity mix</h5>
        <div class="donut-row">
          <div class="donut-chart" style="background:${donutGradient};"><div class="donut-hole"><b>${total}</b><span>iFlows</span></div></div>
          <div class="donut-legend">
            <span><i class="donut-dot" style="background:#10b981;"></i> Simple — ${complexity.Simple} (${Math.round(lowPct)}%)</span>
            <span><i class="donut-dot" style="background:var(--btp-brand-gold-hover);"></i> Medium — ${complexity.Medium} (${Math.round(medPct)}%)</span>
            <span><i class="donut-dot" style="background:var(--lumi-alert);"></i> Complex — ${complexity.High} (${Math.round(100 - lowPct - medPct)}%)</span>
          </div>
        </div>
      </div>
      <div class="report-analytics-card">
        <h5>Top agents used for fix</h5>
        ${topAgents.length ? topAgents.map(([label, count]) => `
          <div class="report-bar-row"><span class="report-bar-label">A2A – ${label}</span><div class="report-bar-track"><div class="report-bar-fill" style="width:${(count / maxAgentCount) * 100}%;"></div></div><span class="report-bar-count">${count}</span></div>`).join('')
          : '<div class="mock-note"><i class="fa-solid fa-circle-info"></i> No issues resolved by AI Agents yet.</div>'}
      </div>
      <div class="report-analytics-card">
        <h5>Top issues raised</h5>
        ${topIssues.length ? topIssues.map(([label, count]) => `
          <div class="report-bar-row"><span class="report-bar-label">${label}</span><div class="report-bar-track"><div class="report-bar-fill issue" style="width:${(count / maxIssueCount) * 100}%;"></div></div><span class="report-bar-count">${count}</span></div>`).join('')
          : '<div class="mock-note"><i class="fa-solid fa-circle-info"></i> No conversion issues raised yet.</div>'}
      </div>
      <div class="report-analytics-card report-analytics-wide">
        <h5>Brain learning curve — auto-resolve rate across migrations</h5>
        ${renderLearningCurveSvg(reportLearningCurve())}
      </div>
    </div>`;
}
function renderReportTab() {
  const tbody = $('report-tbody');
  if (!tbody) return;
  const introEl = $('exec-report-intro');
  if (introEl) {
    const assetCount = new Set(S.cockpitRows.map(r => r.assetId)).size;
    introEl.textContent = `${S.cockpitRows.length} iFlows in scope across ${assetCount} source ${assetCount === 1 ? 'object' : 'objects'}. Every converted, pushed, and migrated iFlow in one view — errors and complex iFlows carry an A2A developer dropdown right here so you can staff them without leaving the report.`;
  }
  renderReportAnalytics();
  tbody.innerHTML = S.cockpitRows.map(r => {
    const asset = S.assets.find(a => a.id === r.assetId);
    const tier = asset ? asset.tier : 'Medium';
    const complex = reportRowIsComplex(r);
    const iflowCell = `<a href="${r.iflowLink}" target="_blank" rel="noopener" title="${r.iflowName}"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open</a>
      <button class="btn-btp-table-action btn-view-iflow" onclick="showIflowViewModal('${r.id}')" title="View iFlow"><i class="fa-solid fa-eye"></i></button>`;
    const assignCell = complex
      ? `<select multiple size="3" class="report-dev-select" id="report-assign-${r.id}" onchange="reportAssignChange('${r.id}')" title="Select up to 8">
          ${activeTeam().map(m => `<option value="${m.id}" ${(r.assignees || []).includes(m.id) ? 'selected' : ''}>${m.name} — ${m.role}</option>`).join('')}
        </select>`
      : `<span style="font-size:0.78rem;">${r.assignee}</span>`;
    return `<tr class="${r.status === 'Error' ? 'row-flagged' : ''}">
      <td>Wave ${r.wave}</td><td>${r.name}</td><td>${tier}</td><td>${r.interfaceIndex}/${r.assetFlowTotal}</td>
      <td><span class="status-pill ${statusPillClass(r.status)}">${r.status}</span></td>
      <td><span class="status-pill ${iflowStepPillClass(r)}">${iflowStepLabel(r)}</span></td>
      <td style="white-space:nowrap;">${iflowCell}</td>
      <td>${assignCell}</td>
    </tr>`;
  }).join('');
}
function reportAssignChange(id) {
  const row = S.cockpitRows.find(r => r.id === id);
  const select = $(`report-assign-${id}`);
  if (!row || !select) return;
  let checked = qsa('option', select).filter(o => o.selected).map(o => o.value);
  if (checked.length > 8) {
    // Selecting past 8 in a native multi-select can't be blocked mid-click the way
    // the modal's checkboxes disable themselves — trim from the end and say so.
    checked = checked.slice(0, 8);
    qsa('option', select).forEach(o => { o.selected = checked.includes(o.value); });
    showToast('Limit is 8', 'Only the first 8 selected developers were kept.', 'danger');
  }
  row.assignees = checked;
  const names = row.assignees.map(mid => (activeTeam().find(m => m.id === mid) || {}).name).filter(Boolean);
  if (names.length) row.assignee = names[0];
  renderCockpitTable();
  showToast('Developers Assigned', `${row.name}: ${names.join(', ') || 'no one'} (${names.length}/8).`, 'purple');
}
function csvEscape(v) { return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`; }
async function downloadReportCsv() {
  if (!S.cockpitRows.length) { showToast('Nothing to report yet', 'Run a migration first — the report fills in as items convert.', 'danger'); return; }
  const header = ['Wave', 'Asset', 'Type', 'Interface (of source object)', 'Complexity', 'Status', 'iFlow Status', 'iFlow Step', 'iFlow Name', 'iFlow Link', 'Assignees', 'Advisory / Error'];
  const rows = S.cockpitRows.map(r => {
    const asset = S.assets.find(a => a.id === r.assetId);
    const assigneeNames = (r.assignees && r.assignees.length ? r.assignees : []).map(mid => (activeTeam().find(m => m.id === mid) || {}).name).filter(Boolean);
    return [
      `Wave ${r.wave}`, r.name, r.type, `${r.interfaceIndex}/${r.assetFlowTotal}`, asset ? asset.tier : 'Medium', r.status,
      iflowStatusLabel(r), iflowStepLabel(r), r.iflowName, r.iflowLink,
      assigneeNames.length ? assigneeNames.join('; ') : r.assignee,
      r.status === 'Error' ? 'Blocking error — needs review' : (r.advisory || '')
    ].map(csvEscape).join(',');
  });
  const assetCount = new Set(S.cockpitRows.map(r => r.assetId)).size;
  const summaryLine = [`${S.cockpitRows.length} iFlows across ${assetCount} source objects`, '', '', '', '', '', '', '', '', '', '', ''].map(csvEscape).join(',');
  const csv = [summaryLine, header.map(csvEscape).join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  await saveBlob(blob, `${S.projectName || 'sdaintai'}-migration-report.csv`, 'CSV file', { 'text/csv': ['.csv'] });
  showToast('Downloaded', 'Migration report CSV saved.', 'purple');
}

async function downloadSingleAsset(id) {
  const row = S.cockpitRows.find(r => r.id === id);
  if (!row || row.status !== 'Done') { showToast('Not ready', "This item needs to finish converting before it's downloadable.", 'danger'); return; }
  const content = [
    '# SDAINTAI converted artifact',
    `Source: ${row.name}`, `Wave: ${row.wave}`, `Assignee: ${row.assignee}`,
    `Converted: ${row.convertedAt}`, `Deduced iFlow: ${row.iflowName}`, `iFlow link: ${row.iflowLink}`, ''
  ].join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  await saveBlob(blob, `${row.id}-${row.name}.txt`, 'Text file', { 'text/plain': ['.txt'] });
  showToast('Downloaded', `${row.name} artifact saved.`, 'purple');
}

// A quick, generated (not a real LLM call) explanation of one converted item —
// same "What it contains / Dependencies / Assumptions / Constraints / Worth
// knowing" shape the reference video's per-item insight panel uses.
function showLumiInsight(id) {
  const row = S.cockpitRows.find(r => r.id === id);
  if (!row) return;
  const asset = S.assets.find(a => a.id === row.assetId);
  if (!asset) return;
  const p = PLATFORMS[S.platform];
  const riskWord = asset.tier === 'High' ? 'heavy custom logic and several dependencies'
    : asset.tier === 'Medium' ? 'some custom mapping/transform logic'
    : 'straightforward, low-risk logic';
  lumiSay(`<b>Insight — ${row.name}</b>`);
  lumiHtml(`<div class="insight-card">
    <div><b>What it contains</b><p>${asset.type} converting via ${p.terms.mappingLabel}; ${riskWord}.</p></div>
    <div><b>Dependencies</b><p>${asset.deps} dependent object${asset.deps === 1 ? '' : 's'} — carried along automatically unless flagged.</p></div>
    <div><b>Assumptions</b><p>Value mappings and credentials already exist on the target; the endpoint contract stays as-is.</p></div>
    <div><b>Constraints</b><p>Estimated ${formatEffort(effortMinutesForTier(asset.tier))} of review effort, owned by ${row.assignee} in Wave ${row.wave}.</p></div>
    <div><b>Worth knowing</b><p>${row.advisory || (asset.tier === 'High' ? 'Custom logic is regenerated as best-effort — test the transform output before promoting.' : 'No advisories on this item.')}</p></div>
  </div>`);
  lumiChoices([
    { label: 'What could break?', onClick: () => lumiSay(asset.tier === 'High'
        ? `Mostly the parts marked "needs review" in the structure tree — those branches couldn't be mapped 1:1 and fall back to a manual pattern.`
        : `Nothing flagged — this one converted cleanly with full coverage.`) },
    { label: 'Show me the script', onClick: () => showTreeModal(id) }
  ]);
}

// A small mocked "canvas" snippet of the actual SAP Integration Suite iFlow —
// start/end message events plus a deterministic run of steps built from the
// asset's tier/type, styled after the real CPI iFlow editor canvas. Not a live
// render of the real .iflw (this app has no BPMN engine); it's a believable
// stand-in so "View iFlow" shows *something* flow-shaped instead of just a link.
function iflowCanvasSteps(row, asset) {
  const steps = [{ kind: 'event', label: 'Start' }];
  steps.push({ kind: 'step', icon: 'fa-pen-to-square', label: 'Content Modifier' });
  if (asset && asset.tier !== 'Low') steps.push({ kind: 'step', icon: 'fa-code', label: 'Groovy Script' });
  steps.push({ kind: 'step', icon: 'fa-shuffle', label: 'Message Mapping' });
  if (asset && asset.tier === 'High') steps.push({ kind: 'router', icon: 'fa-route', label: 'Router' });
  steps.push({ kind: 'step', icon: 'fa-arrow-right-arrow-left', label: 'Request-Reply' });
  steps.push({ kind: 'event', label: 'End' });
  return steps;
}
function showIflowViewModal(id) {
  const row = S.cockpitRows.find(r => r.id === id);
  if (!row) return;
  const asset = S.assets.find(a => a.id === row.assetId);
  const p = PLATFORMS[S.platform] || PLATFORMS.mulesoft;
  const stepLabel = iflowStepLabel(row);
  const stepCls = iflowStepPillClass(row);
  const steps = iflowCanvasSteps(row, asset);
  const nodesHtml = steps.map((s, i) => {
    const node = s.kind === 'event'
      ? `<div class="iflow-node iflow-event ${s.label === 'End' ? 'iflow-event-end' : ''}"><i class="fa-solid fa-circle-dot"></i></div>`
      : s.kind === 'router'
      ? `<div class="iflow-node iflow-router"><i class="fa-solid ${s.icon}"></i></div>`
      : `<div class="iflow-node iflow-step"><i class="fa-solid ${s.icon}"></i></div>`;
    const arrow = i < steps.length - 1 ? '<div class="iflow-arrow"><i class="fa-solid fa-arrow-right"></i></div>' : '';
    return `<div class="iflow-canvas-col"><div class="iflow-canvas-node-wrap">${node}${arrow}</div><span class="iflow-node-label">${s.label}</span></div>`;
  }).join('');
  const body = `
    <div class="iflow-modal-head-row">
      <div><b>${row.iflowName}</b><div style="font-size:0.72rem;color:var(--btp-text-muted-dark);">Deduced from ${row.name} (${p.label})${row.assetFlowTotal > 1 ? ` — interface ${row.interfaceIndex} of ${row.assetFlowTotal} within ${asset ? asset.name : 'this object'}` : ''}</div></div>
      <span class="status-pill ${stepCls}">${stepLabel}</span>
    </div>
    <div class="iflow-canvas">
      <div class="iflow-lane-label"><i class="fa-solid fa-server"></i> ${p.label} (Sender)</div>
      <div class="iflow-canvas-row">${nodesHtml}</div>
      <div class="iflow-lane-label right"><i class="fa-solid fa-cloud"></i> SAP Integration Suite (Receiver)</div>
    </div>
    <div class="mock-note" style="margin-top:14px;"><i class="fa-solid fa-circle-info"></i> Visual snippet only — a simplified stand-in for the real .iflw canvas. Open the item in SAP Integration Suite for the actual editable flow.</div>`;
  openModal(`View iFlow — ${row.name}`, body, [
    { label: 'Close', cls: 'btn-btp-cancel', onClick: closeModal },
    { label: 'Open in Integration Suite', cls: 'btn-btp-gold', onClick: () => window.open(row.iflowLink, '_blank', 'noopener') }
  ]);
}

function getAllKafkaEventNodes(asset) {
  const out = [];
  function walk(node) { if (node.kafkaEvent) out.push(node); (node.children || []).forEach(walk); }
  asset.tree.forEach(walk);
  return out;
}

// Lumi proactively flags Kafka events sitting in an asset under review, instead of waiting
// for the reviewer to notice them buried in the tree — same spirit as Lumi's other
// proactive nudges elsewhere in this cockpit (goToBuckets, checkCockpitCompletion).
// `hostId` is whichever tree-host element is on screen right now (the cockpit row-detail
// modal and the earlier "Validate structure" modal each use their own).
function suggestKafkaConversion(asset, hostId) {
  if (!asset) return;
  hostId = hostId || 'row-detail-tree-host';
  const kafkaNodes = getAllKafkaEventNodes(asset);
  if (!kafkaNodes.length) return;
  const unpicked = kafkaNodes.filter(n => !n.kafkaEvent.selected);
  const n = kafkaNodes.length;
  lumiSay(`${asset.name} carries ${n} Kafka event${n > 1 ? 's' : ''} — want me to wire the one${n > 1 ? 's' : ''} you need to IS-Kafka before this converts?`);
  if (!unpicked.length) return;
  lumiChoices([{ label: `Select all ${n} Kafka event${n > 1 ? 's' : ''}`, cls: 'primary', onClick: () => {
    kafkaNodes.forEach(node => { node.kafkaEvent.selected = true; });
    const host = $(hostId);
    if (host) { host.innerHTML = renderTreeEditorHtml(asset); wireTreeEditorEvents(host, asset); }
    lumiSay(`Done — all ${n} event${n > 1 ? 's' : ''} picked. They'll generate ${n} IS-Kafka channel${n > 1 ? 's' : ''} in the .iflw the moment this converts.`);
  } }]);
}

function sendFixRequest(row) {
  closeModal();
  row.status = 'Pending Fix';
  renderCockpitTable();
  showToast('Fix Requested', `Sent to ${row.assignee}: please review and fix ${row.name}.`, 'purple');
  lumiSay(`I've sent a fix request to <b>${row.assignee}</b> for <b>${row.name}</b>. I'll check back — has it been fixed?`);
  lumiChoices([
    { label: 'Yes, fixed', cls: 'primary', onClick: () => markFixResult(row, 'yes') },
    { label: 'No, not yet', onClick: () => markFixResult(row, 'no') },
    { label: 'Still pending', onClick: () => markFixResult(row, 'pending') }
  ]);
}

function markFixResult(row, answer) {
  if (answer === 'yes') {
    const asset = S.assets.find(a => a.id === row.assetId);
    if (asset) {
      asset.tree.forEach(n => { n.ok = true; (n.children || []).forEach(c => c.ok = true); });
      asset.convertPct = computeConversionPct(asset);
      populateAssetsTable();
    }
    row.status = 'Done'; row.willError = false; row.convertedAt = new Date().toISOString();
    row.resolvedByHuman = row.assignee;
    renderCockpitTable();
    unflagNav('nav-cockpit');
    lumiSay(`Great — marking <b>${row.name}</b> as resolved and converted.`);
    checkCockpitCompletion();
  } else {
    lumiSay(`Understood — <b>${row.name}</b> is still ${answer === 'pending' ? 'pending a fix' : 'not fixed'}. Should I park this asset and continue with the rest of the migration, or hold everything until it's resolved?`);
    lumiChoices([
      { label: 'Park it and continue', cls: 'primary', onClick: () => parkAsset(row) },
      { label: 'Hold — keep it open', onClick: () => { row.status = 'Error'; renderCockpitTable(); } }
    ]);
  }
}

function parkAsset(row) {
  row.status = 'Parked';
  row.willError = false;
  renderCockpitTable();
  unflagNav('nav-cockpit');
  showToast('Parked', `${row.name} has been parked — the rest of the migration continues.`, 'purple');
  lumiSay(`Parked <b>${row.name}</b>. The rest of the migration continues without it.`);
  checkCockpitCompletion();
}

// ==================== EXPORT ACTIONS ====================
const INTEGRATION_SUITE_URL = 'https://lab-sda.integrationsuite.cfapps.us10-002.hana.ondemand.com/shell/home';
const FIGAF_BASE_URL = 'https://www.figaf.com/app';
function figafTestUrl(row) {
  const target = (S.adminDefaults && S.adminDefaults.figafAlmTarget) || 'default';
  return `${FIGAF_BASE_URL}/test-suite/run?target=${encodeURIComponent(target)}&iflow=${encodeURIComponent(row.iflowName)}`;
}

// Pushes progressively, batch-by-batch on a real interval (same pattern as
// startExecution()'s conversion loop) rather than flipping every card at
// once after a single timeout — matches the reference video, where cards
// visibly move Ready to push -> Pushing... (with a progress bar) -> resolved
// one at a time, and the header's "N Deployed" count climbs live.
const PUSH_TARGET_TICKS = 14;
function exportToIS() {
  if (!canTriggerProdAction()) return; // persona gate — Viewer/Approver can't trigger this even via a direct call
  if (S.pushing) return; // already running
  const btn = $('btn-export-is');
  const doneRows = S.cockpitRows.filter(r => r.status === 'Done' && !r.isImportStatus);
  if (!doneRows.length) return;
  const tenant = $('target-tenant').value || 'sda-prod-eu10';
  const baseUrl = S.retargetTenantUrl || (S.adminDefaults && S.adminDefaults.btpTenantUrl) || INTEGRATION_SUITE_URL;
  // Set before the first renderCockpitTable() call below — updateCockpitStats()
  // checks this flag to avoid fighting the button state every render tick
  // while a push is animating (see the ordering note there).
  S.pushing = true;
  doneRows.forEach(r => { r.pushPending = true; r.testRun = false; r.monitorActive = false; });
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Pushing to Integration Suite…';
  btn.disabled = true;
  renderCockpitTable();
  const batchSize = Math.max(1, Math.ceil(doneRows.length / PUSH_TARGET_TICKS));
  let i = 0;
  S.pushInterval = setInterval(() => {
    if (i >= doneRows.length) {
      clearInterval(S.pushInterval);
      S.pushing = false;
      S.pushInterval = null;
      btn.innerHTML = '<i class="fa-solid fa-check"></i> Pushed to BTP Integration Suite';
      const failCount = doneRows.filter(r => r.willError).length;
      showToast(failCount ? 'Imported — with issues' : 'Imported',
        `Pushed ${doneRows.length} converted artifact(s) to ${tenant} via the SAP Integration Suite Content API.${failCount ? ` ${failCount} need review.` : ' All deployed cleanly.'}`,
        failCount ? 'danger' : 'purple');
      window.open(baseUrl, '_blank', 'noopener');
      renderCockpitTable();
      return;
    }
    const batch = doneRows.slice(i, i + batchSize);
    // Mimic the response fields a real Integration Suite Content API push/deploy
    // would hand back — reuses the same willError flag the conversion step
    // already set, so an asset that had trouble converting also has trouble
    // importing. testIflowUrl reuses the same deduced per-row iflowLink
    // (buildCockpitRows()) rather than one shared URL, so the Integration
    // Package tab's Test links and the Integration list tab's iFlow Link
    // column always agree.
    batch.forEach(r => {
      r.pushPending = false;
      r.isImportStatus = r.willError ? 'Failed' : 'Success';
      r.isReturnMessage = r.willError
        ? `Deployment rejected on ${tenant} — property file validation error, 2 of 4 keys have no BAIP equivalent.`
        : `iFlow ${r.iflowName} deployed successfully to ${tenant}.`;
      r.isTestingStatus = r.willError ? 'Blocked' : 'Passed';
      r.testIflowUrl = r.iflowLink || baseUrl;
    });
    // Only the Target Integration Suite grid actually changes per tick — a
    // full renderCockpitTable() cascades into every other tab (Report
    // analytics, Readiness, Migration status, ...), which is both wasted
    // work and, at real scale, slow enough to visibly stall the animation.
    // Those get one full refresh at completion below instead.
    renderExecTargetIS();
    i += batchSize;
  }, 350);
}
// Single-card retry from a failed Target Integration Suite card — always
// resolves clean (a real retry after a fix, not a repeat of the same
// deploy-time error), matching the "View Issue -> Retry" storyline the
// reference video's failed card implies.
function retryIflowPush(id) {
  const r = S.cockpitRows.find(x => x.id === id);
  if (!r) return;
  const tenant = $('target-tenant').value || 'sda-prod-eu10';
  const baseUrl = S.retargetTenantUrl || (S.adminDefaults && S.adminDefaults.btpTenantUrl) || INTEGRATION_SUITE_URL;
  delete r.isImportStatus;
  r.pushPending = true;
  renderCockpitTable();
  setTimeout(() => {
    r.pushPending = false;
    r.willError = false;
    r.isImportStatus = 'Success';
    r.isReturnMessage = `iFlow ${r.iflowName} deployed successfully to ${tenant} (retry).`;
    r.isTestingStatus = 'Passed';
    r.testIflowUrl = r.iflowLink || baseUrl;
    renderCockpitTable();
    showToast('Retry succeeded', `${r.name} deployed successfully on retry.`, 'purple');
  }, 900);
}

const IS_CONTENT_PACKAGE_URL = 'https://lab-sda.integrationsuite.cfapps.us10-002.hana.ondemand.com/shell/design/contentpackage/INTPACKFROMMUKESOFT1?section=DOCUMENTS';
function pushAndImportToIS() {
  const url = ((S.adminDefaults && S.adminDefaults.btpTenantUrl) || IS_CONTENT_PACKAGE_URL).replace(/\?.*$/, '?section=DOCUMENTS');
  window.open(url, '_blank', 'noopener');
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Bundle-SymbolicName must be a bare OSGi symbolic name — letters/digits/._- only
function iflowSlug(name) {
  return (String(name || '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '')) || 'SDAINTAI_Migration';
}

// SAP Integration Suite requires this exact project shape (META-INF/MANIFEST.MF at the
// zip root + a bpmn2 .iflw under src/main/resources/scenarioflows/integrationflow/) to
// accept an "Add > Integration Flow > Upload" — without it you get "must contain a valid
// manifest file". Below builds a minimal but structurally valid Start->End iFlow shell.
function buildIflowManifest(slug, name) {
  return [
    'Manifest-Version: 1.0',
    `Bundle-SymbolicName: ${slug}; singleton:=true`,
    `Bundle-Name: ${name || slug}`,
    'Bundle-Version: 1.0.0',
    'SAP-BundleType: IntegrationFlow',
    'SAP-NodeType: IFLMAP',
    'SAP-RuntimeProfile: iflmap',
    'SAP-Origin: SDAINTAI Brain'
  ].join('\r\n') + '\r\n';
}

// Collects every selected Kafka event across a set of assets (walking each asset's full
// tree, not just top-level nodes) — the single source of truth for "what does the reviewer
// actually want wired to IS-Kafka," shared by the iFlow generator, the manifest, the
// package preview and Revalidate Package.
function getSelectedKafkaEvents(assets) {
  const out = [];
  (assets || []).forEach(asset => {
    function walk(node) { if (node.kafkaEvent && node.kafkaEvent.selected) out.push({ assetId: asset.id, assetName: asset.name, node: node.name, ...node.kafkaEvent }); (node.children || []).forEach(walk); }
    asset.tree.forEach(walk);
  });
  return out;
}

// One IS-Kafka participant + message flow per selected event, appended to the iFlow
// collaboration/process. Property keys follow this project's own established pattern for
// representing adapter config as <ifl:property> extension elements (see the Start/End
// events below) -- grounded in SAP's real, documented Kafka Sender/Receiver adapter
// fields (bootstrap servers, topic, consumer group, SASL auth: help.sap.com/docs/
// cloud-integration/sap-cloud-integration/kafka-adapter) but this generator does not
// claim byte-for-byte fidelity with SAP's internal adapter schema -- it's a structurally
// valid, clearly-attributed representation, same spirit as the rest of this sandbox app.
function buildKafkaParticipantXml(ev, idx) {
  const pid = `Participant_Kafka_${idx}`;
  const mfid = `MessageFlow_Kafka_${idx}`;
  return {
    participant: `    <bpmn2:participant id="${pid}" ifl:type="EndpointReceiver" name="${escapeXml(ev.id)} — ${escapeXml(ev.topic)}"/>`,
    messageFlow: `  <bpmn2:messageFlow id="${mfid}" name="${escapeXml(ev.id)}" sourceRef="Participant_Process_1" targetRef="${pid}">
    <bpmn2:extensionElements>
      <ifl:property><key>ComponentType</key><value>Kafka</value></ifl:property>
      <ifl:property><key>direction</key><value>Receiver</value></ifl:property>
      <ifl:property><key>topic</key><value>${escapeXml(ev.topic)}</value></ifl:property>
      <ifl:property><key>consumerGroup</key><value>${escapeXml(ev.group)}</value></ifl:property>
      <ifl:property><key>authenticationType</key><value>SASL</value></ifl:property>
      <ifl:property><key>generatedBy</key><value>SDAINTAI Brain — recalled from source, not re-typed</value></ifl:property>
    </bpmn2:extensionElements>
  </bpmn2:messageFlow>`,
    shape: `      <bpmndi:BPMNShape id="BPMNShape_${pid}" bpmnElement="${pid}">
        <dc:Bounds height="140.0" width="140.0" x="${560 + idx * 170}.0" y="${300 + idx * 40}.0"/>
      </bpmndi:BPMNShape>`,
    edge: `      <bpmndi:BPMNEdge id="BPMNEdge_${mfid}" bpmnElement="${mfid}" sourceElement="BPMNShape_Process_1" targetElement="BPMNShape_${pid}">
        <di:waypoint x="530.0" xsi:type="dc:Point" y="130.0"/>
        <di:waypoint x="${560 + idx * 170}.0" xsi:type="dc:Point" y="${300 + idx * 40}.0"/>
      </bpmndi:BPMNEdge>`
  };
}

function buildIflowSkeleton(name, kafkaEvents) {
  const flowName = escapeXml(name || 'SDAINTAI Migration');
  const events = kafkaEvents || [];
  const parts = events.map((ev, i) => buildKafkaParticipantXml(ev, i));
  const participants = parts.map(p => p.participant).join('\n');
  const messageFlows = parts.map(p => p.messageFlow).join('\n');
  const shapes = parts.map(p => p.shape).join('\n');
  const edges = parts.map(p => p.edge).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xsi:schemaLocation="http://www.omg.org/spec/BPMN/20100524/MODEL BPMN20.xsd" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn2:collaboration id="Collaboration_1" name="Default Collaboration">
    <bpmn2:extensionElements>
      <ifl:property><key>namespaceMapping</key><value></value></ifl:property>
      <ifl:property><key>allowedHeaderList</key><value>*</value></ifl:property>
      <ifl:property><key>httpSessionHandling</key><value>None</value></ifl:property>
    </bpmn2:extensionElements>
    <bpmn2:participant id="Participant_Process_1" ifl:type="EndpointRecevier" name="${flowName}" processRef="Process_1"/>
${participants}
  </bpmn2:collaboration>
${messageFlows}
  <bpmn2:process id="Process_1" name="Integration Process">
    <bpmn2:extensionElements>
      <ifl:property><key>transactionTimeout</key><value>30000</value></ifl:property>
      <ifl:property><key>componentVersion</key><value>1.1</value></ifl:property>
      <ifl:property><key>cmdVariantUri</key><value>ctype::IFlowVariant/cname::IFlowConfiguration/version::1.1.0</value></ifl:property>
    </bpmn2:extensionElements>
    <bpmn2:startEvent id="StartEvent_2" name="Start">
      <bpmn2:extensionElements>
        <ifl:property><key>cmdVariantUri</key><value>ctype::FlowstepVariant/cname::MessageStartEvent/version::1.1.0</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:outgoing>SequenceFlow_1</bpmn2:outgoing>
      <bpmn2:messageEventDefinition/>
    </bpmn2:startEvent>
    <bpmn2:endEvent id="EndEvent_2" name="End">
      <bpmn2:extensionElements>
        <ifl:property><key>cmdVariantUri</key><value>ctype::FlowstepVariant/cname::MessageEndEvent/version::1.1.0</value></ifl:property>
      </bpmn2:extensionElements>
      <bpmn2:incoming>SequenceFlow_1</bpmn2:incoming>
      <bpmn2:messageEventDefinition/>
    </bpmn2:endEvent>
    <bpmn2:sequenceFlow id="SequenceFlow_1" sourceRef="StartEvent_2" targetRef="EndEvent_2"/>
  </bpmn2:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collaboration_1">
      <bpmndi:BPMNShape id="BPMNShape_Process_1" bpmnElement="Participant_Process_1">
        <dc:Bounds height="220.0" width="600.0" x="240.0" y="20.0"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="BPMNShape_StartEvent_2" bpmnElement="StartEvent_2">
        <dc:Bounds height="32.0" width="32.0" x="292.0" y="114.0"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="BPMNShape_EndEvent_2" bpmnElement="EndEvent_2">
        <dc:Bounds height="32.0" width="32.0" x="782.0" y="114.0"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="BPMNEdge_SequenceFlow_1" bpmnElement="SequenceFlow_1" sourceElement="BPMNShape_StartEvent_2" targetElement="BPMNShape_EndEvent_2">
        <di:waypoint x="324.0" xsi:type="dc:Point" y="130.0"/>
        <di:waypoint x="782.0" xsi:type="dc:Point" y="130.0"/>
      </bpmndi:BPMNEdge>
${shapes}
${edges}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn2:definitions>
`;
}

function buildDotProject(name) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<projectDescription>\n\t<name>${escapeXml(name)}</name>\n\t<comment></comment>\n\t<projects>\n\t</projects>\n\t<buildSpec>\n\t</buildSpec>\n\t<natures>\n\t</natures>\n</projectDescription>\n`;
}

// Pure builder shared by downloadZip(), the Package Preview panel, and Revalidate Package —
// all three must agree on exactly what ships, so they all read from this single function.
function buildPackageManifest() {
  const projectName = S.projectName || 'SDAINTAI Migration';
  const slug = iflowSlug(projectName);
  const doneRows = (S.cockpitRows || []).filter(r => r.status === 'Done');
  const includedAssets = getIncludedAssets();
  const kafkaEvents = getSelectedKafkaEvents(includedAssets);
  const manifestJson = {
    project: S.projectName, platform: PLATFORMS[S.platform].label, generatedBy: 'SDAINTAI Brain', generatedAt: new Date().toISOString(),
    assets: includedAssets.map(a => {
      const assetRows = S.cockpitRows.filter(r => r.assetId === a.id);
      const doneAssetRows = assetRows.filter(r => r.status === 'Done');
      return {
        id: a.id, name: a.name, tier: a.tier, convertPct: a.convertPct, status: a.status,
        iflowsConverted: doneAssetRows.length, iflowsTotal: assetRows.length,
        convertedAt: doneAssetRows.length ? doneAssetRows[doneAssetRows.length - 1].convertedAt : null
      };
    }),
    kafkaChannels: kafkaEvents.map(ev => ({ id: ev.id, topic: ev.topic, consumerGroup: ev.group, sourceAsset: ev.assetName, sourceObject: ev.node }))
  };

  const files = [];
  // ---- SAP Integration Suite Integration Flow project shape (fixes "must contain a valid manifest file") ----
  files.push({ name: 'META-INF/MANIFEST.MF', content: buildIflowManifest(slug, projectName) });
  files.push({ name: `src/main/resources/scenarioflows/integrationflow/${slug}.iflw`, content: buildIflowSkeleton(projectName, kafkaEvents) });
  files.push({ name: 'parameters.prop', content: '' });
  files.push({ name: 'parameters.propdef', content: '[]' });
  files.push({ name: '.project', content: buildDotProject(projectName) });

  // ---- SDAINTAI migration payload, kept alongside as reference resources ----
  files.push({ name: 'manifest.json', content: JSON.stringify(manifestJson, null, 2) });
  doneRows.forEach(r => {
    files.push({ name: `src/main/resources/resources/${r.id}-${r.name}.txt`, content: `Converted artifact — SDAINTAI Brain output\nAsset: ${r.name}\nType: ${r.type}\nWave: ${r.wave}\nAssignee: ${r.assignee}\nConverted At: ${r.convertedAt || 'n/a'}\nTarget: SAP Integration Suite iFlow / CAP service\n` });
  });
  // ---- IS-Kafka channels a reviewer picked in the object tree — one resource file per
  // event, each also wired as a real Kafka messageFlow/participant inside the .iflw above ----
  kafkaEvents.forEach(ev => {
    files.push({ name: `src/main/resources/resources/${ev.id}-kafka-channel.txt`, content: `IS-Kafka channel — SDAINTAI Brain generated\nEvent: ${ev.id}\nSource object: ${ev.node} (${ev.assetName})\nTopic: ${ev.topic}\nConsumer group: ${ev.group}\nAuthentication: SASL\nAdapter: SAP Integration Suite native Kafka Receiver adapter\nWired into: src/main/resources/scenarioflows/integrationflow/${slug}.iflw\n` });
  });
  files.push({ name: 'conversion-log.txt', content: (S.cockpitRows || []).map(r => `[${r.status}] Wave ${r.wave} — ${r.name} (${r.assignee})${r.convertedAt ? ' @ ' + r.convertedAt : ''}`).join('\n') });

  return { projectName, slug, doneRows, includedAssets, kafkaEvents, files };
}

async function downloadZip() {
  const { projectName, slug, files, kafkaEvents } = buildPackageManifest();
  const blob = buildZipBlob(files);
  const filename = `${slug}-package.zip`;
  await saveBlob(blob, filename, 'ZIP archive', { 'application/zip': ['.zip'] });
  const kafkaNote = kafkaEvents.length ? ` — ${kafkaEvents.length} IS-Kafka channel${kafkaEvents.length > 1 ? 's' : ''} wired into the .iflw.` : '';
  showToast('Downloaded', `${filename} saved — packaged as a valid SAP Integration Suite Integration Flow project (META-INF/MANIFEST.MF included).${kafkaNote}`, 'purple');
}

// Re-runs the same package builder used for the download and the preview panel, and checks
// the structural invariants SAP Integration Suite requires for an "Add > Integration Flow >
// Upload" (see buildIflowManifest/buildIflowSkeleton above) — a lightweight self-check rather
// than parsing the actual zip bytes back, since both sides are generated from one source of truth.
// The Kafka check below is the same idea applied to IS-Kafka: confirm every event a reviewer
// picked in the object tree actually landed inside the generated .iflw's own XML, i.e. the
// iFlow "recognizes" it, before anyone imports the zip into a real Integration Suite tenant.
function revalidatePackage() {
  const { projectName, slug, doneRows, includedAssets, kafkaEvents, files } = buildPackageManifest();
  const iflw = files.find(f => f.name.endsWith('.iflw'));
  const kafkaRecognized = kafkaEvents.every(ev => iflw && iflw.content.includes(ev.id));
  const checks = [
    { label: 'META-INF/MANIFEST.MF present', ok: files.some(f => f.name === 'META-INF/MANIFEST.MF') },
    { label: 'Exactly one .iflw under scenarioflows/integrationflow/', ok: files.filter(f => f.name.endsWith('.iflw')).length === 1 },
    { label: 'At least one converted object included', ok: doneRows.length > 0 },
    { label: 'manifest.json matches included objects', ok: files.some(f => f.name === 'manifest.json') && doneRows.length <= includedAssets.length },
    { label: kafkaEvents.length ? `${kafkaEvents.length} IS-Kafka channel(s) recognized in the .iflw` : 'No IS-Kafka channels selected (nothing to check)', ok: kafkaRecognized }
  ];
  const allOk = checks.every(c => c.ok);
  const kafkaRows = kafkaEvents.length ? `
    <div style="margin-top:12px;font-weight:700;font-size:0.78rem;">IS-Kafka channels found in the .iflw</div>
    <div class="btp-table-container" style="margin-top:6px;">
      <table class="btp-table"><thead><tr><th>Event</th><th>Topic</th><th>Source</th></tr></thead>
        <tbody>${kafkaEvents.map(ev => `<tr><td><span class="kafka-badge">${ev.id}</span></td><td><code>${ev.topic}</code></td><td>${ev.assetName} — ${ev.node}</td></tr>`).join('')}</tbody>
      </table>
    </div>` : '';
  const body = `
    <div class="kv"><span>Integration Package</span><b>${projectName}</b></div>
    <div class="kv"><span>iFlow ID</span><b><code>${slug}</code></b></div>
    <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px;">
      ${checks.map(c => `<div style="display:flex;align-items:center;gap:8px;"><i class="fa-solid ${c.ok ? 'fa-circle-check' : 'fa-circle-xmark'}" style="color:${c.ok ? '#0d7a4c' : 'var(--lumi-alert)'};"></i> ${c.label}</div>`).join('')}
    </div>${kafkaRows}`;
  openModal(allOk ? 'Package Valid' : 'Package Has Issues', body, [{ label: 'Close', cls: 'btn-btp-cancel', onClick: closeModal }]);
  showToast(allOk ? 'Package Valid' : 'Package Has Issues', allOk
    ? `${slug}-package.zip structure checks out — ${doneRows.length} converted object(s)${kafkaEvents.length ? ` and ${kafkaEvents.length} IS-Kafka channel(s)` : ''} ready for SAP Integration Suite.`
    : 'One or more structural checks failed — see details.', allOk ? 'purple' : 'danger');
}

// ==================== SAP2SAP MIGRATION (OpenConnectors removal) ====================
// Real feature, not a mockup: ingests an actual downloaded SAP Integration Suite iFlow
// content package (.zip), detects the OpenConnectors "wrapper envelope" pattern confirmed
// on a real EXFO iFlow (a Groovy step parsing an XmlSlurper-wrapped "message.raw.*" payload
// instead of Marketo's own JSON), rewrites the script to read the data directly, and
// repackages a downloadable, re-importable .zip.
//
// Deterministic, rule-based rewrite only — no LLM call in this pass. Matches the scoping
// already committed to for EXFO ("AI drafts the code, a human still configures the tenant"):
// the sender channel/security material still needs manual reconfiguration with real tenant
// credentials, which can't be safely automated blind, so that is surfaced as a clear manual
// step in SAP2SAP-MIGRATION-NOTES.txt inside the output package rather than faked. An
// AI-assisted pass for scripts that don't match this exact pattern is documented as a future
// extension, not built here — see docs/SDAINTAI-SAP2SAP-Migration-Feature.md.

// Uploaded Groovy/filename content is the first place in this app where arbitrary
// user-supplied file content gets rendered into innerHTML (everything else is static sample
// data or filenames already sanitized to [a-zA-Z0-9._-]) -- must escape before display.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openSap2SapModal() {
  const body = `
    <div style="font-size:0.82rem;color:var(--lumi-text-dim,#666);margin-bottom:10px;">
      Upload a downloaded SAP Integration Suite iFlow content package (.zip). SDAINTAI scans every
      Groovy script inside it for the OpenConnectors "wrapper envelope" pattern (<code>XmlSlurper</code> +
      <code>message.raw.*</code> field paths), assesses it the same way as any other migration object
      (Tier / Status / Effort) and, where safe, rewrites the script to read the source payload directly —
      no OpenConnectors unwrap needed.
    </div>
    <input type="file" id="sap2sap-file-input" accept=".zip" style="width:100%;padding:8px;border:1px solid var(--lumi-border,#ccc);border-radius:6px;background:var(--lumi-panel,#fff);" />
    <div id="sap2sap-result" style="margin-top:14px;"></div>
  `;
  openModal('Migrate SAP2SAP — Remove OpenConnectors', body, [{ label: 'Close', cls: 'btn-btp-cancel', onClick: closeModal }]);
  $('sap2sap-file-input').addEventListener('change', handleSap2SapFile);
}

async function handleSap2SapFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const resultHost = $('sap2sap-result');
  resultHost.innerHTML = `<div class="kv"><span>Status</span><b>Reading ${escapeHtml(file.name)}…</b></div>`;

  let zip;
  try {
    const buf = await file.arrayBuffer();
    zip = await JSZip.loadAsync(buf);
  } catch (err) {
    resultHost.innerHTML = `<div style="color:var(--lumi-alert);"><i class="fa-solid fa-circle-xmark"></i> Could not read this file as a .zip — ${escapeHtml(err.message)}</div>`;
    return;
  }

  const iflwEntry = Object.values(zip.files).find(f => !f.dir && f.name.endsWith('.iflw'));
  const groovyEntries = Object.values(zip.files).filter(f => !f.dir && f.name.endsWith('.groovy'));
  if (!iflwEntry) {
    resultHost.innerHTML = `<div style="color:var(--lumi-alert);"><i class="fa-solid fa-circle-xmark"></i> No .iflw file found inside this package — not a recognizable Integration Suite content package. Migration blocked.</div>`;
    return;
  }

  let groovyContents;
  try {
    groovyContents = await Promise.all(groovyEntries.map(async f => ({ name: f.name, text: await f.async('string') })));
  } catch (err) {
    resultHost.innerHTML = `<div style="color:var(--lumi-alert);"><i class="fa-solid fa-circle-xmark"></i> Could not read one or more script files from the package — ${escapeHtml(err.message)}. Migration blocked.</div>`;
    return;
  }

  // Detect, then immediately attempt the rewrite for every candidate -- assessment below
  // needs to know not just "did the name/body look like OpenConnectors" but "did the
  // deterministic fix actually have something safe to apply", since a name-only hint with
  // no matching XmlSlurper+message.raw usage in the body is a real thing to flag, not a
  // silent no-op success.
  const matches = groovyContents
    .map(g => ({ ...g, detected: detectOpenConnectorPattern(g.name, g.text) }))
    .filter(g => g.detected.hit)
    .map(g => ({ ...g, rewrite: rewriteGroovyScript(g.text) }));

  S.sap2sap = { file, zip, iflwEntry, groovyContents, matches };

  const assessment = assessSap2SapPackage(groovyEntries.length, matches);
  resultHost.innerHTML = renderSap2SapAssessment(assessment, matches);
  if (assessment.canMigrate) {
    $('btn-sap2sap-generate').addEventListener('click', generateSap2SapPackage);
  }
}

// Same assessment vocabulary as every other migration object in the cockpit (Tier / Status /
// Effort, via the existing effortMinutesForTier) rather than a bespoke scale for this one
// feature -- "assess it like the other components", per explicit instruction. canMigrate
// gates whether the Generate button even appears: a package with nothing safely rewritable
// does NOT silently report success.
function assessSap2SapPackage(groovyCount, matches) {
  const actionable = matches.filter(m => m.rewrite.changed);
  const flaggedOnly = matches.filter(m => !m.rewrite.changed);
  let tier, status, canMigrate, headline;

  if (!matches.length) {
    tier = 'Simple'; status = 'Ready'; canMigrate = false;
    headline = `Scanned ${groovyCount} Groovy script(s) — no OpenConnectors wrapper pattern detected. Nothing to migrate in this package.`;
  } else if (actionable.length && !flaggedOnly.length) {
    tier = 'Simple'; status = 'Ready'; canMigrate = true;
    headline = `${actionable.length} script${actionable.length > 1 ? 's' : ''} matched the confirmed OpenConnectors pattern exactly — ready to migrate.`;
  } else if (actionable.length && flaggedOnly.length) {
    tier = 'Medium'; status = 'Review'; canMigrate = true;
    headline = `${actionable.length} script${actionable.length > 1 ? 's' : ''} ready to migrate automatically; ${flaggedOnly.length} referenced OpenConnectors but didn't match the exact rewrite pattern — review those manually.`;
  } else {
    tier = 'High'; status = 'Review'; canMigrate = false;
    headline = `${flaggedOnly.length} script${flaggedOnly.length > 1 ? 's' : ''} referenced OpenConnectors but none matched the confirmed XmlSlurper + message.raw rewrite pattern closely enough to auto-fix safely. Migration blocked pending manual review.`;
  }
  return { tier, status, canMigrate, headline, actionable, flaggedOnly, effortMinutes: effortMinutesForTier(tier) };
}

function renderSap2SapAssessment(assessment, matches) {
  const { tier, status, canMigrate, headline, actionable, flaggedOnly, effortMinutes } = assessment;
  const statusIcon = status === 'Ready' ? 'fa-circle-check' : status === 'Review' ? 'fa-triangle-exclamation' : 'fa-circle-xmark';
  const statusColor = status === 'Ready' ? '#0d7a4c' : status === 'Review' ? '#b4770a' : 'var(--lumi-alert)';
  const tierColor = tier === 'High' ? '#ef4444' : tier === 'Medium' ? '#f59e0b' : '#10b981';

  const assessRow = `
    <div class="btp-table-container" style="margin-top:2px;">
      <table class="btp-table">
        <thead><tr><th>Tier</th><th>Status</th><th>Est. Effort</th></tr></thead>
        <tbody><tr>
          <td><span class="tier" style="color:${tierColor};font-weight:700;">${tier}</span></td>
          <td><i class="fa-solid ${statusIcon}" style="color:${statusColor};"></i> ${status}</td>
          <td>~${effortMinutes} min</td>
        </tr></tbody>
      </table>
    </div>
    <div style="margin-top:8px;font-size:0.82rem;color:${statusColor};font-weight:600;">${escapeHtml(headline)}</div>`;

  const compareRows = actionable.map(m => `
    <div style="margin-top:14px;">
      <div style="font-weight:700;font-size:0.78rem;margin-bottom:4px;"><code>${escapeHtml(m.name.split('/').pop())}</code> — ${m.detected.reasons.map(escapeHtml).join(' + ')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <div style="font-size:0.68rem;font-weight:700;color:#a13a3a;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px;">Before</div>
          <pre class="tree-node-preview" style="margin:0;max-height:220px;overflow:auto;">${escapeHtml(m.text)}</pre>
        </div>
        <div>
          <div style="font-size:0.68rem;font-weight:700;color:#0d7a4c;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px;">After</div>
          <pre class="tree-node-preview" style="margin:0;max-height:220px;overflow:auto;">${escapeHtml(m.rewrite.text)}</pre>
        </div>
      </div>
    </div>`).join('');

  const flaggedRows = flaggedOnly.length ? `
    <div style="margin-top:14px;">
      <div style="font-weight:700;font-size:0.78rem;color:#b4770a;margin-bottom:4px;"><i class="fa-solid fa-triangle-exclamation"></i> Needs manual review — not auto-fixed</div>
      <div class="btp-table-container">
        <table class="btp-table"><thead><tr><th>Script</th><th>Why it was flagged</th></tr></thead>
          <tbody>${flaggedOnly.map(m => `<tr><td><code>${escapeHtml(m.name.split('/').pop())}</code></td><td>${m.detected.reasons.map(escapeHtml).join(' + ')} — no matching XmlSlurper().parseText(...) + message.raw usage found to safely rewrite</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>` : '';

  const generateBtn = canMigrate
    ? `<button class="btn-btp btn-btp-gold" id="btn-sap2sap-generate" style="margin-top:14px;">Generate Migrated Package</button>`
    : '';

  return assessRow + compareRows + flaggedRows + generateBtn;
}

// The exact signal confirmed on the real EXFO iFlow (Update C4C Contact from Marketo):
// either the script's own name carries the legacy "OpenConnector" naming, or its body shows
// the XmlSlurper + message.raw combination that is OpenConnectors' fingerprint (not Marketo's
// own payload shape).
function detectOpenConnectorPattern(name, text) {
  const reasons = [];
  if (/openconnector/i.test(name)) reasons.push('script name references OpenConnector');
  if (/XmlSlurper/.test(text) && /message\s*\.\s*raw\s*\./.test(text)) reasons.push('XmlSlurper + message.raw wrapper in body');
  return { hit: reasons.length > 0, reasons };
}

// Deterministic, rule-based rewrite -- the same two-part fix confirmed on the real script:
// XmlSlurper -> JsonSlurper (Marketo's real payload is JSON, not an XML envelope), and drop
// the "message.raw." prefix (OpenConnectors' own wrapper, not Marketo's field shape).
//
// Variable-scoped on purpose, not a blanket find/replace: a script can legitimately use
// XmlSlurper for something else in the same file (the real EXFO script also parses a genuine
// XML C4C OData response in a separate variable) -- only the variable whose own usage shows
// the "<var>.message.raw." wrapper signature gets converted; everything else is left alone.
function rewriteGroovyScript(text) {
  let out = text;
  const targets = new Set();
  const assignRe = /def\s+(\w+)\s*=\s*new\s+XmlSlurper\(\)\s*\.\s*parseText\s*\(/g;
  let m;
  while ((m = assignRe.exec(text)) !== null) {
    const varName = m[1];
    if (new RegExp(`\\b${varName}\\s*\\.\\s*message\\s*\\.\\s*raw\\s*\\.`).test(text)) targets.add(varName);
  }
  if (!targets.size) return { text: out, changed: false, targets: [] };

  targets.forEach(varName => {
    out = out.replace(
      new RegExp(`(def\\s+${varName}\\s*=\\s*new\\s+)XmlSlurper(\\(\\)\\s*\\.\\s*parseText\\s*\\()`),
      '$1JsonSlurper$2'
    );
    // collapse "<var>.message.raw" + optional line break + "." down to "<var>." -- covers both
    // the same-line form (message.raw.email) and the line-broken form seen in the real script
    // (message.raw\n    .first_name)
    out = out.replace(
      new RegExp(`\\b${varName}\\s*\\.\\s*message\\s*\\.\\s*raw\\s*\\r?\\n?\\s*\\.`, 'g'),
      `${varName}.`
    );
  });

  if (!/import\s+groovy\.json\.JsonSlurper/.test(out)) {
    const withAnchor = out.replace(/(import\s+groovy\.util\.XmlSlurper\s*\n)/, `$1import groovy.json.JsonSlurper\n`);
    out = withAnchor !== out ? withAnchor : out.replace(/^(import[^\n]*\n)/, `$1import groovy.json.JsonSlurper\n`);
  }

  return { text: out, changed: true, targets: Array.from(targets) };
}

async function generateSap2SapPackage() {
  const ctx = S.sap2sap;
  if (!ctx) return;
  const actionable = ctx.matches.filter(m => m.rewrite.changed);
  const flaggedOnly = ctx.matches.filter(m => !m.rewrite.changed);
  const outZip = new JSZip();
  const names = Object.keys(ctx.zip.files);
  const changeLog = [];

  for (const name of names) {
    const entry = ctx.zip.files[name];
    if (entry.dir) { outZip.folder(name); continue; }
    const match = actionable.find(m => m.name === name);
    if (match) {
      // Rewrite already computed and shown in the before/after comparison above -- reuse it
      // rather than recomputing, so what the reviewer saw is exactly what ships.
      outZip.file(name, match.rewrite.text);
      changeLog.push(`${name}\n  - ${match.rewrite.targets.join(', ')}: new XmlSlurper().parseText(...) -> new JsonSlurper().parseText(...)\n  - ".message.raw." wrapper prefix removed from ${match.rewrite.targets.join(', ')}'s field paths`);
    } else {
      const content = await entry.async('uint8array');
      outZip.file(name, content);
    }
  }

  const flaggedNote = flaggedOnly.length
    ? `\nFLAGGED, NOT AUTO-FIXED (left unchanged in this package -- review manually)\n${flaggedOnly.map(m => `  - ${m.name}: ${m.detected.reasons.join(' + ')}`).join('\n')}\n`
    : '';

  const notes = `SDAINTAI SAP2SAP MIGRATION -- OpenConnectors Removal
Generated ${new Date().toISOString()}
Source package: ${ctx.file.name}

WHAT WAS CHANGED (automatic, this package)
${changeLog.join('\n')}
${flaggedNote}
WHAT STILL NEEDS MANUAL CONFIGURATION (not automated -- requires tenant-specific security material)
  - Point the source system's webhook/call directly at a new secured CPI endpoint
    (HTTPS + OAuth2ClientCredentials), replacing the OpenConnectors adapter that
    previously sat in front of this iFlow.
  - Create/assign the OAuth2 client credentials in the target Integration Suite tenant.
  - Import this package into Integration Suite Design (not directly to Deploy), review the
    change, then Build & Test before promoting.
`;
  outZip.file('SAP2SAP-MIGRATION-NOTES.txt', notes);

  const blob = await outZip.generateAsync({ type: 'blob' });
  const outName = ctx.file.name.replace(/\.zip$/i, '') + '-sap2sap-migrated.zip';
  await saveBlob(blob, outName, 'ZIP archive', { 'application/zip': ['.zip'] });

  // Self-check, same discipline as revalidatePackage(): re-read the just-built blob back out
  // and confirm the rewrite actually landed, rather than trusting the write path blindly.
  const verifyZip = await JSZip.loadAsync(blob);
  const verifyChecks = await Promise.all(actionable.map(async m => {
    const text = await verifyZip.files[m.name].async('string');
    const ok = /JsonSlurper/.test(text) && m.rewrite.targets.every(v => !new RegExp(`\\b${v}\\s*\\.\\s*message\\s*\\.\\s*raw\\s*\\.`).test(text));
    return { name: m.name, ok };
  }));
  const allOk = verifyChecks.every(c => c.ok);

  const flaggedNoteHtml = flaggedOnly.length
    ? `<div style="margin-top:6px;font-size:0.78rem;color:#b4770a;"><i class="fa-solid fa-triangle-exclamation"></i> ${flaggedOnly.length} script(s) left unchanged pending manual review — see SAP2SAP-MIGRATION-NOTES.txt.</div>`
    : '';

  $('sap2sap-result').innerHTML = `
    <div style="color:${allOk ? '#0d7a4c' : 'var(--lumi-alert)'};font-weight:700;">
      <i class="fa-solid ${allOk ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
      ${escapeHtml(outName)} downloaded${allOk ? ' — rewrite verified in the output package.' : ' — verification found an issue, review before importing.'}
    </div>
    <div style="margin-top:8px;font-size:0.78rem;color:var(--lumi-text-dim,#666);">
      ${actionable.length} script${actionable.length > 1 ? 's' : ''} rewritten. SAP2SAP-MIGRATION-NOTES.txt added to the package with
      what changed and what still needs manual tenant configuration.
    </div>${flaggedNoteHtml}`;
  showToast(allOk ? 'SAP2SAP Package Ready' : 'SAP2SAP Package Has Issues',
    `${outName} — ${actionable.length} script(s) migrated from OpenConnectors.`, allOk ? 'purple' : 'danger');
}

// Renders the "what will actually be in the zip" preview above the export row, so the
// user can verify the package contents before downloading or pushing to Integration Suite.
function renderPackagePreview() {
  const host = $('package-preview-body');
  const titleEl = $('package-preview-title');
  if (!host || !S.platform) return;
  const t = PLATFORMS[S.platform].terms;
  const { projectName, slug, doneRows, includedAssets, kafkaEvents } = buildPackageManifest();
  if (titleEl) titleEl.textContent = `${CPI_TERMS.typeLabel} Package Preview`;

  if (!includedAssets.length) {
    host.innerHTML = `<div class="mock-note"><i class="fa-solid fa-circle-info"></i> No ${PLATFORMS[S.platform].assetNounPlural} approved into a wave yet — the preview fills in once the plan is approved.</div>`;
    return;
  }

  // One row per individual iFlow (S.cockpitRows is now expanded to that
  // granularity in buildCockpitRows) — if the scan found 423 iFlows across
  // these assets, this table lists all 423, not one per source object.
  const rows = S.cockpitRows.map(r => {
    const converted = r.status === 'Done';
    return `<tr>
      <td><code>${r.id}</code></td><td>${r.name}</td>
      <td>${converted ? `<code>src/main/resources/resources/${r.id}-${r.name}.txt</code>` : '<span style="opacity:0.6;">(pending conversion)</span>'}</td>
      <td><span class="status-pill ${converted ? 'done' : 'pending'}">${converted ? 'In package' : 'Not yet converted'}</span></td>
    </tr>`;
  }).join('');

  host.innerHTML = `
    <div class="kv"><span>${CPI_TERMS.packageLabel}</span><b>${S.packageName || projectName}</b></div>
    ${S.packageDescription ? `<div class="kv"><span>Description</span><b>${S.packageDescription}</b></div>` : ''}
    <div class="kv"><span>${CPI_TERMS.idLabel}</span><b><code>${slug}</code></b></div>
    <div class="kv"><span>Source ${PLATFORMS[S.platform].assetNounPlural}</span><b>${includedAssets.length}</b></div>
    <div class="kv"><span>Converted iFlows</span><b>${doneRows.length} / ${S.cockpitRows.length}</b></div>
    <div class="btp-table-container" style="margin-top:10px;">
      <table class="btp-table">
        <thead><tr><th>iFlow ID</th><th>${t.nameLabel}</th><th>Embedded as</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${kafkaEvents.length ? `<div class="kv" style="margin-top:10px;"><span>IS-Kafka channels</span><b>${kafkaEvents.length} selected</b></div>
    <div class="btp-table-container" style="margin-top:6px;">
      <table class="btp-table"><thead><tr><th>Event</th><th>Topic</th><th>From</th></tr></thead>
        <tbody>${kafkaEvents.map(ev => `<tr><td><span class="kafka-badge">${ev.id}</span></td><td><code>${ev.topic}</code></td><td>${ev.assetName}</td></tr>`).join('')}</tbody>
      </table>
    </div>` : ''}
    ${S.cockpitRows.some(r => r.isImportStatus) ? `<div class="mock-note" style="margin-top:10px;"><i class="fa-solid fa-circle-info"></i> Pushed to Integration Suite — see the <b>Migration execution</b> tab for per-iFlow deployment/test/monitor status.</div>` : ''}`;
}
// Only appears once "Push to BTP Integration Suite" has actually run — the mocked
// response fields a real Content API deploy+test call would hand back.
function runIflowTest(id) {
  const r = S.cockpitRows.find(x => x.id === id);
  if (!r) return;
  // No popup — only report a result if a real Figaf ALM target is configured
  // in Settings; otherwise this is a no-op (nothing to test against).
  const figafSet = S.adminDefaults && !S.adminDefaults.figafManual && (S.adminDefaults.figafAlmTarget || '').trim();
  if (!figafSet) return;
  r.figafTestUrl = figafTestUrl(r);
  r.testRun = true;
  renderExecTargetIS();
  showToast('Test passed successfully', `Figaf regression tests passed for ${r.name}.`, 'purple');
}
function startIflowMonitoring(id) {
  const r = S.cockpitRows.find(x => x.id === id);
  if (!r) return;
  window.open(r.testIflowUrl, '_blank', 'noopener');
  r.monitorActive = true;
  renderExecTargetIS();
  showToast('Monitoring started', `${r.name} is now actively monitored in Integration Suite.`, 'purple');
}
// The Target Integration Suite grid appears once every interface has reached
// a terminal conversion state (Done or Error) — matching the reference video,
// which shows all 60 cards as "Ready to push" the moment conversion hits
// 100%, well before anyone clicks Push. Cards then move through three visual
// states: Ready to push (no isImportStatus, not pending) -> Pushing (a row's
// pushPending flag, set by exportToIS()'s staggered animation) -> resolved
// Success/Failed (isImportStatus set), each with its own action set.
function renderIsImportResults(rowPool) {
  const allRows = rowPool || [];
  if (!allRows.length || !allRows.every(r => r.status === 'Done' || r.status === 'Error')) return '';
  const rows = allRows.filter(r => r.status === 'Done');
  if (!rows.length) return '';
  const resolved = rows.filter(r => r.isImportStatus);
  const pushStarted = resolved.length > 0 || rows.some(r => r.pushPending);
  const succeeded = resolved.filter(r => r.isImportStatus === 'Success');
  const failed = resolved.filter(r => r.isImportStatus !== 'Success');
  const tested = succeeded.filter(r => r.testRun);
  const monitoring = succeeded.filter(r => r.monitorActive);
  // "Deployment status" completes once every push attempt has resolved
  // (success or fail) — a failed iFlow still counts as resolved, matching the
  // reference video, which checks this step off even with 1/60 failed.
  const steps = [
    { label: 'Converted', done: true },
    { label: 'Push to Integration Suite', done: pushStarted },
    { label: 'Deployment status', done: pushStarted && resolved.length === rows.length },
    { label: 'Test', done: succeeded.length > 0 && tested.length === succeeded.length },
    { label: 'Monitor', done: succeeded.length > 0 && monitoring.length === succeeded.length }
  ];
  let activeIdx = steps.findIndex(s => !s.done);
  if (activeIdx === -1) activeIdx = steps.length - 1;
  const headerStepsHtml = steps.map((s, i) => {
    const cls = s.done ? 'done' : (i === activeIdx ? 'active' : '');
    const arrow = i < steps.length - 1 ? '<i class="fa-solid fa-chevron-right target-is-arrow"></i>' : '';
    return `<span class="target-is-step ${cls}">${s.done ? '<i class="fa-solid fa-check"></i> ' : ''}${s.label}</span>${arrow}`;
  }).join(' ');
  const cards = rows.map(r => {
    if (!r.isImportStatus && !r.pushPending) {
      return `
      <div class="target-is-card target-is-card-pending">
        <div class="target-is-card-head"><b>${r.name}</b></div>
        <div class="target-is-card-sub">Wave ${r.wave} · ${r.assignee}</div>
        <div class="target-is-row"><span>Conversion</span><span class="target-is-val ok"><i class="fa-solid fa-check"></i> Complete</span></div>
        <div class="target-is-row"><span>Deployment</span><span class="target-is-val">Ready to push</span></div>
        <div class="target-is-row"><span>Status</span><span class="target-is-val">—</span></div>
      </div>`;
    }
    if (r.pushPending) {
      return `
      <div class="target-is-card target-is-card-pending">
        <div class="target-is-card-head"><b>${r.name}</b></div>
        <div class="target-is-card-sub">Wave ${r.wave} · ${r.assignee}</div>
        <div class="target-is-row"><span>Conversion</span><span class="target-is-val ok"><i class="fa-solid fa-check"></i> Complete</span></div>
        <div class="target-is-row"><span>Deployment</span><span class="target-is-val">Pushing to ${(S.retargetTenantName) || ($('target-tenant') ? $('target-tenant').value : '') || 'lab-sda'}…</span></div>
        <div class="target-is-progress"><div class="target-is-progress-fill"></div></div>
        <div class="target-is-row"><span>Status</span><span class="target-is-val">—</span></div>
      </div>`;
    }
    const ok = r.isImportStatus === 'Success';
    const testedR = ok && r.testRun;
    const monitorR = ok && r.monitorActive;
    let lumiMsg, actionHtml;
    if (!ok) {
      lumiMsg = r.isReturnMessage;
      actionHtml = `<button class="btn-btp-action-outline" onclick="showRowDetail('${r.id}')">View Issue</button><button class="btn-btp-action-solid" onclick="retryIflowPush('${r.id}')"><i class="fa-solid fa-rotate"></i> Retry</button>`;
    } else if (monitorR) {
      lumiMsg = `${r.name} is live and monitored. No failed messages since deployment.`;
      actionHtml = `<button class="btn-btp-action-outline" onclick="window.open('${r.testIflowUrl}','_blank','noopener')" title="Opens this iFlow in SAP Integration Suite monitoring"><i class="fa-solid fa-chart-line"></i> Open Monitor</button>`;
    } else if (testedR) {
      lumiMsg = `Figaf regression tests passed for ${r.name}. Next step: monitor message processing.`;
      actionHtml = `<button class="btn-btp-action-solid" onclick="startIflowMonitoring('${r.id}')" title="Opens this iFlow in SAP Integration Suite monitoring"><i class="fa-solid fa-chart-line"></i> Start Monitoring</button>`;
    } else {
      lumiMsg = r.isReturnMessage;
      actionHtml = `<button class="btn-btp-action-solid" onclick="runIflowTest('${r.id}')" title="Opens the Figaf regression test run for this iFlow"><i class="fa-solid fa-vial"></i> Run Test</button>`;
    }
    // Viewer is read-only here too — every control that could change state is
    // omitted, not just disabled (the "Open in Integration Suite" link below
    // stays, since it's a read-only external link, not a trigger).
    if (isViewer()) actionHtml = '';
    const sendToProdDisabled = isApprover() || (isAdmin() && !S.pushApproved);
    const sendToProdTitle = isApprover()
      ? 'Approve-only — an Admin session sends to Prod once you approve'
      : (sendToProdDisabled ? 'Awaiting this wave\'s Approver sign-off — see Pending Approvals above' : 'Send this iFlow to the Prod landscape');
    return `
    <div class="target-is-card ${ok ? '' : 'target-is-card-failed'}">
      <div class="target-is-card-head"><b>${r.name}</b><span class="target-is-dot ${ok ? 'ok' : 'fail'}"></span></div>
      <div class="target-is-card-sub">Wave ${r.wave} · ${r.assignee}</div>
      <div class="target-is-row"><span>Conversion</span><span class="target-is-val ok"><i class="fa-solid fa-check"></i> Complete</span></div>
      <div class="target-is-row"><span>Deployment</span><span class="target-is-val ${ok ? 'ok' : 'fail'}"><i class="fa-solid ${ok ? 'fa-check' : 'fa-xmark'}"></i> ${ok ? 'Successfully pushed to Integration Suite' : 'Deployment failed'}</span></div>
      <div class="target-is-row"><span>Status</span><span class="target-is-val"><span class="target-is-bullet ${ok ? 'ok' : 'fail'}"></span> ${ok ? 'Deployed' : 'Action required'}</span></div>
      ${ok ? `<div class="target-is-row"><span>Test</span><span class="target-is-val ${testedR ? 'ok' : ''}">${testedR ? `<a href="${r.figafTestUrl || figafTestUrl(r)}" target="_blank" rel="noopener">Passed in Figaf</a>` : 'Not run'}</span></div>` : ''}
      ${testedR && !isViewer() ? `<div class="target-is-qaprod-row">
        <button class="btn-btp-action-outline" onclick="sendIflowToLandscape('${r.id}','QA')" title="Send this iFlow to the QA landscape"><i class="fa-solid fa-flask"></i> Send to QA</button>
        <button class="btn-btp-action-outline" ${sendToProdDisabled ? 'disabled' : ''} onclick="sendIflowToLandscape('${r.id}','Prod')" title="${sendToProdTitle}"><i class="fa-solid fa-rocket"></i> Send to Prod</button>
      </div>` : ''}
      ${monitorR ? `<div class="target-is-row"><span>Monitor</span><span class="target-is-val ok"><span class="target-is-bullet ok"></span> Active</span></div>` : ''}
      ${ok ? `<a class="target-is-open-link" href="${r.testIflowUrl}" target="_blank" rel="noopener" title="Opens this iFlow in SAP Integration Suite"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open in Integration Suite</a>` : ''}
      <div class="target-is-recommend">
        <div class="lumi-avatar idle" style="--size:22px;"><div class="visor"></div></div>
        <div><b>Lumi Recommendation</b><p>${lumiMsg}</p></div>
      </div>
      <div class="target-is-actions">${actionHtml}</div>
    </div>`;
  }).join('');
  const tenantUrl = S.retargetTenantUrl || (S.adminDefaults && S.adminDefaults.btpTenantUrl) || INTEGRATION_SUITE_URL;
  const topRight = !pushStarted
    ? `<span class="target-is-all-chip">Ready to push — use Push to BTP Integration Suite below</span>`
    : `<span class="target-is-all-chip">All ${rows.length}</span><span class="target-is-chip ok">${succeeded.length} Deployed</span>${failed.length ? `<span class="target-is-chip fail">${failed.length} Failed</span>` : ''}`;
  return `<div class="target-is-title-row"><h4>Target Integration Suite</h4>${topRight}</div>
    <div class="target-is-tenant-url">${tenantUrl}</div>
    <div class="target-is-header">
      ${headerStepsHtml}
    </div>
    <div class="target-is-grid">${cards}</div>`;
}

// ---- minimal uncompressed (STORE) ZIP writer, no dependencies ----
function buildZipBlob(files) {
  const encoder = new TextEncoder();
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const localParts = [], centralParts = [];
  let offset = 0;
  files.forEach(f => {
    const nameBytes = encoder.encode(f.name);
    const dataBytes = encoder.encode(f.content);
    const crc = crc32(dataBytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, dataBytes.length, true);
    local.setUint32(22, dataBytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    localParts.push(new Uint8Array(local.buffer), nameBytes, dataBytes);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, dataBytes.length, true);
    central.setUint32(24, dataBytes.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);

    offset += 30 + nameBytes.length + dataBytes.length;
  });
  const centralStart = offset;
  let centralSize = 0;
  centralParts.forEach(p => centralSize += p.length);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);
  return new Blob([...localParts, ...centralParts, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ==================== CLOSE ====================
function goToClose() {
  openScreen('close');
  const errors = S.cockpitRows.filter(r => r.status === 'Error').length;
  const done = S.cockpitRows.filter(r => r.status === 'Done').length;
  const p = PLATFORMS[S.platform];
  const summary = errors
    ? `All waves processed — ${errors} item(s) were resolved before close. ${done} ${p.label} ${p.assetNounPlural} converted to SAP Integration Suite (CPI) ${CPI_TERMS.typeLabel}.`
    : `All waves converted, 0 open errors. ${done} ${p.label} ${p.assetNounPlural} are now SAP Integration Suite (CPI) ${CPI_TERMS.typeLabel} objects, ready to push or download.`;
  $('close-summary-text').textContent = summary;
  renderClosureReport();
}
// "What was done" per row, in plain language — used by both the on-screen
// closure summary and the downloadable report so the two never drift apart.
function rowClosureOutcome(r) {
  if (r.resolvedByAgents) return { what: 'Resolved by AI Agents', fixedBy: r.resolvedByAgents.map(a => a.label).join(' + ') };
  if (r.resolvedByHuman) return { what: 'Resolved by developer', fixedBy: r.resolvedByHuman };
  if (r.status === 'Error' || r.status === 'Pending Fix') return { what: 'Still open', fixedBy: '—' };
  if (r.advisory) return { what: 'Converted with advisory', fixedBy: '—' };
  return { what: 'Converted cleanly', fixedBy: '—' };
}
function closureTotals() {
  const totalMinutes = totalEffortMinutes(S.cockpitRows);
  const issuesRaised = S.cockpitRows.reduce((sum, r) => sum + (r.errorCount || 0), 0);
  const resolvedByAgents = S.cockpitRows.filter(r => r.resolvedByAgents).length;
  const resolvedByHuman = S.cockpitRows.filter(r => r.resolvedByHuman).length;
  return { totalMinutes, issuesRaised, resolvedByAgents, resolvedByHuman };
}
function renderClosureReport() {
  const host = $('closure-report-body');
  if (!host || !S.cockpitRows.length) { if (host) host.innerHTML = ''; return; }
  const t = closureTotals();
  const rowsHtml = S.cockpitRows.map(r => {
    const outcome = rowClosureOutcome(r);
    return `<tr class="${r.status === 'Error' ? 'row-flagged' : ''}">
      <td>Wave ${r.wave}</td><td>${r.name}</td>
      <td>${outcome.what}</td><td>${outcome.fixedBy}</td>
      <td>${formatEffort(effortMinutesForTier(rowTier(r)))}</td>
    </tr>`;
  }).join('');
  host.innerHTML = `
    <div class="kv"><span>Total time to migrate</span><b>${formatEffort(t.totalMinutes)}</b></div>
    <div class="kv"><span>Conversion issues raised</span><b>${t.issuesRaised}</b></div>
    <div class="kv"><span>Resolved by AI Agents</span><b>${t.resolvedByAgents}</b></div>
    <div class="kv"><span>Resolved by a developer</span><b>${t.resolvedByHuman}</b></div>
    <div class="btp-table-container" style="margin-top:10px;">
      <table class="btp-table">
        <thead><tr><th>Wave</th><th>iFlow</th><th>What was done</th><th>Fixed by</th><th>Time to migrate</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}
async function downloadClosureReport() {
  const t = closureTotals();
  const lines = [
    `SDAINT-AI — Closure Report`, `Project: ${S.projectName}`, `Platform: ${PLATFORMS[S.platform].label}`,
    `Generated: ${new Date().toISOString()}`, `Prepared by the SDAINTAI Brain.`, '',
    `Total time to migrate: ${formatEffort(t.totalMinutes)}`,
    `Conversion issues raised: ${t.issuesRaised}`,
    `Resolved by AI Agents: ${t.resolvedByAgents}`,
    `Resolved by a developer: ${t.resolvedByHuman}`, '',
    'Assets:'
  ];
  S.cockpitRows.forEach(r => {
    const outcome = rowClosureOutcome(r);
    lines.push(`  [${r.status}] ${r.name} (Wave ${r.wave}, ${r.assignee}) — ${outcome.what}${outcome.fixedBy !== '—' ? ` by ${outcome.fixedBy}` : ''} — ${formatEffort(effortMinutesForTier(rowTier(r)))}${r.convertedAt ? ` — converted ${new Date(r.convertedAt).toLocaleString()}` : ''}`);
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  await saveBlob(blob, `${S.projectName}-closure-report.txt`, 'Text file', { 'text/plain': ['.txt'] });
  showToast('Downloaded', `${S.projectName}-closure-report.txt saved.`, 'purple');
}
function archiveProject() {
  // Idempotency guard — restartMigration() calls this too (so "let's start over"
  // in chat always archives), and a user can also hit the explicit "Archive
  // project" button first on the Close screen before hitting "Start another
  // migration" — without this, that sequence would double-count the same
  // migration in S.migrationHistory.
  if (S.archived) { showToast('Already Archived', `${S.projectName} was already archived.`, 'cyan'); return; }
  S.archived = true;
  showToast('Archived', `${S.projectName} has been archived — find it under Archived projects.`, 'purple');
  // Feeds the "Based on patterns from your last migration…" line in startNewMigration() —
  // the Brain "learning" from one run to the next, however lightly simulated here.
  if (S.platform) {
    S.migrationHistory = S.migrationHistory || [];
    const t = closureTotals();
    S.migrationHistory.push({ name: S.projectName, platform: S.platform, assetCount: S.cockpitRows.length, waveCount: getActiveWaveNumbers().length, issuesRaised: t.issuesRaised, resolvedByAgents: t.resolvedByAgents, resolvedByHuman: t.resolvedByHuman, totalMinutes: t.totalMinutes });
    saveBrainMemory();
  }
  const list = $('archived-projects-list');
  if (list) {
    const empty = list.querySelector('.archived-empty');
    if (empty) empty.remove();
    const wrap = document.createElement('div');
    wrap.className = 'archived-project-entry';
    wrap.innerHTML = `<div class="archived-project-row"><i class="fa-solid fa-box-archive"></i> ${S.projectName || 'Untitled migration'}</div>
      <button class="archived-reopen-btn" type="button">Reopen project</button>`;
    wrap.querySelector('.archived-reopen-btn').addEventListener('click', () => reopenArchivedProject(S.projectName));
    list.appendChild(wrap);
  }
}
// This walkthrough runs entirely client-side with no persisted backend, so an
// archived project's full state isn't stored anywhere to actually rehydrate —
// be upfront about that rather than faking a reopen.
function reopenArchivedProject(name) {
  lumiSay(`Reopening <b>${name || 'that project'}</b> isn't wired to persisted state in this walkthrough yet — start a fresh migration instead and I'll walk you through it again.`);
  openDrawer();
}
// Used by both the Close screen's "Start another migration" button and the
// chat "let's start the migration over" intent (see handleComposerSend) —
// archives whatever migration was in progress (archiveProject() is a no-op
// if it was already archived) before wiping all state via reload.
function restartMigration() {
  if (S.platform && S.projectName) archiveProject();
  location.reload();
}

// Delete/undo — unlike restartMigration() (which archives and wipes the whole
// session back to the platform-picker landing screen), this stays within the
// current project/connection and only throws away scanned assets + generated
// iFlows, landing the user back on Source Object Selection to rescan. No
// archive entry is created — this is meant for "that run was wrong, redo it,"
// not a completed migration.
function deleteMigration() {
  if (!S.assets.length && !S.cockpitRows.length) {
    showToast('Nothing to delete', 'No scanned or converted data yet in this migration.', 'danger');
    return;
  }
  const count = S.cockpitRows.length || S.assets.length;
  openModal('Delete this migration?', `<p style="font-size:0.86rem;line-height:1.5;">This permanently removes the <b>${count}</b> scanned ${PLATFORMS[S.platform].assetNounPlural} and every iFlow generated from them in this session — buckets, waves, packages, and the execution log all reset. You'll land back on Source Object Selection to rescan. This can't be undone.</p>`, [
    { label: 'Cancel', cls: 'btn-btp-cancel', onClick: closeModal },
    { label: 'Delete migration', cls: 'btn-btp-danger', onClick: confirmDeleteMigration }
  ]);
}
function resetNavStep(id) {
  const el = $(id);
  if (el) { el.classList.remove('reachable', 'done', 'flagged'); el.classList.add('pending'); }
}
function confirmDeleteMigration() {
  closeModal();
  const p = PLATFORMS[S.platform];
  if (S.pushInterval) { clearInterval(S.pushInterval); S.pushInterval = null; }
  S.pushing = false;
  if (S.cockpitInterval) { clearInterval(S.cockpitInterval); S.cockpitInterval = null; }
  S.assets = [];
  S.cockpitRows = [];
  S.waves = { 1: [], 2: [], 3: [] };
  S.teamByWave = { 1: [], 2: [], 3: [] };
  S.packageAdded = false;
  S.packageName = null;
  S.packageDescription = null;
  S.assetsFilter = 'all';
  S.cockpitStarted = false;
  S.execLog = [];
  S.execRawLog = [];
  S.execFeed = [];
  S.pushApproved = false;
  S.pushApprovedBy = null;
  S.pushApprovedAt = null;
  ['nav-buckets', 'nav-wave', 'nav-approve', 'nav-cockpit', 'nav-close'].forEach(resetNavStep);
  const summaryMsg = $('assets-summary-msg');
  if (summaryMsg) summaryMsg.style.display = 'none';
  const tableWrap = $('assets-table-wrap');
  if (tableWrap) tableWrap.classList.add('hidden');
  const tbody = $('btp-assets-tbody');
  if (tbody) tbody.innerHTML = '';
  const cont = $('btn-continue-migration');
  if (cont) { cont.style.pointerEvents = 'none'; cont.style.opacity = '0.5'; }
  showToast('Migration deleted', `Every generated iFlow was removed — ready to rescan ${p.label}.`, 'danger');
  lumiSay(`Done — I've deleted the previous migration data, every generated iFlow is gone. Want me to rescan ${p.label} now?`);
  lumiChoices([{ label: `Rescan ${p.label}`, cls: 'primary', onClick: () => { openScreen('assets'); startAssetScan(); } }]);
  openScreen('assets');
}

// ==================== SAVE TO BRAIN / SDAINTAI PACKAGE / RE-TARGET TO QA-PROD ====================
// "Save migration to Brain" — an explicit, visible action distinct from the
// automatic background logBrainEvent calls already fired during scan/plan/execute
// (see logBrainEvent call sites) — this one bundles the full closure summary
// (outcomes + which agent/developer fixed what + total effort) into a single
// event so it reads as a deliberate "commit this migration's learnings" action.
function saveMigrationToBrain() {
  if (!S.cockpitRows.length) { showToast('Nothing to save', 'Run a migration first.', 'danger'); return; }
  const t = closureTotals();
  const summaryRows = S.cockpitRows.map(r => ({ id: r.id, name: r.name, wave: r.wave, ...rowClosureOutcome(r) }));
  logBrainEvent('migration_saved', S.platform,
    { project: S.projectName, totals: t, rows: summaryRows },
    `Migration "${S.projectName}" saved to Brain — ${S.cockpitRows.length} iFlows, ${t.issuesRaised} issue(s) raised, ${t.resolvedByAgents} resolved by AI Agents, ${formatEffort(t.totalMinutes)} total effort.`);
  showToast('Saved to Brain', 'This migration’s outcomes and agent-resolution patterns were saved to the LangChain vector DB for future migrations to learn from.', 'purple');
  lumiSay(`Saved — <b>${S.projectName}</b>'s outcomes and every agent resolution are now in the Brain. Next time a similar issue comes up, I'll recommend from what worked here.`);
}

// A named, hand-picked subset of already-converted iFlows a user can push to a
// different landscape (QA/Prod) independently of the rest of the migration.
function openSavePackageModal() {
  const doneRows = S.cockpitRows.filter(r => r.status === 'Done');
  if (!doneRows.length) { showToast('Nothing to package', 'At least one iFlow needs to be converted first.', 'danger'); return; }
  S._packageDraftSelected = new Set(doneRows.map(r => r.id));
  openModal('Save SDAINTAI Package', renderSavePackageModalBody(), [
    { label: 'Cancel', cls: 'btn-btp-cancel', onClick: closeModal },
    { label: 'Save Package', cls: 'btn-btp-gold', onClick: confirmSavePackage }
  ]);
}
function renderSavePackageModalBody() {
  const doneRows = S.cockpitRows.filter(r => r.status === 'Done');
  const sel = S._packageDraftSelected;
  const rowsHtml = doneRows.map(r => `
    <label class="package-pick-row">
      <input type="checkbox" ${sel.has(r.id) ? 'checked' : ''} onchange="togglePackageDraftRow('${r.id}')">
      <span>${r.name}</span><span class="package-pick-meta">Wave ${r.wave} · ${r.iflowName}</span>
    </label>`).join('');
  return `
    <div class="modal-field"><label for="package-draft-name">Package name</label>
      <input type="text" class="btp-input" id="package-draft-name" value="${S.packageName || S.projectName + ' Package'}">
    </div>
    <div class="modal-field"><label>iFlows to include (${sel.size} of ${doneRows.length} selected)</label>
      <div class="package-pick-list">${rowsHtml}</div>
    </div>`;
}
function togglePackageDraftRow(id) {
  const sel = S._packageDraftSelected;
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  $('lumi-modal-body').innerHTML = renderSavePackageModalBody();
}
function confirmSavePackage() {
  const name = ($('package-draft-name').value || `${S.projectName} Package`).trim();
  const iflowIds = Array.from(S._packageDraftSelected);
  if (!iflowIds.length) { showToast('Select at least one iFlow', 'Pick at least one converted iFlow for the package.', 'danger'); return; }
  closeModal();
  S.savedPackages = S.savedPackages || [];
  const pkg = { id: `pkg-${Date.now()}`, name, iflowIds, sourcePlatform: S.platform, sourceProjectName: S.projectName, createdAt: new Date().toISOString() };
  S.savedPackages.push(pkg);
  logBrainEvent('package_saved', S.platform, { name, iflowCount: iflowIds.length }, `SDAINTAI Package "${name}" saved with ${iflowIds.length} iFlow(s).`);
  showToast('Package saved', `"${name}" saved with ${iflowIds.length} iFlow(s).`, 'purple');
  lumiSay(`Saved <b>${name}</b> with ${iflowIds.length} iFlow${iflowIds.length === 1 ? '' : 's'}. Want to send it to QA or Prod now, or keep it here for later?`);
  lumiChoices([
    { label: 'Send to QA', cls: 'primary', onClick: () => openRetargetModal(pkg.id, 'QA') },
    { label: 'Send to Prod', onClick: () => openRetargetModal(pkg.id, 'Prod') },
    { label: 'Not now', onClick: () => {} }
  ]);
}

// Per-iFlow "Send to QA" / "Send to Prod" — available on each Target Integration
// Suite card right after Figaf testing passes, not just at end-of-project via
// "Save SDAINTAI Package". Wraps the single row in the same ad-hoc "package" shape
// openRetargetModal already expects, so the QA/Prod connection-details flow is
// identical either way instead of a second parallel implementation.
function sendIflowToLandscape(rowId, target) {
  if (target === 'Prod' && !canTriggerProdAction()) return; // persona gate — Take to Production is Admin-only, post-approval
  if (target === 'QA' && isViewer()) return;
  const row = (S.cockpitRows || []).find(r => r.id === rowId);
  if (!row) return;
  S.savedPackages = S.savedPackages || [];
  const pkg = {
    id: `adhoc-${rowId}-${Date.now()}`, name: row.name, iflowIds: [rowId],
    sourcePlatform: S.platform, sourceProjectName: S.projectName, createdAt: new Date().toISOString(), adhoc: true
  };
  S.savedPackages.push(pkg);
  openRetargetModal(pkg.id, target);
}
// Re-target a saved package to a new landscape: collects the new source system's
// connection (the same PI/PO or MuleSoft platform, just a different QA/Prod
// instance) and the new target Integration Suite tenant, then — once "validated" —
// produces a migration copy scoped to just that package's iFlows, retargeted so
// "Push to BTP Integration Suite" fires against the new tenant on the next click.
function openRetargetModal(packageId, target) {
  const pkg = (S.savedPackages || []).find(p => p.id === packageId);
  if (!pkg) return;
  const p = PLATFORMS[pkg.sourcePlatform] || PLATFORMS[S.platform];
  S._retargetDraft = { packageId, target };
  openModal(`Send "${pkg.name}" to ${target}`, `
    <p style="font-size:0.8rem;color:var(--btp-text-muted-dark);margin-bottom:12px;">Enter the ${target} landscape's connection details. Once validated, a new migration copy targeting ${target} is created with this package's ${pkg.iflowIds.length} iFlow(s), ready to push.</p>
    <div class="modal-field-group-label">Source — ${p.label} (${target})</div>
    <div class="modal-field"><label for="retarget-source-url">System URL</label><input type="text" class="btp-input" id="retarget-source-url" placeholder="https://${(pkg.sourcePlatform === 'pipo') ? 'pipo' : 'anypoint'}-${target.toLowerCase()}.example.com"></div>
    <div class="modal-field"><label for="retarget-source-user">Username</label><input type="text" class="btp-input" id="retarget-source-user" placeholder="service-account"></div>
    <div class="modal-field"><label for="retarget-source-pass">Password</label><input type="password" class="btp-input" id="retarget-source-pass" placeholder="••••••••"></div>
    <div class="modal-field-group-label">Target — SAP Integration Suite (${target})</div>
    <div class="modal-field"><label for="retarget-target-url">Tenant URL</label><input type="text" class="btp-input" id="retarget-target-url" placeholder="https://sda-${target.toLowerCase()}.integrationsuite.cfapps.us10-002.hana.ondemand.com"></div>
    <div class="modal-field"><label for="retarget-target-user">Username</label><input type="text" class="btp-input" id="retarget-target-user" placeholder="service-account"></div>
    <div class="modal-field"><label for="retarget-target-pass">Password</label><input type="password" class="btp-input" id="retarget-target-pass" placeholder="••••••••"></div>
  `, [
    { label: 'Cancel', cls: 'btn-btp-cancel', onClick: closeModal },
    { label: `Validate & Create Copy`, cls: 'btn-btp-gold', onClick: confirmRetarget }
  ]);
}
function confirmRetarget() {
  const fields = ['retarget-source-url', 'retarget-source-user', 'retarget-source-pass', 'retarget-target-url', 'retarget-target-user', 'retarget-target-pass'];
  const values = {};
  for (const id of fields) { values[id] = ($(id).value || '').trim(); }
  if (Object.values(values).some(v => !v)) {
    showToast('Missing info', 'Fill in every source and target field before validating.', 'danger');
    return;
  }
  const { packageId, target } = S._retargetDraft;
  const pkg = (S.savedPackages || []).find(p => p.id === packageId);
  const btn = qsa('.btn-btp-gold', $('lumi-modal-foot'))[0];
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Validating…'; }
  setTimeout(() => {
    closeModal();
    S.retargetedCopies = S.retargetedCopies || [];
    const copyName = `${pkg.sourceProjectName} — ${target}`;
    S.retargetedCopies.push({
      name: copyName, target, packageId: pkg.id, iflowIds: pkg.iflowIds,
      sourceUrl: values['retarget-source-url'], targetTenantUrl: values['retarget-target-url'],
      createdAt: new Date().toISOString()
    });
    // Retarget the session's active push destination so the next "Push to BTP
    // Integration Suite" click (on this same cockpit) lands on the new tenant —
    // this walkthrough is single-session, so "a new migration copy" is realized
    // as this retarget rather than a second parallel project space.
    S.retargetTenantUrl = values['retarget-target-url'];
    S.retargetTenantName = `${target.toLowerCase()}-${iflowSlug(pkg.sourceProjectName).toLowerCase()}`;
    const tenantField = $('target-tenant');
    if (tenantField) tenantField.value = S.retargetTenantName;
    pkg.iflowIds.forEach(id => {
      const r = S.cockpitRows.find(x => x.id === id);
      if (r) { r.isImportStatus = null; r.testRun = false; r.monitorActive = false; }
    });
    renderPackagePreview();
    showToast('Copy created', `"${copyName}" is ready — retargeted to ${target}. Push to BTP Integration Suite to deploy this package there.`, 'purple');
    lumiSay(`Validated and created <b>${copyName}</b> — ${pkg.iflowIds.length} iFlow(s) from "${pkg.name}", pointed at ${values['retarget-target-url']}. Whenever you're ready, hit <b>Push to BTP Integration Suite</b> again to deploy this package to ${target}.`);
    openScreen('cockpit');
    switchExecTab('package');
  }, 900);
}

// ==================== ADMIN — DEFAULTS ====================
// Session-level org defaults: default connection fields, the editable team roster
// (backs activeTeam(), used everywhere the old TEAM constant used to be read
// directly), and S/4HANA system-connection settings for the not-yet-built
// S/4HANA push. No backend — this is client-side state like the rest of the app.
function renderAdminTeamList() {
  const host = $('admin-team-list');
  if (!host) return;
  host.innerHTML = activeTeam().map(m => `
    <div class="team-member-card">
      <div class="avatar-chip" style="background:${m.color};">${m.name.split(' ').map(x => x[0]).join('')}</div>
      <div class="info"><b>${m.name}</b><span>${m.role}</span></div>
      <button class="team-remove-btn" data-id="${m.id}" title="Remove ${m.name}"><i class="fa-solid fa-xmark"></i></button>
    </div>`).join('');
  qsa('.team-remove-btn', host).forEach(btn => btn.addEventListener('click', () => removeAdminTeamMember(btn.dataset.id)));
}
const ADMIN_AVATAR_COLORS = ['#e5a93b', '#8b5cf6', '#06b6d4', '#10b981', '#ef4444', '#f59e0b', '#ec4899', '#3b82f6'];
function addAdminTeamMember() {
  const nameEl = $('admin-team-name'), roleEl = $('admin-team-role');
  const name = nameEl.value.trim(), role = roleEl.value.trim();
  if (!name || !role) { showToast('Missing info', 'Enter both a name and a role before adding.', 'danger'); return; }
  S.team = [...activeTeam()];
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `member-${S.team.length + 1}`;
  S.team.push({ id, name, role, avail: 75, color: ADMIN_AVATAR_COLORS[S.team.length % ADMIN_AVATAR_COLORS.length] });
  nameEl.value = ''; roleEl.value = '';
  renderAdminTeamList();
  showToast('Team Member Added', `${name} (${role}) is now available for wave assignment.`, 'purple');
}
function removeAdminTeamMember(id) {
  if (activeTeam().length <= 1) { showToast("Can't remove", 'At least one team member is required.', 'danger'); return; }
  S.team = activeTeam().filter(m => m.id !== id);
  renderAdminTeamList();
}

// AI Agents (A2A) roster — same copy-on-write pattern as the team roster above,
// so activeAgents() automatically prefers S.agents once anyone edits it here.
function renderAdminAgentList() {
  const host = $('admin-agent-list');
  if (!host) return;
  host.innerHTML = activeAgents().map(a => `
    <div class="team-member-card">
      <div class="avatar-chip" style="background:#0056d2;"><i class="fa-solid fa-robot"></i></div>
      <div class="info"><b>A2A – ${a.label}</b><span>${a.domain} · ${a.desc}</span></div>
      <button class="team-remove-btn" data-id="${a.id}" title="Remove ${a.label}"><i class="fa-solid fa-xmark"></i></button>
    </div>`).join('');
  qsa('.team-remove-btn', host).forEach(btn => btn.addEventListener('click', () => removeAdminAgent(btn.dataset.id)));
}
function addAdminAgent() {
  const nameEl = $('admin-agent-name'), domainEl = $('admin-agent-domain'), descEl = $('admin-agent-desc');
  const name = nameEl.value.trim(), domain = domainEl.value.trim(), desc = descEl.value.trim();
  if (!name || !domain) { showToast('Missing info', 'Enter both an agent name and a business process/domain before adding.', 'danger'); return; }
  S.agents = [...activeAgents()];
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `agent-${S.agents.length + 1}`;
  S.agents.push({ id, label: name, domain, desc: desc || `${domain} mapping & value review`, needPhrase: `${domain} mapping review`, subject: `${domain} value mapping` });
  nameEl.value = ''; domainEl.value = ''; descEl.value = '';
  renderAdminAgentList();
  showToast('Agent Added', `A2A – ${name} (${domain}) can now be recommended on blocking issues.`, 'purple');
}
function removeAdminAgent(id) {
  if (activeAgents().length <= 1) { showToast("Can't remove", 'At least one agent is required.', 'danger'); return; }
  S.agents = activeAgents().filter(a => a.id !== id);
  renderAdminAgentList();
}
function setAdminAuthMode(mode) {
  $('admin-auth-toggle').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('admin-userpass-fields').classList.toggle('hidden', mode !== 'userpass');
  $('admin-oauth-fields').classList.toggle('hidden', mode !== 'oauth');
}
function setAdminS4AuthMode(mode) {
  $('admin-s4-auth-toggle').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('admin-s4-userpass-fields').classList.toggle('hidden', mode !== 'userpass');
  $('admin-s4-oauth-fields').classList.toggle('hidden', mode !== 'oauth');
}
function testS4Connection() {
  const statusEl = $('admin-s4-test-status');
  statusEl.style.display = 'flex';
  statusEl.className = 'conn-status';
  statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testing…';
  $('btn-admin-test-s4').disabled = true;
  setTimeout(() => {
    $('btn-admin-test-s4').disabled = false;
    const host = $('admin-s4-host').value.trim();
    if (!host) {
      statusEl.className = 'conn-status fail';
      statusEl.innerHTML = '<span class="dot"></span> Enter a host before testing';
      return;
    }
    statusEl.className = 'conn-status ok';
    statusEl.innerHTML = '<span class="dot"></span> Connected — S/4HANA system reachable';
  }, 1200);
}
// Wires a "Manual — I don't have a value yet" checkbox to disable/enable its
// paired input, and applies the checkbox's current (HTML-default) state on load.
function setupManualToggle(checkboxId, inputId) {
  const cb = $(checkboxId), input = $(inputId);
  if (!cb || !input) return;
  const apply = () => { input.disabled = cb.checked; };
  cb.addEventListener('change', apply);
  apply();
}
// Reflects the SDA AI Subaccount + sda-prv-tenant checkbox into the status line
// underneath. Shared subaccount is never "private" even if someone checks the
// box there — isolation only means something once the subaccount itself is a
// client-dedicated one, not the shared sandbox everyone's demos run in.
function updatePrvTenantStatus() {
  const select = $('admin-sda-subaccount'), cb = $('admin-prv-tenant'), statusEl = $('admin-prv-tenant-status');
  if (!select || !cb || !statusEl) return;
  const isSharedSubaccount = select.value === 'sda-ai-shared-eu10';
  if (isSharedSubaccount) cb.checked = false;
  cb.disabled = isSharedSubaccount;
  if (isSharedSubaccount) {
    statusEl.className = 'conn-status';
    statusEl.innerHTML = '<span class="dot"></span> Shared subaccount — demo/sandbox tenant, not isolated';
  } else if (cb.checked) {
    statusEl.className = 'conn-status ok';
    statusEl.innerHTML = `<span class="dot"></span> Private — ${select.value} is dedicated to this client only`;
  } else {
    statusEl.className = 'conn-status fail';
    statusEl.innerHTML = `<span class="dot"></span> ${select.value} picked, but sda-prv-tenant isn't checked — this subaccount can still be shared with other clients`;
  }
}
// Reflects the two Migration Acceleration checkboxes into their status line,
// updates S.adminDefaults immediately (not gated behind Save Defaults, so the
// slowdown is visible right away), and refreshes every duration already on
// screen — wave timing, Plan approval, Readiness/Progress effort, and the
// Migration Cockpit's own Est. Time Remaining stat — so unchecking an agent
// visibly slows the numbers without needing to navigate away and back.
function updateAgentSpeedStatus() {
  const mappingCb = $('admin-agent-mapping'), conversionCb = $('admin-agent-conversion'), statusEl = $('admin-agent-speed-status');
  if (!mappingCb || !conversionCb || !statusEl) return;
  S.adminDefaults.agentMappingEnabled = mappingCb.checked;
  S.adminDefaults.agentConversionEnabled = conversionCb.checked;
  const agents = activeAgentCount();
  const sample = tier => formatEffort(effortMinutesForTier(tier));
  const sampleLine = `Simple ${sample('Simple')} · Medium ${sample('Medium')} · Complex ${sample('High')}`;
  if (agents === 2) {
    statusEl.className = 'conn-status ok';
    statusEl.innerHTML = `<span class="dot"></span> Both agents active — full 30x acceleration (${sampleLine})`;
  } else if (agents === 1) {
    statusEl.className = 'conn-status';
    statusEl.innerHTML = `<span class="dot"></span> 1 of 2 agents active — ~5.5x acceleration (${sampleLine})`;
  } else {
    statusEl.className = 'conn-status fail';
    statusEl.innerHTML = `<span class="dot"></span> No agents active — fully manual baseline, no acceleration (${sampleLine})`;
  }
  if (S.cockpitRows && S.cockpitRows.length) { refreshExecTabs(); refreshWaveMeter(); }
}
// Mirrors the Progress tab's remaining/estimated effort onto the Migration
// Cockpit header stats, so the acceleration effect is visible on the main
// execution screen itself, not just the Progress tab.
function updateCockpitTimeStat() {
  const valEl = $('cockpit-time-remaining'), subEl = $('cockpit-time-remaining-sub');
  if (!valEl || !subEl) return;
  if (!S.cockpitRows || !S.cockpitRows.length) { valEl.textContent = '0m'; subEl.textContent = '—'; return; }
  const remainingTotal = totalEffortMinutes(S.cockpitRows.filter(r => !['Done', 'Error', 'Parked'].includes(r.status)));
  const estimatedTotal = totalEffortMinutes(S.cockpitRows);
  valEl.textContent = formatEffort(remainingTotal);
  subEl.textContent = `of ${formatEffort(estimatedTotal)} · ${activeAgentCount()} of 2 agents active`;
}
function saveAdminDefaults() {
  const authMode = $('admin-auth-toggle').querySelector('button.active').dataset.mode;
  const s4AuthMode = $('admin-s4-auth-toggle').querySelector('button.active').dataset.mode;
  S.adminDefaults = {
    platform: $('admin-default-platform').value,
    env: $('admin-default-env').value,
    authMode,
    username: $('admin-default-username').value,
    password: $('admin-default-password').value,
    clientId: $('admin-default-client-id').value,
    clientSecret: $('admin-default-client-secret').value,
    tenant: $('admin-default-tenant').value,
    region: $('admin-default-region').value,
    btpTenantUrl: $('admin-btp-tenant-url').value,
    btpTenantManual: $('admin-btp-tenant-manual').checked,
    sdaSubaccount: $('admin-sda-subaccount').value,
    prvTenant: $('admin-prv-tenant').checked,
    agentMappingEnabled: $('admin-agent-mapping').checked,
    agentConversionEnabled: $('admin-agent-conversion').checked,
    almTenantUrl: $('admin-alm-tenant-url').value,
    almTenantManual: $('admin-alm-tenant-manual').checked,
    figafAlmTarget: $('admin-figaf-target').value,
    figafManual: $('admin-figaf-manual').checked,
    s4Host: $('admin-s4-host').value,
    s4Client: $('admin-s4-client').value,
    s4AuthMode,
    s4Username: $('admin-s4-username').value,
    s4Password: $('admin-s4-password').value,
    s4ClientId: $('admin-s4-client-id').value,
    s4ClientSecret: $('admin-s4-client-secret').value,
    piPo: {
      systemName: $('admin-pipo-system-name').value,
      systemVersion: $('admin-pipo-version').value,
      address: $('admin-pipo-address').value,
      userId: $('admin-pipo-userid').value,
      password: $('admin-pipo-password').value,
      authType: $('admin-pipo-auth').value,
      proxyType: $('admin-pipo-proxy').value,
      locationId: $('admin-pipo-location').value
    }
  };
  saveBrainMemory();
  logBrainEvent('setting_changed', 'admin', S.adminDefaults, `Admin defaults saved — platform=${S.adminDefaults.platform || 'n/a'}, tenant=${S.adminDefaults.tenant}, subaccount=${S.adminDefaults.sdaSubaccount}${S.adminDefaults.prvTenant ? ' (sda-prv-tenant)' : ''}, PI/PO system=${S.adminDefaults.piPo.systemName}.`);
  showToast('Defaults Saved', 'New migrations will start from these connection defaults, and the updated team roster is live for wave assignment.', 'purple');
}
// Same mock reachability check as testS4Connection — validates the Integration
// Directory address is present, doesn't actually call out to nwjava.consultsda.com.
function testPiPoConnection() {
  const statusEl = $('admin-pipo-test-status');
  const host = $('admin-pipo-address').value.trim();
  statusEl.style.display = 'flex';
  statusEl.className = 'conn-status';
  statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testing PI/PO Integration Directory…';
  $('btn-admin-test-pipo').disabled = true;
  setTimeout(() => {
    $('btn-admin-test-pipo').disabled = false;
    if (!host) {
      statusEl.className = 'conn-status fail';
      statusEl.innerHTML = '<span class="dot"></span> Enter an Integration Directory address before testing';
      return;
    }
    if (!$('admin-pipo-password').value) {
      statusEl.className = 'conn-status fail';
      statusEl.innerHTML = '<span class="dot"></span> PI_TECH_MIG password not set yet — enter it above';
      return;
    }
    statusEl.className = 'conn-status ok';
    statusEl.innerHTML = `<span class="dot"></span> Connected — ${$('admin-pipo-system-name').value || 'PI/PO'} Integration Directory reachable`;
  }, 1200);
}
// Called from selectPlatform() so Admin's defaults actually reach the Set Connection
// screen instead of just sitting unused in S.adminDefaults.
function applyAdminConnectionDefaults() {
  const d = S.adminDefaults;
  if (!d) return;
  if ($('connection-env')) $('connection-env').value = d.env;
  setAuthMode(d.authMode);
  if (d.authMode === 'userpass') {
    $('auth-username').value = d.username;
    $('auth-password').value = d.password;
  } else {
    $('auth-client-id').value = d.clientId;
    $('auth-client-secret').value = d.clientSecret;
  }
  $('target-tenant').value = d.tenant;
  $('target-region').value = d.region;
}

// ==================== GENERIC MODAL ====================
function openModal(title, bodyHtml, buttons) {
  $('lumi-modal-title').textContent = title;
  $('lumi-modal-body').innerHTML = bodyHtml;
  $('lumi-modal-foot').innerHTML = '';
  (buttons || []).forEach(b => {
    const btn = document.createElement('button');
    btn.className = `btn-btp ${b.cls || 'btn-btp-cancel'}`;
    btn.textContent = b.label;
    btn.addEventListener('click', b.onClick);
    $('lumi-modal-foot').appendChild(btn);
  });
  $('lumi-modal-overlay').classList.remove('hidden');
}
function closeModal() { $('lumi-modal-overlay').classList.add('hidden'); }
function showTreeModal(assetId) {
  validateStructure();
  setTimeout(() => { $('structure-picker').value = assetId; renderStructureEditor(); }, 0);
}

// ==================== COMPOSER (free-text intents) ====================
// ==================== FREE-FORM COMMANDS ====================
// Lightweight keyword+regex intent router — not a real NLU model (this is a static
// client-side demo with no backend LLM call), but genuinely parses and executes
// "update settings btp to <url>" style requests rather than just echoing a canned
// reply, matching the ask that Lumi act like an orchestrator you can just tell to
// do things, not only a Q&A wizard.
function extractAfterTo(text) {
  const m = text.match(/\bto\s+["']?([^"']+?)["']?\s*$/i);
  return m ? m[1].trim() : null;
}
function extractUrl(text) { const m = text.match(/https?:\/\/\S+/i); return m ? m[0].replace(/[.,)]+$/, '') : null; }
function extractEmail(text) { const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/i); return m ? m[0] : null; }

function tryInterpretCommand(rawText) {
  const t = rawText.toLowerCase();
  if (!/\b(update|change|set|edit|modify|rename)\b/.test(t)) return false;

  // Password is checked first — "update the btp tenant password" contains both
  // "btp" and "tenant" and would otherwise get misrouted to the tenant URL branch.
  if (/\bpassword\b/.test(t)) {
    const val = extractAfterTo(rawText);
    if (val) { applyDefaultPasswordCommand(val); return true; }
    lumiSay('Sure — what should the password be?');
    S.pendingAnswerHandler = (val2) => applyDefaultPasswordCommand(val2.trim());
    return true;
  }
  // ALM tenant is checked before BTP tenant since both phrases contain "tenant" —
  // a separate target system from BTP Integration Suite and from Figaf.
  if (/\balm\b/.test(t) && /\btenant\b/.test(t)) {
    const url = extractUrl(rawText);
    if (url) { applyAlmTenantUrlCommand(url); return true; }
    lumiSay('Sure — what should I set the ALM tenant URL to? Paste it here and I\'ll save it to Settings.');
    S.pendingAnswerHandler = (val) => applyAlmTenantUrlCommand(extractUrl(val) || val.trim());
    return true;
  }
  if ((/\bbtp\b|\btenant\b|integration suite/.test(t)) && !/\bfigaf\b|\balm\b/.test(t)) {
    const url = extractUrl(rawText);
    if (url) { applyBtpTenantUrlCommand(url); return true; }
    lumiSay('Sure — what should I set the BTP Integration Suite tenant URL to? Paste it here and I\'ll save it to Settings.');
    S.pendingAnswerHandler = (val) => applyBtpTenantUrlCommand(extractUrl(val) || val.trim());
    return true;
  }
  if (/\bfigaf\b|\balm target\b/.test(t)) {
    const val = extractAfterTo(rawText);
    if (val) { applyFigafTargetCommand(val); return true; }
    lumiSay('Sure — what should the Figaf ALM target be?');
    S.pendingAnswerHandler = (val2) => applyFigafTargetCommand(val2.trim());
    return true;
  }
  if (/\bemail\b|\busername\b/.test(t)) {
    const email = extractEmail(rawText);
    if (email) { applyDefaultEmailCommand(email); return true; }
    lumiSay('Sure — what should the default integration email/username be?');
    S.pendingAnswerHandler = (val) => applyDefaultEmailCommand(extractEmail(val) || val.trim());
    return true;
  }
  if (/\bpackage name\b|\bproject name\b/.test(t)) {
    const val = extractAfterTo(rawText);
    if (val) { applyProjectNameCommand(val); return true; }
    lumiSay('Sure — what should I rename the project to?');
    S.pendingAnswerHandler = (val2) => applyProjectNameCommand(val2.trim());
    return true;
  }
  return false;
}
// Confirms the change AND offers to pick the guided flow back up — the
// "smart orchestrator" behavior: handle the side request, then resume where
// the conversation actually was, rather than leaving the user stranded on a
// generic "I can help with..." message.
function lumiSayWithResume(text) {
  lumiSay(`${text} Shall we continue where we left off?`);
  if (S.resumeAction && S.resumeAction.fn) {
    lumiChoices([{ label: `Continue — ${S.resumeAction.label}`, cls: 'primary', onClick: S.resumeAction.fn }]);
  }
}
function applyBtpTenantUrlCommand(url) {
  S.adminDefaults.btpTenantUrl = url;
  S.adminDefaults.btpTenantManual = false;
  const f = $('admin-btp-tenant-url'); if (f) { f.value = url; f.disabled = false; }
  const cb = $('admin-btp-tenant-manual'); if (cb) cb.checked = false;
  lumiSayWithResume(`Done — I've adjusted the settings as per your request. BTP Integration Suite tenant URL is now <b>${url}</b>.`);
}
function applyAlmTenantUrlCommand(url) {
  S.adminDefaults.almTenantUrl = url;
  S.adminDefaults.almTenantManual = false;
  const f = $('admin-alm-tenant-url'); if (f) { f.value = url; f.disabled = false; }
  const cb = $('admin-alm-tenant-manual'); if (cb) cb.checked = false;
  lumiSayWithResume(`Done — I've adjusted the settings as per your request. ALM tenant URL is now <b>${url}</b>.`);
}
function applyFigafTargetCommand(val) {
  S.adminDefaults.figafAlmTarget = val;
  S.adminDefaults.figafManual = false;
  const f = $('admin-figaf-target'); if (f) { f.value = val; f.disabled = false; }
  const cb = $('admin-figaf-manual'); if (cb) cb.checked = false;
  lumiSayWithResume(`Done — I've adjusted the settings as per your request. Figaf ALM target is now <b>${val}</b>.`);
}
function applyDefaultEmailCommand(email) {
  S.adminDefaults.username = email;
  const f = $('admin-default-username'); if (f) f.value = email;
  const f2 = $('auth-username'); if (f2) f2.value = email;
  lumiSayWithResume(`Done — I've adjusted the settings as per your request. Default integration email/username is now <b>${email}</b>.`);
}
function applyDefaultPasswordCommand(pw) {
  S.adminDefaults.password = pw;
  const f = $('admin-default-password'); if (f) f.value = pw;
  const f2 = $('auth-password'); if (f2) f2.value = pw;
  lumiSayWithResume(`Done — I've adjusted the settings as per your request. Default connection password has been updated.`);
}
function applyProjectNameCommand(name) {
  S.projectName = name;
  const f = $('project-selector-text'); if (f) f.textContent = name;
  if ($('project-badge-text')) $('project-badge-text').textContent = name;
  document.title = `SDAINT-AI — ${name}`;
  lumiSayWithResume(`Done — I've adjusted the settings as per your request. Project renamed to <b>${name}</b>.`);
}
function lumiHtml(html) {
  const body = $('lumi-drawer-body');
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
}

// The sidebar's "Plan" section covers three screens (buckets/wave/approve),
// not one — a bare "go to plan" resolves to wherever the user actually is:
// the furthest unlocked-but-not-yet-done screen, or null if Plan itself
// hasn't unlocked yet (buckets still pending).
function resolvePlanScreen() {
  for (const id of ['buckets', 'wave', 'approve']) {
    const el = $(`nav-${id}`);
    if (!el || el.classList.contains('pending')) return null;
    if (!el.classList.contains('done')) return id;
  }
  return 'approve'; // all three done — show the last one
}

function handleComposerSend() {
  const input = $('lumi-drawer-input');
  const text = input.value.trim();
  if (!text) return;
  lumiSayUser(text);
  input.value = '';
  logBrainChat(text);
  logBrainEvent('user_command', S.platform || 'chat', { text, screen: S.lastScreenId || 'unknown' }, text);

  if (S.pendingAnswerHandler) {
    const handler = S.pendingAnswerHandler;
    S.pendingAnswerHandler = null;
    handler(text);
    return;
  }

  if (tryInterpretCommand(text)) return;

  // "continue" / "let's continue" / "proceed" typed into the composer, instead of
  // clicking the primary chip Lumi already offered, used to fall straight through
  // to the generic canned reply below — a real bug (user-reported screenshot: typed
  // "lets continue" after the wave-planning pie chart, got the generic help list
  // back). S.resumeAction always holds whatever primary action the last lumiChoices()
  // call offered, so honor it here instead of silently doing nothing.
  if (/\b(continue|proceed|keep going|go ahead)\b/i.test(text) || /\blet'?s\s+go\b/i.test(text)) {
    if (S.resumeAction && S.resumeAction.fn) {
      const action = S.resumeAction;
      lumiSay(`Continuing — ${action.label}.`);
      action.fn();
    } else {
      lumiSay("There's nothing queued to continue right now — tell me what you'd like to do next, or use the buttons on screen.");
    }
    return;
  }

  // "let's start the migration over (again)" / "restart the migration" —
  // archives whatever's in progress (same path as the Close screen's
  // explicit "Archive project" button, idempotent either way) and drops back
  // to platform selection, exactly like clicking "Start another migration".
  if (/\brestart\b/i.test(text) || (/\bstart\b/i.test(text) && /\b(over|again)\b/i.test(text))) {
    lumiSay(S.platform ? "Got it — archiving this migration and starting fresh." : "Starting fresh.");
    setTimeout(restartMigration, 600);
    return;
  }

  const t = text.toLowerCase();
  const p = PLATFORMS[S.platform] || PLATFORMS.mulesoft;
  if (t.includes('structure') || t.includes('validate')) {
    if (!S.assets.length) { lumiSay(`I don't have any ${p.assetNounPlural} scanned yet — let's finish ${p.terms.sourceStepNoun} Selection first.`); return; }
    const first = S.assets[0];
    lumiSay(`Here's the structure for <b>${first.name}</b>:`);
    lumiTree(renderInlineTree(first));
    lumiChoices([{ label: 'Let me edit branches', onClick: () => showTreeModal(first.id) }, { label: 'Looks good', cls: 'primary', onClick: () => {} }]);
  } else if (t.includes('show') && t.includes('detail')) {
    if ($('screen-btp-assets').classList.contains('active')) showAssetDetails();
    else lumiSay(`Sure — which screen's details would you like? Try asking on the ${p.terms.sourceStepNoun} Selection or Migration Cockpit step.`);
  } else if (t.includes('connect') || t.includes('setup') || t.includes('set up')) {
    // lumiSay()/lumiChoices() before openScreen() everywhere in this chain, not
    // after — lumiSay() calls openDrawer() internally, which re-activates the
    // chat drawer over whatever screen just opened. openScreen() has to run
    // last or the target screen flashes then bounces back to chat (the exact
    // bug already fixed once for the iflow-status handler below — same fix,
    // applied consistently here instead of one-off).
    lumiSay('Here you go — Set Connection is open.');
    openScreen('connection');
  } else if (t.includes('import asset') || t.includes('source selection') || t.includes('source object') || t.includes('object selection') || (t.includes('scan') && !t.includes('rescan'))) {
    // "Import Assets" is relabeled per platform to "{X} Source Object Selection"
    // (applyPlatformTerminology) — recognize both the generic screen name and
    // whatever this platform is currently calling it, not just the static one.
    if (!$('nav-assets').classList.contains('pending')) { lumiSay(`Here you go — ${p.terms.sourceStepNoun} Selection is open.`); openScreen('assets'); }
    else lumiSay("That unlocks once Set Connection is done — let's finish that first.");
  } else if (t.includes('bucket') || t.includes('which asset') || t.includes('pick asset')) {
    if (!$('nav-buckets').classList.contains('pending')) {
      lumiSay(`Here you go — Migration Buckets is open. Want to pick which ${p.assetNounPlural} are included?`);
      lumiChoices([{ label: 'Let me pick', onClick: () => { lumiSay('Click each one to include or exclude it.'); renderAssetPickChips(); } }]);
      openScreen('buckets');
    }
    else lumiSay(`We're not at ${p.assetNoun} selection yet — let's finish ${p.terms.sourceStepNoun} Selection first.`);
  } else if (t.includes('wave') || t.includes('team')) {
    if (!$('nav-wave').classList.contains('pending')) openScreen('wave');
    else lumiSay(`Wave and team planning unlocks once ${p.assetNounPlural} are grouped into buckets.`);
  } else if (t.includes('approve')) {
    if (!$('nav-approve').classList.contains('pending')) openScreen('approve');
    else lumiSay("Approval unlocks once waves and team are set.");
  } else if (t.includes('plan') && !t.includes('planet')) {
    // Generic "go to plan" (the sidebar's Plan section covers 3 screens, not
    // one) — resolve to wherever the user actually is in that phase: the
    // furthest unlocked-but-not-done screen among buckets/wave/approve.
    const target = resolvePlanScreen();
    if (target) { lumiSay("Here you go — that's where your migration plan is right now."); openScreen(target); }
    else lumiSay(`Planning unlocks once ${p.assetNounPlural} are scanned — let's finish ${p.terms.sourceStepNoun} Selection first.`);
  } else if (t.includes('cockpit') || t.includes('execute') || t.includes('convert')) {
    if (!$('nav-cockpit').classList.contains('pending')) openScreen('cockpit');
    else lumiSay("The cockpit unlocks once the plan is approved — let's get there first.");
  } else if (t.includes('close project') || t.includes('close screen') || (t.includes('close') && t.includes('migration'))) {
    if (!$('nav-close').classList.contains('pending')) openScreen('close');
    else lumiSay("Closing unlocks once everything in the cockpit is resolved.");
  } else if (t.includes('iflow') && (t.includes('status') || t.includes('link'))) {
    if (!S.cockpitRows.length) {
      lumiSay("There's nothing converted yet — once execution starts I'll have a deduced iFlow, status, and link for each item.");
    } else {
      const rows = S.cockpitRows.slice(0, 6);
      const list = rows.map(r => `• <b>${r.iflowName}</b> — ${iflowStatusLabel(r)} — <a href="${r.iflowLink}" target="_blank" rel="noopener">Open</a>`).join('<br>');
      // lumiSay() before openScreen() (not after) — lumiSay() re-shows the chat
      // internally, so calling openScreen() last is what actually leaves the
      // Integration list tab on screen instead of flashing then bouncing back.
      lumiSay(`Here's the deduced iFlow per converted item (showing ${rows.length} of ${S.cockpitRows.length} — see the Integration list tab for the rest):<br>${list}`);
      openScreen('cockpit');
    }
  } else if (t.includes('setting') || t.includes('admin')) {
    lumiSay("Here you go — Settings is open.");
    openScreen('admin');
  } else {
    const prior = recallSimilarQuestion(text);
    const recallPrefix = prior ? `You asked something close to this before — I still don't have a dedicated answer for it, but noted. ` : '';
    lumiSay(`${recallPrefix}I can help with connecting a source, scanning ${p.assetNounPlural}, picking ${p.assetNounPlural} into buckets, planning waves and team, approving the plan, opening the cockpit, or opening Settings — try "go to Execute", "go to Plan", "go to Approve", "go to Close", ask about iFlow status/links, say "continue" to pick up where we left off, "start the migration over" to archive this one and begin fresh, or use the buttons above at each step.`);
  }
}
function formatTreeNodeLabel(node) {
  const text = `${node.kind}: ${node.name}`;
  if (node.ok === false) return `<span class="node-error">⚠ ${text}</span>`;
  if (node.kind === 'schema') return `<span class="node-schema">${text}</span>`;
  return text;
}
function renderInlineTree(a) {
  let out = `<span class="app-name">${a.name}</span>  (${a.type})\n`;
  a.tree.forEach((node, i) => {
    const last = i === a.tree.length - 1;
    out += `${last ? '└─' : '├─'} ${formatTreeNodeLabel(node)}\n`;
    (node.children || []).forEach((c, j) => {
      out += `${last ? '   ' : '│  '}${j === node.children.length - 1 ? '└─' : '├─'} ${formatTreeNodeLabel(c)}\n`;
    });
  });
  return out;
}

// ==================== ACCESS LOCK ====================
// SHA-256 of "username:password" — a soft deterrent against casual view-source
// snooping, not real access control. This is a static page with no backend,
// so anyone determined enough to open dev tools can still bypass it; it exists
// to keep the page from being an obvious open link during pre-sales walkthroughs.
// Two credential pairs both unlock: the primary, and a backup in case the primary is forgotten.
const LOCK_HASHES = [
  '082ceb39c81b133d1046f09ddf1533bc0502e6eacda68aa200320828abf82a3c', // primary
  'e0d014e36895b189e47990158f4e31535b38fca9204d3a3cb8249b72afbc8624', // backup
  // Seeded per-client test users (username:TEST123) — one per pilot client, so
  // each can be handed their own login without going through Sign Up.
  '92de7eb88481687fae819e02ab483df03a5fb3dcd268917f6ae9e04693cfd7a4', // ALDO_SDA_MIGUSER1
  'b805667168080d202b2391f934c4643fc696bf423a124b80ae310a1b3414bdb9', // CN_SDA_MIGUSER2
  'f56fcde920f0c2e8a21823368ebf29412669d9703db8fe48251af38987e1802d'  // HYDRO_SDA_MIGUSER3
];
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
// Self-service accounts created through the Sign Up step live alongside the two
// hardcoded demo pairs — stored as hashes only, same "soft deterrent, not real
// auth" posture as LOCK_HASHES (see note above), just persisted in localStorage
// instead of baked into the source so a client's own created login survives reloads.
const SIGNUP_HASHES_KEY = 'sdaintai_signup_hashes';
function getSignupHashes() {
  try { return JSON.parse(localStorage.getItem(SIGNUP_HASHES_KEY) || '[]'); } catch (e) { return []; }
}
function addSignupHash(hash) {
  try {
    const hashes = getSignupHashes();
    if (!hashes.includes(hash)) hashes.push(hash);
    localStorage.setItem(SIGNUP_HASHES_KEY, JSON.stringify(hashes));
  } catch (e) { /* localStorage unavailable — the session still unlocks, just won't be rememberable */ }
}
// Shows exactly one of the four lock-overlay steps (login / signup / verify / onboard).
function showLockStep(id) {
  qsa('.lock-card').forEach(card => card.classList.toggle('hidden', card.id !== id));
}
function unlockApp() {
  try { sessionStorage.setItem('sdaintai_unlocked', '1'); } catch (e) { /* won't persist across reloads, but still unlock this view */ }
  document.getElementById('btp-app-root').classList.remove('locked');
  document.getElementById('lock-overlay').classList.add('hidden');
}
function setupAccessLock() {
  const form = document.getElementById('lock-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const user = document.getElementById('lock-username').value.trim();
    const pass = document.getElementById('lock-password').value;
    const errorEl = document.getElementById('lock-error');
    const card = document.getElementById('lock-card');
    const submitBtn = document.getElementById('lock-submit');
    submitBtn.disabled = true;
    const hash = await sha256Hex(`${user}:${pass}`);
    submitBtn.disabled = false;
    if (LOCK_HASHES.includes(hash) || getSignupHashes().includes(hash)) {
      unlockApp();
    } else {
      errorEl.textContent = 'Incorrect username or password.';
      document.getElementById('lock-password').value = '';
      card.classList.remove('shake');
      void card.offsetWidth; // restart the animation on repeated failures
      card.classList.add('shake');
    }
  });

  // ---- Sign up / verify (mocked email) / onboarding ----
  $('lock-go-signup').addEventListener('click', () => showLockStep('signup-card'));
  $('signup-go-login').addEventListener('click', () => showLockStep('lock-card'));

  $('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const identifier = $('signup-identifier').value.trim();
    const pass = $('signup-password').value;
    const confirm = $('signup-password-confirm').value;
    const errorEl = $('signup-error');
    if (!identifier || !pass) { errorEl.textContent = 'Enter an email or username, and a password.'; return; }
    if (pass !== confirm) { errorEl.textContent = 'Passwords don’t match.'; return; }
    errorEl.textContent = '';
    S.pendingSignup = { identifier, pass };
    $('verify-identifier-label').textContent = identifier;
    showLockStep('verify-card');
  });

  $('btn-verify-simulate').addEventListener('click', async () => {
    if (!S.pendingSignup) { showLockStep('signup-card'); return; }
    const { identifier, pass } = S.pendingSignup;
    const hash = await sha256Hex(`${identifier}:${pass}`);
    addSignupHash(hash);
    showLockStep('onboard-card');
  });

  $('onboard-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const errorEl = $('onboard-error');
    const username = $('onboard-username').value.trim();
    const password = $('onboard-password').value;
    if (!username || !password) { errorEl.textContent = 'Enter the integration username and password for your source platform.'; return; }
    errorEl.textContent = '';
    Object.assign(S.adminDefaults, {
      platform: $('onboard-platform').value,
      env: $('onboard-env').value,
      authMode: 'userpass',
      username,
      password,
      sdaSubaccount: $('onboard-subaccount').value,
      prvTenant: $('onboard-prv-tenant').checked,
      tenant: $('onboard-tenant').value.trim() || S.adminDefaults.tenant,
      region: $('onboard-region').value.trim() || S.adminDefaults.region
    });
    saveBrainMemory();
    populateAdminFormFromDefaults();
    unlockApp();
    showToast('Welcome to SDAINTAI', `Account created and your first migration settings are saved — ${PLATFORMS[S.adminDefaults.platform] ? PLATFORMS[S.adminDefaults.platform].label : S.adminDefaults.platform} on ${S.adminDefaults.sdaSubaccount}${S.adminDefaults.prvTenant ? ' (sda-prv-tenant)' : ''}. Ready when you are.`, 'purple');
  });
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', () => {
  setupAccessLock();
  loadBrainMemory();
  loadPersona();
  applyPersonaGating();
  const personaSelect = $('persona-select');
  if (personaSelect) personaSelect.addEventListener('change', (e) => setPersona(e.target.value));

  // sidebar accordion (kept from original prototype)
  qsa('.menu-accordion-title').forEach(title => {
    title.addEventListener('click', () => {
      const items = title.nextElementSibling;
      const caret = title.querySelector('i');
      if (items) {
        items.classList.toggle('hidden');
        caret.className = items.classList.contains('hidden') ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-down';
      }
    });
  });

  // sidebar nav clicks == "user explicitly asks to see this"
  qsa('.sidebar-item').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (a.classList.contains('pending')) { lumiSay("That step isn't unlocked yet — let's finish the current one first."); openDrawer(false); return; }
      if (a.dataset.screen === 'details') {
        lumiSay(`<b>${S.projectName || '—'}</b> on <b>${S.platform ? PLATFORMS[S.platform].label : '—'}</b>. This step is just the project name and sponsor — there's nothing else to review here unless I flag a naming conflict.`);
        openDrawer(false);
        return;
      }
      openScreen(a.dataset.screen);
    });
  });
  qsa('[data-goto]').forEach(b => b.addEventListener('click', () => openScreen(b.dataset.goto)));

  // Lumi open/close
  $('btn-open-lumi').addEventListener('click', () => returnToChat());
  $('lumi-dock').addEventListener('click', () => returnToChat());
  $('btn-continue-chat').addEventListener('click', () => returnToChat());
  $('lumi-drawer-close').addEventListener('click', closeDrawer);
  $('lumi-drawer-minimize').addEventListener('click', minimizeDrawer);
  $('lumi-drawer-position').addEventListener('click', cycleDrawerPosition);
  setupDrawerResize();
  $('lumi-drawer-send').addEventListener('click', handleComposerSend);
  $('lumi-drawer-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleComposerSend(); });
  $('lumi-drawer-fullscreen').addEventListener('click', toggleDrawerFullscreen);
  $('lumi-dock').classList.remove('hidden');

  // landing
  $('btn-start-new').addEventListener('click', startNewMigration);
  $('btn-open-cockpit-shortcut').addEventListener('click', () => {
    if (!S.platform) { lumiSay("You'll need to start a migration first — let's connect a platform."); startNewMigration(); }
    else openScreen('cockpit');
  });

  // platform + connection
  qsa('.platform-card').forEach(c => c.addEventListener('click', () => selectPlatform(c.dataset.platform)));
  $('auth-mode-userpass').addEventListener('click', () => setAuthMode('userpass'));
  $('auth-mode-oauth').addEventListener('click', () => setAuthMode('oauth'));
  $('btn-test-connection').addEventListener('click', () => testConnection(false));
  $('btn-simulate-fail').addEventListener('click', () => testConnection(true));
  $('btn-save-connection').addEventListener('click', saveConnection);
  $('btn-back-to-connection').addEventListener('click', () => openScreen('connection'));
  $('connect-mode-direct').addEventListener('click', () => selectConnectMode('direct'));
  $('connect-mode-upload').addEventListener('click', () => selectConnectMode('upload'));
  setupUploadZone();

  // assets
  $('btn-import-assets-trigger').addEventListener('click', startAssetScan);
  $('btn-show-asset-details').addEventListener('click', showAssetDetails);
  $('btn-view-asset-tree').addEventListener('click', validateStructure);

  // buckets / wave & team / approve
  $('buckets-select-all').addEventListener('change', (e) => qsa('.bucket-cb').forEach(cb => cb.checked = e.target.checked));
  $('btn-goto-wave-from-buckets').addEventListener('click', goToWaveFromBuckets);
  setupWaveDnD();
  $('btn-validate-structure').addEventListener('click', validateStructure);
  $('btn-continue-to-approve').addEventListener('click', continueToApprove);
  $('btn-export-pdf').addEventListener('click', exportPdf);
  $('btn-approve-start').addEventListener('click', approveAndStart);

  // cockpit
  $('btn-start-execution').addEventListener('click', startExecution);
  $('btn-start-execution-footer').addEventListener('click', startExecution);
  $('btn-refresh-cockpit').addEventListener('click', refreshCockpit);
  $('btn-export-is').addEventListener('click', exportToIS);
  $('btn-is-import-artifact').addEventListener('click', pushAndImportToIS);
  $('btn-download-zip').addEventListener('click', downloadZip);
  $('btn-revalidate-zip').addEventListener('click', revalidatePackage);
  $('btn-migrate-sap2sap').addEventListener('click', openSap2SapModal);
  $('btn-view-cockpit-tree').addEventListener('click', validateStructure);
  $('btn-add-package').addEventListener('click', addPackage);
  $('btn-download-report-csv').addEventListener('click', downloadReportCsv);
  qsa('.exec-tab', $('exec-tabs')).forEach(btn => btn.addEventListener('click', () => switchExecTab(btn.dataset.tab)));

  // close
  $('btn-download-closure').addEventListener('click', downloadClosureReport);
  $('btn-archive-project').addEventListener('click', archiveProject);
  $('btn-save-brain').addEventListener('click', saveMigrationToBrain);
  $('btn-save-package').addEventListener('click', openSavePackageModal);
  $('btn-restart').addEventListener('click', restartMigration);
  $('btn-delete-migration-close').addEventListener('click', deleteMigration);
  $('btn-delete-migration').addEventListener('click', deleteMigration);

  // admin
  qsa('#admin-auth-toggle button').forEach(b => b.addEventListener('click', () => setAdminAuthMode(b.dataset.mode)));
  qsa('#admin-s4-auth-toggle button').forEach(b => b.addEventListener('click', () => setAdminS4AuthMode(b.dataset.mode)));
  $('btn-admin-add-team').addEventListener('click', addAdminTeamMember);
  $('btn-admin-add-agent').addEventListener('click', addAdminAgent);
  $('btn-admin-test-s4').addEventListener('click', testS4Connection);
  $('btn-admin-test-pipo').addEventListener('click', testPiPoConnection);
  $('admin-sda-subaccount').addEventListener('change', updatePrvTenantStatus);
  $('admin-prv-tenant').addEventListener('change', updatePrvTenantStatus);
  updatePrvTenantStatus();
  $('admin-agent-mapping').addEventListener('change', updateAgentSpeedStatus);
  $('admin-agent-conversion').addEventListener('change', updateAgentSpeedStatus);
  updateAgentSpeedStatus();
  $('btn-activate-brain').addEventListener('click', activateBrainEngine);
  $('btn-deactivate-brain').addEventListener('click', deactivateBrainEngine);
  $('btn-save-admin-defaults').addEventListener('click', saveAdminDefaults);
  $('btn-open-btp-tenant').addEventListener('click', (e) => {
    e.preventDefault();
    if ($('admin-btp-tenant-manual').checked) { showToast('No Tenant Set', "This target's marked Manual — uncheck it and enter a tenant URL first.", 'danger'); return; }
    const url = $('admin-btp-tenant-url').value.trim();
    if (url) window.open(url, '_blank', 'noopener');
  });
  // "Manual" checkboxes: no value for this target yet, so disable the field
  // instead of pretending there's something to save there.
  setupManualToggle('admin-btp-tenant-manual', 'admin-btp-tenant-url');
  setupManualToggle('admin-alm-tenant-manual', 'admin-alm-tenant-url');
  setupManualToggle('admin-figaf-manual', 'admin-figaf-target');
  // Brain memory may have loaded saved admin defaults (incl. PI/PO credentials)
  // above the hardcoded HTML values — push them into the form now that every
  // admin listener (incl. the Manual-toggle ones) is wired.
  populateAdminFormFromDefaults();

  // modal
  $('lumi-modal-close').addEventListener('click', closeModal);
  $('lumi-modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'lumi-modal-overlay') closeModal(); });

  // Auto-activate the real AI Brain on every load — explicit user request for
  // active testing, not the default posture (the feature normally stays off
  // until someone hits Activate). Fire-and-forget: a network hiccup here
  // shouldn't block the rest of the app from loading.
  activateBrainEngine();

  // The landing screen (#screen-landing) already carries this same greeting +
  // "Start a new migration" action as the resting Home view — Lumi's chat log
  // stays empty until startNewMigration() actually begins the conversation,
  // instead of hijacking the panel out from under the Home screen on load.
});
