using { rapdev } from '../db/rap-dev-schema';

// Sibling of Kara HR's kara-orchestrator-service.cds pattern (TDDKARAHR001),
// pointed at RAP/ABAP development instead of HR data extraction. Lumi (or any
// other A2A caller — Joule Agent Studio, another CAP service) never talks to
// the ABAP system directly: it sends a structured order to one of the actions
// below, and this service is the only thing holding the ADT MCP tool access.
service RapDevOrchestratorService @(path: '/odata/v4/rap-dev', requires: 'any') {

  entity Runs as projection on rapdev.RapAgentRuns { * };

  // ── Behavior-implementation generation agent ──
  // Given a behavior definition's declared operations/actions, generates the
  // ABAP handler method bodies (create/update/delete, execute_<action>,
  // validate_<x>, calculate_<x>, save-sequence hooks).
  action generateBehaviorImpl(
    key         : String,
    objectId    : String,   // e.g. "ZI_KARA_EMPLOYEE_360"
    spec        : String,   // JSON: which operations/actions/validations to implement
    requestedBy : String    // "lumi" | developer user ID | calling agent ID
  ) returns {
    runId   : String;
    status  : String;
    message : String;
  };

  // ── CDS/RAP consistency-review agent ──
  // Checks association keys, cardinalities, draft-enablement, and whether a
  // composite view's exposed fields honor the source views' own annotations
  // (e.g. the PA0077-style "deliberately not associated" pattern).
  action reviewConsistency(key: String, objectId: String, requestedBy: String) returns {
    runId   : String;
    status  : String;
    message : String;
  };

  // ── DCL / authorization-review agent ──
  // Checks that every entity behind @AccessControl.authorizationCheck: #CHECK
  // has a matching `define role` DCL object, and flags any that don't.
  action reviewDclCoverage(key: String, objectId: String, requestedBy: String) returns {
    runId   : String;
    status  : String;
    message : String;
  };

  // ── ATC-check agent ──
  // Runs the ABAP Test Cockpit against the object via the ADT MCP tool and
  // returns findings — the automated gate before a generated object is
  // considered done, same role Pattern C plays for financial postings.
  action runAtcCheck(key: String, objectId: String, requestedBy: String) returns {
    runId   : String;
    status  : String;
    findings: String;   // JSON array of ATC findings
    message : String;
  };

  // ── Poll a run's status (UI5 widget / Lumi status queries read this) ──
  action getRunStatus(key: String, runId: String) returns {
    status     : String;
    result     : String;
    message    : String;
  };

  // ── Notify a developer (chat/email advisory loop, same shape as Kara HR's notifyHR) ──
  action notifyDeveloper(key: String, runId: String, message: String) returns {
    success: Boolean;
    message: String;
  };

  // ── Generic capability discovery ──
  // Reads a RAP object's own released service binding ($metadata / behavior
  // definition source) and lists every operation actually callable on it —
  // standard create/update/delete, every declared action, every function.
  // This is the honest boundary: only RELEASED/activated operations are
  // listable or callable — there is no path to an arbitrary private ABAP
  // method, in this design or in ABAP Cloud itself (clean-core release
  // contracts are enforced by the platform, not just a design choice here).
  action discoverRapService(key: String, serviceId: String, requestedBy: String) returns {
    entities  : String;   // JSON array of exposed entity sets
    operations: String;   // JSON array of {entity, name, kind: action|function|create|update|delete, parameters}
    message   : String;
  };

  // ── Generic invoker ──
  // Executes one specific operation returned by discoverRapService above,
  // against the real activated OData service — the actual "call it" step.
  action invokeRapAction(
    key         : String,
    serviceId   : String,
    entity      : String,
    operation   : String,
    keyValues   : String,   // JSON: entity key(s), e.g. {"PersonnelNumber":"00012345"}
    parameters  : String,   // JSON: operation's own input parameters
    requestedBy : String
  ) returns {
    runId  : String;
    result : String;
    message: String;
  };

  // ── The learning advisor ──
  // Given a plain-language developer request ("add a validation that rejects
  // negative basic pay on ZI_CDS_KARA_BASICPAY"), searches the shared Brain
  // vector store for relevant precedent (past runs, seeded RAP patterns),
  // asks Claude which discovered operation(s) address the request, invokes
  // them, then writes the outcome back into the vector store — the same
  // Ingest→Classify→Convert→Learn shape as the platform's migrationAdvisor,
  // applied to day-to-day RAP development requests instead of migration
  // objects.
  action rapDevAdvisor(key: String, request: String, objectId: String, requestedBy: String) returns {
    runId         : String;
    recommendation: String;   // JSON: which operation(s) it chose and why
    result        : String;
    message       : String;
  };

  // ── Seed this domain's own knowledge into the shared Brain vector store ──
  action seedRapDevKnowledge(key: String) returns {
    seeded : Integer;
    message: String;
  };
}
