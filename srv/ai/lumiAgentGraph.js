'use strict';

const crypto = require('node:crypto');
const cds = require('@sap/cds');
const { AuthorizationError, assertToolAllowed, MCP_TOOLS_BY_PERSONA } = require('../utils/personaAuth');
const { buildArchitectReport, computePlanRevisionHash } = require('../utils/pipoArchitectReport');
const { getTenantVectorStore } = require('./pgVectorStore');

const TENANT_CHAT_WINDOW_MS = 60 * 1000;
const MAX_CHAT_REQ_PER_WINDOW = Number(process.env.PIPO_CHAT_RATE_LIMIT_PER_MIN || 30);
const tenantChatBuckets = new Map();

function enforceTenantChatRateLimit(tenantId, now = Date.now()) {
  const bucket = (tenantChatBuckets.get(tenantId) || []).filter((ts) => now - ts < TENANT_CHAT_WINDOW_MS);
  if (bucket.length >= MAX_CHAT_REQ_PER_WINDOW) {
    const err = new Error(`Tenant chat rate limit (${MAX_CHAT_REQ_PER_WINDOW}/min) reached to prevent noisy-neighbor contention. Please retry shortly.`);
    err.code = 'RATE_LIMIT_EXCEEDED';
    err.statusCode = 429;
    throw err;
  }
  bucket.push(now);
  tenantChatBuckets.set(tenantId, bucket);
}

function selectA2AAgent(message, configuredAgents = []) {
  const q = String(message || '').toLowerCase();
  for (const ag of configuredAgents) {
    if (ag?.domain && q.includes(String(ag.domain).toLowerCase())) {
      return { name: ag.name || 'Domain A2A Agent', domain: ag.domain };
    }
  }
  if (/mapping|xslt|udf|java|xi_trafo|valuemapping|field|segment/.test(q)) {
    return { name: 'A2A — Mapping Agent', domain: 'Mapping & Transformation' };
  }
  if (/convert|groovy|iflow|ccbpm|bapi|rap|wave|deploy|package/.test(q)) {
    return { name: 'A2A — Conversion Agent', domain: 'iFlow & Code Conversion' };
  }
  return { name: 'Lumi — PI/PO Principal Architect', domain: 'Landscape & Governance' };
}

