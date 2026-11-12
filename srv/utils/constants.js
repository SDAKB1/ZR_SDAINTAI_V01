'use strict';

/**
 * Centralized Constants Module
 *
 * Consolidates magic strings, status values, and configuration constants
 * used across the PI/PO migration services.
 *
 * @module constants
 */

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS VALUES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Job and process status values
 */
const Status = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  ERROR: 'error',
  SUCCESS: 'success',
  UNKNOWN: 'unknown',
});

/**
 * Artifact migration status values
 */
const ArtifactStatus = Object.freeze({
  DISCOVERED: 'discovered',
  ASSESSED: 'assessed',
  APPROVED: 'approved',
  SKIPPED: 'skipped',
  IN_PROGRESS: 'in_progress',
  MIGRATED: 'migrated',
  FAILED: 'failed',
});

/**
 * SAP Migration Assessment Tool status terminology
 * Maps internal tiers to official SAP statuses
 */
const SapMigrationStatus = Object.freeze({
  SIMPLE: 'Ready to migrate',
  MEDIUM: 'Adjustment required',
  COMPLEX: 'Evaluation required',
});

// ═══════════════════════════════════════════════════════════════════════════════
// TIMEOUT CONFIGURATIONS (milliseconds)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Timeout configurations for various operations
 */
