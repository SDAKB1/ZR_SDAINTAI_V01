using { cuid, managed } from '@sap/cds/common';
namespace tenant;

// -------------------------------------------------------------------------------
// TENANT PI/PO SYSTEM CONFIGURATION
// -------------------------------------------------------------------------------

/**
 * Each tenant can configure multiple PI/PO systems for migration.
 * Destinations are created dynamically when a system is added.
 */
entity PISystem : cuid, managed {
  tenantId        : String(50);           // cds-mtx tenant subdomain
  systemName      : String(50) not null;  // e.g. "PJ2", "PD1", "Production"
  description     : String(200);

  // Connection details (mapped via Cloud Connector)
  virtualHost     : String(200) not null; // Virtual host exposed by Cloud Connector
  virtualPort     : Integer default 443;
  protocol        : String(10) default 'http';  // http | https
  locationId      : String(50) not null;  // Cloud Connector Location ID (e.g. "SDA_LAB")

  // BTP Destinations (auto-created on system add)
  destinationDir  : String(100);          // e.g. "PO_PJ2_DIR_<tenantId>"
  destinationEsr  : String(100);          // e.g. "PO_PJ2_ESR_<tenantId>"

  // PI/PO credentials (stored in destination, reference only)
  techUser        : String(50);
  piVersion       : String(20) default '7.50';  // 7.31 | 7.40 | 7.50

  // System status
  status          : String(20) default 'configured';  // configured | testing | active | error | disabled
  lastTestedAt    : DateTime;
  lastTestResult  : LargeString;          // JSON: { success, dirOk, esrOk, version, errors }

  // Statistics
  totalArtifacts  : Integer default 0;
  lastDiscoveryAt : DateTime;

  // Relations
  jobs            : Composition of many DiscoveryJob on jobs.system = $self;
  artifacts       : Composition of many Artifact on artifacts.system = $self;
}

// -------------------------------------------------------------------------------
// DISCOVERY JOB TRACKING
// -------------------------------------------------------------------------------

/**
 * Tracks discovery jobs with real-time progress for UI updates.
 * Progress is published to Event Mesh for SSE streaming.
 */
entity DiscoveryJob : cuid, managed {
  tenantId        : String(50);
  system          : Association to PISystem;

  // Job lifecycle
  status          : String(20) default 'pending';  // pending | running | paused | completed | failed | cancelled
  startedAt       : DateTime;
  completedAt     : DateTime;
  startedBy       : String(100);          // User who initiated

  // Progress tracking (6 phases)
  totalPhases     : Integer default 6;
  currentPhase    : Integer default 0;
  currentPhaseName: String(100);
  progressPercent : Integer default 0;

  // Discovery options
  options         : LargeString;          // JSON: { includeInactive, includeHistory, artifactTypes[] }

  // Results
  artifactsFound  : Integer default 0;
  artifactsNew    : Integer default 0;
  artifactsUpdated: Integer default 0;
  errorsCount     : Integer default 0;
  warningsCount   : Integer default 0;

  // Logs (append-only JSON arrays)
  progressLog     : LargeString;          // [ { ts, phase, message, count } ]
  errorLog        : LargeString;          // [ { ts, phase, type, message, details } ]

  // Duration tracking
  durationMs      : Integer;
}

// -------------------------------------------------------------------------------
// DISCOVERED PI/PO ARTIFACTS
// -------------------------------------------------------------------------------

/**
 * All discovered PI/PO artifacts normalized into a single entity.
 * Supports ICOs, Channels, Mappings, Agreements, Value Mappings, etc.
 */
