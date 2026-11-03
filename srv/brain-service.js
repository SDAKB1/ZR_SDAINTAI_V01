const cds = require('@sap/cds');
const { verifyKey, readState, writeState, isBrainEnabled } = require('./ai/brainConfig');
const { getVectorStore } = require('./ai/vectorStore');

// ── SAP Migration knowledge base (seeded into vector store) ──────────────────
const MIGRATION_KNOWLEDGE = [
  // Master Data — Simple
  { id: 'GLMAST',  desc: 'GL Account Master',      tier: 'simple',  tool: 'BAPI_GL_ACC_SAVE',                   hours: 4,  adapterType: 'idoc',  segmentCount: 5,  hasZFields: false },
  { id: 'COSMAS',  desc: 'Cost Center Master',      tier: 'simple',  tool: 'BAPI_COSTCENTER_CREATEMULTIPLE',     hours: 4,  adapterType: 'idoc',  segmentCount: 6,  hasZFields: false },
  { id: 'PRMAS',   desc: 'Profit Center Master',    tier: 'simple',  tool: 'BAPI_PROFITCENTER_CREATE',           hours: 4,  adapterType: 'idoc',  segmentCount: 5,  hasZFields: false },
  { id: 'DEBMAS',  desc: 'Customer Master',         tier: 'simple',  tool: 'BAPI_CUSTOMER_CREATEFROMDATA1',      hours: 12, adapterType: 'idoc',  segmentCount: 15, hasZFields: false },
  { id: 'CREMAS',  desc: 'Vendor/Supplier Master',  tier: 'simple',  tool: 'BAPI_VENDOR_CREATEFROMDATA',         hours: 12, adapterType: 'idoc',  segmentCount: 12, hasZFields: false },
  // Master Data — Medium
  { id: 'MATMAS',  desc: 'Material Master',         tier: 'medium',  tool: 'iFlow_SAP_Material_Replication',    hours: 20, adapterType: 'idoc',  segmentCount: 38, hasZFields: true  },
  { id: 'BPMAS',   desc: 'Business Partner',        tier: 'medium',  tool: 'iFlow_SAP_BP_Replication',          hours: 24, adapterType: 'soap',  segmentCount: 20, hasZFields: true  },
  { id: 'KNVK',    desc: 'Customer Contact Master', tier: 'medium',  tool: 'iFlow_Customer_Replication',        hours: 10, adapterType: 'idoc',  segmentCount: 8,  hasZFields: true  },
  // Master Data — Complex
  { id: 'HRMAS',   desc: 'HR Master Data',          tier: 'complex', tool: 'iFlow_SuccessFactors_Replication',  hours: 60, adapterType: 'idoc',  segmentCount: 55, hasZFields: true  },
  { id: 'ARTMAS',  desc: 'Retail Article Master',   tier: 'complex', tool: 'iFlow_Custom_ARTMAS',               hours: 80, adapterType: 'idoc',  segmentCount: 65, hasZFields: true  },
  // Transactional — Medium
  { id: 'ORDERS05',desc: 'Purchase Order',          tier: 'medium',  tool: 'iFlow_Ariba_S4_Integration',        hours: 24, adapterType: 'idoc',  segmentCount: 22, hasZFields: false },
  { id: 'ORDCHG',  desc: 'PO Change',               tier: 'medium',  tool: 'iFlow_Ariba_S4_Integration',        hours: 16, adapterType: 'idoc',  segmentCount: 18, hasZFields: false },
  { id: 'ORDRSP',  desc: 'Order Confirmation',      tier: 'medium',  tool: 'iFlow_Ariba_S4_Integration',        hours: 16, adapterType: 'idoc',  segmentCount: 15, hasZFields: false },
  { id: 'DESADV',  desc: 'Delivery Note/ASN',       tier: 'medium',  tool: 'iFlow_SAP_WMS_Integration',         hours: 20, adapterType: 'idoc',  segmentCount: 20, hasZFields: false },
  { id: 'WMMBXY',  desc: 'Goods Movement',          tier: 'medium',  tool: 'iFlow_SAP_WMS_Integration',         hours: 18, adapterType: 'idoc',  segmentCount: 12, hasZFields: false },
  // Transactional — Complex
  { id: 'INVOIC02',desc: 'Invoice',                 tier: 'complex', tool: 'iFlow_Custom_Finance_INVOIC',       hours: 60, adapterType: 'as2',   segmentCount: 45, hasZFields: true  },
  { id: 'SHPMNT04',desc: 'Shipment',                tier: 'complex', tool: 'iFlow_Custom_Logistics_SHPMNT',     hours: 50, adapterType: 'idoc',  segmentCount: 40, hasZFields: true  },
  { id: 'FIDCCP02',desc: 'FI Document',             tier: 'complex', tool: 'iFlow_Custom_Finance_FIDCCP',       hours: 80, adapterType: 'rest',  segmentCount: 50, hasZFields: true  },
  { id: 'PEXR2003',desc: 'Payment Advice',          tier: 'complex', tool: 'iFlow_Custom_Finance_PEXR',         hours: 60, adapterType: 'as2',   segmentCount: 35, hasZFields: true  },
];