function createScopedMcpTools({ tenantId, projectId, persona, userId, vectorStore }) {
  const entities = () => cds.entities('pipo.discovery');

  async function getActiveRun() {
    const { DiscoveryRuns } = entities();
    return cds.db.run(
      cds.ql.SELECT.one.from(DiscoveryRuns).where({ tenantId, projectId, isActive: true, status: 'COMPLETED' })
    );
  }

  const handlers = {
    async semantic_search_artifacts({ query, topK = 5 }) {
      const run = await getActiveRun();
      const hits = await vectorStore.searchTenant(tenantId, query, { runId: run?.ID || null, topK });
      return { vectorBackend: vectorStore.backend, hitCount: hits.length, hits };
    },
    async list_discovered_interfaces({ waveNumber = null, artifactType = null } = {}) {
      const run = await getActiveRun();
      if (!run) return { found: false, items: [] };
      const { DiscoveredArtifacts } = entities();
      const where = { tenantId, run_ID: run.ID };
      if (waveNumber) where.waveNumber = Number(waveNumber);
      if (artifactType) where.artifactType = artifactType;
      const rows = await cds.db.run(cds.ql.SELECT.from(DiscoveredArtifacts).where(where).limit(40));
      return { found: true, runId: run.ID, count: rows.length, items: rows.map((r) => ({ id: r.objectId, name: r.name, type: r.artifactType, tier: r.complexityTier, wave: r.waveNumber, target: r.proposedTarget })) };
    },
    async inspect_artifact_evidence({ nameOrId }) {
      const run = await getActiveRun();
      if (!run) return { found: false };
      const { DiscoveredArtifacts, ArtifactDependencies } = entities();
      const all = await cds.db.run(cds.ql.SELECT.from(DiscoveredArtifacts).where({ tenantId, run_ID: run.ID }));
      const needle = String(nameOrId || '').toLowerCase();
      const target = all.find((a) => a.objectId.toLowerCase() === needle || a.name.toLowerCase().includes(needle)) || all[0];
      if (!target) return { found: false };
      const deps = await cds.db.run(cds.ql.SELECT.from(ArtifactDependencies).where({ tenantId, run_ID: run.ID, sourceArtifactId: target.objectId }));
      return { found: true, artifact: target, dependencies: deps };
    },
    async analyze_discovery_failures() {
      const run = await getActiveRun();
      if (!run) return { found: false, failures: [] };
      const eps = JSON.parse(run.endpointsJson || '[]');
      return { found: true, failures: eps.filter((e) => e.status !== 'ok' || (e.httpStatus && e.httpStatus >= 400)) };
    },
    async compare_esr_vs_directory() {
      const run = await getActiveRun();
      if (!run) return { found: false };
      const { DiscoveredArtifacts, ArtifactDependencies } = entities();
      const [arts, deps] = await Promise.all([
        cds.db.run(cds.ql.SELECT.from(DiscoveredArtifacts).where({ tenantId, run_ID: run.ID })),
        cds.db.run(cds.ql.SELECT.from(ArtifactDependencies).where({ tenantId, run_ID: run.ID }))
      ]);
      const rep = buildArchitectReport(run, arts, deps, 'esr_vs_dir');
      return { found: true, kpis: rep.kpis, esrVsDir: rep.deepDive };
    },
    async get_wave_plan_status() {
      const run = await getActiveRun();
      if (!run) return { found: false };
      const { DiscoveredArtifacts, PlanApprovals } = entities();
      const [arts, apps] = await Promise.all([
        cds.db.run(cds.ql.SELECT.from(DiscoveredArtifacts).where({ tenantId, run_ID: run.ID })),
        cds.db.run(cds.ql.SELECT.from(PlanApprovals).where({ tenantId, projectId, run_ID: run.ID }).orderBy('decidedAt desc').limit(1))
      ]);
      const waves = { 1: 0, 2: 0, 3: 0 };
      for (const a of arts) waves[a.waveNumber || 1] = (waves[a.waveNumber || 1] || 0) + 1;
      return { found: true, runId: run.ID, planRevisionHash: run.planRevisionHash, waves, approvalStatus: apps[0]?.decision || 'PENDING', approvedBy: apps[0]?.decidedBy || null };
    },
    async approve_wave_plan({ rationale = 'Approved via Lumi MCP governance tool.' } = {}) {
      assertToolAllowed(persona, 'approve_wave_plan');
      const run = await getActiveRun();
      if (!run) throw new Error('No completed discovery run is active to approve.');
      const { PlanApprovals } = entities();
      const nowIso = new Date().toISOString();
      await cds.db.run(cds.ql.INSERT.into(PlanApprovals).entries({
        ID: crypto.randomUUID(),
        tenantId,
        projectId,
        run_ID: run.ID,
        planRevisionHash: run.planRevisionHash,
        decision: 'APPROVED',
        decidedBy: userId,
        decidedPersona: persona,
        rationale: String(rationale).slice(0, 500),
        decidedAt: nowIso
      }));
      return { approved: true, decision: 'APPROVED', decidedBy: userId, planRevisionHash: run.planRevisionHash };
    },
    async reject_wave_plan({ rationale = 'Rejected via Lumi MCP governance tool.' } = {}) {
      assertToolAllowed(persona, 'reject_wave_plan');
      const run = await getActiveRun();
      if (!run) throw new Error('No completed discovery run is active to reject.');
      const { PlanApprovals } = entities();
      const nowIso = new Date().toISOString();
      await cds.db.run(cds.ql.INSERT.into(PlanApprovals).entries({
        ID: crypto.randomUUID(),
        tenantId,
        projectId,
        run_ID: run.ID,
        planRevisionHash: run.planRevisionHash,
        decision: 'REJECTED',
        decidedBy: userId,
        decidedPersona: persona,
        rationale: String(rationale).slice(0, 500),
        decidedAt: nowIso
      }));
      return { approved: false, decision: 'REJECTED', decidedBy: userId };
    },
    async update_wave_assignment({ artifactName, targetWave }) {
      assertToolAllowed(persona, 'update_wave_assignment');
      const waveNum = Number(targetWave);
      if (![1, 2, 3].includes(waveNum)) throw new Error('targetWave must be 1, 2, or 3.');
      const run = await getActiveRun();
      if (!run) throw new Error('No completed discovery run is active.');
      const { DiscoveryRuns, DiscoveredArtifacts, PlanApprovals } = entities();
      const all = await cds.db.run(cds.ql.SELECT.from(DiscoveredArtifacts).where({ tenantId, run_ID: run.ID }));
      const needle = String(artifactName || '').toLowerCase();
      const hit = all.find((a) => a.name.toLowerCase().includes(needle) || a.objectId.toLowerCase() === needle);
      if (!hit) return { updated: false, reason: `No artifact matching "${artifactName}" found in active run.` };
      hit.waveNumber = waveNum;
      const newHash = computePlanRevisionHash(run.ID, all);
      await cds.db.run(cds.ql.UPDATE(DiscoveredArtifacts).set({ waveNumber: waveNum }).where({ ID: hit.ID, tenantId }));
      await cds.db.run(cds.ql.UPDATE(DiscoveryRuns).set({ planRevisionHash: newHash }).where({ ID: run.ID, tenantId }));
      await cds.db.run(cds.ql.UPDATE(PlanApprovals).set({ decision: 'INVALIDATED' }).where({ tenantId, projectId, run_ID: run.ID, decision: 'APPROVED' }));
      return { updated: true, artifact: hit.name, waveNumber: waveNum, planRevisionHash: newHash, priorApprovalsInvalidated: true };
    },
    async deploy_approved_wave({ waveNumber = 1, targetTenant = 'SAP Integration Suite' } = {}) {
      assertToolAllowed(persona, 'deploy_approved_wave');
      const run = await getActiveRun();
      if (!run) throw new Error('No completed discovery run is active for deployment.');
      const { PlanApprovals } = entities();
      const approvals = await cds.db.run(
        cds.ql.SELECT.from(PlanApprovals).where({ tenantId, projectId, run_ID: run.ID }).orderBy('decidedAt desc').limit(1)
      );
      const latest = approvals[0];
      if (!latest || latest.decision !== 'APPROVED' || latest.planRevisionHash !== run.planRevisionHash) {
        const err = new AuthorizationError(
          'APPROVAL_REQUIRED',
          'Deployment blocked: An Approver must approve the current wave plan revision before an Admin can deploy.',
          412
        );
        throw err;
      }
      const nowIso = new Date().toISOString();
      await cds.db.run(cds.ql.UPDATE(PlanApprovals).set({ deployedAt: nowIso, deployedBy: userId }).where({ ID: latest.ID, tenantId }));
      return { deployed: true, waveNumber: Number(waveNumber), approvedBy: latest.decidedBy, targetTenant, planRevisionHash: run.planRevisionHash };
    }
  };

  async function invokeTool(toolName, args = {}) {
    assertToolAllowed(persona, toolName);
    const fn = handlers[toolName];
    if (!fn) throw new AuthorizationError('UNKNOWN_MCP_TOOL', `Unsupported MCP tool "${toolName}".`, 400);
    return fn(args);
  }

  return {
    allowedTools: [...(MCP_TOOLS_BY_PERSONA[persona] || MCP_TOOLS_BY_PERSONA.Viewer)],
    invokeTool,
    getActiveRun
  };
}

