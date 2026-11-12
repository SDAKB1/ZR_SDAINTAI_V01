using { tenant } from '../../db/tenant-schema';

/**
 * Tenant Service
 *
 * Handles tenant-specific PI/PO system configuration and discovery triggering.
 * Implements tenant isolation via cds.context.tenant.
 *
 * Uses CAP Native Event Queues (cds.queued) for async discovery processing.
 */
service TenantService @(path: '/api/tenant', requires: 'authenticated-user') {

  // ═══════════════════════════════════════════════════════════════════════════
  // ENTITY PROJECTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  @readonly
  entity PISystems as projection on tenant.PISystem {
    ID,
    tenantId,
    systemName,
    description,
    virtualHost,
    virtualPort,
    protocol,
    locationId,
    destinationDir,
    destinationEsr,
    techUser,
    piVersion,
    status,
    lastTestedAt,
    totalArtifacts,
    lastDiscoveryAt
  };

  @readonly
  entity DiscoveryJobs as projection on tenant.DiscoveryJob {
    *
  } excluding { progressLog, errorLog };

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Save or update a PI/PO system configuration.
   * Validates URL format, port range, and required fields.
   * Creates BTP destinations automatically on first save.
   */
  action savePipoSystem(
    systemConfig: {
      systemId       : UUID;            // null for new, ID for update
      systemName     : String(50);      // Required
      description    : String(200);
      virtualHost    : String(200);     // Required - must be valid hostname
      virtualPort    : Integer;         // 1-65535
      protocol       : String(10);      // http | https
      locationId     : String(50);      // Required - Cloud Connector Location ID
      techUser       : String(50);      // Required
      techPassword   : String(100);     // Required for new, optional for update
      piVersion      : String(20);      // 7.31 | 7.40 | 7.50
      autoDiscoveryEnabled: Boolean;    // Toggle auto-discovery after successful test (default: true)
      discoveryOptions: LargeString;    // JSON: default options for auto-discovery
    }
  ) returns tenant.PISystem;

  /**
   * Test connection to a PI/PO system.
   * Verifies Cloud Connector connectivity and PI/PO credentials via DIR and ESR endpoints.
   */
  action testConnection(systemId: UUID) returns {
    success        : Boolean;
    dirStatus      : String;
    esrStatus      : String;
    message        : String;
    piVersion      : String;
    swcvCount      : Integer;
    channelCount   : Integer;
  };

  /**
   * Trigger discovery for a PI/PO system.
   * Creates a DiscoveryJob record and queues async processing via cds.queued().
   */
  action triggerDiscovery(systemId: UUID) returns tenant.DiscoveryJob;

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENTS - Processed asynchronously via CAP Event Queues
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Discovery request event - triggers async PI/PO discovery.
   * Emitted by triggerDiscovery action, processed by DiscoveryService.
   */
  event DiscoveryRequested {
    tenantId        : String(64);
    systemId        : UUID;
    jobId           : UUID;
    options         : LargeString;      // JSON: { includeInactive, includeHistory, artifactTypes[] }
    triggeredBy     : String(100);
    timestamp       : DateTime;
  };
}
