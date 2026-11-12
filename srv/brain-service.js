const cds = require('@sap/cds');
const LOG = cds.log('brain-service');
const { verifyKey, readState, writeState, isBrainEnabled } = require('./ai/brainConfig');
const { getVectorStore } = require('./ai/vectorStore');
// DRY-2 fix: Import centralized complexity scorer
const { scoreMultiDimensional } = require('./utils/complexityScorer');

// ── SAP Migration knowledge base (seeded into vector store) ──────────────────
const MIGRATION_KNOWLEDGE = [
  // Master Data — Simple
  { id: 'GLMAST', desc: 'GL Account Master', tier: 'simple', tool: 'BAPI_GL_ACC_SAVE', hours: 4, adapterType: 'idoc', segmentCount: 5, hasZFields: false },
  { id: 'COSMAS', desc: 'Cost Center Master', tier: 'simple', tool: 'BAPI_COSTCENTER_CREATEMULTIPLE', hours: 4, adapterType: 'idoc', segmentCount: 6, hasZFields: false },
  { id: 'PRMAS', desc: 'Profit Center Master', tier: 'simple', tool: 'BAPI_PROFITCENTER_CREATE', hours: 4, adapterType: 'idoc', segmentCount: 5, hasZFields: false },
  { id: 'DEBMAS', desc: 'Customer Master', tier: 'simple', tool: 'BAPI_CUSTOMER_CREATEFROMDATA1', hours: 12, adapterType: 'idoc', segmentCount: 15, hasZFields: false },
  { id: 'CREMAS', desc: 'Vendor/Supplier Master', tier: 'simple', tool: 'BAPI_VENDOR_CREATEFROMDATA', hours: 12, adapterType: 'idoc', segmentCount: 12, hasZFields: false },
  // Master Data — Medium
  { id: 'MATMAS', desc: 'Material Master', tier: 'medium', tool: 'iFlow_SAP_Material_Replication', hours: 20, adapterType: 'idoc', segmentCount: 38, hasZFields: true },
  { id: 'BPMAS', desc: 'Business Partner', tier: 'medium', tool: 'iFlow_SAP_BP_Replication', hours: 24, adapterType: 'soap', segmentCount: 20, hasZFields: true },
  { id: 'KNVK', desc: 'Customer Contact Master', tier: 'medium', tool: 'iFlow_Customer_Replication', hours: 10, adapterType: 'idoc', segmentCount: 8, hasZFields: true },
  // Master Data — Complex
  { id: 'HRMAS', desc: 'HR Master Data', tier: 'complex', tool: 'iFlow_SuccessFactors_Replication', hours: 60, adapterType: 'idoc', segmentCount: 55, hasZFields: true },
  { id: 'ARTMAS', desc: 'Retail Article Master', tier: 'complex', tool: 'iFlow_Custom_ARTMAS', hours: 80, adapterType: 'idoc', segmentCount: 65, hasZFields: true },
  // Transactional — Medium
  { id: 'ORDERS05', desc: 'Purchase Order', tier: 'medium', tool: 'iFlow_Ariba_S4_Integration', hours: 24, adapterType: 'idoc', segmentCount: 22, hasZFields: false },
  { id: 'ORDCHG', desc: 'PO Change', tier: 'medium', tool: 'iFlow_Ariba_S4_Integration', hours: 16, adapterType: 'idoc', segmentCount: 18, hasZFields: false },
  { id: 'ORDRSP', desc: 'Order Confirmation', tier: 'medium', tool: 'iFlow_Ariba_S4_Integration', hours: 16, adapterType: 'idoc', segmentCount: 15, hasZFields: false },
  { id: 'DESADV', desc: 'Delivery Note/ASN', tier: 'medium', tool: 'iFlow_SAP_WMS_Integration', hours: 20, adapterType: 'idoc', segmentCount: 20, hasZFields: false },
  { id: 'WMMBXY', desc: 'Goods Movement', tier: 'medium', tool: 'iFlow_SAP_WMS_Integration', hours: 18, adapterType: 'idoc', segmentCount: 12, hasZFields: false },
  // Transactional — Complex
  { id: 'INVOIC02', desc: 'Invoice', tier: 'complex', tool: 'iFlow_Custom_Finance_INVOIC', hours: 60, adapterType: 'as2', segmentCount: 45, hasZFields: true },
  { id: 'SHPMNT04', desc: 'Shipment', tier: 'complex', tool: 'iFlow_Custom_Logistics_SHPMNT', hours: 50, adapterType: 'idoc', segmentCount: 40, hasZFields: true },
  { id: 'FIDCCP02', desc: 'FI Document', tier: 'complex', tool: 'iFlow_Custom_Finance_FIDCCP', hours: 80, adapterType: 'rest', segmentCount: 50, hasZFields: true },
  { id: 'PEXR2003', desc: 'Payment Advice', tier: 'complex', tool: 'iFlow_Custom_Finance_PEXR', hours: 60, adapterType: 'as2', segmentCount: 35, hasZFields: true },
];

// BAPI lookup for simple objects
const BAPI_MAP = {
  GLMAST: 'BAPI_GL_ACC_SAVE', COSMAS: 'BAPI_COSTCENTER_CREATEMULTIPLE',
  PRMAS: 'BAPI_PROFITCENTER_CREATE', DEBMAS: 'BAPI_CUSTOMER_CREATEFROMDATA1',
  CREMAS: 'BAPI_VENDOR_CREATEFROMDATA', MATMAS: 'BAPI_MATERIAL_SAVEDATA',
};

// SAP Business Accelerator Hub package lookup
const HUB_PACKAGE_MAP = {
  MATMAS: 'SAP S/4HANA Material Replication', DEBMAS: 'SAP Customer Master Replication',
  CREMAS: 'SAP Vendor Master Replication', HRMAS: 'SAP SuccessFactors Employee Central',
  ORDERS05: 'SAP S/4HANA ↔ Ariba Integration', INVOIC02: 'SAP S/4HANA Finance Integration',
  DESADV: 'SAP S/4HANA ↔ 3rd Party WMS', WMMBXY: 'SAP S/4HANA ↔ 3rd Party WMS',
  FIDCCP02: 'SAP S/4HANA Finance Integration', BPMAS: 'SAP BP Replication Add-On',
};

// ── SAP Migration Course Gap #1: Scenario Pattern Classification ─────────────
// Based on SAP PO-to-IS migration course taxonomy
const SCENARIO_PATTERNS = {
  P2P_ASYNC: {
    code: 'P2P_ASYNC',
    name: 'Point-to-Point Asynchronous',
    isTarget: 'Standard iFlow (Async)',
    baseComplexity: 'simple',
    typicalHours: 8,
    detectionRules: { sync: false, receiverCount: 1, bpm: false },
  },
  P2P_SYNC: {
    code: 'P2P_SYNC',
    name: 'Point-to-Point Synchronous',
    isTarget: 'Standard iFlow (Sync)',
    baseComplexity: 'medium',
    typicalHours: 12,
    detectionRules: { sync: true, receiverCount: 1, bpm: false },
  },
  MULTICAST: {
    code: 'MULTICAST',
    name: 'Multicast/Split (1:N)',
    isTarget: 'iFlow with Splitter/Multicast',
    baseComplexity: 'medium',
    typicalHours: 20,
    detectionRules: { sync: false, receiverCount: { min: 2 }, bpm: false },
  },
  CCBPM: {
    code: 'CCBPM',
    name: 'Cross-Component BPM',
    isTarget: 'SAP Build Process Automation / Custom iFlow',
    baseComplexity: 'complex',
    typicalHours: 80,
    detectionRules: { bpm: true, stateful: true },
  },
  BPM: {
    code: 'BPM',
    name: 'Simple BPM (stateless)',
    isTarget: 'iFlow with Orchestration',
    baseComplexity: 'complex',
    typicalHours: 40,
    detectionRules: { bpm: true, stateful: false },
  },
  CUSTOM: {
    code: 'CUSTOM',
    name: 'Custom/Non-Standard Pattern',
    isTarget: 'Custom iFlow (requires analysis)',
    baseComplexity: 'complex',
    typicalHours: 60,
    detectionRules: {},
  },
};

// ── SAP Migration Course Gap #2: SAP Status Terminology ──────────────────────
// Maps internal tiers to official SAP Migration Assessment Tool statuses
const SAP_STATUS_MAP = {
  simple: 'Ready to migrate',
  medium: 'Adjustment required',
  complex: 'Evaluation required',
};