function detectActionIntent(message) {
  const m = String(message || '').trim();
  const lower = m.toLowerCase();
  if (/\b(approve|sign\s*off)\b/.test(lower) && !/\bwho\b|\bstatus\b|\bhow\b|\?/.test(lower)) {
    return { kind: 'approve', tool: 'approve_wave_plan', rationale: m };
  }
  if (/\breject\b/.test(lower) && !/\bwhy\b|\?/.test(lower)) {
    return { kind: 'reject', tool: 'reject_wave_plan', rationale: m };
  }
  if (/\b(deploy|push\s+to\s+btp|promote\s+wave)\b/.test(lower) && !/\bcan\s+i\b|\bstatus\b|\?/.test(lower)) {
    const waveMatch = lower.match(/wave\s*([123])/);
    return { kind: 'deploy', tool: 'deploy_approved_wave', waveNumber: waveMatch ? Number(waveMatch[1]) : 1 };
  }
  const moveMatch = m.match(/move\s+([A-Za-z0-9_.-]+)\s+to\s+wave\s*([123])/i);
  if (moveMatch) {
    return { kind: 'update_wave', tool: 'update_wave_assignment', artifactName: moveMatch[1], targetWave: Number(moveMatch[2]) };
  }
  if (/fail|403|404|500|error|forbidden|diagnostic/.test(lower)) {
    return { kind: 'read', tool: 'analyze_discovery_failures' };
  }
  if (/esr\s*(vs|versus|and)\s*dir|orphan|dormant|unreferenced/.test(lower)) {
    return { kind: 'read', tool: 'compare_esr_vs_directory' };
  }
  if (/wave|plan|approval|hours|effort/.test(lower)) {
    return { kind: 'read', tool: 'get_wave_plan_status' };
  }
  return { kind: 'search', tool: 'semantic_search_artifacts' };
}

