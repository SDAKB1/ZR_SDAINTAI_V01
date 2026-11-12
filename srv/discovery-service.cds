using { tenant } from '../db/tenant-schema';

/**
 * Discovery Service - PI/PO Artifact Discovery with Multi-Tenant Support
 *
 * Provides APIs for:
 * - Managing PI/PO system connections
 * - Running discovery jobs with real-time progress via SSE
 * - Browsing and searching discovered artifacts
 * - AI-powered migration assessment
 *
 * All operations use cds.context.tenant for tenant isolation.
 * Integrates with artifactCacheService for durable caching.
 */
@requires: ['authenticated-user']
service DiscoveryService @(path: '/odata/v4/discovery') {

  // ═══════════════════════════════════════════════════════════════════════════
  // ENTITY PROJECTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  @readonly
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
  entity Artifacts as projection on tenant.Artifact {
    *,
    system: redirected to PISystems,
    discoveryJob: redirected to DiscoveryJobs
  } excluding { rawDefinition };

  @readonly
  entity ArtifactDetails as projection on tenant.Artifact;

  @readonly
  entity AuditLogs as projection on tenant.AuditLog;

  @readonly
  entity ArtifactTypes as projection on tenant.ArtifactType;

  @readonly
  entity MigrationLimitations as projection on tenant.MigrationLimitationRef;

  @readonly
  entity ScenarioPatterns as projection on tenant.ScenarioPatternRef;

  @readonly
  entity AdapterMigrations as projection on tenant.AdapterMigrationRef;

  @readonly
  entity ModuleConfigurations as projection on tenant.ModuleConfiguration;

  @readonly
  entity Credentials as projection on tenant.CredentialInventory;

  @readonly
  entity DependencyGraph as projection on tenant.DependencyGraph;

  // ═══════════════════════════════════════════════════════════════════════════
  // DISCOVERY OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start discovery job for a PI/PO system.
   * Runs asynchronously with progress updates via SSE.
   * Discovered artifacts are cached via artifactCacheService.
   */
  action startDiscovery(
    systemId       : UUID,
    includeInactive: Boolean default false,
    includeHistory : Boolean default false,
    artifactTypes  : LargeString             // JSON array or null for all
  ) returns {
    jobId          : UUID;
    status         : String;
    estimatedTime  : Integer;
    message        : String;
  };

  /**
   * Get current discovery progress (polling alternative to SSE).
   */
  function getDiscoveryProgress(jobId: UUID) returns {
    jobId          : UUID;
    status         : String;
    phase          : Integer;
    phaseName      : String;
    progressPercent: Integer;
    artifactsFound : Integer;
    currentItem    : String;
    errors         : LargeString;
    estimatedRemaining: Integer;
  };

  /**
   * Cancel a running discovery job.
   */
  action cancelDiscovery(jobId: UUID) returns {
    success        : Boolean;
    message        : String;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // ARTIFACT OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get discovery summary statistics for a PI/PO system.
   */
  function getDiscoverySummary(systemId: UUID) returns {
    systemName     : String;
    totalArtifacts : Integer;
    byType         : LargeString;          // JSON: { ICO: 50, Channel: 120, ... }
    byTier         : LargeString;          // JSON: { simple: 80, medium: 40, complex: 20 }
    byStatus       : LargeString;          // JSON: { discovered: 100, assessed: 30, approved: 10 }
    estimatedTotalHours: Decimal;
    lastDiscoveryAt: DateTime;
  };

  /**
   * AI-powered artifact assessment.
   * By default runs asynchronously via CAP outbox.
   */
  action assessArtifact(
    artifactId     : UUID,
    async          : Boolean default true
  ) returns {
    artifactId     : UUID;
    status         : String;
    tier           : String;
    complexityScore: Integer;
    recommendedTool: String;
    estimatedHours : Decimal;
    rationale      : String;
    scenarioPattern: String;
    sapMigrationStatus: String;
    matchedTemplate: String;
    limitations    : String;
    limitationCount: Integer;
    hasBlockers    : Boolean;
    message        : String;
  };

  /**
   * Approve artifact for migration.
   */
  action approveArtifact(
    artifactId     : UUID,
    wave           : Integer,
    notes          : LargeString
  ) returns {
    success        : Boolean;
    message        : String;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Emitted when artifact assessment is requested.
   * Processed asynchronously by background runner.
   */
  event AssessmentRequested {
    artifactId     : UUID;
    tenantId       : String(64);
    userId         : String(100);
  };

  /**
   * Emitted for SSE progress updates during discovery.
   * Clients can subscribe to receive real-time progress notifications.
   */
  event DiscoveryProgress {
    tenantId       : String(64);
    jobId          : UUID;
    type           : String(30);       // phase_start | phase_complete | artifact_found | error | discovery_complete
    phase          : Integer;
    phaseName      : String;
    progressPercent: Integer;
    artifactsFound : Integer;
    newArtifacts   : Integer;
    updatedArtifacts: Integer;
    errorsCount    : Integer;
    currentItem    : String;
    timestamp      : DateTime;
  };

  /**
   * Emitted when a discovery job completes (success or failure).
   * Used for UI notifications and email alerts.
   */
  event DiscoveryComplete {
    tenantId       : String(64);
    jobId          : UUID;
    systemId       : UUID;
    systemName     : String;
    status         : String;           // completed | failed | cancelled
    artifactsFound : Integer;
    newArtifacts   : Integer;
    updatedArtifacts: Integer;
    errorsCount    : Integer;
    durationMs     : Integer;
    timestamp      : DateTime;
  };

  /**
   * Emitted when artifact assessment completes.
   */
  event AssessmentComplete {
    tenantId       : String(64);
    artifactId     : UUID;
    tier           : String;
    complexityScore: Integer;
    recommendedTool: String;
    timestamp      : DateTime;
  };
}