// BAPI lookup for simple objects
const BAPI_MAP = {
  GLMAST: 'BAPI_GL_ACC_SAVE', COSMAS: 'BAPI_COSTCENTER_CREATEMULTIPLE',
  PRMAS:  'BAPI_PROFITCENTER_CREATE', DEBMAS: 'BAPI_CUSTOMER_CREATEFROMDATA1',
  CREMAS: 'BAPI_VENDOR_CREATEFROMDATA', MATMAS: 'BAPI_MATERIAL_SAVEDATA',
};

// SAP Business Accelerator Hub package lookup
const HUB_PACKAGE_MAP = {
  MATMAS: 'SAP S/4HANA Material Replication', DEBMAS: 'SAP Customer Master Replication',
  CREMAS: 'SAP Vendor Master Replication',    HRMAS:  'SAP SuccessFactors Employee Central',
  ORDERS05: 'SAP S/4HANA ↔ Ariba Integration', INVOIC02: 'SAP S/4HANA Finance Integration',
  DESADV: 'SAP S/4HANA ↔ 3rd Party WMS',      WMMBXY: 'SAP S/4HANA ↔ 3rd Party WMS',
  FIDCCP02: 'SAP S/4HANA Finance Integration', BPMAS: 'SAP BP Replication Add-On',
};

// ── LangGraph Migration Advisor pipeline ─────────────────────────────────────
let _migrationGraph = null;

