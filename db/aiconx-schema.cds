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
