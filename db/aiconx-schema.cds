using { cuid, managed } from '@sap/cds/common';

namespace aiconx;

entity DbActivityLog : cuid, managed {
  logTimestamp   : DateTime;
  source         : String(50);
  query          : String(500);
  status         : String(20);
  duration       : String(10);
  logType        : String(10);  // DB | API | STATE
}

entity SystemMetric : cuid, managed {
  metricKey      : String(50);
  metricValue    : String(100);
}

entity MigrationAsset : cuid, managed {
  assetCode      : String(100);
  name           : String(200);
  assetType      : String(50);
  createdDate    : DateTime;
  lastUsedDate   : DateTime;
  proposedTarget : String(100);
  complexity     : String(20);
  supported      : Boolean default true;
  mode           : String(20);
  size           : String(20);
  projectId      : String(50) default 'Mule2BTP';
}

entity ConductorSession : cuid, managed {
  username       : String(100);
  isActive       : Boolean default true;
  coherence      : Integer default 82;
  dataPoints     : Integer default 0;
  adaptations    : Integer default 0;
}

/**
 * PI/PO Artifact - extracted from PI/PO system via SOAP APIs.
 * Unified model for CommunicationChannels and IntegratedConfigurations.
 * Used for quick extraction and complexity assessment.
 */
entity PipoArtifact : cuid, managed {
  artifactType   : String(50);   // CommunicationChannel | IntegratedConfiguration
  sourceSystem   : String(100);  // PI/PO system identifier
  // Common
  partyId        : String(100);
  componentId    : String(200);
  objectId       : String(200);  // ChannelID or InterfaceName
  namespace      : String(500);
  lastChangedAt  : DateTime;
  changedBy      : String(100);
  // CC-specific
  adapterType    : String(100);
  transportProto : String(50);
  msgProtocol    : String(50);
  direction      : String(20);   // Sender | Receiver
  // ICO-specific
  senderComponent: String(200);
  rcvComponent   : String(200);
  qualityOfSvc   : String(20);   // EO | EOIO | BE
  // Raw XML for full fidelity
  rawXml         : LargeString;
  // Migration fields
  complexity     : String(20);
  complexityScore: Integer;
  proposedTarget : String(200);
  migrationStatus: String(30) default 'Pending';
  projectId      : String(50)  default 'PO2IS';
}