const Timeouts = Object.freeze({
  /** Default timeout for standard HTTP requests */
  DEFAULT: 60000,
  /** Short timeout for health checks and quick operations */
  SHORT: 30000,
  /** Long timeout for large data operations */
  LONG: 180000,
  /** SOAP service timeout */
  SOAP: 120000,
  /** Circuit breaker check timeout */
  CIRCUIT_CHECK: 5000,
  /** Destination health check timeout */
  HEALTH_CHECK: 10000,
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLEXITY TIERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Migration complexity tier values
 */
const ComplexityTier = Object.freeze({
  SIMPLE: 'Simple',
  MEDIUM: 'Medium',
  COMPLEX: 'Complex',
});

/**
 * Complexity tier thresholds (raw score boundaries)
 */
const ComplexityThresholds = Object.freeze({
  /** Score at or below this is Simple */
  SIMPLE_MAX: 8,
  /** Score at or below this is Medium (above SIMPLE_MAX) */
  MEDIUM_MAX: 18,
  /** Score above MEDIUM_MAX is Complex */
});

// ═══════════════════════════════════════════════════════════════════════════════
// DESTINATION NAMES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * BTP Destination names for PI/PO connectivity
 */
const Destinations = Object.freeze({
  /** Integration Directory destination */
  DIR: 'PO_PJ2_DIR',
  /** Enterprise Services Repository destination */
  ESR: 'PO_PJ2_ESR',
  /** System Landscape Directory (if separate) */
  SLD: 'PO_PJ2_SLD',
  /** Integration Suite API destination */
  IS_API: 'IS_API',
});

// ═══════════════════════════════════════════════════════════════════════════════
// API PATHS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ESR Repository API endpoints
 */
const EsrEndpoints = Object.freeze({
  SIMPLE_QUERY: '/rep/support/SimpleQuery',
  QUERY_EXT: '/rep/query/ext/1',
  READ_EXT: '/rep/read/ext/1',
  QUERY_INT: '/rep/query/int/1',
  EXPORT_CONTENT: '/rep/export/ext/1',
  CACHE_ADMIN: '/rep/cache/admin',
  RUNTIME_CONFIG: '/rep/support/admin',
});

/**
 * Monitoring API endpoints
 */
const MonitoringEndpoints = Object.freeze({
  CHANNEL_ADMIN: '/AdapterFramework/ChannelAdminServlet',
  MESSAGE_LOGS: '/mdt/api/1.0/MessageProcessingLogs',
  MESSAGE_OVERVIEW: '/mdt/overview.do',
});

/**
 * SLD CIM interface endpoints
 */
const SldEndpoints = Object.freeze({
  CIMOM: '/sld/cimom',
  DATA_SUPPLIER: '/sld/ds',
  BRIDGE: '/sld/bridge',
});

// ═══════════════════════════════════════════════════════════════════════════════
// DIRECTORY SOAP SERVICES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PI/PO Directory SOAP service paths
 */
const DirectorySoapServices = Object.freeze({
  IntegratedConfiguration: '/IntegratedConfigurationInService/IntegratedConfigurationInImplBean',
  IntegratedConfiguration750: '/IntegratedConfiguration750InService/IntegratedConfiguration750InImplBean',
  CommunicationChannel: '/CommunicationChannelInService/CommunicationChannelInImplBean',
  SenderAgreement: '/SenderAgreementInService/SenderAgreementInImplBean',
  ReceiverAgreement: '/ReceiverAgreementInService/ReceiverAgreementInImplBean',
  InterfaceDetermination: '/InterfaceDeterminationInService/InterfaceDeterminationInImplBean',
  ReceiverDetermination: '/ReceiverDeterminationInService/ReceiverDeterminationInImplBean',
  ValueMapping: '/ValueMappingInService/ValueMappingInImplBean',
  AlertRule: '/AlertRuleInService/AlertRuleInImplBean',
  BusinessComponent: '/BusinessComponentInService/BusinessComponentInImplBean',
  ConfigurationScenario: '/ConfigurationScenarioInService/ConfigurationScenarioInImplBean',
  Party: '/PartyInService/PartyInImplBean',
  BusinessSystem: '/BusinessSystemInService/BusinessSystemInImplBean',
});

// ═══════════════════════════════════════════════════════════════════════════════
// OBJECT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ESR object types for discovery
 */
const EsrObjectTypes = Object.freeze([
  'SoftwareComponentVersion',
  'Namespace',
  'MessageType',
  'DataType',
  'ExternalDefinition',
  'ServiceInterface',
  'MessageMapping',
  'OperationMapping',
  'InterfaceMapping',
  'FunctionLibrary',
  'ImportedArchive',
]);

/**
 * Directory object types for discovery
 */
const DirObjectTypes = Object.freeze([
  'IntegratedConfiguration',
  'CommunicationChannel',
  'SenderAgreement',
  'ReceiverAgreement',
  'InterfaceDetermination',
  'ReceiverDetermination',
  'ValueMappingGroup',
  'BusinessComponent',
  'ConfigurationScenario',
]);

/**
 * PI/PO object types grouped by repository
 */
const PipoObjectTypes = Object.freeze({
  ESR: [
    'SoftwareComponentVersion',
    'MessageType',
    'DataType',
    'ServiceInterface',
    'MessageMapping',
    'OperationMapping',
    'InterfaceMapping',
  ],
  DIR: [
    'IntegratedConfiguration',
    'CommunicationChannel',
    'SenderAgreement',
    'ReceiverAgreement',
    'InterfaceDetermination',
    'ReceiverDetermination',
  ],
});

// ═══════════════════════════════════════════════════════════════════════════════
// XML NAMESPACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * SAP NetWeaver XI XML Namespaces
 */
const XiNamespaces = Object.freeze({
  BASIS: 'http://sap.com/xi/BASIS',
  BASIS_750: 'http://sap.com/xi/BASIS/750',
  ADAPTER: 'http://sap.com/xi/XI/Adapter',
  SYSTEM: 'http://sap.com/xi/XI/System',
  SOAP_ENV: 'http://schemas.xmlsoap.org/soap/envelope/',
});

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP HEADERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Common HTTP headers
 */
const HttpHeaders = Object.freeze({
  ACCEPT_XML: 'application/xml, text/xml, */*',
  ACCEPT_JSON: 'application/json',
  CONTENT_TYPE_XML: 'application/xml',
  CONTENT_TYPE_SOAP: 'text/xml; charset=utf-8',
  CONTENT_TYPE_JSON: 'application/json',
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLEXITY SCORING FACTORS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Complexity scoring weights for artifact analysis
 */
const ComplexityWeights = Object.freeze({
  BPM: 10,
  JAVA_ABAP: 6,
  XSLT: 3,
  AS2_JMS: 6,
  JDBC_RFC: 3,
  EDI: 4,
  Z_FIELDS: 4,
  HIGH_VOLUME: 6, // > 100k/day
  MEDIUM_VOLUME: 3, // > 10k/day
  LARGE_SEGMENTS: 6, // > 15 segments
  MEDIUM_SEGMENTS: 3, // > 5 segments
  FINANCE_HR: 3, // FI/HR always elevated
});

/**
 * Complexity keyword patterns for detection
 */
const ComplexityPatterns = Object.freeze({
  BPM: ['ccbpm', 'bpm'],
  CUSTOM_CODE: ['java', 'abap'],
  XSLT: ['xslt'],
  AS2_JMS: ['as2', 'jms'],
  JDBC_RFC: ['jdbc', 'rfc'],
  EDI: ['edi', 'edifact'],
  Z_FIELDS: ['zfield', 'z_field'],
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Status values
  Status,
  ArtifactStatus,
  SapMigrationStatus,

  // Timeouts
  Timeouts,

  // Complexity
  ComplexityTier,
  ComplexityThresholds,
  ComplexityWeights,
  ComplexityPatterns,

  // Destinations
  Destinations,

  // API Endpoints
  EsrEndpoints,
  MonitoringEndpoints,
  SldEndpoints,
  DirectorySoapServices,

  // Object types
  EsrObjectTypes,
  DirObjectTypes,
  PipoObjectTypes,

  // XML Namespaces
  XiNamespaces,

  // HTTP Headers
  HttpHeaders,
};
