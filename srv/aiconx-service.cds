using { aiconx } from '../db/aiconx-schema';

service AiconxService @(path: '/odata/v4/aiconx') {

  entity DbActivityLogs  as projection on aiconx.DbActivityLog;
  entity SystemMetrics   as projection on aiconx.SystemMetric;
  entity MigrationAssets as projection on aiconx.MigrationAsset;
  entity Sessions        as projection on aiconx.ConductorSession;

  // Simulate a host-app event and persist the log entry
  action simulateEvent(eventType: String) returns DbActivityLogs;

  // Parse and seed mock migration assets for a given platform
  action importBtpAssets(platform: String, mode: String) returns array of MigrationAssets;
}
