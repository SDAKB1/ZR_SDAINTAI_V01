'use strict';

const crypto = require('node:crypto');

function classifyPipoObject(obj, references = []) {
  const outEdges = references.filter((e) => e.sourceId === obj.id);
  const type = obj.type || 'Other';
  let score = 15;
  let adapterType = '';
  let direction = '';
  let senderComponent = '';
  let receiverComponent = '';
  let hasCustomCode = false;
  let isCcBpm = false;
  let processSteps = 0;
  let name = obj.name || '';
  let namespace = obj.namespace || '';
  let swcv = obj.versionContext?.caption || obj.versionContext?.swcGuid || '';

  if (type === 'CommunicationChannel') {
    name = obj.identifier?.ChannelID || name || obj.id;
    senderComponent = obj.identifier?.ComponentID || '';
    direction = obj.details?.Direction || '';
    adapterType = obj.details?.adapter?.Name || obj.details?.TransportProtocol || 'Unknown';
    const modCount = Array.isArray(obj.details?.modules) ? obj.details.modules.length : 0;
    hasCustomCode = modCount > 1;
    score = 18 + (modCount > 1 ? 20 : 0) + (/as2|jms|jdbc|rfc/i.test(adapterType) ? 18 : 6);
  } else if (type === 'IntegratedConfiguration') {
    const id = obj.identifier || {};
    name = id.InterfaceName ? `${id.SenderComponentID || 'SRC'}_${id.InterfaceName}` : obj.id;
    namespace = id.InterfaceNamespace || '';
    senderComponent = id.SenderComponentID || '';
    receiverComponent = id.ReceiverComponentID || '';
    const opMapRefs = outEdges.filter((e) => e.kind === 'operation-mapping');
    const recvRefs = outEdges.filter((e) => e.kind === 'receiver-component');
    adapterType = outEdges.find((e) => e.kind === 'inbound-channel')?.target?.ChannelID || 'ICO';
    score = 22 + (opMapRefs.length * 14) + (recvRefs.length > 1 ? 18 : 4);
    if (/invoic|fidccp|pexr|finance|tax/i.test(name)) score += 24;
  } else if (type === 'IntegrationProcess') {
    isCcBpm = true;
    processSteps = Number(obj.details?.processStepCount || 0);
    score = Math.min(98, 68 + processSteps * 3);
  } else if (type === 'MessageMapping') {
    const blobs = obj.details?.blobs || {};
    hasCustomCode = Boolean(blobs.ByteCodeJar?.present || blobs.SourceCode?.present);
    score = hasCustomCode ? 64 : 32;
  } else if (type === 'OperationMapping') {
    score = obj.details?.Multiplicity && obj.details.Multiplicity !== '1:1' ? 48 : 26;
  } else if (type === 'ServiceInterface') {
    score = /stateful|tucc/i.test(obj.details?.interfacePattern || '') ? 56 : 18;
  }

  score = Math.max(8, Math.min(100, Math.round(score)));
  const complexityTier = score <= 30 ? 'Simple' : score <= 60 ? 'Medium' : 'Complex';
  const waveNumber = complexityTier === 'Simple' ? 1 : complexityTier === 'Medium' ? 2 : 3;
  const estimatedHours = complexityTier === 'Simple' ? 4.0 : complexityTier === 'Medium' ? 16.0 : (isCcBpm ? 64.0 : 48.0);
  const proposedTarget = isCcBpm
    ? 'Cloud Integration iFlow + JMS / DataStore Redesign'
    : complexityTier === 'Simple' && /matmas|debmas|cremas|glmast|cosmas/i.test(name)
      ? 'S/4HANA RAP OData / Standard BAPI'
      : hasCustomCode
        ? 'SAP Integration Suite iFlow + Groovy Transformation'
        : 'SAP Integration Suite iFlow (Semi-Automated)';

  return {
    objectId: obj.id,
    sourceArea: obj.source === 'ESR' ? 'ESR' : 'Directory',
    artifactType: type,
    name: String(name || obj.id).slice(0, 240),
    namespace: String(namespace || '').slice(0, 260),
    swcv: String(swcv || '').slice(0, 160),
    adapterType: String(adapterType || '').slice(0, 60),
    direction: String(direction || '').slice(0, 20),
    senderComponent: String(senderComponent || '').slice(0, 160),
    receiverComponent: String(receiverComponent || '').slice(0, 160),
    verifiedDef: Boolean(obj.verifiedDefinition),
    hasCustomCode,
    isCcBpm,
    processSteps,
    complexityScore: score,
    complexityTier,
    waveNumber,
    estimatedHours,
    proposedTarget,
    metadataJson: JSON.stringify({
      identifier: obj.identifier || null,
      details: obj.details || {},
      outboundReferences: outEdges.length
    })
  };
}