// ── SAP Migration Course Gap #3: Known IS Limitations ────────────────────────
// Pre-defined limitations from SAP official documentation and course materials
const KNOWN_LIMITATIONS = {
  NFS_ADAPTER: {
    code: 'NFS_ADAPTER',
    name: 'NFS Adapter Not Supported',
    category: 'adapter',
    severity: 'blocker',
    description: 'Integration Suite does not support NFS adapter. File-based integration requires SFTP or alternative.',
    workaroundType: 'manual',
    workaroundDesc: 'Replace with SFTP adapter or use Edge Integration Cell with local file system access.',
    effortMultiplier: 2.0,
    detectionRules: { adapterTypes: ['nfs', 'file'] },
  },
  ASMA_HEADER: {
    code: 'ASMA_HEADER',
    name: 'ASMA/Dynamic Configuration',
    category: 'runtime',
    severity: 'major',
    description: 'Adapter-Specific Message Attributes (ASMA) and Dynamic Configuration require manual conversion to Camel headers or Content Modifier.',
    workaroundType: 'script',
    workaroundDesc: 'Convert ASMA lookups to Camel exchange properties using Groovy script in iFlow.',
    effortMultiplier: 1.5,
    detectionRules: { features: ['asma', 'dynamicConfiguration', 'adapter.udf'] },
  },
  ACK_HANDLING: {
    code: 'ACK_HANDLING',
    name: 'Acknowledgment Handling Differs',
    category: 'feature',
    severity: 'major',
    description: 'PI/PO acknowledgment handling (ALEAUD, positive/negative acks) works differently in IS.',
    workaroundType: 'manual',
    workaroundDesc: 'Implement acknowledgment logic using iFlow exception handling and custom status tracking.',
    effortMultiplier: 1.3,
    detectionRules: { features: ['ack', 'acknowledgment', 'aleaud'] },
  },
  CCBPM_STATEFUL: {
    code: 'CCBPM_STATEFUL',
    name: 'ccBPM Stateful Process',
    category: 'feature',
    severity: 'blocker',
    description: 'Cross-component BPM with stateful correlation cannot be directly migrated. Requires redesign.',
    workaroundType: 'none',
    workaroundDesc: 'Redesign using SAP Build Process Automation or stateless iFlow patterns with external state management.',
    effortMultiplier: 3.0,
    detectionRules: { isBpmProcess: true, patterns: ['ccbpm', 'correlation'] },
  },
  JAVA_MAPPING: {
    code: 'JAVA_MAPPING',
    name: 'Java Mapping Programs',
    category: 'mapping',
    severity: 'major',
    description: 'Custom Java mappings must be converted to Groovy scripts or iFlow message mapping.',
    workaroundType: 'script',
    workaroundDesc: 'Convert Java logic to Groovy script step or use XSLT. Complex logic may need external microservice.',
    effortMultiplier: 1.8,
    detectionRules: { mappingTypes: ['java'] },
  },
  ABAP_MAPPING: {
    code: 'ABAP_MAPPING',
    name: 'ABAP Mapping Programs',
    category: 'mapping',
    severity: 'major',
    description: 'ABAP mappings are not supported in IS and must be rewritten.',
    workaroundType: 'manual',
    workaroundDesc: 'Rewrite ABAP logic as Groovy script or expose as BAPI/Function Module and call via RFC adapter.',
    effortMultiplier: 2.0,
    detectionRules: { mappingTypes: ['abap'] },
  },
  JMS_ADAPTER: {
    code: 'JMS_ADAPTER',
    name: 'JMS Adapter Differences',
    category: 'adapter',
    severity: 'major',
    description: 'JMS adapter in IS has different configuration and may not support all JMS provider features.',
    workaroundType: 'manual',
    workaroundDesc: 'Verify JMS provider compatibility. Consider AMQP adapter or Advanced Event Mesh as alternative.',
    effortMultiplier: 1.5,
    detectionRules: { adapterTypes: ['jms'] },
  },
  JDBC_STORED_PROC: {
    code: 'JDBC_STORED_PROC',
    name: 'JDBC Stored Procedure Calls',
    category: 'adapter',
    severity: 'minor',
    description: 'JDBC adapter stored procedure syntax differs between PI/PO and IS.',
    workaroundType: 'manual',
    workaroundDesc: 'Adjust stored procedure call syntax. Complex procedures may need wrapper functions.',
    effortMultiplier: 1.2,
    detectionRules: { adapterTypes: ['jdbc'], features: ['storedProcedure'] },
  },
  RFC_TRFC: {
    code: 'RFC_TRFC',
    name: 'tRFC/qRFC Transaction Handling',
    category: 'adapter',
    severity: 'minor',
    description: 'Transactional RFC and queued RFC handling differs in IS RFC adapter.',
    workaroundType: 'manual',
    workaroundDesc: 'Review tRFC/qRFC requirements. May need to use synchronous RFC with custom retry logic.',
    effortMultiplier: 1.2,
    detectionRules: { adapterTypes: ['rfc'], features: ['trfc', 'qrfc'] },
  },
  AS2_MDN: {
    code: 'AS2_MDN',
    name: 'AS2 MDN Handling',
    category: 'adapter',
    severity: 'minor',
    description: 'AS2 MDN (Message Disposition Notification) configuration differs in IS.',
    workaroundType: 'manual',
    workaroundDesc: 'Reconfigure MDN settings in IS AS2 adapter. Verify with trading partner.',
    effortMultiplier: 1.1,
    detectionRules: { adapterTypes: ['as2'] },
  },
};

// ── Helper: Classify scenario pattern ────────────────────────────────────────
function classifyScenarioPattern(input) {
  const { isBpmProcess, receiverCount, isSync, hasCorrelation } = input;

  if (isBpmProcess) {
    return hasCorrelation ? SCENARIO_PATTERNS.CCBPM : SCENARIO_PATTERNS.BPM;
  }
  if ((receiverCount || 1) > 1) {
    return SCENARIO_PATTERNS.MULTICAST;
  }
  if (isSync) {
    return SCENARIO_PATTERNS.P2P_SYNC;
  }
  return SCENARIO_PATTERNS.P2P_ASYNC;
}

// ── Helper: Map tier to SAP Migration Status ─────────────────────────────────
function tierToSapStatus(tier) {
  return SAP_STATUS_MAP[tier] || 'Evaluation required';
}

// ── Helper: Identify applicable limitations ──────────────────────────────────
function identifyLimitations(input) {
  const detected = [];
  const { adapterType, mappingType, isBpmProcess, hasCorrelation, features = [] } = input;
  const adapterLower = (adapterType || '').toLowerCase();
  const mappingLower = (mappingType || '').toLowerCase();
  const featuresLower = features.map(f => f.toLowerCase());

  for (const [code, limitation] of Object.entries(KNOWN_LIMITATIONS)) {
    const rules = limitation.detectionRules;
    let matches = false;

    // Check adapter type rules
    if (rules.adapterTypes && rules.adapterTypes.some(a => adapterLower.includes(a))) {
      matches = true;
    }
    // Check mapping type rules
    if (rules.mappingTypes && rules.mappingTypes.some(m => mappingLower.includes(m))) {
      matches = true;
    }
    // Check BPM rules
    if (rules.isBpmProcess && isBpmProcess) {
      if (!rules.patterns || rules.patterns.some(p => hasCorrelation && p === 'correlation')) {
        matches = true;
      }
    }
    // Check feature rules
    if (rules.features && rules.features.some(f => featuresLower.includes(f))) {
      matches = true;
    }

    if (matches) {
      detected.push({
        code: limitation.code,
        name: limitation.name,
        severity: limitation.severity,
        category: limitation.category,
        workaroundType: limitation.workaroundType,
        workaroundDesc: limitation.workaroundDesc,
        effortMultiplier: limitation.effortMultiplier,
      });
    }
  }

  return detected;
}

