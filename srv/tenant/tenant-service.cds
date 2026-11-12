using { tenant } from '../db/tenant-schema';

/**
 * Tenant Onboarding Service
 * Handles tenant profile management and discovery triggering
 * per North Star multitenancy flow
 *
 * Uses CAP Native Event Queues (cds.queued) instead of custom outbox.
 * Events are stored in the built-in cds.outbox.Messages table.
 */
service TenantService @(path: '/api/tenant') {

  // ═══════════════════════════════════════════════════════════════════════════
  // TENANT PROFILE - Admin completes after subscription
  // ═══════════════════════════════════════════════════════════════════════════

  entity TenantProfile @(restrict: [{ grant: '*', to: 'TenantAdmin' }]) {
    key tenantId         : String(64);
    organizationName     : String(200) not null;
    adminEmail           : String(200);
    locale               : String(10) default 'en';  // en | fr
    sourceMode           : String(10) default 'MOCK'; // MOCK | LIVE
    destinationName      : String(100);  // BTP Destination for live PI/PO
    status               : String(30) default 'PROFILE_PENDING';
    // SUBSCRIPTION_PENDING | PROVISIONING | TECHNICALLY_READY | PROFILE_PENDING | ACTIVE | FAILED | SUSPENDED | OFFBOARDING | OFFBOARDED
    profileVersion       : Integer default 1;
    createdAt            : DateTime default $now;
    modifiedAt           : DateTime default $now;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DISCOVERY RUN - Tracks PI/PO discovery progress
  // ═══════════════════════════════════════════════════════════════════════════

  entity DiscoveryRun @(restrict: [{ grant: 'READ', to: 'Viewer' }, { grant: '*', to: 'TenantAdmin' }]) {
    key ID               : UUID;
    tenantId             : String(64);
    status               : String(30) default 'PENDING';
    // PENDING | RUNNING | COMPLETED | PARTIAL | FAILED_CONNECTIVITY
    sourceMode           : String(10);  // MOCK | LIVE
    checkpoint           : String(500); // Resume point
    artifactsFound       : Integer default 0;
    artifactsNew         : Integer default 0;
    artifactsUpdated     : Integer default 0;
    errorsCount          : Integer default 0;
    correlationId        : String(50);
    startedAt            : DateTime;
    completedAt          : DateTime;
    errorMessage         : LargeString;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NOTE: Custom OutboxEvent entity REMOVED - Using CAP native cds.outbox.Messages
  // Events are now queued via cds.queued(discoveryService).emit('DiscoveryRequested', {...})
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENTS - Processed asynchronously via CAP Event Queues
  // ═══════════════════════════════════════════════════════════════════════════

  // Discovery request event - triggers async PI/PO discovery
  event DiscoveryRequested {
    tenantId        : String(64);
    runId           : UUID;
    sourceMode      : String(10);
    destinationName : String(100);
    triggeredBy     : String(50);
    timestamp       : DateTime;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  // Submit or update tenant profile (triggers discovery)
  action submitProfile(
    organizationName : String(200),
    locale           : String(10),
    sourceMode       : String(10),
    destinationName  : String(100)
  ) returns TenantProfile;

  // Get tenant readiness status
  function getTenantReadiness() returns {
    tenantId         : String;
    subscriptionStatus : String;
    profileStatus    : String;
    discoveryStatus  : String;
    isReady          : Boolean;
    lastDiscoveryRun : DiscoveryRun;
  };

  // Manually trigger discovery (admin only)
  action triggerDiscovery() returns DiscoveryRun;

  // Switch source mode (MOCK <-> LIVE)
  action switchSourceMode(mode : String(10)) returns TenantProfile;
}