entity Artifact : cuid, managed {
  tenantId        : String(50);
  system          : Association to PISystem;
  discoveryJob    : Association to DiscoveryJob;

  // Artifact identification
  artifactType    : String(50) not null;  // IntegratedConfiguration | CommunicationChannel | MessageMapping | etc.
  artifactKey     : String(1000);         // Composite key from PI/PO (serialized)
  objectId        : String(200);          // Short ID for display
  name            : String(500);
  description     : LargeString;

  // PI/PO location
  namespace       : String(500);
  swcv            : String(200);          // Software Component Version
  swcvGuid        : String(50);

  // Configuration details (type-specific)
  direction       : String(20);           // inbound | outbound | bidirectional
  adapterType     : String(100);          // IDoc | SOAP | REST | SFTP | RFC | JDBC | AS2 | JMS | HTTP | etc.

  // Sender/Receiver (for ICOs, Agreements)
  senderParty     : String(100);
  senderComponent : String(100);
  senderInterface : String(200);
  senderNamespace : String(500);

  receiverParty   : String(100);
  receiverComponent: String(100);
  receiverInterface: String(200);
  receiverNamespace: String(500);

  // Mapping references
  mappingProgram  : String(500);
  mappingType     : String(50);           // graphical | xslt | java | abap | message | operation

  // Runtime status
  piStatus        : String(20);           // active | inactive | error | unknown
  lastActivatedAt : DateTime;
  lastModifiedBy  : String(100);

  // Full definition (for detailed view and migration)
  rawDefinition   : LargeString;          // Full XML definition from PI/PO
  rawFormat       : String(20) default 'xml';  // xml | json

  // Dependencies (resolved during discovery)
  dependencies    : LargeString;          // JSON: [ { type, key, name } ]
  dependencyCount : Integer default 0;

  // Migration assessment (populated by AI advisor)
  migrationTier   : String(20);           // simple | medium | complex
  complexityScore : Integer;              // 0-100
  recommendedTool : String(100);          // BAPI | iFlow_SemiAuto | iFlow_Custom | Pattern_C
  estimatedHours  : Decimal(5,1);
  assessedAt      : DateTime;
  assessmentNotes : LargeString;

  // SAP Migration Assessment Alignment (Gap #1 & #2)
  scenarioPattern : String(30);           // P2P_ASYNC | P2P_SYNC | MULTICAST | BPM | CCBPM | CUSTOM
  sapMigrationStatus: String(50);         // "Ready to migrate" | "Adjustment required" | "Evaluation required"
  matchedTemplate : String(200);          // SAP Business Accelerator Hub template or standard iFlow

  // Known Limitations (Gap #3)
  limitations     : Composition of many ArtifactLimitation on limitations.artifact = $self;

  // Migration workflow
  migrationStatus : String(30) default 'discovered';  // discovered | assessed | approved | in_progress | migrated | skipped
  migrationWave   : Integer;
  approvedBy      : String(100);
  approvedAt      : DateTime;
  approvalNotes   : LargeString;

  // Target (after migration)
  targetArtifactId: String(200);          // IS iFlow ID or S/4 object
  targetType      : String(50);           // iFlow | BAPI | CAP | etc.
  migratedAt      : DateTime;
}

// -------------------------------------------------------------------------------
// AUDIT LOG
// -------------------------------------------------------------------------------

/**
 * Immutable audit log for compliance and debugging.
 */
entity AuditLog : cuid, managed {
  tenantId        : String(50);
  userId          : String(100);
  userName        : String(200);
  userRole        : String(50);           // Admin | Approver | Viewer

  action          : String(100) not null; // system_added | system_tested | discovery_started | artifact_approved | etc.
  entityType      : String(50);           // PISystem | DiscoveryJob | Artifact
  entityId        : String(50);
  entityName      : String(200);

  details         : LargeString;          // JSON with action-specific details
  ipAddress       : String(50);
  userAgent       : String(500);

  // For tracking changes
  previousValue   : LargeString;
  newValue        : LargeString;
}

// -------------------------------------------------------------------------------
// ARTIFACT TYPE REFERENCE
// -------------------------------------------------------------------------------

/**
 * Reference data for artifact types and their discovery configuration.
 */
entity ArtifactType {
  key code        : String(50);           // IntegratedConfiguration, CommunicationChannel, etc.
  name            : String(100);
  category        : String(50);           // directory | esr | monitoring
  soapService     : String(200);          // SOAP service path
  discoveryOrder  : Integer;              // Order in discovery phases
  supportsQuery   : Boolean default true;
  supportsRead    : Boolean default true;
  description     : String(500);
}

// -------------------------------------------------------------------------------
// PI/PO DISCOVERY CACHE (per north_star.md)
// -------------------------------------------------------------------------------
/**
 * Cache layer for PI/PO API responses with TTL support.
 * Reduces load on PI/PO systems and improves response times.
 */
