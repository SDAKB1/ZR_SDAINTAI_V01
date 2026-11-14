using { pipo.discovery } from '../db/pipo-discovery-schema';

service PipoCockpitService @(path: '/odata/v4/pipo-cockpit', requires: 'any') {

  action getCurrentPersona() returns {
    tenantId     : String;
    persona      : String;
    userId       : String;
    isProduction : Boolean;
    allowedTools : array of String;
  };

  action verifyConnection(
    systemName    : String,
    systemVersion : String,
    address       : String,
    userId        : String,
    password      : String,
    authType      : String,
    proxyType     : String,
    locationId    : String,
    subaccount    : String,
    projectId     : String
  ) returns {
    connected       : Boolean;
    connectionToken : String;
    formFingerprint : String;
    code            : String;
    field           : String;
    layer           : String;
    userMessage     : String;
    detailsJson     : LargeString;
  };

  action startDiscovery(
    connectionToken : String,
    projectId       : String,
    systemName      : String,
    systemVersion   : String,
    address         : String,
    userId          : String,
    authType        : String,
    proxyType       : String,
    locationId      : String,
    subaccount      : String
  ) returns {
    runId          : String;
    status         : String;
    nonCancellable : Boolean;
    phase          : String;
    progressPct    : Integer;
    message        : String;
  };

  action cancelDiscovery(runId : String) returns {
    cancelled : Boolean;
    message   : String;
  };

  action getDiscoveryStatus(runId : String, projectId : String) returns {
    found           : Boolean;
    runId           : String;
    status          : String;
    isActive        : Boolean;
    nonCancellable  : Boolean;
    phase           : String;
    progressPct     : Integer;
    progressMessage : String;
    totalObjects    : Integer;
    icoCount        : Integer;
    channelCount    : Integer;
    mappingCount    : Integer;
    ccBpmCount      : Integer;
    failedEndpoints : Integer;
    planRevisionHash: String;
    approvalStatus  : String;
    approvedBy      : String;
    errorCode       : String;
    errorMessage    : String;
    completedAt     : Timestamp;
  };

  action getArchitectReport(runId : String, projectId : String, filter : String) returns LargeString;

  action rerunDiscovery(
    connectionToken            : String,
    projectId                  : String,
    systemName                 : String,
    systemVersion              : String,
    address                    : String,
    userId                     : String,
    authType                   : String,
    proxyType                  : String,
    locationId                 : String,
    subaccount                 : String,
    confirmInvalidateApprovals : Boolean
  ) returns {
    confirmationRequired : Boolean;
    hasActiveApproval    : Boolean;
    approvedBy           : String;
    runId                : String;
    status               : String;
    priorRunsWiped       : Integer;
    message              : String;
  };

  action approveWavePlan(projectId : String, runId : String, planRevisionHash : String, rationale : String) returns {
    approved         : Boolean;
    decision         : String;
    decidedBy        : String;
    planRevisionHash : String;
    message          : String;
  };

  action rejectWavePlan(projectId : String, runId : String, planRevisionHash : String, rationale : String) returns {
    approved  : Boolean;
    decision  : String;
    decidedBy : String;
    message   : String;
  };

  action deployApprovedWave(projectId : String, runId : String, waveNumber : Integer, planRevisionHash : String, targetTenant : String) returns {
    deployed   : Boolean;
    waveNumber : Integer;
    approvedBy : String;
    message    : String;
  };

  action semanticSearchArtifacts(query : String, projectId : String, chunkKind : String, topK : Integer) returns LargeString;

  action getCapacityHealth() returns LargeString;
}
