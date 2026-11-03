using { cuid, managed } from '@sap/cds/common';

namespace rapdev;

// Mirrors brain-schema.cds's BrainEvent / Kara HR's FlowRuns pattern: one row
// per agent invocation, the single source of truth both a future UI5 widget
// and Lumi-style status queries would read from.
entity RapAgentRuns : cuid, managed {
  objectId    : String(90);    // ABAP repository object, e.g. "ZI_KARA_EMPLOYEE_360" or "ZCL_KARA_BEHAVIOR_IMPL"
  objectType  : String(30);    // CDS_VIEW | BEHAVIOR_DEF | BEHAVIOR_IMPL | CLASS | DDLX
  agentType   : String(30);    // BEHAVIOR_GEN | CONSISTENCY_REVIEW | DCL_REVIEW | TEST_GEN | ATC_CHECK
  status      : String(20) default 'SCHEDULED'; // SCHEDULED | RUNNING | DONE | ERROR
  requestedBy : String(60);    // "lumi" | a developer's user ID | another agent's ID (A2A caller)
  input       : LargeString;   // JSON: the spec/prompt/parameters the agent ran with
  result      : LargeString;   // JSON: generated code / findings / ATC results
  message     : String(500);   // human-readable summary, e-mailed/chat-relayed on completion or error
  startedAt   : DateTime;
  completedAt : DateTime;
}
