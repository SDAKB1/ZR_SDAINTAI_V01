using { aiconx } from '../db/aiconx-schema';

service AiconxService @(path: '/odata/v4/aiconx') {

  entity DbActivityLogs  as projection on aiconx.DbActivityLog;
  entity SystemMetrics   as projection on aiconx.SystemMetric;
  entity MigrationAssets as projection on aiconx.MigrationAsset;
  entity Sessions        as projection on aiconx.ConductorSession;
  entity PipoArtifacts   as projection on aiconx.PipoArtifact;

  // Import all PI/PO artifacts from the connected PI/PO system via BTP Destination
  action importPipoArtifacts(
    destination: String,    // BTP Destination name (e.g. 'PO_PJ2_DIR')
    sourceSystem: String,   // Source system identifier (e.g. 'PJ2_PI')
    projectId: String       // Project ID for grouping (e.g. 'PO2IS')
  ) returns array of PipoArtifacts;

  // Simulate a host-app event and persist the log entry
  action simulateEvent(eventType: String) returns DbActivityLogs;

  // Parse and seed mock migration assets for a given platform
  action importBtpAssets(platform: String, mode: String) returns array of MigrationAssets;
}