// ── SAP Migration Guide Gap #2: Standard Adapter Migration Matrix ────────────
// Source: btp-process-orchestration-migration-guide/docs/30-connectivity/standard-adapter-migration-2622c30.md
const ADAPTER_MIGRATION_MATRIX = {
  // Sender adapters
  AS2_SENDER: { pipoAdapter: 'AS2', direction: 'sender', isAdapter: 'AS2, AS4', migrationStatus: 'direct', effortMultiplier: 1.0 },
  EDI_SENDER: { pipoAdapter: 'EDISeparator', direction: 'sender', isAdapter: null, migrationStatus: 'alternative', alternativeAdapter: 'AS2/AS4/SFTP + EDI Splitter step', effortMultiplier: 1.3 },
  FILE_SENDER: { pipoAdapter: 'File', direction: 'sender', isAdapter: null, migrationStatus: 'alternative', alternativeAdapter: 'FTP or SFTP adapter', limitations: 'Content Conversion via CSV to XML step or script', effortMultiplier: 1.2 },
  HTTP_SENDER: { pipoAdapter: 'HTTP_AAE', direction: 'sender', isAdapter: 'HTTPS', migrationStatus: 'direct', effortMultiplier: 1.0 },
  IDOC_SENDER: { pipoAdapter: 'IDoc_AAE', direction: 'sender', isAdapter: 'IDoc', migrationStatus: 'partial', limitations: 'HTTP protocol only - RFC packing not supported', effortMultiplier: 1.2 },
  JDBC_SENDER: { pipoAdapter: 'JDBC', direction: 'sender', isAdapter: null, migrationStatus: 'alternative', alternativeAdapter: 'Timer + JDBC receiver', limitations: 'Transaction handling limited', effortMultiplier: 1.5 },
  JMS_SENDER: { pipoAdapter: 'JMS', direction: 'sender', isAdapter: null, migrationStatus: 'alternative', alternativeAdapter: 'AMQP or IBM MQ adapter', limitations: 'JMS only for internal use - external requires AMQP', effortMultiplier: 1.4 },
  MAIL_SENDER: { pipoAdapter: 'Mail', direction: 'sender', isAdapter: 'Mail', migrationStatus: 'direct', effortMultiplier: 1.0 },
  ODATA_SENDER: { pipoAdapter: 'OData', direction: 'sender', isAdapter: 'OData', migrationStatus: 'direct', effortMultiplier: 1.0 },
  REST_SENDER: { pipoAdapter: 'REST', direction: 'sender', isAdapter: null, migrationStatus: 'alternative', alternativeAdapter: 'HTTP adapter', limitations: 'Use iFlow steps for HTTP verbs and URI handling', effortMultiplier: 1.1 },
  RFC_SENDER: { pipoAdapter: 'RFC', direction: 'sender', isAdapter: null, migrationStatus: 'partial', alternativeAdapter: 'Edge Integration Cell', limitations: 'Alternative: SOAP proxy in ABAP', effortMultiplier: 2.0 },
  SFTP_SENDER: { pipoAdapter: 'SFTP', direction: 'sender', isAdapter: 'SFTP', migrationStatus: 'direct', limitations: 'Limited advanced file selection', effortMultiplier: 1.0 },
  SOAP_SENDER: { pipoAdapter: 'SOAP', direction: 'sender', isAdapter: 'SOAP', migrationStatus: 'direct', effortMultiplier: 1.0 },
  SOAPXI_SENDER: { pipoAdapter: 'SOAP-XI', direction: 'sender', isAdapter: 'XI', migrationStatus: 'direct', limitations: 'Proxy generation differs in S/4HANA', effortMultiplier: 1.2 },
  SFSF_SENDER: { pipoAdapter: 'SFSF', direction: 'sender', isAdapter: 'SuccessFactors', migrationStatus: 'direct', effortMultiplier: 1.0 },
  X400_SENDER: { pipoAdapter: 'X400', direction: 'sender', isAdapter: null, migrationStatus: 'planned', effortMultiplier: 3.0 },
  BC_SENDER: { pipoAdapter: 'BC', direction: 'sender', isAdapter: null, migrationStatus: 'planned', effortMultiplier: 3.0 },
  CIDX_SENDER: { pipoAdapter: 'CIDX', direction: 'sender', isAdapter: null, migrationStatus: 'planned', effortMultiplier: 3.0 },
  RNIF_SENDER: { pipoAdapter: 'RNIF', direction: 'sender', isAdapter: null, migrationStatus: 'planned', effortMultiplier: 3.0 },
  OFTP_SENDER: { pipoAdapter: 'OFTP', direction: 'sender', isAdapter: null, migrationStatus: 'none', alternativeAdapter: 'External OFTP-to-HTTP bridge', effortMultiplier: 3.0 },
  // Receiver adapters
  AS2_RECEIVER: { pipoAdapter: 'AS2', direction: 'receiver', isAdapter: 'AS2, AS4', migrationStatus: 'direct', effortMultiplier: 1.0 },
  FILE_RECEIVER: { pipoAdapter: 'File', direction: 'receiver', isAdapter: null, migrationStatus: 'alternative', alternativeAdapter: 'FTP or SFTP adapter', effortMultiplier: 1.2 },
  HTTP_RECEIVER: { pipoAdapter: 'HTTP_AAE', direction: 'receiver', isAdapter: 'HTTP', migrationStatus: 'direct', effortMultiplier: 1.0 },
  IDOC_RECEIVER: { pipoAdapter: 'IDoc_AAE', direction: 'receiver', isAdapter: 'IDoc', migrationStatus: 'partial', limitations: 'HTTP protocol only', effortMultiplier: 1.2 },
  JDBC_RECEIVER: { pipoAdapter: 'JDBC', direction: 'receiver', isAdapter: 'JDBC', migrationStatus: 'partial', limitations: 'Limited database vendor support', effortMultiplier: 1.3 },
  JMS_RECEIVER: { pipoAdapter: 'JMS', direction: 'receiver', isAdapter: null, migrationStatus: 'alternative', alternativeAdapter: 'AMQP or IBM MQ adapter', effortMultiplier: 1.4 },
  MAIL_RECEIVER: { pipoAdapter: 'Mail', direction: 'receiver', isAdapter: 'Mail', migrationStatus: 'direct', effortMultiplier: 1.0 },
  ODATA_RECEIVER: { pipoAdapter: 'OData', direction: 'receiver', isAdapter: 'OData', migrationStatus: 'direct', effortMultiplier: 1.0 },
  REST_RECEIVER: { pipoAdapter: 'REST', direction: 'receiver', isAdapter: null, migrationStatus: 'alternative', alternativeAdapter: 'HTTP adapter', effortMultiplier: 1.1 },
  RFC_RECEIVER: { pipoAdapter: 'RFC', direction: 'receiver', isAdapter: 'RFC', migrationStatus: 'direct', effortMultiplier: 1.0 },
  SFTP_RECEIVER: { pipoAdapter: 'SFTP', direction: 'receiver', isAdapter: 'SFTP', migrationStatus: 'direct', effortMultiplier: 1.0 },
  SOAP_RECEIVER: { pipoAdapter: 'SOAP', direction: 'receiver', isAdapter: 'SOAP', migrationStatus: 'direct', effortMultiplier: 1.0 },
  SOAPXI_RECEIVER: { pipoAdapter: 'SOAP-XI', direction: 'receiver', isAdapter: 'XI', migrationStatus: 'direct', limitations: 'Proxy generation differs', effortMultiplier: 1.2 },
  SFSF_RECEIVER: { pipoAdapter: 'SFSF', direction: 'receiver', isAdapter: 'SuccessFactors', migrationStatus: 'direct', effortMultiplier: 1.0 },
};