function buildSemanticChunks(classifiedArtifacts, analysis) {
  const chunks = [];
  for (const a of classifiedArtifacts) {
    chunks.push({
      artifactId: a.objectId,
      chunkKind: /Mapping/.test(a.artifactType) ? 'mapping' : a.artifactType === 'CommunicationChannel' ? 'channel' : 'interface',
      contentText: `${a.artifactType} ${a.name} (${a.sourceArea}) namespace=${a.namespace || 'n/a'} adapter=${a.adapterType || 'n/a'} direction=${a.direction || 'n/a'} sender=${a.senderComponent || 'n/a'} receiver=${a.receiverComponent || 'n/a'} tier=${a.complexityTier} score=${a.complexityScore} wave=${a.waveNumber} ccBPM=${a.isCcBpm} steps=${a.processSteps} customCode=${a.hasCustomCode} target=${a.proposedTarget}`,
      metadata: { artifactType: a.artifactType, name: a.name, waveNumber: a.waveNumber, complexityTier: a.complexityTier, sourceArea: a.sourceArea }
    });
  }
  for (const ep of (analysis.endpoints || [])) {
    if (ep.status !== 'ok') {
      chunks.push({
        artifactId: ep.tool,
        chunkKind: 'diagnostic',
        contentText: `Discovery endpoint ${ep.path} (${ep.tool}) status=${ep.status} HTTP=${ep.httpStatus || 'n/a'} code=${ep.diagnostic?.code || 'UNKNOWN'} layer=${ep.diagnostic?.layer || 'source'} reason=${ep.diagnostic?.reason || ''} remediation=${ep.diagnostic?.remediation || ''}`,
        metadata: { tool: ep.tool, path: ep.path, httpStatus: ep.httpStatus, status: ep.status }
      });
    }
  }
  return chunks;
}