async function buildMigrationGraph() {
  if (_migrationGraph) return _migrationGraph;
  try {
    const { StateGraph, END } = await import('@langchain/langgraph');
    const { ChatAnthropic }   = await import('@langchain/anthropic');

    const model = new ChatAnthropic({ model: 'claude-sonnet-4-6', maxTokens: 1024 });

    // Node 1: Classify the SAP object type
    async function classifyObjectNode(state) {
      const { input } = state;
      const prompt = `You are an expert SAP Enterprise Architect with 20+ years experience.
Classify this SAP object into ONE category:
MASTER_DATA_MATMAS | MASTER_DATA_DEBMAS | MASTER_DATA_CREMAS |
MASTER_DATA_HR | MASTER_DATA_FI | MASTER_DATA_CO |
TRANSACTIONAL_PROCUREMENT | TRANSACTIONAL_LOGISTICS |
TRANSACTIONAL_FINANCE | TRANSACTIONAL_WAREHOUSE |
INTEGRATION_FLOW_SIMPLE | INTEGRATION_FLOW_MEDIUM | INTEGRATION_FLOW_COMPLEX |
ANALYTICS_BW_CUBE | ANALYTICS_BW_ODS | ANALYTICS_BW_MASTERDATA | ANALYTICS_BW_HIERARCHY |
UNKNOWN

Object ID: ${input.objectId}
Description: ${input.objectDesc}
Source system: ${input.sourceSystem}
Adapter type: ${input.adapterType}
Is BPM process: ${input.isBpmProcess}

Reply with just the category name.`;
      const res = await model.invoke([{ role: 'user', content: prompt }]);
      return { objectType: res.content.trim() };
    }

    // Node 2: Score complexity (rule-based + AI refinement)
    async function scoreComplexityNode(state) {
      const { input, objectType } = state;
      // Rule-based scoring dimensions
      let score = 0;
      score += input.segmentCount > 15 ? 6 : input.segmentCount > 5 ? 3 : 1;
      score += input.hasZFields ? 4 : 0;
      score += input.mappingType === 'java' || input.mappingType === 'abap' ? 6
             : input.mappingType === 'xslt' ? 3 : 0;
      score += input.volumePerDay > 100000 ? 6 : input.volumePerDay > 10000 ? 3 : 0;
      score += input.adapterType === 'as2' || input.adapterType === 'jms' || input.adapterType === 'custom' ? 6
             : input.adapterType === 'jdbc' || input.adapterType === 'rfc' ? 3 : 0;
      score += input.isEdiBased ? 4 : 0;
      score += input.isBpmProcess ? 10 : 0;
      // Finance/HR always elevated
      if (objectType && (objectType.includes('_FI') || objectType.includes('_HR'))) score += 3;

      const tier = score <= 8 ? 'simple' : score <= 18 ? 'medium' : 'complex';
      const complexityScore = Math.min(100, Math.round((score / 30) * 100));
      return { tier, complexityScore };
    }

    // Node 3: Recommend the best migration tool
    async function recommendToolNode(state) {
      const { input, tier, objectType } = state;
      const { objectId } = input;
      const idUpper = (objectId || '').toUpperCase();

      let recommendedTool, specificTool;

      if (tier === 'simple') {
        recommendedTool = 'BAPI';
        specificTool = BAPI_MAP[idUpper] || `BAPI_${idUpper}_SAVE`;
      } else if (tier === 'medium') {
        const hubPkg = HUB_PACKAGE_MAP[idUpper];
        recommendedTool = hubPkg ? 'iFlow_SemiAuto' : 'iFlow_Custom';
        specificTool = hubPkg || `Custom iFlow: ${idUpper}_MIGRATION`;
      } else {
        // Complex — check if AI pattern applies
        if (objectType && (objectType.includes('_FI') || objectType.includes('_HR'))) {
          recommendedTool = 'LangChain_Pattern_C';
          specificTool = `AI-Augmented iFlow: SDAINTAI validates & routes ${idUpper} with confidence scoring`;
        } else {
          recommendedTool = 'iFlow_Custom';
          specificTool = HUB_PACKAGE_MAP[idUpper] || `Custom iFlow: ${idUpper}_MIGRATION (full rebuild)`;
        }
      }
      return { recommendedTool, specificTool };
    }

    // Node 4: Estimate effort and wave assignment
    async function estimateEffortNode(state) {
      const { input, tier, complexityScore } = state;
      const known = MIGRATION_KNOWLEDGE.find(k => k.id === (input.objectId || '').toUpperCase());
      let estimatedHours = known
        ? known.hours
        : tier === 'simple' ? 4 + (input.segmentCount * 0.3)
        : tier === 'medium' ? 16 + (input.segmentCount * 0.5) + (input.hasZFields ? 8 : 0)
        : 60 + (input.segmentCount * 0.8) + (input.isEdiBased ? 20 : 0) + (input.isBpmProcess ? 40 : 0);

      estimatedHours = Math.round(estimatedHours);
      const riskLevel = tier === 'simple' ? 'low' : tier === 'medium' ? 'medium' : 'high';
      const waveAssignment = tier === 'simple' ? 1 : tier === 'medium' ? 2 : 3;
      return { estimatedHours, riskLevel, waveAssignment };
    }

    // Node 5: Generate the migration plan with rationale
    async function buildPlanNode(state) {
      const { input, objectType, tier, recommendedTool, specificTool, estimatedHours, riskLevel, waveAssignment } = state;
      const prompt = `You are an SAP Enterprise Architect building a migration plan.

Object: ${input.objectId} — ${input.objectDesc}
Type: ${objectType} | Tier: ${tier} | Tool: ${recommendedTool} (${specificTool})
Segments: ${input.segmentCount} | Z-Fields: ${input.hasZFields} | Volume/day: ${input.volumePerDay}
Adapter: ${input.adapterType} | Mapping: ${input.mappingType} | BPM: ${input.isBpmProcess} | EDI: ${input.isEdiBased}
Estimated: ${estimatedHours} hours | Risk: ${riskLevel} | Wave: ${waveAssignment}

Generate a JSON object with these exact keys:
{
  "rationale": "2-3 sentence explanation of why this tier and tool were chosen",
  "steps": ["step1", "step2", "step3", "step4", "step5"],
  "prereqs": ["prereq1", "prereq2"]
}
Reply with valid JSON only.`;

      const res = await model.invoke([{ role: 'user', content: prompt }]);
      try {
        const plan = JSON.parse(res.content.trim());
        return {
          rationale: plan.rationale || '',
          steps: JSON.stringify(plan.steps || []),
          prereqs: JSON.stringify(plan.prereqs || []),
        };
      } catch {
        return {
          rationale: `${tier} complexity object — recommended ${recommendedTool} approach based on ${input.segmentCount} segments and adapter type ${input.adapterType}.`,
          steps: JSON.stringify(['Assess source system', 'Configure adapter', 'Build/configure mapping', 'Test with sample data', 'Deploy and monitor']),
          prereqs: JSON.stringify(['IS tenant configured', 'RFC destination to S/4', 'Source system credentials']),
        };
      }
    }

    const graph = new StateGraph({
      channels: {
        input:           { value: (x, y) => y ?? x, default: () => ({}) },
        objectType:      { value: (x, y) => y ?? x, default: () => '' },
        tier:            { value: (x, y) => y ?? x, default: () => 'medium' },
        complexityScore: { value: (x, y) => y ?? x, default: () => 0 },
        recommendedTool: { value: (x, y) => y ?? x, default: () => '' },
        specificTool:    { value: (x, y) => y ?? x, default: () => '' },
        estimatedHours:  { value: (x, y) => y ?? x, default: () => 0 },
        riskLevel:       { value: (x, y) => y ?? x, default: () => 'medium' },
        waveAssignment:  { value: (x, y) => y ?? x, default: () => 2 },
        rationale:       { value: (x, y) => y ?? x, default: () => '' },
        steps:           { value: (x, y) => y ?? x, default: () => '[]' },
        prereqs:         { value: (x, y) => y ?? x, default: () => '[]' },
      },
    });

    graph.addNode('classifyObject',  classifyObjectNode);
    graph.addNode('scoreComplexity', scoreComplexityNode);
    graph.addNode('recommendTool',   recommendToolNode);
    graph.addNode('estimateEffort',  estimateEffortNode);
    graph.addNode('buildPlan',       buildPlanNode);

    graph.addEdge('classifyObject',  'scoreComplexity');
    graph.addEdge('scoreComplexity', 'recommendTool');
    graph.addEdge('recommendTool',   'estimateEffort');
    graph.addEdge('estimateEffort',  'buildPlan');
    graph.addEdge('buildPlan',       END);
    graph.setEntryPoint('classifyObject');

    _migrationGraph = graph.compile();
    return _migrationGraph;
  } catch (err) {
    console.warn('[Brain] Migration graph unavailable, using rule-based fallback:', err.message);
    return null;
  }
}