// ── SAP Migration Guide Gap #3: Adapter Module Replacement Mapping ───────────
// Source: btp-process-orchestration-migration-guide/docs/30-connectivity/adapter-modules-e402f4a.md
const ADAPTER_MODULE_MAPPING = {
  MESSAGE_TRANSFORM: {
    moduleClass: 'AF_Modules/MessageTransformBean',
    moduleName: 'Message Transform Bean',
    description: 'Runtime format conversion - Plain to XML and XML to Plain',
    isEquivalent: 'XSLT step or Groovy script',
    migrationApproach: 'script',
    effortHours: 4,
    transformationPackage: 'Message Transformation Utilities',
  },
  PAYLOAD_SWAP: {
    moduleClass: 'AF_Modules/PayloadSwapBean',
    moduleName: 'Payload Swap Bean',
    description: 'Replace application payload with attachment',
    isEquivalent: 'Mail adapter mapping or Groovy script',
    migrationApproach: 'script',
    effortHours: 2,
  },
  STRICT_XML2PLAIN: {
    moduleClass: 'AF_Modules/StrictXml2PlainBean',
    moduleName: 'Strict XML to Plain',
    description: 'Convert XML to text format',
    isEquivalent: 'XML to CSV/EDI/JSON converter steps',
    migrationApproach: 'auto',
    effortHours: 1,
  },
  XML_ANONYMIZER: {
    moduleClass: 'AF_Modules/XMLAnonymizerBean',
    moduleName: 'XML Anonymizer',
    description: 'Remove namespaces or prefixes from XML',
    isEquivalent: 'XSLT step',
    migrationApproach: 'script',
    effortHours: 2,
    transformationPackage: 'Message Transformation Utilities',
  },
  IDOC_XML_TO_FLAT: {
    moduleClass: 'SAP_XI_IDOC/IDOCXmlToFlatConvertor',
    moduleName: 'IDoc XML to Flat',
    description: 'Convert IDoc XML to IDoc Flat format',
    isEquivalent: 'XML to CSV converter',
    migrationApproach: 'auto',
    effortHours: 1,
  },
  IDOC_FLAT_TO_XML: {
    moduleClass: 'SAP_XI_IDOC/IDOCFlatToXmlConvertor',
    moduleName: 'IDoc Flat to XML',
    description: 'Convert IDoc Flat format to XML',
    isEquivalent: 'Custom Groovy/JavaScript script',
    migrationApproach: 'script',
    effortHours: 8,
  },
  PAYLOAD_ZIP: {
    moduleClass: 'AF_Modules/PayloadZipBean',
    moduleName: 'Payload Zip',
    description: 'Compress or extract payloads',
    isEquivalent: 'Encoder/Decoder steps (ZIP, GZIP, Base64, MIME)',
    migrationApproach: 'auto',
    effortHours: 0.5,
  },
  DYNAMIC_CONFIG: {
    moduleClass: 'AF_Modules/DynamicConfigurationBean',
    moduleName: 'Dynamic Configuration',
    description: 'Edit adapter-specific message attributes (ASMA)',
    isEquivalent: 'External parameters or runtime parameters',
    migrationApproach: 'manual',
    effortHours: 4,
  },
  ARCHIVER: {
    moduleClass: 'localejbs/ArchiverModuleBean',
    moduleName: 'Archiver Module',
    description: 'Archive messages from channels',
    isEquivalent: 'Data archiving feature or Splunk external logging',
    migrationApproach: 'manual',
    effortHours: 8,
  },
};