entity PIPOCache : managed {
  key tenant_ID   : String(64);   // Tenant ID
  key resourceType: String(64);    // ico_list, ico_detail, channel_list, mapping_list, etc.
  key resourceId  : String(256);   // Specific resource ID or '__all__' for lists
  data            : LargeString;   // JSON serialized response data
  etag            : String(128);   // For change detection
  version         : Integer default 1;
  expiresAt       : DateTime not null;
  updatedAt       : DateTime;
}

// -------------------------------------------------------------------------------
// VECTOR EMBEDDINGS FOR SEMANTIC SEARCH (per north_star.md)
// -------------------------------------------------------------------------------
/**
 * Stores embeddings for semantic search over PI/PO artifacts.
 * Enables AI-powered migration suggestions and similar artifact discovery.
 */
entity PIPOEmbeddings : managed {
  key tenant_ID   : String(64);
  key resourceType: String(64);    // ICO, CHANNEL, MAPPING, VALUE_MAP, etc.
  key resourceId  : String(256);   // Artifact identifier
  key chunkIndex  : Integer default 0;  // For large artifacts split into chunks
  contentText     : LargeString;   // Original text for display
  embedding       : LargeString;   // JSON array of floats (REAL_VECTOR in HANA)
  metadata        : LargeString;   // JSON metadata
}

// -------------------------------------------------------------------------------
// LANGGRAPH STATE CHECKPOINTS (per north_star.md)
// -------------------------------------------------------------------------------
/**
 * Stores LangGraph workflow checkpoints for resumable AI operations.
 */
entity LangGraphCheckpoints {
  key threadId          : String(128);
  key checkpointNs      : String(128);
  key checkpointId      : String(128);
  parentCheckpointId    : String(128);
  tenantId              : String(64);
  checkpoint            : LargeBinary;  // Serialized state
  metadata              : LargeString;  // JSON metadata
  createdAt             : DateTime default $now;
}

// -------------------------------------------------------------------------------
// DEPENDENCY GRAPH FOR IMPACT ANALYSIS
// -------------------------------------------------------------------------------
/**
 * Tracks dependencies between PI/PO artifacts for impact analysis.
 * Answers: "What's affected if I change this mapping?"
 */
entity DependencyGraph {
  key tenant_ID         : String(64);
  key sourceArtifactId  : String(512);
  key targetArtifactId  : String(512);
  dependencyType        : String(64);  // uses_mapping, uses_channel, references, etc.
  metadata              : LargeString; // Additional dependency info
  createdAt             : DateTime default $now;
}

// -------------------------------------------------------------------------------
// MIGRATION HISTORY TRACKING
// -------------------------------------------------------------------------------
/**
 * Records migration attempts and outcomes for audit and learning.
 */
entity MigrationHistory : cuid, managed {
  tenantId              : String(64);
  sourceArtifact        : Association to Artifact;
  targetIFlowId         : String(256);
  status                : String(32);  // pending, converting, converted, deployed, failed
  conversionResult      : LargeString; // JSON conversion details
  deploymentResult      : LargeString; // JSON deployment response
  completedAt           : DateTime;
  errorMessage          : LargeString;
}


// ═══════════════════════════════════════════════════════════════════════════════
// MODULE CONFIGURATIONS (Critical for migration - extracted from channels)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Adapter module chain configurations extracted from Communication Channels.
 * Contains processing logic that must be analyzed for IS equivalent.
 */