async function runLumiAgentTurn({
  tenantId,
  projectId = 'PIPO32Migration',
  sessionId = 'default',
  persona,
  userId,
  message,
  configuredAgents = [],
  llmInvokeFn = null
}) {
  enforceTenantChatRateLimit(tenantId);
  const vectorStore = getTenantVectorStore();
  const toolset = createScopedMcpTools({ tenantId, projectId, persona, userId, vectorStore });
  const { AgentChatMessages } = cds.entities('pipo.discovery');

  const { Annotation, StateGraph, START, END } = await import('@langchain/langgraph');

  const AgentState = Annotation.Root({
    message: Annotation({ reducer: (x, y) => y ?? x, default: () => '' }),
    activeAgent: Annotation({ reducer: (x, y) => y ?? x, default: () => ({ name: 'Lumi', domain: 'General' }) }),
    activeRun: Annotation({ reducer: (x, y) => y ?? x, default: () => null }),
    citations: Annotation({ reducer: (x, y) => y ?? x, default: () => [] }),
    intent: Annotation({ reducer: (x, y) => y ?? x, default: () => null }),
    toolCalls: Annotation({ reducer: (x, y) => y ?? x, default: () => [] }),
    rbacBlocked: Annotation({ reducer: (x, y) => y ?? x, default: () => null }),
    reply: Annotation({ reducer: (x, y) => y ?? x, default: () => '' })
  });

  async function retrieveNode(state) {
    const run = await toolset.getActiveRun();
    const hits = await vectorStore.searchTenant(tenantId, state.message, {
      runId: run?.ID || null,
      topK: 5
    });
    return {
      activeRun: run || null,
      citations: hits.map((h) => ({
        artifactId: h.artifactId,
        chunkKind: h.chunkKind,
        score: h.score,
        snippet: h.contentText.slice(0, 240)
      }))
    };
  }

  async function routeNode(state) {
    return {
      activeAgent: selectA2AAgent(state.message, configuredAgents),
      intent: detectActionIntent(state.message)
    };
  }

  async function mcpToolNode(state) {
    const intent = state.intent;
    const calls = [];
    try {
      if (intent.tool === 'approve_wave_plan') {
        const res = await toolset.invokeTool('approve_wave_plan', { rationale: intent.rationale });
        calls.push({ tool: 'approve_wave_plan', status: 'ok', output: res });
      } else if (intent.tool === 'reject_wave_plan') {
        const res = await toolset.invokeTool('reject_wave_plan', { rationale: intent.rationale });
        calls.push({ tool: 'reject_wave_plan', status: 'ok', output: res });
      } else if (intent.tool === 'deploy_approved_wave') {
        const res = await toolset.invokeTool('deploy_approved_wave', { waveNumber: intent.waveNumber });
        calls.push({ tool: 'deploy_approved_wave', status: 'ok', output: res });
      } else if (intent.tool === 'update_wave_assignment') {
        const res = await toolset.invokeTool('update_wave_assignment', { artifactName: intent.artifactName, targetWave: intent.targetWave });
        calls.push({ tool: 'update_wave_assignment', status: 'ok', output: res });
      } else {
        const res = await toolset.invokeTool(intent.tool, { query: state.message });
        calls.push({ tool: intent.tool, status: 'ok', output: res });
      }
      return { toolCalls: calls };
    } catch (err) {
      calls.push({ tool: intent.tool, status: 'denied', code: err.code || 'FORBIDDEN', error: err.message });
      return {
        toolCalls: calls,
        rbacBlocked: { code: err.code || 'FORBIDDEN', statusCode: err.statusCode || 403, message: err.message }
      };
    }
  }

  async function synthesizeNode(state) {
    if (state.rbacBlocked) {
      return {
        reply: `⛔ **Action Blocked (${state.rbacBlocked.code}):** ${state.rbacBlocked.message} *(Active persona: **${persona}** · Permitted MCP tools: ${toolset.allowedTools.join(', ')})*`
      };
    }

    const lastCall = state.toolCalls[0];
    if (lastCall?.tool === 'approve_wave_plan' && lastCall.status === 'ok') {
      return {
        reply: `✅ **Wave Plan Approved** via MCP tool \`approve_wave_plan\` by **${userId}** (${persona}) for revision \`${lastCall.output.planRevisionHash.slice(0, 8)}\`. An **Admin** may now execute target BTP deployment.`
      };
    }
    if (lastCall?.tool === 'reject_wave_plan' && lastCall.status === 'ok') {
      return {
        reply: `⚠️ **Wave Plan Rejected** via MCP tool \`reject_wave_plan\` by **${userId}** (${persona}). Deployment remains locked until revised and re-approved.`
      };
    }
    if (lastCall?.tool === 'deploy_approved_wave' && lastCall.status === 'ok') {
      return {
        reply: `🚀 **Wave ${lastCall.output.waveNumber} Deployed** via MCP tool \`deploy_approved_wave\` by **${userId}** (${persona}), verified against Approver sign-off by **${lastCall.output.approvedBy}** (revision \`${lastCall.output.planRevisionHash.slice(0, 8)}\`).`
      };
    }
    if (lastCall?.tool === 'update_wave_assignment' && lastCall.status === 'ok') {
      return {
        reply: lastCall.output.updated
          ? `✅ Moved **${lastCall.output.artifact}** to **Wave ${lastCall.output.waveNumber}** (new plan revision \`${lastCall.output.planRevisionHash.slice(0, 8)}\`; any prior approvals were invalidated).`
          : `ℹ️ ${lastCall.output.reason}`
      };
    }

    if (!state.activeRun) {
      return {
        reply: `No completed SAP PI/PO discovery run exists yet for tenant \`${tenantId}\`. Have an **Admin** run **Test Connection** → **Discover Interfaces** first so I can ground answers in verified landscape evidence.`
      };
    }

    const evidenceContext = state.citations.map((c, idx) => `[${idx + 1}] (${c.chunkKind}, cosine=${c.score}) ${c.snippet}`).join('\n');
    const toolJson = JSON.stringify(lastCall?.output || {}).slice(0, 2200);

    const invokeModel = llmInvokeFn || (process.env.ANTHROPIC_API_KEY ? async (prompt) => {
      const { ChatAnthropic } = await import('@langchain/anthropic');
      const model = new ChatAnthropic({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', maxTokens: 700 });
      const res = await model.invoke([{ role: 'user', content: prompt }]);
      return typeof res.content === 'string' ? res.content : '';
    } : null);

    if (invokeModel) {
      try {
        const prompt = `You are ${state.activeAgent.name} (${state.activeAgent.domain}) for SAP PI/PO Migration Cockpit.
Caller persona: ${persona} (tenant: ${tenantId}). Never invent objects or expose credentials.
Active Run: ${state.activeRun.systemName} (${state.activeRun.totalObjects} objects: ${state.activeRun.icoCount} ICOs, ${state.activeRun.channelCount} channels, ${state.activeRun.mappingCount} mappings, ${state.activeRun.ccBpmCount} ccBPM).
pgvector Cosine Evidence:
${evidenceContext || 'none'}
MCP Tool Output (${lastCall?.tool}):
${toolJson}

User question: ${state.message}
Provide a concise, grounded architect answer citing exact object names, counts, and wave/remediation guidance.`;
        const llmText = await invokeModel(prompt);
        if (llmText && llmText.trim()) return { reply: llmText.trim() };
      } catch { /* fall through to deterministic grounded reply */ }
    }

    // Deterministic grounded architect synthesis when ANTHROPIC_API_KEY is unset
    const r = state.activeRun;
    const topSnippets = state.citations.slice(0, 3).map((c) => `• \`${c.artifactId}\` *(cosine ${c.score})*: ${c.snippet}`).join('\n');
    let toolSummary = '';
    if (lastCall?.tool === 'analyze_discovery_failures') {
      const fails = lastCall.output?.failures || [];
      toolSummary = fails.length
        ? `Flagged endpoints: ${fails.map((f) => `\`${f.path}\` (HTTP ${f.httpStatus ?? 'ERR'}, layer \`${f.diagnostic?.layer || 'source'}\`: ${f.diagnostic?.code || f.status})`).join('; ')}.`
        : 'All discovery endpoints succeeded without HTTP errors.';
    } else if (lastCall?.tool === 'compare_esr_vs_directory') {
      const rows = lastCall.output?.esrVsDir?.rows || [];
      toolSummary = rows.map((row) => `${row[0]}: ${row[3]}`).join(' ');
    } else if (lastCall?.tool === 'get_wave_plan_status') {
      const o = lastCall.output || {};
      toolSummary = `Wave distribution — Wave 1: ${o.waves?.[1] || 0}, Wave 2: ${o.waves?.[2] || 0}, Wave 3: ${o.waves?.[3] || 0} · Governance status: **${o.approvalStatus || 'PENDING'}** (revision \`${(o.planRevisionHash || '').slice(0, 8)}\`).`;
    }

    const replyParts = [
      `**${state.activeAgent.name}:** Grounded in **${r.systemName}** discovery run (\`${r.totalObjects}\` artifacts: \`${r.icoCount}\` ICOs, \`${r.channelCount}\` Channels, \`${r.mappingCount}\` Mappings, \`${r.ccBpmCount}\` ccBPM processes).`,
      toolSummary,
      topSnippets ? `Top semantic matches (\`${vectorStore.backend}\` cosine similarity):\n${topSnippets}` : ''
    ].filter(Boolean);

    return { reply: replyParts.join('\n\n') };
  }

  const graph = new StateGraph(AgentState)
    .addNode('retrieve', retrieveNode)
    .addNode('route', routeNode)
    .addNode('mcpTools', mcpToolNode)
    .addNode('synthesize', synthesizeNode)
    .addEdge(START, 'retrieve')
    .addEdge('retrieve', 'route')
    .addEdge('route', 'mcpTools')
    .addEdge('mcpTools', 'synthesize')
    .addEdge('synthesize', END)
    .compile();

  const finalState = await graph.invoke({ message: String(message || '') });

  if (AgentChatMessages) {
    const nowIso = new Date().toISOString();
    await cds.db.run(cds.ql.INSERT.into(AgentChatMessages).entries([
      {
        ID: crypto.randomUUID(),
        tenantId,
        sessionId,
        projectId,
        role: 'user',
        persona,
        agentName: 'user',
        content: String(message || ''),
        citationsJson: '[]',
        toolCallsJson: '[]',
        createdAt: nowIso
      },
      {
        ID: crypto.randomUUID(),
        tenantId,
        sessionId,
        projectId,
        role: 'assistant',
        persona,
        agentName: finalState.activeAgent.name,
        content: finalState.reply,
        citationsJson: JSON.stringify(finalState.citations || []),
        toolCallsJson: JSON.stringify(finalState.toolCalls || []),
        createdAt: nowIso
      }
    ]));
  }

  return {
    tenantId,
    persona,
    agentName: finalState.activeAgent.name,
    agentDomain: finalState.activeAgent.domain,
    vectorBackend: vectorStore.backend,
    allowedTools: toolset.allowedTools,
    rbacBlocked: finalState.rbacBlocked,
    reply: finalState.reply,
    citations: finalState.citations || [],
    toolCalls: finalState.toolCalls || []
  };
}

module.exports = {
  enforceTenantChatRateLimit,
  selectA2AAgent,
  createScopedMcpTools,
  detectActionIntent,
  runLumiAgentTurn
};
