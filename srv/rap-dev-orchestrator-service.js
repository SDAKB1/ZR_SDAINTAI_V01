const cds = require('@sap/cds');
const LOG = cds.log('rap-dev-orchestrator');
const { verifyKey } = require('./ai/brainConfig');
const { getVectorStore } = require('./ai/vectorStore');
const adt = require('./ai/adtMcpClient');

// Seed patterns for this domain — same role MIGRATION_KNOWLEDGE plays in
// brain-service.js: gives the vector store real starting knowledge instead of
// a blank slate. Sourced from real RAP objects already documented in this
// repo's Kara HR TDDs (TDDKARAHR001/002), not invented.
const RAPDEV_KNOWLEDGE = [
  {
    pattern: 'basic interface view, no association',
    note: 'A basic CDS interface view (e.g. ZI_CDS_KARA_WORKTIME) wraps one infotype table 1:1 — no associations at this layer, associations belong on the composite/consumption view.'
  },
  {
    pattern: 'composite/consumption view with restricted field',
    note: 'A field that must never leak into a general-purpose query (e.g. PA0077 diversity data) is deliberately left OUT of the composite view\'s associations, not merely access-controlled — access control alone is not enough if the field is joinable by default.'
  },
  {
    pattern: 'payroll-cluster read',
    note: 'Cluster tables (PCL2-style, e.g. PC2BF/PT_BAL00) are not relational — no CDS view, standard or custom, can read them directly. The correct mechanism is a CDS Custom Entity backed by an ABAP class implementing IF_RAP_QUERY_PROVIDER, which can call the ABAP-layer function modules (CU_READ_RGDIR, PYXX_READ_PAYROLL_RESULT) that a SQLScript/AMDP table function cannot.'
  },
  {
    pattern: 'field-level authorization',
    note: '@AccessControl.authorizationCheck: #CHECK on a view must be paired with a matching DCL `define role` object checking the querying user\'s own PFCG authorization (P_ORGIN structural, P_PERNR infotype-level) — without the DCL object the view silently returns zero rows for everyone, which is the safe failure mode, not a silent bypass.'
  },
  {
    pattern: 'PII field annotation',
    note: '@Semantics.piiCategory + @DataProtection.personalData: true classify a field for SAP ILM tooling — this does NOT encrypt the stored value, encryption is a HANA-layer concern, not a CDS annotation.'
  },
];

async function seed(vs) {
  let count = 0;
  for (const k of RAPDEV_KNOWLEDGE) {
    await vs.add(`${k.pattern}: ${k.note}`, { domain: 'rapdev', kind: 'seed', pattern: k.pattern });
    count++;
  }
  return count;
}

// ── LangGraph advisor: request → search precedent → decide → invoke → learn ──
let _rapDevGraph = null;

async function buildRapDevGraph() {
  if (_rapDevGraph) return _rapDevGraph;
  try {
    const { StateGraph, END } = await import('@langchain/langgraph');
    const { ChatAnthropic } = await import('@langchain/anthropic');
    const model = new ChatAnthropic({ model: 'claude-sonnet-4-6', maxTokens: 1024 });

    async function retrievePrecedentNode(state) {
      const vs = getVectorStore();
      const hits = await vs.search(state.request, 5);
      return { precedent: hits.filter(h => h.metadata?.domain === 'rapdev') };
    }

    async function discoverNode(state) {
      const discovery = await adt.callTool('discoverRapService', { serviceId: state.objectId });
      return { discovery };
    }

    async function decideNode(state) {
      const precedentText = state.precedent.map(p => `- ${p.content} (score ${p.score.toFixed(2)})`).join('\n') || 'none';
      const prompt = `You are the RAP-dev advisor for SDAINTAI's Brain.
Developer request: ${state.request}
Object: ${state.objectId}
Discovered callable operations (JSON, may be empty if not yet wired to a live system): ${JSON.stringify(state.discovery)}
Relevant precedent from past runs/seeded knowledge:
${precedentText}

Reply with a short JSON object: {"chosenOperation": string|null, "rationale": string, "risk": "low"|"medium"|"high"}.
If no discovered operation actually matches, say so honestly in rationale rather than guessing.`;
      const res = await model.invoke([{ role: 'user', content: prompt }]);
      let parsed;
      try { parsed = JSON.parse(res.content.match(/\{[\s\S]*\}/)?.[0] || '{}'); }
      catch { parsed = { chosenOperation: null, rationale: res.content, risk: 'medium' }; }
      return { decision: parsed };
    }

    const graph = new StateGraph({
      channels: { request: null, objectId: null, precedent: null, discovery: null, decision: null },
    });
    graph.addNode('retrievePrecedent', retrievePrecedentNode);
    graph.addNode('discover', discoverNode);
    graph.addNode('decide', decideNode);
    graph.addEdge('retrievePrecedent', 'discover');
    graph.addEdge('discover', 'decide');
    graph.addEdge('decide', END);
    graph.setEntryPoint('retrievePrecedent');

    _rapDevGraph = graph.compile();
    return _rapDevGraph;
  } catch (err) {
    LOG.warn('LangGraph unavailable, no rule-based fallback for this domain yet', { error: err.message });
    return null;
  }
}