entity ModuleConfiguration : managed {
  key tenant_ID       : String(64);
  key channelId       : String(512);
  key moduleKey       : String(128);
  moduleName          : String(256);      // e.g., "AF_Modules/PayloadSwapBean"
  moduleType          : String(64);       // "Local Enterprise Bean", "Module"
  parameters          : LargeString;      // JSON: module parameters
  processingSequence  : Integer;
  // Migration analysis
  isEquivalent        : String(256);      // IS equivalent: "Content Modifier", "Groovy Script", etc.
  migrationNotes      : LargeString;      // Notes for conversion
  migrationStatus     : String(32) default 'pending';  // pending, analyzed, converted, verified
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREDENTIAL INVENTORY (For planning - NOT actual credentials)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Inventory of credential references for migration planning.
 * Does NOT store actual credentials - only references for security planning.
 */
entity CredentialInventory : managed {
  key tenant_ID       : String(64);
  key credentialAlias : String(256);      // Name/alias in PI/PO secure storage
  credentialType      : String(64);       // "Password", "Certificate", "KeyPair", "OAuth"
  authType            : String(64);       // "Basic", "Certificate", "OAuth2ClientCredentials"
  referencedBy        : LargeString;      // JSON: array of channel/agreement IDs using this
  // Migration tracking
  isSecurityMaterial  : String(256);      // Corresponding IS Security Material artifact name
  migrationStatus     : String(32) default 'pending';  // pending, created, verified
  notes               : LargeString;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARTIES (Conditional - B2B scenarios only)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Trading partner parties for B2B/EDI migrations.
 * Only needed when customer uses Parties for AS2, SFTP partners, EDI X12/EDIFACT.
 */
entity Party : cuid, managed {
  tenant_ID           : String(64);
  partyId             : String(256);
  partyName           : String(256);
  partyAgency         : String(64);       // "DUNS", "GLN", etc.
  identifiers         : LargeString;      // JSON: identifier schemes
  contacts            : LargeString;      // JSON: business contacts
  certificates        : LargeString;      // JSON: certificate references (NOT actual certs)
  // Relations
  channels            : LargeString;      // JSON: referenced channel IDs
  agreements          : LargeString;      // JSON: referenced agreement IDs
  // Migration to IS Trading Partner
  isTradingPartnerId  : String(256);      // Corresponding IS Trading Partner profile
  migrationStatus     : String(32) default 'pending';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ARTIFACT LIMITATIONS (Gap #3 - Known IS Limitations per SAP Course)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Tracks known Integration Suite limitations affecting each artifact.
 * Based on SAP official migration course and Migration Assessment Tool categories.
 */
entity ArtifactLimitation : cuid, managed {
  tenant_ID           : String(64);
  artifact            : Association to Artifact;
  limitation          : Association to MigrationLimitationRef;

  // Instance-specific context
  detectedAt          : DateTime default $now;
  detectedBy          : String(30) default 'auto';  // auto | manual
  context             : LargeString;      // JSON: where in artifact this was found

  // Resolution tracking
  resolutionStatus    : String(30) default 'open';  // open | workaround_applied | accepted | resolved
  resolutionNotes     : LargeString;
  resolvedBy          : String(100);
  resolvedAt          : DateTime;
}

/**
 * Reference data: Known Integration Suite limitations from SAP documentation.
 * Pre-seeded with limitations from SAP PO-to-IS migration course.
 */
entity MigrationLimitationRef {
  key code            : String(50);       // NFS_ADAPTER, ASMA_HEADER, etc.
  name                : String(200);
  category            : String(50);       // adapter | runtime | feature | mapping
  severity            : String(20);       // blocker | major | minor
  description         : LargeString;

  // Detection rules
  detectionRules      : LargeString;      // JSON: { adapterTypes:[], features:[], patterns:[] }

  // Workaround guidance
  workaroundType      : String(30);       // none | manual | script | custom_adapter
  workaroundDesc      : LargeString;
  effortMultiplier    : Decimal(3,1) default 1.0;  // Multiplier on estimated hours

  // SAP references
  sapNoteId           : String(20);       // SAP Note number if applicable
  sapDocUrl           : String(500);      // Link to SAP documentation
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO PATTERN REFERENCE (Gap #1 - SAP Course Taxonomy)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Reference data: Standard PI/PO scenario patterns and their IS migration path.
 */
entity ScenarioPatternRef {
  key code            : String(30);       // P2P_ASYNC, P2P_SYNC, MULTICAST, BPM, CCBPM, CUSTOM
  name                : String(100);
  description         : LargeString;

  // Classification rules
  detectionRules      : LargeString;      // JSON: criteria to detect this pattern

  // IS target
  isTargetPattern     : String(100);      // iFlow, ProcessDirect, etc.
  migrationApproach   : LargeString;      // Description of how to migrate
  standardTemplates   : LargeString;      // JSON: SAP Business Accelerator Hub templates

  // Complexity impact
  baseComplexity      : String(20);       // simple | medium | complex
  typicalHours        : Decimal(5,1);
}


// ═══════════════════════════════════════════════════════════════════════════════
// ADAPTER MIGRATION REFERENCE (Gap Analysis - SAP Migration Guide)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Reference: PI/PO adapter to IS adapter mapping from SAP's official migration guide.
 * Source: standard-adapter-migration-2622c30.md
 */
entity AdapterMigrationRef {
  key pipoAdapter     : String(50);       // AS2, FILE, HTTP_AAE, IDOC_AAE, JDBC, JMS, etc.
  key direction       : String(10);       // sender | receiver
  isAdapter           : String(100);      // IS equivalent adapter name (or null)
  migrationStatus     : String(20);       // direct | alternative | partial | planned | none
  alternativeAdapter  : String(200);      // Alternative IS adapter if not direct match
  limitations         : LargeString;      // JSON: specific limitations
  migrationNotes      : LargeString;      // Guidance text from SAP documentation
  effortMultiplier    : Decimal(3,1) default 1.0;
  sapDocUrl           : String(500);      // Link to SAP documentation
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADAPTER MODULE MIGRATION REFERENCE (Gap Analysis - SAP Migration Guide)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Reference: PI/PO adapter modules to IS equivalent steps/scripts.
 * Source: adapter-modules-e402f4a.md
 */
entity AdapterModuleMigrationRef {
  key moduleClass     : String(200);      // Full class name: AF_Modules/PayloadSwapBean
  moduleName          : String(100);      // Human-readable name
  description         : LargeString;      // What the module does
  isEquivalent        : String(200);      // IS step or approach name
  migrationApproach   : String(30);       // auto | manual | script | rebuild | none
  effortHours         : Decimal(5,1);     // Typical conversion effort
  exampleCode         : LargeString;      // Groovy script example if applicable
  sapBlogUrl          : String(500);      // Link to SAP community blog
  transformationPackage: String(200);     // SAP Business Accelerator Hub package if available
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY MATERIAL INVENTORY (Gap Analysis - SAP Migration Guide)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Tracks security material (certificates, credentials, keys) for migration planning.
 * Source: managing-security-material-in-cloud-integration-09ec016.md
 */
entity SecurityMaterialInventory : cuid, managed {
  tenant_ID           : String(64);
  artifact            : Association to Artifact;  // Channel or agreement using this material

  // Material identification
  materialType        : String(50);       // user_credentials | oauth2_client | oauth2_saml |
                                          // oauth2_authcode | secure_param | ssh_known_hosts |
                                          // pgp_public | pgp_secret | x509_cert | x509_keypair
  pipoLocation        : String(200);      // Keystore view in PI/PO (TrustedCAs, ICM_SSL, etc.)
  alias               : String(200);      // Credential/certificate alias

  // Certificate details (if applicable)
  subjectDN           : String(500);      // Certificate subject distinguished name
  issuerDN            : String(500);      // Certificate issuer
  serialNumber        : String(100);
  validFrom           : DateTime;
  expiresAt           : DateTime;
  algorithm           : String(50);       // RSA, EC, etc.
  keyLength           : Integer;

  // Usage tracking
  referencedByChannels: LargeString;      // JSON: array of channel IDs using this material
  authenticationMethod: String(100);      // basic | certificate | oauth2_client_credentials | etc.

  // IS target
  isMaterialName      : String(200);      // Target IS security material name
  isMaterialType      : String(50);       // IS security material type
  migrationStatus     : String(30) default 'pending';  // pending | created | verified | failed
  migrationNotes      : LargeString;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTERPRISE INTEGRATION PATTERN REFERENCE (Gap Analysis - SAP Migration Guide)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Reference: Enterprise Integration Patterns and their PI/PO to IS migration paths.
 * Based on Gregor Hohpe patterns documented in SAP's migration guide.
 */
entity EIPPatternRef {
  key code            : String(30);       // AGGREGATOR, SPLITTER, SCATTER_GATHER, etc.
  name                : String(100);
  description         : LargeString;

  // PI/PO implementation
  pipoImplementation  : String(200);      // ccBPM Collect, Multi-mapping, Receiver determination, etc.
  pipoComplexity      : String(20);       // simple | medium | complex

  // IS implementation
  isImplementation    : String(200);      // Aggregator step, Splitter step, etc.
  isComplexity        : String(20);       // simple | medium | complex

  // Detection rules
  detectionRules      : LargeString;      // JSON: criteria to detect this pattern in ICO

  // References
  sapTutorialUrl      : String(500);      // Link to SAP tutorial
  acceleratorHubPkg   : String(200);      // Business Accelerator Hub package name
}