// ── Helper: Lookup adapter migration info ────────────────────────────────────
function lookupAdapterMigration(adapterType, direction = 'sender') {
  const normalized = (adapterType || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const key = `${normalized}_${direction.toUpperCase()}`;
  return ADAPTER_MIGRATION_MATRIX[key] || null;
}

// ── Helper: Identify adapter modules in channel ──────────────────────────────
function identifyAdapterModules(moduleChain = []) {
  const detected = [];
  for (const module of moduleChain) {
    const moduleClass = (typeof module === 'string' ? module : module.moduleName || '').toLowerCase();
    for (const [key, mapping] of Object.entries(ADAPTER_MODULE_MAPPING)) {
      const targetClass = mapping.moduleClass.toLowerCase();
      if (moduleClass.includes(targetClass) || targetClass.includes(moduleClass.split('/').pop())) {
        detected.push({ code: key, ...mapping });
      }
    }
  }
  return detected;
}

// ── LangGraph Migration Advisor pipeline ─────────────────────────────────────
let _migrationGraph = null;

async function buildMigrationGraph() {
  if (_migrationGraph) return _migrationGraph;
  try {
    const { StateGraph, END } = await import('@langchain/langgraph');
    const { ChatAnthropic } = await import('@langchain/anthropic');

    const model = new ChatAnthropic({ model: 'claude-sonnet-4-6', maxTokens: 1024 });

    // Node 1: Classify the SAP object type
    async function classifyObjectNode(state) {
      const { input } = state;
      const prompt = `You are an expert SAP Enterprise Architect with 20+ years experience.
Classify this SAP object into ONE category:
MASTER_DATA_MATMAS | MASTER_DATA_DEBMAS | MASTER_DATA_CREMAS |
MASTER_DATA_HR | MASTER_DATA_FI | MASTER_DATA_CO |
TRANSACTIONAL_PROCUREMENT | TRANSACTIONAL_LOGISTICS |
TRANSACTIONAL_FINANCE | TRANSACTIONAL_WAREHOUSE |
INTEGRATION_FLOW_SIMPLE | INTEGRATION_FLOW_MEDIUM | INTEGRATION_FLOW_COMPLEX |
ANALYTICS_BW_CUBE | ANALYTICS_BW_ODS | ANALYTICS_BW_MASTERDATA | ANALYTICS_BW_HIERARCHY |
UNKNOWN

Object ID: ${input.objectId}
Description: ${input.objectDesc}
Source system: ${input.sourceSystem}
Adapter type: ${input.adapterType}
Is BPM process: ${input.isBpmProcess}

Reply with just the category name.`;
      const res = await model.invoke([{ role: 'user', content: prompt }]);
      return { objectType: res.content.trim() };
    }

    // Node 2: Score complexity (rule-based + AI refinement)
    // DRY-2 fix: Delegate to centralized complexityScorer module
    async function scoreComplexityNode(state) {
      const { input, objectType } = state;
      // Use centralized multi-dimensional scoring
      const result = scoreMultiDimensional({ ...input, objectType });
      return { tier: result.tier.toLowerCase(), complexityScore: result.score };
    }

    // Node 3: Recommend the best migration tool
    async function recommendToolNode(state) {
      const { input, tier, objectType } = state;
      const { objectId } = input;
      const idUpper = (objectId || '').toUpperCase();

      let recommendedTool, specificTool;

      if (tier === 'simple') {
        recommendedTool = 'BAPI';
        specificTool = BAPI_MAP[idUpper] || `BAPI_${idUpper}_SAVE`;
      } else if (tier === 'medium') {
        const hubPkg = HUB_PACKAGE_MAP[idUpper];
        recommendedTool = hubPkg ? 'iFlow_SemiAuto' : 'iFlow_Custom';
        specificTool = hubPkg || `Custom iFlow: ${idUpper}_MIGRATION`;
      } else {
        // Complex — check if AI pattern applies
        if (objectType && (objectType.includes('_FI') || objectType.includes('_HR'))) {
          recommendedTool = 'LangChain_Pattern_C';
          specificTool = `AI-Augmented iFlow: SDAINTAI validates & routes ${idUpper} with confidence scoring`;
        } else {
          recommendedTool = 'iFlow_Custom';
          specificTool = HUB_PACKAGE_MAP[idUpper] || `Custom iFlow: ${idUpper}_MIGRATION (full rebuild)`;
        }
      }
      return { recommendedTool, specificTool };
    }

    // Node 4: Estimate effort and wave assignment
    async function estimateEffortNode(state) {
      const { input, tier, complexityScore } = state;
      const known = MIGRATION_KNOWLEDGE.find(k => k.id === (input.objectId || '').toUpperCase());
      let estimatedHours = known
        ? known.hours
        : tier === 'simple' ? 4 + (input.segmentCount * 0.3)
          : tier === 'medium' ? 16 + (input.segmentCount * 0.5) + (input.hasZFields ? 8 : 0)
            : 60 + (input.segmentCount * 0.8) + (input.isEdiBased ? 20 : 0) + (input.isBpmProcess ? 40 : 0);

      estimatedHours = Math.round(estimatedHours);
      const riskLevel = tier === 'simple' ? 'low' : tier === 'medium' ? 'medium' : 'high';
      const waveAssignment = tier === 'simple' ? 1 : tier === 'medium' ? 2 : 3;
      return { estimatedHours, riskLevel, waveAssignment };
    }

    // Node 5: Generate the migration plan with rationale
    async function buildPlanNode(state) {
      const { input, objectType, tier, recommendedTool, specificTool, estimatedHours, riskLevel, waveAssignment } = state;
      const prompt = `You are an SAP Enterprise Architect building a migration plan.

Object: ${input.objectId} — ${input.objectDesc}
Type: ${objectType} | Tier: ${tier} | Tool: ${recommendedTool} (${specificTool})
Segments: ${input.segmentCount} | Z-Fields: ${input.hasZFields} | Volume/day: ${input.volumePerDay}
Adapter: ${input.adapterType} | Mapping: ${input.mappingType} | BPM: ${input.isBpmProcess} | EDI: ${input.isEdiBased}
Estimated: ${estimatedHours} hours | Risk: ${riskLevel} | Wave: ${waveAssignment}

Generate a JSON object with these exact keys:
{
  "rationale": "2-3 sentence explanation of why this tier and tool were chosen",
  "steps": ["step1", "step2", "step3", "step4", "step5"],
  "prereqs": ["prereq1", "prereq2"]
}
Reply with valid JSON only.`;

      const res = await model.invoke([{ role: 'user', content: prompt }]);
      try {
        const plan = JSON.parse(res.content.trim());
        return {
          rationale: plan.rationale || '',
          steps: JSON.stringify(plan.steps || []),
          prereqs: JSON.stringify(plan.prereqs || []),
        };
      } catch {
        return {
          rationale: `${tier} complexity object — recommended ${recommendedTool} approach based on ${input.segmentCount} segments and adapter type ${input.adapterType}.`,
          steps: JSON.stringify(['Assess source system', 'Configure adapter', 'Build/configure mapping', 'Test with sample data', 'Deploy and monitor']),
          prereqs: JSON.stringify(['IS tenant configured', 'RFC destination to S/4', 'Source system credentials']),
        };
      }
    }

    const graph = new StateGraph({
      channels: {
        input: { value: (x, y) => y ?? x, default: () => ({}) },
        objectType: { value: (x, y) => y ?? x, default: () => '' },
        tier: { value: (x, y) => y ?? x, default: () => 'medium' },
        complexityScore: { value: (x, y) => y ?? x, default: () => 0 },
        recommendedTool: { value: (x, y) => y ?? x, default: () => '' },
        specificTool: { value: (x, y) => y ?? x, default: () => '' },
        estimatedHours: { value: (x, y) => y ?? x, default: () => 0 },
        riskLevel: { value: (x, y) => y ?? x, default: () => 'medium' },
        waveAssignment: { value: (x, y) => y ?? x, default: () => 2 },
        rationale: { value: (x, y) => y ?? x, default: () => '' },
        steps: { value: (x, y) => y ?? x, default: () => '[]' },
        prereqs: { value: (x, y) => y ?? x, default: () => '[]' },
      },
    });

    graph.addNode('classifyObject', classifyObjectNode);
    graph.addNode('scoreComplexity', scoreComplexityNode);
    graph.addNode('recommendTool', recommendToolNode);
    graph.addNode('estimateEffort', estimateEffortNode);
    graph.addNode('buildPlan', buildPlanNode);

    graph.addEdge('classifyObject', 'scoreComplexity');
    graph.addEdge('scoreComplexity', 'recommendTool');
    graph.addEdge('recommendTool', 'estimateEffort');
    graph.addEdge('estimateEffort', 'buildPlan');
    graph.addEdge('buildPlan', END);
    graph.setEntryPoint('classifyObject');

    _migrationGraph = graph.compile();
    return _migrationGraph;
  } catch (err) {
    LOG.warn('Migration graph unavailable, using rule-based fallback', { error: err.message });
    return null;
  }
}

// Rule-based migration fallback (no LLM needed)
function ruleMigrationAdvisor(input) {
  const idUpper = (input.objectId || '').toUpperCase();
  const known = MIGRATION_KNOWLEDGE.find(k => k.id === idUpper);
  const tier = known ? known.tier : input.isBpmProcess ? 'complex'
    : input.adapterType === 'as2' || input.adapterType === 'custom' ? 'complex'
      : (input.segmentCount > 15 || input.hasZFields) ? 'medium' : 'simple';

  const recommendedTool = tier === 'simple' ? 'BAPI' : tier === 'medium' ? 'iFlow_SemiAuto' : 'iFlow_Custom';
  const specificTool = tier === 'simple' ? (BAPI_MAP[idUpper] || 'BAPI_SAVE')
    : (HUB_PACKAGE_MAP[idUpper] || `Custom iFlow: ${idUpper}_MIGRATION`);

  // Gap #1: Classify scenario pattern
  const pattern = classifyScenarioPattern(input);

  // Gap #2: Map to SAP Migration Assessment status
  const sapMigrationStatus = tierToSapStatus(tier);

  // Gap #3: Identify known limitations
  const limitations = identifyLimitations(input);

  // SAP Migration Guide Gap #2: Lookup adapter migration info
  const adapterMigration = lookupAdapterMigration(input.adapterType, input.direction || 'sender');
  let adapterMigrationStatus = 'unknown';
  let adapterAlternative = null;
  let adapterLimitations = null;
  if (adapterMigration) {
    adapterMigrationStatus = adapterMigration.migrationStatus;
    adapterAlternative = adapterMigration.alternativeAdapter || adapterMigration.isAdapter;
    adapterLimitations = adapterMigration.limitations;
    // Apply adapter-specific effort multiplier if not direct
    if (adapterMigration.migrationStatus !== 'direct') {
      limitations.push({
        code: `ADAPTER_${input.adapterType?.toUpperCase()}`,
        name: `${input.adapterType} Adapter Migration`,
        severity: adapterMigration.migrationStatus === 'none' ? 'blocker' : 'major',
        category: 'adapter',
        workaroundType: adapterMigration.alternativeAdapter ? 'alternative' : 'manual',
        workaroundDesc: adapterMigration.alternativeAdapter || adapterMigration.limitations || '',
        effortMultiplier: adapterMigration.effortMultiplier || 1.0,
      });
    }
  }

  // Calculate effort multiplier from all limitations
  const effortMultiplier = limitations.reduce((mult, lim) => mult * (lim.effortMultiplier || 1), 1);

  // Base hours calculation with limitation multiplier
  let baseHours = known ? known.hours
    : tier === 'simple' ? 6 : tier === 'medium' ? 20 : 60;
  const estimatedHours = Math.round(baseHours * effortMultiplier);

  // Find matching SAP template
  const matchedTemplate = HUB_PACKAGE_MAP[idUpper] || pattern.isTarget;

  return {
    objectType: known ? `MASTER_DATA_${idUpper}` : 'UNKNOWN',
    tier, complexityScore: tier === 'simple' ? 20 : tier === 'medium' ? 55 : 85,
    recommendedTool, specificTool, estimatedHours,
    riskLevel: tier === 'simple' ? 'low' : tier === 'medium' ? 'medium' : 'high',
    waveAssignment: tier === 'simple' ? 1 : tier === 'medium' ? 2 : 3,
    rationale: `Rule-based assessment: ${tier} complexity for ${idUpper} based on ${input.segmentCount} segments, adapter=${input.adapterType}, z-fields=${input.hasZFields}.`,
    steps: JSON.stringify(['Assess source', 'Configure adapter', 'Build mapping', 'Test', 'Deploy']),
    prereqs: JSON.stringify(['IS tenant', 'RFC destination', 'Source credentials']),
    // SAP Migration Course aligned fields (Gaps #1, #2, #3)
    scenarioPattern: pattern.code,
    scenarioPatternName: pattern.name,
    sapMigrationStatus,
    matchedTemplate,
    limitations: JSON.stringify(limitations),
    limitationCount: limitations.length,
    hasBlockers: limitations.some(l => l.severity === 'blocker'),
    // SAP Migration Guide Gap #2: Adapter migration info
    adapterMigrationStatus,
    adapterAlternative,
  };
}

// ── LangGraph analysis pipeline ───────────────────────────────────────────────
let _graph = null;

async function buildGraph() {
  if (_graph) return _graph;
  try {
    const { StateGraph, END } = await import('@langchain/langgraph');
    const { ChatAnthropic } = await import('@langchain/anthropic');

    const model = new ChatAnthropic({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 512,
    });

    // Node: classify an event into a category
    async function classifyNode(state) {
      const { event } = state;
      const prompt = `Classify this application event into ONE category from:
frontend_interaction | backend_call | conversation | app_usage | performance | security | error

Event type: ${event.eventType}
Source: ${event.source}
Summary: ${event.summary}
Payload (truncated): ${(event.payload || '').slice(0, 300)}

Reply with just the category name, nothing else.`;

      const res = await model.invoke([{ role: 'user', content: prompt }]);
      return { category: res.content.trim().toLowerCase() };
    }

    // Node: generate an insight from an event
    async function insightNode(state) {
      const { event, category } = state;
      const prompt = `You are an AI system observing a SAP CAP application called SDAINTAI (AI Connectivity platform).
An event was captured:
  Category  : ${category}
  Type      : ${event.eventType}
  Source    : ${event.source}
  Summary   : ${event.summary}

Generate a concise JSON insight with these exact keys:
{
  "insightType": "optimization | bug | scenario | pattern | warning",
  "title": "short title (max 80 chars)",
  "description": "1-2 sentence description",
  "priority": "high | medium | low"
}
Reply with valid JSON only.`;

      const res = await model.invoke([{ role: 'user', content: prompt }]);
      try {
        const json = JSON.parse(res.content.trim());
        return { insight: json };
      } catch {
        return { insight: null };
      }
    }

    const graph = new StateGraph({
      channels: {
        event: { value: (x, y) => y ?? x, default: () => null },
        category: { value: (x, y) => y ?? x, default: () => '' },
        insight: { value: (x, y) => y ?? x, default: () => null },
      },
    });

    graph.addNode('classify', classifyNode);
    graph.addNode('insight', insightNode);
    graph.addEdge('classify', 'insight');
    graph.addEdge('insight', END);
    graph.setEntryPoint('classify');

    _graph = graph.compile();
    return _graph;
  } catch (err) {
    // If Anthropic key missing or langgraph unavailable, fall back to rule-based
    LOG.warn('LangGraph unavailable, using rule-based fallback', { error: err.message });
    return null;
  }
}

// Rule-based fallback when LLM is not available
function classifyRuleBased(eventType) {
  const map = {
    click: 'frontend_interaction', navigation: 'frontend_interaction', input: 'frontend_interaction',
    api_call: 'backend_call', db_query: 'backend_call', odata: 'backend_call',
    chat: 'conversation', message: 'conversation',
    login: 'app_usage', logout: 'app_usage', feature: 'app_usage',
    latency: 'performance', memory: 'performance', cpu: 'performance',
    error: 'error', exception: 'error',
  };
  const lower = (eventType || '').toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (lower.includes(k)) return v;
  }
  return 'app_usage';
}

