using { tenant } from '../db/tenant-schema';

/**
 * Discovery Service - PI/PO Artifact Discovery with Multi-Tenant Support
 *
 * Provides APIs for:
 * - Managing PI/PO system connections
 * - Running discovery jobs with real-time progress
 * - Browsing and searching discovered artifacts
 * - Approving artifacts for migration
 *
 * Role-based access:
 * - Admin: Full access (manage systems, run discovery, approve)
 * - Approver: View and approve artifacts
 * - Viewer: Read-only access
 */
@requires: ['admin', 'approver', 'viewer']
service DiscoveryService @(path: '/odata/v4/discovery') {

  // -------------------------------------------------------------------------------
  // ENTITIES - Role-based projections
  // -------------------------------------------------------------------------------

  @requires: 'admin'
  @cds.redirection.target: true
  entity PISystems as projection on tenant.PISystem {
    *,
    jobs: redirected to DiscoveryJobs,
    artifacts: redirected to Artifacts
  } excluding { rawDefinition };

  @readonly
  entity DiscoveryJobs as projection on tenant.DiscoveryJob {
    *,
    system: redirected to PISystems
  };

  @readonly
  @cds.redirection.target: true
  entity Artifacts as projection on tenant.Artifact {
    *,
    system: redirected to PISystems,
    discoveryJob: redirected to DiscoveryJobs
  } excluding { rawDefinition };

  // Full artifact with raw definition (separate for performance)
  @readonly
  entity ArtifactDetails as projection on tenant.Artifact;

  @requires: 'admin'
  @readonly
  entity AuditLogs as projection on tenant.AuditLog;

  @readonly
  entity ArtifactTypes as projection on tenant.ArtifactType;

  // Reference data: Known IS limitations (Gap #3)
  @readonly
  entity MigrationLimitations as projection on tenant.MigrationLimitationRef;

  // Reference data: Scenario patterns (Gap #1)
  @readonly
  entity ScenarioPatterns as projection on tenant.ScenarioPatternRef;

  // Reference data: Adapter migration matrix (SAP Migration Guide Gap #2)
  @readonly
  entity AdapterMigrations as projection on tenant.AdapterMigrationRef;

  // Reference data: Adapter module mappings (SAP Migration Guide Gap #3)
  @readonly
  entity AdapterModuleMigrations as projection on tenant.AdapterModuleMigrationRef;

  // Reference data: Security material inventory (SAP Migration Guide Gap #4)
  @readonly
  entity SecurityMaterialInventory as projection on tenant.SecurityMaterialInventory;

  // Reference data: Enterprise Integration Patterns (SAP Migration Guide Gap #5)
  @readonly
  entity EIPPatterns as projection on tenant.EIPPatternRef;

  // Module configurations extracted from channels (SAP NetWeaver 7.50)
  @readonly
  entity ModuleConfigurations as projection on tenant.ModuleConfiguration;

  // Credential/security material inventory (for migration planning)
  @readonly
  entity Credentials as projection on tenant.CredentialInventory;

  // Parties for B2B scenarios
  @readonly
  entity Parties as projection on tenant.Party;

  // Artifact limitations (joins artifacts with their detected limitations)
  @readonly
  entity ArtifactLimitations as projection on tenant.ArtifactLimitation {
    *,
    artifact: redirected to Artifacts,
    limitation: redirected to MigrationLimitations
  };

  // -------------------------------------------------------------------------------
  // SYSTEM MANAGEMENT (Admin only)
  // -------------------------------------------------------------------------------

  /**
   * Add a new PI/PO system for this tenant.
   * Creates BTP destinations automatically.
   */
  @requires: 'admin'
  action addPISystem(
    systemName    : String(50),
    description   : String(200),
    virtualHost   : String(200),
    virtualPort   : Integer,
    protocol      : String(10),
    locationId    : String(50),
    techUser      : String(50),
    techPassword  : String(100),  // Used to create destination, not stored
    piVersion     : String(20)
  ) returns {
    systemId      : UUID;
    destinationDir: String;
    destinationEsr: String;
    status        : String;
    message       : String;
  };

  /**
   * Update PI/PO system configuration.
   */
  @requires: 'admin'
  action updatePISystem(
    systemId      : UUID,
    systemName    : String(50),
    description   : String(200),
    techUser      : String(50),
    techPassword  : String(100),  // Optional, only if changing
    piVersion     : String(20)
  ) returns {
    success       : Boolean;
    message       : String;
  };

  /**
   * Test connection to a PI/PO system.
   * Verifies Cloud Connector connectivity and PI/PO credentials.
   */
  @requires: 'admin'
  action testConnection(systemId: UUID) returns {
    success       : Boolean;
    dirStatus     : String;
    esrStatus     : String;
    sldStatus     : String;
    piVersion     : String;
    swcvCount     : Integer;
    icoCount      : Integer;
    channelCount  : Integer;
    message       : String;
    details       : LargeString;  // JSON with detailed test results
  };

  /**
   * Remove a PI/PO system and all its discovered artifacts.
   */
  @requires: 'admin'
  action removePISystem(systemId: UUID) returns {
    success       : Boolean;
    artifactsDeleted: Integer;
    message       : String;
  };

  // -------------------------------------------------------------------------------
  // DISCOVERY OPERATIONS
  // -------------------------------------------------------------------------------

  /**
   * Start a discovery job for a PI/PO system.
   * Runs asynchronously with progress updates via Event Mesh.
   */
  @requires: 'admin'
  action startDiscovery(
    systemId      : UUID,
    includeInactive: Boolean,     // Include inactive ICOs/channels
    includeHistory : Boolean,     // Include historical/versioned objects
    artifactTypes  : LargeString  // JSON array of types to discover, null = all
  ) returns {
    jobId         : UUID;
    status        : String;
    estimatedTime : Integer;      // Estimated seconds
    message       : String;
  };

  /**
   * Cancel a running discovery job.
   */
  @requires: 'admin'
  action cancelDiscovery(jobId: UUID) returns {
    success       : Boolean;
    message       : String;
  };

  /**
   * Get current discovery progress (polling alternative to SSE).
   */
  function getDiscoveryProgress(jobId: UUID) returns {
    jobId         : UUID;
    status        : String;
    phase         : Integer;
    phaseName     : String;
    progressPercent: Integer;
    artifactsFound: Integer;
    currentItem   : String;
    errors        : LargeString;  // JSON array of errors
    estimatedRemaining: Integer;  // Seconds
  };

  /**
   * Re-run discovery for specific artifact types only.
   */
  @requires: 'admin'
  action refreshArtifacts(
    systemId      : UUID,
    artifactTypes : LargeString   // JSON array of types to refresh
  ) returns {
    jobId         : UUID;
    status        : String;
    message       : String;
  };

  // -------------------------------------------------------------------------------
  // ARTIFACT OPERATIONS
  // -------------------------------------------------------------------------------

  /**
   * Get full artifact details including raw XML definition.
   */
  function getArtifactDetails(artifactId: UUID) returns {
    artifact      : LargeString;  // JSON serialized artifact data
    dependencies  : LargeString;  // JSON array of dependent artifacts
    dependents    : LargeString;  // JSON array of artifacts depending on this
    migrationPlan : LargeString;  // JSON from AI advisor
  };

  /**
   * Run AI assessment on an artifact.
   * Returns SAP Migration Assessment Tool aligned fields (per SAP PO-to-IS course).
   * By default runs asynchronously via CAP outbox; set async=false for synchronous.
   */
  @requires: ['admin', 'approver']
  action assessArtifact(artifactId: UUID, async: Boolean default true) returns {
    artifactId    : UUID;
    status        : String;       // 'queued' for async, 'complete' for sync
    tier          : String;
    complexityScore: Integer;
    recommendedTool: String;
    estimatedHours: Decimal;
    rationale     : String;
    // Gap #1: Scenario Pattern Classification
    scenarioPattern    : String;   // P2P_ASYNC | P2P_SYNC | MULTICAST | BPM | CCBPM | CUSTOM
    scenarioPatternName: String;   // Human-readable pattern name
    // Gap #2: SAP Migration Status Alignment
    sapMigrationStatus : String;   // "Ready to migrate" | "Adjustment required" | "Evaluation required"
    matchedTemplate    : String;   // SAP Business Accelerator Hub template or standard iFlow
    // Gap #3: Known Limitations
    limitations        : String;   // JSON array of detected limitations
    limitationCount    : Integer;  // Number of limitations found
    hasBlockers        : Boolean;  // True if any blocker-severity limitations
    message       : String;
  };

  // -------------------------------------------------------------------------
  // EVENTS - CAP Native Event Queue
  // -------------------------------------------------------------------------

  /**
   * Emitted when an artifact assessment is requested via CAP outbox.
   * Processed asynchronously by background runner.
   */
  event AssessmentRequested {
    artifactId    : UUID;
    tenantId      : String;
    userId        : String;
  };

  /**
   * Batch assess multiple artifacts.
   */
  @requires: ['admin', 'approver']
  action batchAssess(
    artifactIds   : LargeString   // JSON array of artifact UUIDs
  ) returns {
    assessed      : Integer;
    failed        : Integer;
    message       : String;
  };

  /**
   * Approve an artifact for migration.
   */
  @requires: ['admin', 'approver']
  action approveArtifact(
    artifactId    : UUID,
    wave          : Integer,
    notes         : LargeString
  ) returns {
    success       : Boolean;
    message       : String;
  };

  /**
   * Reject an artifact (skip from migration).
   */
  @requires: ['admin', 'approver']
  action skipArtifact(
    artifactId    : UUID,
    reason        : LargeString
  ) returns {
    success       : Boolean;
    message       : String;
  };

  /**
   * Batch approve multiple artifacts.
   */
  @requires: ['admin', 'approver']
  action batchApprove(
    artifactIds   : LargeString,  // JSON array of artifact UUIDs
    wave          : Integer,
    notes         : LargeString
  ) returns {
    approved      : Integer;
    failed        : Integer;
    message       : String;
  };

  // -------------------------------------------------------------------------------
  // REPORTING & EXPORT
  // -------------------------------------------------------------------------------

  /**
   * Get discovery summary statistics.
   */
  function getDiscoverySummary(systemId: UUID) returns {
    systemName    : String;
    totalArtifacts: Integer;
    byType        : LargeString;  // JSON: { ICO: 50, Channel: 120, ... }
    byTier        : LargeString;  // JSON: { simple: 80, medium: 40, complex: 20 }
    byStatus      : LargeString;  // JSON: { discovered: 100, assessed: 30, approved: 10 }
    estimatedTotalHours: Decimal;
    lastDiscoveryAt: DateTime;
  };

  /**
   * Export artifact inventory to Excel/CSV.
   */
  @requires: ['admin', 'approver']
  action exportInventory(
    systemId      : UUID,
    format        : String,       // excel | csv | json
    filters       : LargeString   // JSON: { types, tiers, statuses }
  ) returns {
    downloadUrl   : String;
    artifactCount : Integer;
    message       : String;
  };

  /**
   * Generate migration wave plan.
   */
  @requires: ['admin', 'approver']
  action generateWavePlan(systemId: UUID) returns {
    waves         : LargeString;  // JSON array of wave objects
    totalWaves    : Integer;
    totalHours    : Decimal;
    message       : String;
  };

  // -------------------------------------------------------------------------------
  // SAP NETWEAVER 7.50 SPECIFIC OPERATIONS
  // -------------------------------------------------------------------------------

  /**
   * Extract detailed channel information including module chains.
   * Reads full channel definitions using Directory API and extracts:
   * - ModuleProcess chains with IS equivalent mappings
   * - Adapter-specific configurations
   * - Security/credential references
   */
  @requires: 'admin'
  action extractChannelDetails(
    systemId      : UUID,
    channelIds    : LargeString,  // JSON array of channel IDs (null = all)
    includeModules: Boolean default true,
    includeSecurityConfig: Boolean default true
  ) returns {
    processed     : Integer;
    modulesExtracted: Integer;
    credentialsFound: Integer;
    errors        : LargeString;
    message       : String;
  };

  /**
   * Extract 7.50-specific ICO details.
   * Uses IntegratedConfiguration750InService for additional fields:
   * - ReceiverWildcardIndicator
   * - Enhanced routing configuration
   */
  @requires: 'admin'
  action extractIcoDetails750(
    systemId      : UUID,
    icoIds        : LargeString   // JSON array of ICO IDs (null = all)
  ) returns {
    processed     : Integer;
    with750Fields : Integer;      // ICOs with 7.50-specific fields
    errors        : LargeString;
    message       : String;
  };

  /**
   * Query configuration scenarios that group related artifacts.
   * Returns scenarios with their contained ICOs, channels, and agreements.
   */
  @requires: 'admin'
  function getConfigurationScenarios(systemId: UUID) returns {
    scenarios     : LargeString;  // JSON array of scenario summaries
    count         : Integer;
    message       : String;
  };

  /**
   * Get module configurations for a specific channel.
   * Returns the extracted module chain with IS equivalent mappings.
   */
  function getChannelModules(channelId: String) returns {
    channelId     : String;
    channelName   : String;
    adapterType   : String;
    modules       : LargeString;  // JSON array of module configs
    moduleCount   : Integer;
    hasCustomModules: Boolean;    // True if any modules need manual migration
    message       : String;
  };

  /**
   * Get security material inventory for a system.
   * Returns all credential/certificate references found in channels and agreements.
   */
  function getSecurityInventory(systemId: UUID) returns {
    credentials   : LargeString;  // JSON array of credential inventory items
    count         : Integer;
    byType        : LargeString;  // JSON: { Password: 10, Certificate: 5, ... }
    needsMigration: Integer;      // Count of items requiring IS security material
    message       : String;
  };
}