// Rule-based migration fallback (no LLM needed)
function ruleMigrationAdvisor(input) {
  const idUpper = (input.objectId || '').toUpperCase();
  const known = MIGRATION_KNOWLEDGE.find(k => k.id === idUpper);
  const tier = known ? known.tier : input.isBpmProcess ? 'complex'
    : input.adapterType === 'as2' || input.adapterType === 'custom' ? 'complex'
    : (input.segmentCount > 15 || input.hasZFields) ? 'medium' : 'simple';

  const recommendedTool = tier === 'simple' ? 'BAPI' : tier === 'medium' ? 'iFlow_SemiAuto' : 'iFlow_Custom';
  const specificTool = tier === 'simple' ? (BAPI_MAP[idUpper] || 'BAPI_SAVE')
    : (HUB_PACKAGE_MAP[idUpper] || `Custom iFlow: ${idUpper}_MIGRATION`);
  const estimatedHours = known ? known.hours
    : tier === 'simple' ? 6 : tier === 'medium' ? 20 : 60;

  return {
    objectType: known ? `MASTER_DATA_${idUpper}` : 'UNKNOWN',
    tier, complexityScore: tier === 'simple' ? 20 : tier === 'medium' ? 55 : 85,
    recommendedTool, specificTool, estimatedHours,
    riskLevel: tier === 'simple' ? 'low' : tier === 'medium' ? 'medium' : 'high',
    waveAssignment: tier === 'simple' ? 1 : tier === 'medium' ? 2 : 3,
    rationale: `Rule-based assessment: ${tier} complexity for ${idUpper} based on ${input.segmentCount} segments, adapter=${input.adapterType}, z-fields=${input.hasZFields}.`,
    steps: JSON.stringify(['Assess source', 'Configure adapter', 'Build mapping', 'Test', 'Deploy']),
    prereqs: JSON.stringify(['IS tenant', 'RFC destination', 'Source credentials']),
  };
}

// ── LangGraph analysis pipeline ───────────────────────────────────────────────
let _graph = null;

async function buildGraph() {
  if (_graph) return _graph;
  try {
    const { StateGraph, END } = await import('@langchain/langgraph');
    const { ChatAnthropic } = await import('@langchain/anthropic');

    const model = new ChatAnthropic({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 512,
    });

    // Node: classify an event into a category
    async function classifyNode(state) {
      const { event } = state;
      const prompt = `Classify this application event into ONE category from:
frontend_interaction | backend_call | conversation | app_usage | performance | security | error

Event type: ${event.eventType}
Source: ${event.source}
Summary: ${event.summary}
Payload (truncated): ${(event.payload || '').slice(0, 300)}

Reply with just the category name, nothing else.`;

      const res = await model.invoke([{ role: 'user', content: prompt }]);
      return { category: res.content.trim().toLowerCase() };
    }

    // Node: generate an insight from an event
    async function insightNode(state) {
      const { event, category } = state;
      const prompt = `You are an AI system observing a SAP CAP application called SDAINTAI (AI Connectivity platform).
An event was captured:
  Category  : ${category}
  Type      : ${event.eventType}
  Source    : ${event.source}
  Summary   : ${event.summary}

Generate a concise JSON insight with these exact keys:
{
  "insightType": "optimization | bug | scenario | pattern | warning",
  "title": "short title (max 80 chars)",
  "description": "1-2 sentence description",
  "priority": "high | medium | low"
}
Reply with valid JSON only.`;

      const res = await model.invoke([{ role: 'user', content: prompt }]);
      try {
        const json = JSON.parse(res.content.trim());
        return { insight: json };
      } catch {
        return { insight: null };
      }
    }

    const graph = new StateGraph({
      channels: {
        event:    { value: (x, y) => y ?? x, default: () => null },
        category: { value: (x, y) => y ?? x, default: () => '' },
        insight:  { value: (x, y) => y ?? x, default: () => null },
      },
    });

    graph.addNode('classify', classifyNode);
    graph.addNode('insight',  insightNode);
    graph.addEdge('classify', 'insight');
    graph.addEdge('insight',  END);
    graph.setEntryPoint('classify');

    _graph = graph.compile();
    return _graph;
  } catch (err) {
    // If Anthropic key missing or langgraph unavailable, fall back to rule-based
    console.warn('[Brain] LangGraph unavailable, using rule-based fallback:', err.message);
    return null;
  }
}

