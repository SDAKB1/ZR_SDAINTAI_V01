using { cuid, managed } from '@sap/cds/common';

namespace brain;

entity BrainEvent : cuid, managed {
  eventType   : String(50);     // frontend_interaction | backend_call | conversation | app_usage | performance
  category    : String(50);     // auto-classified by LangGraph
  source      : String(150);    // component that emitted the event
  payload     : LargeString;    // raw JSON payload
  summary     : String(500);    // human-readable summary
  embeddingId : String(150);    // reference to vector store entry
  sessionId   : String(100);
  processed   : Boolean default false;
}

entity BrainInsight : cuid, managed {
  insightType   : String(50);   // optimization | bug | scenario | pattern | warning
  title         : String(200);
  description   : LargeString;
  priority      : String(20);   // high | medium | low
  status        : String(20) default 'new';   // new | reviewed | applied | dismissed
  sourceEventIds: LargeString;  // JSON array of BrainEvent IDs
  exportable    : Boolean default true;
}

entity BrainSession : cuid, managed {
  startedAt     : DateTime;
  endedAt       : DateTime;
  eventsCount   : Integer default 0;
  insightsCount : Integer default 0;
  sessionSummary: LargeString;
}

entity BrainConfig : cuid, managed {
  configKey   : String(100);
  configValue : LargeString;
}

// Mirrors the table already deployed to the dedicated AICONX-brain-hana HDI
// container (see mta.yaml) via a one-off `cds deploy` — kept here for schema
// documentation/parity, not wired to the main app's db-deployer. If this
// entity's shape ever changes, re-deploy it to that container the same way
// (a standalone `cds deploy --to hana` using the container's _DT credentials)
// before srv/ai/vectorStore.js's column list is updated to match.
entity BrainVector : cuid, managed {
  content   : LargeString;   // the text that was embedded
  embedding : LargeString;   // JSON-serialized float array
  metadata  : LargeString;   // JSON-serialized {eventType, source, payload, sessionId, ts}
  ts        : Timestamp;
}