// ── Service implementation ────────────────────────────────────────────────────
module.exports = class BrainService extends cds.ApplicationService {
  async init() {
    const { Events, Insights, Sessions } = this.entities;

    // ── toggleBrain ──────────────────────────────────────────────────────────
    this.on('toggleBrain', async (req) => {
      const { key, enabled } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      const state = writeState(enabled);
      return {
        success: true,
        message: enabled ? 'Brain activated' : 'Brain deactivated',
        state: state.enabled,
      };
    });

    // ── captureEvent ─────────────────────────────────────────────────────────
    this.on('captureEvent', async (req) => {
      const { key, eventType, source, payload, summary, sessionId } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      if (!isBrainEnabled()) return req.error(400, 'Brain is not enabled');

      const vs = getVectorStore();
      const embeddingId = await vs.add(`${eventType} ${source} ${summary}`, { eventType, source, payload, sessionId, ts: new Date().toISOString() });

      // The vector store (local file, always available) is the source of truth
      // for this action's success — the DB row is a nice-to-have for the OData
      // Events/Insights entities, not a hard dependency. Without this, a HANA
      // connection-pool hiccup (seen in this environment: generic-pool
      // TimeoutError on the shared HDI container) turned every capture into a
      // 500, silently losing the vector write too since the whole handler threw
      // before returning. Degrading gracefully means capture still "works" and
      // is searchable even when the DB row never lands.
      let eventRecord = null;
      try {
        eventRecord = await INSERT.into(Events).entries({
          eventType,
          source: source || 'unknown',
          payload: payload || '{}',
          summary: summary || '',
          embeddingId,
          sessionId: sessionId || '',
          processed: false,
        });
      } catch (err) {
        LOG.error('Events insert failed, continuing on vector store alone', { error: err.message });
      }

      // Run LangGraph analysis inline (best-effort)
      let category = classifyRuleBased(eventType);
      let insights = 0;

      try {
        const graph = await buildGraph();
        const eventObj = { eventType, source, payload, summary };

        if (graph) {
          const result = await graph.invoke({ event: eventObj });
          category = result.category || category;

          if (result.insight) {
            const eventId = eventRecord?.req?.data?.ID || eventRecord?.[0]?.ID || embeddingId;
            try {
              await INSERT.into(Insights).entries({
                insightType: result.insight.insightType || 'pattern',
                title: result.insight.title || 'Untitled insight',
                description: result.insight.description || '',
                priority: result.insight.priority || 'medium',
                status: 'new',
                sourceEventIds: JSON.stringify([eventId]),
                exportable: true,
              });
              insights = 1;
            } catch (err) {
              LOG.error('Insights insert failed', { error: err.message });
            }
          }
        }

        // Update category on the event (best-effort)
        if (eventRecord?.[0]?.ID) {
          await UPDATE(Events).set({ category }).where({ ID: eventRecord[0].ID });
        }
      } catch (err) {
        LOG.error('Analysis error', { error: err.message });
      }

      return {
        eventId: eventRecord?.[0]?.ID || embeddingId,
        category,
        insights,
        message: eventRecord ? 'Event captured' : 'Event captured (vector store only — DB unavailable)',
      };
    });

    // ── runAnalysis ──────────────────────────────────────────────────────────
    this.on('runAnalysis', async (req) => {
      const { key } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      if (!isBrainEnabled()) return req.error(400, 'Brain is not enabled');

      const { Events, Insights } = this.entities;
      const unprocessed = await SELECT.from(Events).where({ processed: false });
      if (!unprocessed.length) return { processed: 0, insights: 0, message: 'No unprocessed events' };

      let insightsGenerated = 0;

      try {
        const graph = await buildGraph();

        for (const event of unprocessed) {
          let category = classifyRuleBased(event.eventType);
          let insight = null;

          if (graph) {
            const result = await graph.invoke({ event });
            category = result.category || category;
            insight = result.insight;
          }

          await UPDATE(Events).set({ processed: true, category }).where({ ID: event.ID });

          if (insight) {
            await INSERT.into(Insights).entries({
              insightType: insight.insightType || 'pattern',
              title: insight.title || 'Untitled insight',
              description: insight.description || '',
              priority: insight.priority || 'medium',
              status: 'new',
              sourceEventIds: JSON.stringify([event.ID]),
              exportable: true,
            });
            insightsGenerated++;
          }
        }
      } catch (err) {
        LOG.error('runAnalysis error', { error: err.message });
      }

      return {
        processed: unprocessed.length,
        insights: insightsGenerated,
        message: `Processed ${unprocessed.length} events, generated ${insightsGenerated} insights`,
      };
    });

    // ── getBrainStatus ───────────────────────────────────────────────────────
    this.on('getBrainStatus', async (req) => {
      const { key } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      const state = readState();
      const vs = getVectorStore();
      // Same DB-optional posture as captureEvent — a HANA hiccup shouldn't make
      // the status dashboard itself unreachable; fall back to 0 and let
      // vectorCount (always available) carry the real signal.
      let eventsCount = 0, insightsCount = 0;
      try { eventsCount = (await SELECT.from(Events).columns('count(*) as n'))[0]?.n || 0; } catch (err) { LOG.error('Events count failed', { error: err.message }); }
      try { insightsCount = (await SELECT.from(Insights).columns('count(*) as n'))[0]?.n || 0; } catch (err) { LOG.error('Insights count failed', { error: err.message }); }
      const vectorCount = await vs.count();

      return {
        enabled: state.enabled,
        eventsCount: Number(eventsCount),
        insightsCount: Number(insightsCount),
        coherence: Math.min(100, Math.floor((vectorCount / (Number(eventsCount) || 1)) * 100)),
        enabledSince: state.enabledAt || '',
        vectorCount,
        message: state.enabled ? 'Brain is active' : 'Brain is inactive',
      };
    });

    // ── exportBrain ──────────────────────────────────────────────────────────
    this.on('exportBrain', async (req) => {
      const { key } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      const vs = getVectorStore();
      const events = await SELECT.from(Events);
      const insights = await SELECT.from(Insights);
      const sessions = await SELECT.from(Sessions);

      const archive = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        events,
        insights,
        sessions,
        vectors: await vs.getAll(),
      };

      const json = JSON.stringify(archive);
      const b64 = Buffer.from(json).toString('base64');
      const filename = `brain-export-${Date.now()}.sdab`;

      return { filename, data: b64, size: json.length };
    });

    // ── migrationAdvisor ─────────────────────────────────────────────────────
    this.on('migrationAdvisor', async (req) => {
      const {
        key, objectId, objectDesc, segmentCount, hasZFields,
        mappingType, adapterType, volumePerDay, isBpmProcess, isEdiBased, sourceSystem,
      } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      const input = {
        objectId: objectId || '',
        objectDesc: objectDesc || '',
        segmentCount: segmentCount || 0,
        hasZFields: hasZFields || false,
        mappingType: (mappingType || 'graphical').toLowerCase(),
        adapterType: (adapterType || 'idoc').toLowerCase(),
        volumePerDay: volumePerDay || 0,
        isBpmProcess: isBpmProcess || false,
        isEdiBased: isEdiBased || false,
        sourceSystem: sourceSystem || 'LEGACY_ERP',
      };

      let result = ruleMigrationAdvisor(input);

      try {
        const graph = await buildMigrationGraph();
        if (graph) {
          const graphResult = await graph.invoke({ input });
          result = {
            objectType: graphResult.objectType || result.objectType,
            tier: graphResult.tier || result.tier,
            complexityScore: graphResult.complexityScore ?? result.complexityScore,
            recommendedTool: graphResult.recommendedTool || result.recommendedTool,
            specificTool: graphResult.specificTool || result.specificTool,
            estimatedHours: graphResult.estimatedHours ?? result.estimatedHours,
            riskLevel: graphResult.riskLevel || result.riskLevel,
            waveAssignment: graphResult.waveAssignment ?? result.waveAssignment,
            rationale: graphResult.rationale || result.rationale,
            steps: graphResult.steps || result.steps,
            prereqs: graphResult.prereqs || result.prereqs,
          };
        }
      } catch (err) {
        LOG.error('migrationAdvisor error', { error: err.message });
      }

      // Store in vector store for future RAG learning
      const vs = getVectorStore();
      await vs.add(
        `migration ${input.objectId} ${result.tier} ${result.recommendedTool} ${input.adapterType} ${input.sourceSystem}`,
        { objectId: input.objectId, tier: result.tier, tool: result.recommendedTool, hours: result.estimatedHours }
      );

      // Capture as brain event for insight generation
      if (isBrainEnabled()) {
        try {
          await INSERT.into(Events).entries({
            eventType: 'migration_advisory',
            source: `migrationAdvisor:${input.objectId}`,
            payload: JSON.stringify(input),
            summary: `Migration advice requested for ${input.objectId}: ${result.tier} complexity, recommend ${result.recommendedTool}, est. ${result.estimatedHours}h`,
            embeddingId: `ma_${Date.now()}`,
            sessionId: '',
            processed: false,
          });
        } catch { /* non-blocking */ }
      }

      return {
        objectId: input.objectId,
        objectType: result.objectType,
        tier: result.tier,
        complexityScore: result.complexityScore,
        recommendedTool: result.recommendedTool,
        specificTool: result.specificTool,
        estimatedHours: result.estimatedHours,
        riskLevel: result.riskLevel,
        waveAssignment: result.waveAssignment,
        rationale: result.rationale,
        steps: result.steps,
        prereqs: result.prereqs,
        // SAP Migration Course aligned fields (Gaps #1, #2, #3)
        scenarioPattern: result.scenarioPattern,
        scenarioPatternName: result.scenarioPatternName,
        sapMigrationStatus: result.sapMigrationStatus,
        matchedTemplate: result.matchedTemplate,
        limitations: result.limitations,
        limitationCount: result.limitationCount,
        hasBlockers: result.hasBlockers,
        // SAP Migration Guide Gap #2: Adapter Migration Info
        adapterMigrationStatus: result.adapterMigrationStatus,
        adapterAlternative: result.adapterAlternative,
        message: `Migration analysis complete for ${input.objectId}`,
      };
    });

    // ── seedMigrationKnowledge ────────────────────────────────────────────────
    this.on('seedMigrationKnowledge', async (req) => {
      const { key } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      const vs = getVectorStore();
      let seeded = 0;

      for (const obj of MIGRATION_KNOWLEDGE) {
        await vs.add(
          `sap migration ${obj.id} ${obj.desc} ${obj.tier} ${obj.tool} adapter:${obj.adapterType} segments:${obj.segmentCount}`,
          { objectId: obj.id, tier: obj.tier, tool: obj.tool, hours: obj.hours, source: 'seed' }
        );
        seeded++;
      }

      // Also seed the SAP IS capability knowledge
      const isKnowledge = [
        'SAP Integration Suite Cloud Integration iFlow IDoc adapter MATMAS DEBMAS CREMAS master data migration simple',
        'SAP Integration Suite Migration Assessment Tool MAT ICO score complexity wave plan PI PO migration',
        'SAP Integration Suite iFlow medium complexity XSLT mapping SFTP adapter semi-automated migration wizard',
        'SAP Integration Suite complex iFlow AS2 EDI trading partner INVOIC ORDERS EDIFACT X12 Integration Advisor MIG MAG',
        'SAP Integration Suite LangChain AI Pattern C FIDCCP FI document validation confidence routing human review',
        'SAP Integration Suite Event Mesh AMQP pub sub guaranteed delivery high volume migration async queue',
        'SAP Integration Suite API Management gateway OAuth2 rate limiting developer portal SDAINTAI CAP OData',
        'BAPI direct S4 HANA simple migration BAPI_MATERIAL_SAVEDATA BAPI_CUSTOMER_CREATEFROMDATA1 BAPI_VENDOR_CREATEFROMDATA',
        'SAP BW migration BDC Datasphere AI Foundation InfoCube ODS ADSO master data hierarchy analytics',
        'SDA SAP Migration Factory partner 21 years innovation SDAINTAI AI accelerator assessment planning wave execution',
        'Forrester TEI SAP Integration Suite 345 percent ROI 554000 savings legacy PI PO retirement',
        'Harrods 60 percent content reuse PI PO migration Integration Suite Kemira 50 percent development time reduction',
        'Int4 Shield automated testing iFlow regression 12 months free Figaf DevOps CI CD pipeline IS migration',
        'ccBPM BPM stateful process orchestration PI PO always complex rebuild redesign SAP Build Process Automation',
        // ── SAP Reference Architecture: PI/PO → Integration Suite (architecture.learning.sap.com 9a5f7b59dc)
        'SAP PI PO standard maintenance ending 2027 migration mandatory Integration Suite cloud iPaaS NetWeaver replacement',
        'SAP Integration Suite iPaaS cloud-to-cloud cloud-to-on-premise on-premise Edge Integration Cell EIC deployment patterns',
        'SAP Integration Suite as-is PI PO cross-domain integration dedicated API Management event broker DMZ firewall',
        'SAP Integration Suite to-be target architecture Edge Integration Cell BTP Destination Connectivity Cloud Connector private network',
        'SAP Integration Suite build-once deploy-anywhere single iFlow runs Integration Suite and Edge Integration Cell EIC same artifact',
        'SAP Cloud Connector high availability HA BTP Destination Service secure cloud to on-premise connectivity private network hyperscaler',
        'SAP Integration Suite Migration Assessment Tool evaluate technical effort scenario migration approach ICO PI PO scoring',
        'SAP Integration Suite Migration Tooling wizard-based artifact migration automated iFlow generation from PI PO ICO',
        'SAP Integration Suite migration partner tools Figaf Int4 65 percent automation third party tooling PI PO',
        'SAP Integration Suite static IP address simplified third-party connectivity firewall rules trading partner whitelist',
        'SAP Integration Suite central monitoring administration BTP cockpit consolidated observability reduced operational complexity',
        'SAP Integration Suite Advanced Event Mesh event-driven architecture pub sub AMQP MQTT topic subscription',
        'SAP Integration Suite API Management rate limiting monetization developer portal OAuth2 lifecycle governance',
        'SAP Integration Suite reduced technology footprint skill consolidation retire PI PO dual-stack advanced adapter engine',
        // ── EDA / AEM / iFlow event-driven patterns & AI capabilities (2026-06-26)
        'EDA event-driven architecture pattern producer consumer asynchronous decoupled fact-based events no point-to-point',
        'AEM Advanced Event Mesh SAP Solace PubSub+ enterprise event broker topic routing guaranteed delivery replay multi-region',
        'SAP S4HANA 1500 native business events AEM MaterialMasterChanged PurchaseOrderCreated InvoicePosted direct publish',
        'AEM AMQP adapter iFlow trigger event queue subscription real-time no polling no RFC dependency wake on event',
        'EDA vs PI PO synchronous RFC IDoc point-to-point brittle vs async resilient scalable event-driven modernization',
        'AEM topic hierarchy sap s4 mm material changed MATMAS sda migration completed event stream live progress tracker',
        'AEM event replay backfill migration catch-up wave cutover missed events reprocess guaranteed delivery SDAINTAI',
        'SDAINTAI lift-and-shift iFlow ICO 1:1 migration vs EDA modernization high volume real-time fan-out candidate',
        'SAP Migration Assessment Tool Business Events recommendation EDA modernization flag wave planning SDAINTAI',
        'ccBPM stateful process AEM SAP Build Process Automation orchestration event-driven workflow modernization',
        'SAP Integration Suite GenAI AI-assisted mapping message mapping suggestions XSLT graphical reduce manual effort',
        'SAP Integration Suite agentic integration AI agents autonomous multi-step orchestration intelligent recommendations',
        'SAP Integration Suite AI monitoring anomaly detection predictive alerting root cause analysis operations',
        'SAP Integration Suite generative assistant natural language to iFlow configuration accelerate developer productivity',
        'AEM MQTT WebSocket real-time notification pattern low-latency IoT mobile event streaming IS integration',
      ];

      for (const text of isKnowledge) {
        await vs.add(text, { source: 'is_knowledge_seed', tier: 'reference' });
        seeded++;
      }

      return { seeded, message: `Seeded ${seeded} migration knowledge vectors into brain` };
    });

    // ── seedLimitationRef (Gap #3: Known Limitations Database) ───────────────
    this.on('seedLimitationRef', async (req) => {
      const { key } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      // Get tenant-aware database access
      const db = await cds.connect.to('db');
      const { MigrationLimitationRef, ScenarioPatternRef } = db.entities('tenant');

      let seeded = 0;

      // Seed KNOWN_LIMITATIONS into MigrationLimitationRef
      for (const [code, lim] of Object.entries(KNOWN_LIMITATIONS)) {
        try {
          await db.run(
            INSERT.into(MigrationLimitationRef).entries({
              code: lim.code,
              name: lim.name,
              category: lim.category,
              severity: lim.severity,
              description: lim.description,
              detectionRules: JSON.stringify(lim.detectionRules),
              workaroundType: lim.workaroundType,
              workaroundDesc: lim.workaroundDesc,
              effortMultiplier: lim.effortMultiplier,
            })
          );
          seeded++;
        } catch (err) {
          // Skip if already exists (unique constraint on code)
          if (!err.message?.includes('unique') && !err.message?.includes('duplicate')) {
            LOG.warn('Failed to seed limitation', { code, error: err.message });
          }
        }
      }

      // Seed SCENARIO_PATTERNS into ScenarioPatternRef
      for (const [code, pattern] of Object.entries(SCENARIO_PATTERNS)) {
        try {
          await db.run(
            INSERT.into(ScenarioPatternRef).entries({
              code: pattern.code,
              name: pattern.name,
              description: `Detection: ${JSON.stringify(pattern.detectionRules)}`,
              detectionRules: JSON.stringify(pattern.detectionRules),
              isTargetPattern: pattern.isTarget,
              migrationApproach: `Standard migration to ${pattern.isTarget}`,
              standardTemplates: JSON.stringify([]),
              baseComplexity: pattern.baseComplexity,
              typicalHours: pattern.typicalHours,
            })
          );
          seeded++;
        } catch (err) {
          if (!err.message?.includes('unique') && !err.message?.includes('duplicate')) {
            LOG.warn('Failed to seed pattern', { code, error: err.message });
          }
        }
      }

      return { seeded, message: `Seeded ${seeded} reference records (limitations + scenario patterns)` };
    });

    // ── seedAdapterMigrationRef (SAP Migration Guide Gaps #2, #3) ────────────
    this.on('seedAdapterMigrationRef', async (req) => {
      const { key } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      const db = await cds.connect.to('db');
      const { AdapterMigrationRef, AdapterModuleMigrationRef } = db.entities('tenant');

      let seeded = 0;

      // Seed ADAPTER_MIGRATION_MATRIX into AdapterMigrationRef
      for (const [key, mapping] of Object.entries(ADAPTER_MIGRATION_MATRIX)) {
        try {
          await db.run(
            INSERT.into(AdapterMigrationRef).entries({
              pipoAdapter: mapping.pipoAdapter,
              direction: mapping.direction,
              isAdapter: mapping.isAdapter || '',
              migrationStatus: mapping.migrationStatus,
              alternativeAdapter: mapping.alternativeAdapter || '',
              limitations: mapping.limitations ? JSON.stringify({ note: mapping.limitations }) : '',
              migrationNotes: mapping.limitations || '',
              effortMultiplier: mapping.effortMultiplier || 1.0,
            })
          );
          seeded++;
        } catch (err) {
          if (!err.message?.includes('unique') && !err.message?.includes('duplicate')) {
            LOG.warn('Failed to seed adapter mapping', { key, error: err.message });
          }
        }
      }

      // Seed ADAPTER_MODULE_MAPPING into AdapterModuleMigrationRef
      for (const [key, mapping] of Object.entries(ADAPTER_MODULE_MAPPING)) {
        try {
          await db.run(
            INSERT.into(AdapterModuleMigrationRef).entries({
              moduleClass: mapping.moduleClass,
              moduleName: mapping.moduleName,
              description: mapping.description,
              isEquivalent: mapping.isEquivalent,
              migrationApproach: mapping.migrationApproach,
              effortHours: mapping.effortHours,
              transformationPackage: mapping.transformationPackage || '',
            })
          );
          seeded++;
        } catch (err) {
          if (!err.message?.includes('unique') && !err.message?.includes('duplicate')) {
            LOG.warn('Failed to seed module mapping', { key, error: err.message });
          }
        }
      }

      return { seeded, message: `Seeded ${seeded} adapter/module migration reference records` };
    });

    // ── importBrain ──────────────────────────────────────────────────────────
    this.on('importBrain', async (req) => {
      const { key, data } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      let archive;
      try {
        archive = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
      } catch {
        return req.error(400, 'Invalid brain archive data');
      }

      let eventsImported = 0;
      if (Array.isArray(archive.events)) {
        for (const ev of archive.events) {
          try {
            await INSERT.into(Events).entries(ev);
            eventsImported++;
          } catch { /* skip duplicates */ }
        }
      }

      if (Array.isArray(archive.vectors)) {
        await getVectorStore().replaceAll(archive.vectors);
      }

      return {
        success: true,
        eventsImported,
        message: `Imported ${eventsImported} events from archive`,
      };
    });

    // ── testPipoDestinations ─────────────────────────────────────────────────
    this.on('testPipoDestinations', async (req) => {
      const { key } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      const pipoClient = require('./utils/pipoClient');
      let dirStatus = 'ERROR', esrStatus = 'ERROR';
      let dirArtifacts = 0, esrArtifacts = 0;
      let errors = [];

      // Test DIR destination
      try {
        const dirResult = await pipoClient.listIcos();
        dirStatus = 'OK';
        dirArtifacts = Array.isArray(dirResult) ? dirResult.length : (dirResult?.count || 0);
      } catch (err) {
        dirStatus = `ERROR: ${err.message}`;
        errors.push(`DIR: ${err.message}`);
      }

      // Test ESR destination
      try {
        const esrResult = await pipoClient.listPipoPackages();
        esrStatus = 'OK';
        esrArtifacts = Array.isArray(esrResult) ? esrResult.length : (esrResult?.count || 0);
      } catch (err) {
        esrStatus = `ERROR: ${err.message}`;
        errors.push(`ESR: ${err.message}`);
      }

      const message = errors.length > 0
        ? `Connectivity issues: ${errors.join('; ')}`
        : `Both destinations reachable. DIR: ${dirArtifacts} ICOs, ESR: ${esrArtifacts} components`;

      return { dirStatus, esrStatus, dirArtifacts, esrArtifacts, message };
    });

    return super.init();
  }
};
