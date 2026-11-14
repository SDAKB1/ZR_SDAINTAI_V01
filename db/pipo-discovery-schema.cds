namespace pipo.discovery;

using { cuid, managed } from '@sap/cds/common';

entity DiscoveryRuns : cuid, managed {
  tenantId          : String(64) not null;
  projectId         : String(80) not null;
  systemName        : String(40) not null;
  systemVersion     : String(20);
  address           : String(260);
  subaccount        : String(80);
  locationId        : String(60);
  authType          : String(40);
  proxyType         : String(30);
  status            : String(20) not null; // STAGING | RUNNING | COMPLETED | FAILED | WIPED
  isActive          : Boolean default false;
  nonCancellable    : Boolean default true;
  phase             : String(40);          // tools | endpoints | reads | analyze | embed | commit
  progressPct       : Integer default 0;
  progressMessage   : String(300);
  runDirectory      : String(260);
  manifestSha256    : String(64);
  planRevisionHash  : String(64);
  totalObjects      : Integer default 0;
  verifiedDefs      : Integer default 0;
  esrCount          : Integer default 0;
  dirCount          : Integer default 0;
  channelCount      : Integer default 0;
  icoCount          : Integer default 0;
  mappingCount      : Integer default 0;
  ccBpmCount        : Integer default 0;
  failedEndpoints   : Integer default 0;
  matchedRefs       : Integer default 0;
  unmatchedRefs     : Integer default 0;
  leaseOwner        : String(80);
  leaseExpiresAt    : Timestamp;
  startedAt         : Timestamp;
  completedAt       : Timestamp;
  errorCode         : String(60);
  errorMessage      : String(500);
  summaryJson       : LargeString;
  endpointsJson     : LargeString;
}

entity DiscoveredArtifacts : cuid {
  tenantId          : String(64) not null;
  run               : Association to DiscoveryRuns not null;
  objectId          : String(120) not null;
  sourceArea        : String(20) not null; // ESR | Directory | Metadata | Monitoring
  artifactType      : String(60) not null;
  name              : String(240) not null;
  namespace         : String(260);
  swcv              : String(160);
  adapterType       : String(60);
  direction         : String(20);
  senderComponent   : String(160);
  receiverComponent : String(160);
  verifiedDef       : Boolean default false;
  hasCustomCode     : Boolean default false;
  isCcBpm           : Boolean default false;
  processSteps      : Integer default 0;
  complexityScore   : Integer default 0;
  complexityTier    : String(20);          // Simple | Medium | Complex
  waveNumber        : Integer default 1;   // 1 | 2 | 3
  estimatedHours    : Decimal(6, 1) default 4.0;
  proposedTarget    : String(120);
  metadataJson      : LargeString;
}

entity ArtifactDependencies : cuid {
  tenantId          : String(64) not null;
  run               : Association to DiscoveryRuns not null;
  sourceArtifactId  : String(120) not null;
  sourceName        : String(240);
  referenceKind     : String(60) not null;
  targetType        : String(60);
  targetKey         : String(300) not null;
  matched           : Boolean default false;
}

entity PlanApprovals : cuid, managed {
  tenantId          : String(64) not null;
  projectId         : String(80) not null;
  run               : Association to DiscoveryRuns not null;
  planRevisionHash  : String(64) not null;
  decision          : String(20) not null; // APPROVED | REJECTED | INVALIDATED
  decidedBy         : String(120) not null;
  decidedPersona    : String(30) not null;
  rationale         : String(500);
  decidedAt         : Timestamp not null;
  deployedAt        : Timestamp;
  deployedBy        : String(120);
}

@cds.autoexpose: false
entity ArtifactVectors : cuid {
  tenantId          : String(64) not null;
  runId             : String(36) not null;
  artifactId        : String(120) not null;
  chunkKind         : String(40) not null;
  contentText       : LargeString not null;
  metadataJson      : LargeString;
  embeddingJson     : LargeString not null;
  createdAt         : Timestamp;
}

entity AgentChatMessages : cuid, managed {
  tenantId          : String(64) not null;
  sessionId         : String(80) not null;
  projectId         : String(80);
  role              : String(20) not null; // user | assistant | tool
  persona           : String(20) not null;
  agentName         : String(60);
  content           : LargeString not null;
  citationsJson     : LargeString;
  toolCallsJson     : LargeString;
}