// Rule-based fallback when LLM is not available
function classifyRuleBased(eventType) {
  const map = {
    click: 'frontend_interaction', navigation: 'frontend_interaction', input: 'frontend_interaction',
    api_call: 'backend_call', db_query: 'backend_call', odata: 'backend_call',
    chat: 'conversation', message: 'conversation',
    login: 'app_usage', logout: 'app_usage', feature: 'app_usage',
    latency: 'performance', memory: 'performance', cpu: 'performance',
    error: 'error', exception: 'error',
  };
  const lower = (eventType || '').toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (lower.includes(k)) return v;
  }
  return 'app_usage';
}

// ── Service implementation ────────────────────────────────────────────────────
module.exports = class BrainService extends cds.ApplicationService {
  async init() {
    const { Events, Insights, Sessions } = this.entities;

    // ── toggleBrain ──────────────────────────────────────────────────────────
    this.on('toggleBrain', async (req) => {
      const { key, enabled } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      const state = writeState(enabled);
      return {
        success: true,
        message: enabled ? 'Brain activated' : 'Brain deactivated',
        state:   state.enabled,
      };
    });

    // ── captureEvent ─────────────────────────────────────────────────────────
    this.on('captureEvent', async (req) => {
      const { key, eventType, source, payload, summary, sessionId } = req.data;
      if (!verifyKey(key))    return req.error(403, 'Invalid master key');
      if (!isBrainEnabled()) return req.error(400, 'Brain is not enabled');

      const vs = getVectorStore();
      const embeddingId = await vs.add(`${eventType} ${source} ${summary}`, { eventType, source, payload, sessionId, ts: new Date().toISOString() });

      // The vector store (local file, always available) is the source of truth
      // for this action's success — the DB row is a nice-to-have for the OData
      // Events/Insights entities, not a hard dependency. Without this, a HANA
      // connection-pool hiccup (seen in this environment: generic-pool
      // TimeoutError on the shared HDI container) turned every capture into a
      // 500, silently losing the vector write too since the whole handler threw
      // before returning. Degrading gracefully means capture still "works" and
      // is searchable even when the DB row never lands.
      let eventRecord = null;
      try {
        eventRecord = await INSERT.into(Events).entries({
          eventType,
          source: source || 'unknown',
          payload: payload || '{}',
          summary: summary || '',
          embeddingId,
          sessionId: sessionId || '',
          processed: false,
        });
      } catch (err) {
        console.error('[Brain] Events insert failed, continuing on vector store alone:', err.message);
      }

      // Run LangGraph analysis inline (best-effort)
      let category = classifyRuleBased(eventType);
      let insights = 0;

      try {
        const graph = await buildGraph();
        const eventObj = { eventType, source, payload, summary };

        if (graph) {
          const result = await graph.invoke({ event: eventObj });
          category = result.category || category;

          if (result.insight) {
            const eventId = eventRecord?.req?.data?.ID || eventRecord?.[0]?.ID || embeddingId;
            try {
              await INSERT.into(Insights).entries({
                insightType:    result.insight.insightType || 'pattern',
                title:          result.insight.title || 'Untitled insight',
                description:    result.insight.description || '',
                priority:       result.insight.priority || 'medium',
                status:         'new',
                sourceEventIds: JSON.stringify([eventId]),
                exportable:     true,
              });
              insights = 1;
            } catch (err) {
              console.error('[Brain] Insights insert failed:', err.message);
            }
          }
        }

        // Update category on the event (best-effort)
        if (eventRecord?.[0]?.ID) {
          await UPDATE(Events).set({ category }).where({ ID: eventRecord[0].ID });
        }
      } catch (err) {
        console.error('[Brain] Analysis error:', err.message);
      }

      return {
        eventId:  eventRecord?.[0]?.ID || embeddingId,
        category,
        insights,
        message:  eventRecord ? 'Event captured' : 'Event captured (vector store only — DB unavailable)',
      };
    });

    // ── runAnalysis ──────────────────────────────────────────────────────────
    this.on('runAnalysis', async (req) => {
      const { key } = req.data;
      if (!verifyKey(key))    return req.error(403, 'Invalid master key');
      if (!isBrainEnabled()) return req.error(400, 'Brain is not enabled');

      const { Events, Insights } = this.entities;
      const unprocessed = await SELECT.from(Events).where({ processed: false });
      if (!unprocessed.length) return { processed: 0, insights: 0, message: 'No unprocessed events' };

      let insightsGenerated = 0;

      try {
        const graph = await buildGraph();

        for (const event of unprocessed) {
          let category = classifyRuleBased(event.eventType);
          let insight  = null;

          if (graph) {
            const result = await graph.invoke({ event });
            category = result.category || category;
            insight  = result.insight;
          }

          await UPDATE(Events).set({ processed: true, category }).where({ ID: event.ID });

          if (insight) {
            await INSERT.into(Insights).entries({
              insightType:    insight.insightType || 'pattern',
              title:          insight.title || 'Untitled insight',
              description:    insight.description || '',
              priority:       insight.priority || 'medium',
              status:         'new',
              sourceEventIds: JSON.stringify([event.ID]),
              exportable:     true,
            });
            insightsGenerated++;
          }
        }
      } catch (err) {
        console.error('[Brain] runAnalysis error:', err.message);
      }

      return {
        processed: unprocessed.length,
        insights:  insightsGenerated,
        message:   `Processed ${unprocessed.length} events, generated ${insightsGenerated} insights`,
      };
    });

    // ── getBrainStatus ───────────────────────────────────────────────────────
    this.on('getBrainStatus', async (req) => {
      const { key } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      const state        = readState();
      const vs           = getVectorStore();
      // Same DB-optional posture as captureEvent — a HANA hiccup shouldn't make
      // the status dashboard itself unreachable; fall back to 0 and let
      // vectorCount (always available) carry the real signal.
      let eventsCount = 0, insightsCount = 0;
      try { eventsCount = (await SELECT.from(Events).columns('count(*) as n'))[0]?.n || 0; } catch (err) { console.error('[Brain] Events count failed:', err.message); }
      try { insightsCount = (await SELECT.from(Insights).columns('count(*) as n'))[0]?.n || 0; } catch (err) { console.error('[Brain] Insights count failed:', err.message); }
      const vectorCount = await vs.count();

      return {
        enabled:       state.enabled,
        eventsCount:   Number(eventsCount),
        insightsCount: Number(insightsCount),
        coherence:     Math.min(100, Math.floor((vectorCount / (Number(eventsCount) || 1)) * 100)),
        enabledSince:  state.enabledAt || '',
        vectorCount,
        message:       state.enabled ? 'Brain is active' : 'Brain is inactive',
      };
    });

    // ── exportBrain ──────────────────────────────────────────────────────────
    this.on('exportBrain', async (req) => {
      const { key } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      const vs       = getVectorStore();
      const events   = await SELECT.from(Events);
      const insights = await SELECT.from(Insights);
      const sessions = await SELECT.from(Sessions);

      const archive = {
        version:   '1.0',
        exportedAt: new Date().toISOString(),
        events,
        insights,
        sessions,
        vectors: await vs.getAll(),
      };

      const json = JSON.stringify(archive);
      const b64  = Buffer.from(json).toString('base64');
      const filename = `brain-export-${Date.now()}.sdab`;

      return { filename, data: b64, size: json.length };
    });

    // ── migrationAdvisor ─────────────────────────────────────────────────────
    this.on('migrationAdvisor', async (req) => {
      const {
        key, objectId, objectDesc, segmentCount, hasZFields,
        mappingType, adapterType, volumePerDay, isBpmProcess, isEdiBased, sourceSystem,
      } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      const input = {
        objectId: objectId || '',
        objectDesc: objectDesc || '',
        segmentCount: segmentCount || 0,
        hasZFields: hasZFields || false,
        mappingType: (mappingType || 'graphical').toLowerCase(),
        adapterType: (adapterType || 'idoc').toLowerCase(),
        volumePerDay: volumePerDay || 0,
        isBpmProcess: isBpmProcess || false,
        isEdiBased: isEdiBased || false,
        sourceSystem: sourceSystem || 'LEGACY_ERP',
      };

      let result = ruleMigrationAdvisor(input);

      try {
        const graph = await buildMigrationGraph();
        if (graph) {
          const graphResult = await graph.invoke({ input });
          result = {
            objectType:       graphResult.objectType      || result.objectType,
            tier:             graphResult.tier            || result.tier,
            complexityScore:  graphResult.complexityScore ?? result.complexityScore,
            recommendedTool:  graphResult.recommendedTool || result.recommendedTool,
            specificTool:     graphResult.specificTool    || result.specificTool,
            estimatedHours:   graphResult.estimatedHours  ?? result.estimatedHours,
            riskLevel:        graphResult.riskLevel       || result.riskLevel,
            waveAssignment:   graphResult.waveAssignment  ?? result.waveAssignment,
            rationale:        graphResult.rationale       || result.rationale,
            steps:            graphResult.steps           || result.steps,
            prereqs:          graphResult.prereqs         || result.prereqs,
          };
        }
      } catch (err) {
        console.error('[Brain] migrationAdvisor error:', err.message);
      }

      // Store in vector store for future RAG learning
      const vs = getVectorStore();
      await vs.add(
        `migration ${input.objectId} ${result.tier} ${result.recommendedTool} ${input.adapterType} ${input.sourceSystem}`,
        { objectId: input.objectId, tier: result.tier, tool: result.recommendedTool, hours: result.estimatedHours }
      );

      // Capture as brain event for insight generation
      if (isBrainEnabled()) {
        try {
          await INSERT.into(Events).entries({
            eventType: 'migration_advisory',
            source: `migrationAdvisor:${input.objectId}`,
            payload: JSON.stringify(input),
            summary: `Migration advice requested for ${input.objectId}: ${result.tier} complexity, recommend ${result.recommendedTool}, est. ${result.estimatedHours}h`,
            embeddingId: `ma_${Date.now()}`,
            sessionId: '',
            processed: false,
          });
        } catch { /* non-blocking */ }
      }

      return {
        objectId:        input.objectId,
        objectType:      result.objectType,
        tier:            result.tier,
        complexityScore: result.complexityScore,
        recommendedTool: result.recommendedTool,
        specificTool:    result.specificTool,
        estimatedHours:  result.estimatedHours,
        riskLevel:       result.riskLevel,
        waveAssignment:  result.waveAssignment,
        rationale:       result.rationale,
        steps:           result.steps,
        prereqs:         result.prereqs,
        message:         `Migration analysis complete for ${input.objectId}`,
      };
    });

    // ── seedMigrationKnowledge ────────────────────────────────────────────────
    this.on('seedMigrationKnowledge', async (req) => {
      const { key } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      const vs = getVectorStore();
      let seeded = 0;

      for (const obj of MIGRATION_KNOWLEDGE) {
        await vs.add(
          `sap migration ${obj.id} ${obj.desc} ${obj.tier} ${obj.tool} adapter:${obj.adapterType} segments:${obj.segmentCount}`,
          { objectId: obj.id, tier: obj.tier, tool: obj.tool, hours: obj.hours, source: 'seed' }
        );
        seeded++;
      }

      // Also seed the SAP IS capability knowledge
      const isKnowledge = [
        'SAP Integration Suite Cloud Integration iFlow IDoc adapter MATMAS DEBMAS CREMAS master data migration simple',
        'SAP Integration Suite Migration Assessment Tool MAT ICO score complexity wave plan PI PO migration',
        'SAP Integration Suite iFlow medium complexity XSLT mapping SFTP adapter semi-automated migration wizard',
        'SAP Integration Suite complex iFlow AS2 EDI trading partner INVOIC ORDERS EDIFACT X12 Integration Advisor MIG MAG',
        'SAP Integration Suite LangChain AI Pattern C FIDCCP FI document validation confidence routing human review',
        'SAP Integration Suite Event Mesh AMQP pub sub guaranteed delivery high volume migration async queue',
        'SAP Integration Suite API Management gateway OAuth2 rate limiting developer portal SDAINTAI CAP OData',
        'BAPI direct S4 HANA simple migration BAPI_MATERIAL_SAVEDATA BAPI_CUSTOMER_CREATEFROMDATA1 BAPI_VENDOR_CREATEFROMDATA',
        'SAP BW migration BDC Datasphere AI Foundation InfoCube ODS ADSO master data hierarchy analytics',
        'SDA SAP Migration Factory partner 21 years innovation SDAINTAI AI accelerator assessment planning wave execution',
        'Forrester TEI SAP Integration Suite 345 percent ROI 554000 savings legacy PI PO retirement',
        'Harrods 60 percent content reuse PI PO migration Integration Suite Kemira 50 percent development time reduction',
        'Int4 Shield automated testing iFlow regression 12 months free Figaf DevOps CI CD pipeline IS migration',
        'ccBPM BPM stateful process orchestration PI PO always complex rebuild redesign SAP Build Process Automation',
        // ── SAP Reference Architecture: PI/PO → Integration Suite (architecture.learning.sap.com 9a5f7b59dc)
        'SAP PI PO standard maintenance ending 2027 migration mandatory Integration Suite cloud iPaaS NetWeaver replacement',
        'SAP Integration Suite iPaaS cloud-to-cloud cloud-to-on-premise on-premise Edge Integration Cell EIC deployment patterns',
        'SAP Integration Suite as-is PI PO cross-domain integration dedicated API Management event broker DMZ firewall',
        'SAP Integration Suite to-be target architecture Edge Integration Cell BTP Destination Connectivity Cloud Connector private network',
        'SAP Integration Suite build-once deploy-anywhere single iFlow runs Integration Suite and Edge Integration Cell EIC same artifact',
        'SAP Cloud Connector high availability HA BTP Destination Service secure cloud to on-premise connectivity private network hyperscaler',
        'SAP Integration Suite Migration Assessment Tool evaluate technical effort scenario migration approach ICO PI PO scoring',
        'SAP Integration Suite Migration Tooling wizard-based artifact migration automated iFlow generation from PI PO ICO',
        'SAP Integration Suite migration partner tools Figaf Int4 65 percent automation third party tooling PI PO',
        'SAP Integration Suite static IP address simplified third-party connectivity firewall rules trading partner whitelist',
        'SAP Integration Suite central monitoring administration BTP cockpit consolidated observability reduced operational complexity',
        'SAP Integration Suite Advanced Event Mesh event-driven architecture pub sub AMQP MQTT topic subscription',
        'SAP Integration Suite API Management rate limiting monetization developer portal OAuth2 lifecycle governance',
        'SAP Integration Suite reduced technology footprint skill consolidation retire PI PO dual-stack advanced adapter engine',
        // ── EDA / AEM / iFlow event-driven patterns & AI capabilities (2026-06-26)
        'EDA event-driven architecture pattern producer consumer asynchronous decoupled fact-based events no point-to-point',
        'AEM Advanced Event Mesh SAP Solace PubSub+ enterprise event broker topic routing guaranteed delivery replay multi-region',
        'SAP S4HANA 1500 native business events AEM MaterialMasterChanged PurchaseOrderCreated InvoicePosted direct publish',
        'AEM AMQP adapter iFlow trigger event queue subscription real-time no polling no RFC dependency wake on event',
        'EDA vs PI PO synchronous RFC IDoc point-to-point brittle vs async resilient scalable event-driven modernization',
        'AEM topic hierarchy sap s4 mm material changed MATMAS sda migration completed event stream live progress tracker',
        'AEM event replay backfill migration catch-up wave cutover missed events reprocess guaranteed delivery SDAINTAI',
        'SDAINTAI lift-and-shift iFlow ICO 1:1 migration vs EDA modernization high volume real-time fan-out candidate',
        'SAP Migration Assessment Tool Business Events recommendation EDA modernization flag wave planning SDAINTAI',
        'ccBPM stateful process AEM SAP Build Process Automation orchestration event-driven workflow modernization',
        'SAP Integration Suite GenAI AI-assisted mapping message mapping suggestions XSLT graphical reduce manual effort',
        'SAP Integration Suite agentic integration AI agents autonomous multi-step orchestration intelligent recommendations',
        'SAP Integration Suite AI monitoring anomaly detection predictive alerting root cause analysis operations',
        'SAP Integration Suite generative assistant natural language to iFlow configuration accelerate developer productivity',
        'AEM MQTT WebSocket real-time notification pattern low-latency IoT mobile event streaming IS integration',
      ];

      for (const text of isKnowledge) {
        await vs.add(text, { source: 'is_knowledge_seed', tier: 'reference' });
        seeded++;
      }

      return { seeded, message: `Seeded ${seeded} migration knowledge vectors into brain` };
    });

    // ── importBrain ──────────────────────────────────────────────────────────
    this.on('importBrain', async (req) => {
      const { key, data } = req.data;
      if (!verifyKey(key)) return req.error(403, 'Invalid master key');

      let archive;
      try {
        archive = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
      } catch {
        return req.error(400, 'Invalid brain archive data');
      }

      let eventsImported = 0;
      if (Array.isArray(archive.events)) {
        for (const ev of archive.events) {
          try {
            await INSERT.into(Events).entries(ev);
            eventsImported++;
          } catch { /* skip duplicates */ }
        }
      }

      if (Array.isArray(archive.vectors)) {
        await getVectorStore().replaceAll(archive.vectors);
      }

      return {
        success: true,
        eventsImported,
        message: `Imported ${eventsImported} events from archive`,
      };
    });

    return super.init();
  }
};
