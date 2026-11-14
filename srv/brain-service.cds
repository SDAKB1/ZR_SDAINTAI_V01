using { brain } from '../db/brain-schema';

service BrainService @(path: '/odata/v4/brain', requires: 'any') {

  entity Events   as projection on brain.BrainEvent   { * };
  entity Insights as projection on brain.BrainInsight { * };
  entity Sessions as projection on brain.BrainSession { * };

  // ── Toggle brain ON / OFF (master key required) ──
  action toggleBrain(key: String, enabled: Boolean) returns {
    success: Boolean;
    message: String;
    state  : Boolean;
  };

  // ── Capture a learning event into the graph ──
  action captureEvent(
    key      : String,
    eventType: String,
    source   : String,
    payload  : String,
    summary  : String,
    sessionId: String
  ) returns {
    eventId  : String;
    category : String;
    insights : Integer;
    message  : String;
  };

  // ── Re-run analysis on unprocessed events → generate insights ──
  action runAnalysis(key: String) returns {
    processed: Integer;
    insights : Integer;
    message  : String;
  };

  // ── Export the full brain state as a portable SDAINTAI Brain Archive ──
  action exportBrain(key: String) returns {
    filename: String;
    data    : String;   // base64-encoded JSON
    size    : Integer;
  };

  // ── Re-import a brain archive (merge) ──
  action importBrain(key: String, data: String) returns {
    success       : Boolean;
    eventsImported: Integer;
    message       : String;
  };

  // ── Status dashboard (read-only, still key-gated) ──
  action getBrainStatus(key: String) returns {
    enabled      : Boolean;
    eventsCount  : Integer;
    insightsCount: Integer;
    coherence    : Integer;
    enabledSince : String;
    vectorCount  : Integer;
    message      : String;
  };

  // ── SAP Migration Advisor — AI-powered object analysis ──
  action migrationAdvisor(
    key         : String,
    objectId    : String,       // e.g. "MATMAS05", "ICO_ORDERS_LEGACY", "ZSD_A01"
    objectDesc  : String,       // human-readable description
    segmentCount: Integer,      // number of IDoc segments or iFlow steps
    hasZFields  : Boolean,      // has custom Z-fields or BADI
    mappingType : String,       // graphical | xslt | java | abap | groovy | none
    adapterType : String,       // idoc | soap | rest | sftp | as2 | jdbc | rfc | jms | custom
    volumePerDay: Integer,      // estimated daily message/record volume
    isBpmProcess: Boolean,      // is it a ccBPM / stateful BPM process?
    isEdiBased  : Boolean,      // involves external EDI trading partner (AS2)?
    sourceSystem: String        // LEGACY_ERP | SAP_PI_PO | SAP_BW | NON_SAP_SAAS
  ) returns {
    objectId         : String;
    objectType       : String;   // classified type
    tier             : String;   // simple | medium | complex
    complexityScore  : Integer;  // 0-100
    recommendedTool  : String;   // BAPI | iFlow_SemiAuto | iFlow_Custom | LangChain_Pattern_C
    specificTool     : String;   // e.g. "BAPI_MATERIAL_SAVEDATA" or "SAP S/4HANA Material Replication"
    estimatedHours   : Integer;
    riskLevel        : String;   // low | medium | high
    waveAssignment   : Integer;  // 1 = first wave, higher = later
    rationale        : String;
    steps            : String;   // JSON array of migration steps
    prereqs          : String;   // JSON array of prerequisites
    message          : String;
  };

  // ── Seed migration knowledge into vector store ──
  action seedMigrationKnowledge(key: String) returns {
    seeded  : Integer;
    message : String;
  };

  // ── Grounded LangGraph + pgvector + Persona-Scoped MCP Agent Chat ──
  action lumiChat(
    sessionId        : String,
    projectId        : String,
    message          : LargeString,
    configuredAgents : LargeString
  ) returns {
    tenantId      : String;
    persona       : String;
    agentName     : String;
    agentDomain   : String;
    vectorBackend : String;
    reply         : LargeString;
    citationsJson : LargeString;
    toolCallsJson : LargeString;
    allowedTools  : array of String;
  };

  action getLumiChatHistory(sessionId : String, projectId : String) returns LargeString;
}