function computePlanRevisionHash(runId, artifacts) {
  const canonical = artifacts
    .map((a) => `${a.objectId}:${a.waveNumber}:${a.complexityTier}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(`${runId}#${canonical}`).digest('hex').slice(0, 32);
}

function buildArchitectReport(runRow, artifacts = [], dependencies = [], requestedFilter = 'interfaces') {
  const endpoints = (() => { try { return JSON.parse(runRow.endpointsJson || '[]'); } catch { return []; } })();
  const summaryMeta = (() => { try { return JSON.parse(runRow.summaryJson || '{}'); } catch { return {}; } })();

  const byType = {};
  const byAdapter = {};
  const byWave = { 1: { count: 0, hours: 0 }, 2: { count: 0, hours: 0 }, 3: { count: 0, hours: 0 } };
  let senderChannels = 0, receiverChannels = 0, totalCcBpmSteps = 0, customMappingCount = 0;

  for (const a of artifacts) {
    byType[a.artifactType] = (byType[a.artifactType] || 0) + 1;
    const w = [1, 2, 3].includes(Number(a.waveNumber)) ? Number(a.waveNumber) : 2;
    byWave[w].count += 1;
    byWave[w].hours += Number(a.estimatedHours || 0);
    if (a.artifactType === 'CommunicationChannel') {
      const adp = a.adapterType || 'Other';
      byAdapter[adp] = (byAdapter[adp] || 0) + 1;
      if (/sender|inbound/i.test(a.direction || '')) senderChannels += 1;
      else if (/receiver|outbound/i.test(a.direction || '')) receiverChannels += 1;
    }
    if (a.isCcBpm) totalCcBpmSteps += Number(a.processSteps || 0);
    if (/Mapping/.test(a.artifactType) && a.hasCustomCode) customMappingCount += 1;
  }

  const icoList = artifacts.filter((a) => a.artifactType === 'IntegratedConfiguration');
  const siList = artifacts.filter((a) => a.artifactType === 'ServiceInterface');
  const omList = artifacts.filter((a) => a.artifactType === 'OperationMapping');
  const mmList = artifacts.filter((a) => a.artifactType === 'MessageMapping');
  const bpmList = artifacts.filter((a) => a.artifactType === 'IntegrationProcess');
  const chList = artifacts.filter((a) => a.artifactType === 'CommunicationChannel');
  const tplList = artifacts.filter((a) => a.artifactType === 'ChannelTemplate');

  const esrTotal = artifacts.filter((a) => a.sourceArea === 'ESR').length;
  const dirTotal = artifacts.filter((a) => a.sourceArea !== 'ESR').length;
  const failedEps = endpoints.filter((e) => ['failed', 'unavailable', 'unknown'].includes(e.status) || (e.httpStatus && e.httpStatus >= 400));

  // Cross-reference ESR vs Directory usage
  const icoLinkedMappings = new Set(
    dependencies.filter((d) => d.referenceKind === 'operation-mapping').map((d) => String(d.targetKey || '').split('|')[0])
  );
  const icoLinkedInterfaces = new Set([
    ...icoList.map((i) => {
      try { return JSON.parse(i.metadataJson || '{}')?.identifier?.InterfaceName; } catch { return null; }
    }).filter(Boolean),
    ...dependencies.filter((d) => d.referenceKind === 'receiver-interface').map((d) => String(d.targetKey || '').split('|')[0])
  ]);
  const unreferencedSiCount = siList.filter((s) => !icoLinkedInterfaces.has(s.name)).length;
  const unreferencedOmCount = omList.filter((m) => !icoLinkedMappings.has(m.name)).length;

  const adapterSummaryText = Object.entries(byAdapter)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(', ') || 'none exported';

  const architectNarrative = [
    `Landscape ${runRow.systemName} (${runRow.systemVersion || '7.50'}) yielded ${artifacts.length} catalogued PI/PO artifacts (${dirTotal} Integration Directory runtime objects with exporter-verified definitions and ${esrTotal} Enterprise Services Repository design objects).`,
    `Active routing comprises ${icoList.length} Integrated Configurations (ICOs) backed by ${chList.length} Communication Channels (${senderChannels} Sender / ${receiverChannels} Receiver across ${adapterSummaryText}).`,
    `Transformation & orchestration inventory spans ${omList.length} Operation Mappings, ${mmList.length} Message Mappings (${customMappingCount} retaining compressed Java/UDF source or bytecode blobs requiring Groovy inspection), ${bpmList.length} ccBPM Integration Processes (${totalCcBpmSteps} aggregate process steps requiring stateless/JMS Cloud Integration redesign), and ${tplList.length} Channel Templates.`,
    failedEps.length
      ? `${failedEps.length} discovery endpoint(s) reported restrictions or unavailability (notably ${failedEps.map((e) => `${e.path} [HTTP ${e.httpStatus || 'ERR'}]`).slice(0, 3).join(', ')}); inspect Failures & Diagnostics before final cutover sign-off.`
      : 'All queried discovery endpoints responded without transport or authorization faults.'
  ].join(' ');

  const deepDives = {
    interfaces: {
      title: `Interfaces Found (${icoList.length} Active ICOs · ${siList.length} ESR Service Interfaces)`,
      insight: 'Active ICOs represent live runtime flows and anchor Wave 1–3 scope; unlinked ESR Service Interfaces are preserved for contract reference.',
      columns: ['Name', 'Type', 'Area', 'Sender → Receiver / Pattern', 'Adapter', 'Tier / Wave', 'Recommended Target'],
      rows: [...icoList, ...siList].slice(0, 200).map((a) => [
        a.name,
        a.artifactType,
        a.sourceArea,
        a.senderComponent || a.receiverComponent ? `${a.senderComponent || '*'} → ${a.receiverComponent || '*'}` : (a.namespace || 'ESR Design Contract'),
        a.adapterType || 'SOAP/XI',
        `${a.complexityTier} (Wave ${a.waveNumber})`,
        a.proposedTarget
      ])
    },
    failures: {
      title: `Failures & Endpoint Diagnostics (${failedEps.length} Flagged of ${endpoints.length || 23} Endpoints)`,
      insight: 'Layer-attributed diagnostics separate BTP/MCP transport checks from PI/PO UME role or Cloud Connector ACL restrictions.',
      columns: ['Endpoint Path', 'Tool', 'HTTP', 'Status', 'Layer', 'Diagnostic Code & Architect Remediation'],
      rows: (failedEps.length ? failedEps : endpoints).map((e) => [
        e.path,
        e.tool,
        e.httpStatus ?? '—',
        e.status,
        e.diagnostic?.layer || 'source',
        `${e.diagnostic?.code || 'INFO'}: ${e.diagnostic?.reason || ''} ${e.diagnostic?.remediation || ''}`.trim()
      ])
    },
    complexities: {
      title: `Complexities, Mappings & ccBPM (${bpmList.length} ccBPM · ${omList.length + mmList.length} Mappings)`,
      insight: 'ccBPM stateful processes and Message Mappings with Java/UDF bytecode blobs drive Wave 3 effort.',
      columns: ['Artifact Name', 'Type', 'Complexity Drivers', 'Score', 'Tier / Wave', 'Est. Effort', 'Target Pattern'],
      rows: [...artifacts]
        .sort((a, b) => b.complexityScore - a.complexityScore)
        .slice(0, 120)
        .map((a) => [
          a.name,
          a.artifactType,
          a.isCcBpm
            ? `ccBPM stateful orchestration (${a.processSteps} steps)`
            : a.hasCustomCode
              ? 'Compressed Java/UDF blob or custom adapter module'
              : a.adapterType ? `Adapter: ${a.adapterType} (${a.direction || 'bidirectional'})` : 'Standard ESR design object',
          `${a.complexityScore}/100`,
          `${a.complexityTier} · Wave ${a.waveNumber}`,
          `${a.estimatedHours}h`,
          a.proposedTarget
        ])
    },
    coverage: {
      title: `Discovery Coverage & Dependency Graph (${runRow.verifiedDefs || dirTotal} Verified · ${dependencies.length} Refs)`,
      insight: 'Verified Directory XML definitions establish routing; unmatched ESR links typically reference standard SAP BASIS types outside custom SWCVs.',
      columns: ['Dimension', 'Observed Metric', 'Architect Interpretation'],
      rows: [
        ['Catalogued Artifacts', `${artifacts.length} total (${dirTotal} Directory, ${esrTotal} ESR)`, '100% of enumerated identifiers processed during bounded export.'],
        ['Exporter-Verified Definitions', `${runRow.verifiedDefs || dirTotal} full XML definitions`, `${icoList.length} ICOs and ${chList.length} Communication Channels verified.`],
        ['ESR Retained Payloads', `${esrTotal} identity-checked xiObj bodies`, 'Metadata, links, process step counts, and compressed mapping blob indicators extracted.'],
        ['Explicit Dependency Edges', `${dependencies.length} total (${runRow.matchedRefs || 0} matched · ${runRow.unmatchedRefs || 0} unmatched)`, 'All ICO inbound/outbound channel links resolved; unmatched links require SAP BASIS / XSD check before build.'],
        ['WSDL Service Contracts', `${summaryMeta.metadataDocuments ?? 8} WSDL documents`, 'Protocol metadata retained where Configuration records returned 0 items or 403.']
      ]
    },
    esr_vs_dir: {
      title: `ESR Design-Time (${esrTotal}) vs Integration Directory Runtime (${dirTotal})`,
      insight: 'Comparing ESR against active Directory ICOs prevents migrating dormant legacy interfaces and unused mappings.',
      columns: ['Comparison Axis', 'ESR (Repository)', 'Integration Directory', 'Architect Alignment Finding'],
      rows: [
        ['Interfaces vs Active Flows', `${siList.length} Service Interfaces`, `${icoList.length} Integrated Configurations`, `${unreferencedSiCount} ESR Service Interface(s) have no active ICO reference in this snapshot (candidate dormant/reusable contracts).`],
        ['Mappings vs ICO Rules', `${omList.length} Op Mappings · ${mmList.length} Msg Mappings`, `${icoLinkedMappings.size} distinct Op Mapping ref(s) in ICOs`, `${unreferencedOmCount} Operation Mapping(s) are not directly referenced by exported ICOs — verify dynamic/ccBPM invocation before migrating.`],
        ['Channels vs Templates', `${tplList.length} Channel Templates`, `${chList.length} Configured Channels (${senderChannels} Snd / ${receiverChannels} Rcv)`, `Adapter distribution: ${adapterSummaryText}.`],
        ['Process Orchestration', `${bpmList.length} Integration Processes (${totalCcBpmSteps} steps)`, 'BPMFacade / IntegrationProcess SOAP', 'ESR process structures retained; refactor stateful correlations into Cloud Integration JMS queues + DataStores.']
      ]
    }
  };

  const activeFilter = Object.hasOwn(deepDives, requestedFilter) ? requestedFilter : 'interfaces';

  return {
    runId: runRow.ID,
    systemName: runRow.systemName,
    systemVersion: runRow.systemVersion,
    subaccount: runRow.subaccount,
    locationId: runRow.locationId,
    completedAt: runRow.completedAt,
    manifestSha256: runRow.manifestSha256,
    planRevisionHash: runRow.planRevisionHash,
    nonCancellable: true,
    architectNarrative,
    kpis: {
      totalObjects: artifacts.length,
      esrCount: esrTotal,
      dirCount: dirTotal,
      verifiedDefinitions: runRow.verifiedDefs || dirTotal,
      icoCount: icoList.length,
      channelCount: chList.length,
      senderChannels,
      receiverChannels,
      serviceInterfaceCount: siList.length,
      operationMappingCount: omList.length,
      messageMappingCount: mmList.length,
      customMappingCount,
      ccBpmCount: bpmList.length,
      totalCcBpmSteps,
      channelTemplateCount: tplList.length,
      failedEndpointCount: failedEps.length,
      matchedReferences: runRow.matchedRefs || 0,
      unmatchedReferences: runRow.unmatchedRefs || 0
    },
    charts: {
      esrVsDirDonut: [
        { label: 'ESR Design Objects', count: esrTotal, color: '#131417' },
        { label: 'Directory Runtime Config', count: dirTotal, color: '#e5a93b' }
      ],
      objectTypeBars: Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
      adapterBars: Object.entries(byAdapter).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
      waveBars: [
        { wave: 1, label: 'Wave 1 · Simple', count: byWave[1].count, hours: Number(byWave[1].hours.toFixed(1)), color: '#16a34a' },
        { wave: 2, label: 'Wave 2 · Medium', count: byWave[2].count, hours: Number(byWave[2].hours.toFixed(1)), color: '#d97706' },
        { wave: 3, label: 'Wave 3 · Complex', count: byWave[3].count, hours: Number(byWave[3].hours.toFixed(1)), color: '#dc2626' }
      ]
    },
    activeFilter,
    availableFilters: ['interfaces', 'failures', 'complexities', 'coverage', 'esr_vs_dir'],
    deepDive: deepDives[activeFilter],
    allDeepDives: deepDives
  };
}

module.exports = {
  classifyPipoObject,
  buildSemanticChunks,
  computePlanRevisionHash,
  buildArchitectReport
};