async function startRun(Runs, { objectId, objectType, agentType, requestedBy, input }) {
  const [run] = await INSERT.into(Runs).entries({
    objectId, objectType: objectType || '', agentType, requestedBy: requestedBy || 'unknown',
    status: 'RUNNING', input: JSON.stringify(input || {}), startedAt: new Date().toISOString(),
  });
  return run.ID;
}

async function finishRun(Runs, runId, { status, result, message }) {
  await UPDATE(Runs).set({ status, result: JSON.stringify(result ?? null), message, completedAt: new Date().toISOString() }).where({ ID: runId });
}

module.exports = class RapDevOrchestratorService extends cds.ApplicationService {
  async init() {
    const { Runs } = this.entities;

    // ── generateBehaviorImpl ─────────────────────────────────────────────
    this.on('generateBehaviorImpl', async (req) => {
      const { key, objectId, spec, requestedBy } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      const runId = await startRun(Runs, { objectId, objectType: 'BEHAVIOR_IMPL', agentType: 'BEHAVIOR_GEN', requestedBy, input: { spec } });
      try {
        const def = await adt.callTool('getBehaviorDefinition', { objectId });
        await finishRun(Runs, runId, {
          status: def.found ? 'DONE' : 'ERROR', result: def,
          message: def.found ? 'Behavior definition read — generation not yet implemented against a live system' : 'No live ADT connection configured (stub)'
        });
      } catch (err) {
        await finishRun(Runs, runId, { status: 'ERROR', result: { error: err.message }, message: err.message });
      }
      return { runId, status: 'RUNNING', message: 'Generation started' };
    });

    // ── reviewConsistency ────────────────────────────────────────────────
    this.on('reviewConsistency', async (req) => {
      const { key, objectId, requestedBy } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      const runId = await startRun(Runs, { objectId, agentType: 'CONSISTENCY_REVIEW', requestedBy });
      await finishRun(Runs, runId, { status: 'ERROR', result: null, message: 'Not yet wired to a live ADT connection (stub)' });
      return { runId, status: 'RUNNING', message: 'Review started' };
    });

    // ── reviewDclCoverage ────────────────────────────────────────────────
    this.on('reviewDclCoverage', async (req) => {
      const { key, objectId, requestedBy } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      const runId = await startRun(Runs, { objectId, agentType: 'DCL_REVIEW', requestedBy });
      await finishRun(Runs, runId, { status: 'ERROR', result: null, message: 'Not yet wired to a live ADT connection (stub)' });
      return { runId, status: 'RUNNING', message: 'DCL review started' };
    });

    // ── runAtcCheck ──────────────────────────────────────────────────────
    this.on('runAtcCheck', async (req) => {
      const { key, objectId, requestedBy } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      const runId = await startRun(Runs, { objectId, agentType: 'ATC_CHECK', requestedBy });
      const findings = await adt.callTool('runAtcCheck', { objectId });
      await finishRun(Runs, runId, { status: 'DONE', result: findings, message: findings.note });
      return { runId, status: 'DONE', findings: JSON.stringify(findings.findings || []), message: findings.note };
    });

    // ── discoverRapService ───────────────────────────────────────────────
    this.on('discoverRapService', async (req) => {
      const { key, serviceId, requestedBy } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      const runId = await startRun(Runs, { objectId: serviceId, agentType: 'DISCOVERY', requestedBy });
      const discovery = await adt.callTool('discoverRapService', { serviceId });
      await finishRun(Runs, runId, { status: 'DONE', result: discovery, message: discovery.note });
      return { entities: JSON.stringify(discovery.entities || []), operations: JSON.stringify(discovery.operations || []), message: discovery.note };
    });

    // ── invokeRapAction ───────────────────────────────────────────────────
    this.on('invokeRapAction', async (req) => {
      const { key, serviceId, entity, operation, keyValues, parameters, requestedBy } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      const runId = await startRun(Runs, { objectId: serviceId, agentType: 'INVOKE', requestedBy, input: { entity, operation, keyValues, parameters } });
      const outcome = await adt.callTool('invokeRapAction', { serviceId, entity, operation, keyValues, parameters });
      await finishRun(Runs, runId, { status: outcome.result != null ? 'DONE' : 'ERROR', result: outcome, message: outcome.note });

      // Learn from the outcome regardless of success — a failed/stubbed call
      // is still precedent worth retrieving next time the same operation is asked for.
      const vs = getVectorStore();
      await vs.add(`invoked ${operation} on ${entity} (${serviceId}): ${outcome.note}`,
        { domain: 'rapdev', kind: 'run-outcome', serviceId, entity, operation });

      return { runId, result: JSON.stringify(outcome.result), message: outcome.note };
    });

    // ── rapDevAdvisor ─────────────────────────────────────────────────────
    this.on('rapDevAdvisor', async (req) => {
      const { key, request, objectId, requestedBy } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      const runId = await startRun(Runs, { objectId, agentType: 'ADVISOR', requestedBy, input: { request } });

      const graph = await buildRapDevGraph();
      if (!graph) {
        await finishRun(Runs, runId, { status: 'ERROR', result: null, message: 'LangGraph pipeline unavailable' });
        return { runId, recommendation: '{}', result: '{}', message: 'LangGraph pipeline unavailable' };
      }

      const outcome = await graph.invoke({ request, objectId });
      const vs = getVectorStore();
      await vs.add(`request "${request}" on ${objectId} → ${JSON.stringify(outcome.decision)}`,
        { domain: 'rapdev', kind: 'advisor-decision', objectId });

      await finishRun(Runs, runId, { status: 'DONE', result: outcome.decision, message: outcome.decision?.rationale || '' });
      return {
        runId,
        recommendation: JSON.stringify(outcome.decision),
        result: JSON.stringify(outcome.discovery),
        message: outcome.decision?.rationale || 'No confident recommendation',
      };
    });

    // ── getRunStatus ─────────────────────────────────────────────────────
    this.on('getRunStatus', async (req) => {
      const { key, runId } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      const run = await SELECT.one.from(Runs).where({ ID: runId });
      if (!run) return { status: 'NOT_FOUND', result: '', message: 'No such run' };
      return { status: run.status, result: run.result || '', message: run.message || '' };
    });

    // ── notifyDeveloper ──────────────────────────────────────────────────
    this.on('notifyDeveloper', async (req) => {
      const { key, runId, message } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      await UPDATE(Runs).set({ message }).where({ ID: runId });
      // Real mail delivery (SMTP or a mail-adapter step) is intentionally not
      // implemented here — this action's job is to log the advisory; wiring
      // it to an actual outbound channel is the same pattern already used by
      // brain-service.js's captureEvent, kept as a follow-up, not invented.
      return { success: true, message: `Logged: ${message}` };
    });

    // ── seedRapDevKnowledge ──────────────────────────────────────────────
    this.on('seedRapDevKnowledge', async (req) => {
      const { key } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      const vs = getVectorStore();
      const seeded = await seed(vs);
      return { seeded, message: `Seeded ${seeded} RAP-dev knowledge patterns into the shared Brain vector store` };
    });

    return super.init();
  }
};
