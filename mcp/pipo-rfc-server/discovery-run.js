'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const cds = require('@sap/cds');
const { summarizeDiscovery } = require('./discovery-report');
const { ENDPOINTS } = require('./pipo-endpoints');
const { projectDiagnostic } = require('./discovery-diagnostics');

const EVENTS = new Set(['start', 'finish', 'failed', 'run-start', 'run-finish', 'run-failed',
  'endpoint-start', 'endpoint-finish', 'endpoint-result', 'query-start', 'query-finish',
  'read-start', 'read-finish', 'read-result', 'export-start', 'export-finish', 'cache-hit', 'cache-miss']);
const PHASES = new Set(['discovery', 'probe', 'query', 'read', 'export', 'report', 'complete', 'failed']);
const STATUSES = new Set(['started', 'ok', 'success', 'successful', 'completed', 'failed', 'error',
  'partial', 'unavailable', 'unsupported', 'not-found', 'skipped', 'metadata-only', 'needs_parameters',
  'unauthorized', 'forbidden', 'timeout', 'reachable', 'unknown']);
const LEGACY_CODES = { UNAUTHORIZED: 'AUTH_REQUIRED', TIMEOUT: 'UNAVAILABLE', RUN_FAILED: 'FAILED' };
const COUNT_KEYS = ['total', 'successful', 'failed', 'unavailable', 'unknown', 'metadataOnly',
  'artifacts', 'catalogIdentifiers', 'fullDefinitions', 'interfaces', 'metadataDocuments',
  'diagnosticSnapshots', 'reads', 'attempted', 'completed', 'exported', 'hits', 'misses', 'bypassed'];
const TOOLS = new Set(ENDPOINTS.map(({ tool }) => tool));
const TYPES = {
  ifmmessif: 'ServiceInterface', serviceinterface: 'ServiceInterface',
  mapping: 'OperationMapping', operationmapping: 'OperationMapping',
  xitrafo: 'MessageMapping', messagemapping: 'MessageMapping',
  channeltemplate: 'CommunicationChannelTemplate', communicationchanneltemplate: 'CommunicationChannelTemplate',
  repbprocess: 'IntegrationProcess', integrationprocess: 'IntegrationProcess',
  datatype: 'DataType', messagetype: 'MessageType', externaldefinition: 'ExternalDefinition',
  communicationchannel: 'CommunicationChannel', businesssystem: 'BusinessSystem',
  businesscomponent: 'BusinessComponent', alertrule: 'AlertRule', receiverrule: 'ReceiverRule',
  configurationscenario: 'ConfigurationScenario', integratedconfiguration: 'IntegratedConfiguration',
  integratedconfigurationobject: 'IntegratedConfiguration', receiverdetermination: 'ReceiverDetermination',
  interfacedetermination: 'InterfaceDetermination', receiveragreement: 'ReceiverAgreement',
  senderagreement: 'SenderAgreement', valuesmapping: 'ValueMapping', valuemapping: 'ValueMapping'
};

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const items = value => Array.isArray(value) ? value.filter(record) : [];
const key = value => typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const allowed = (value, choices) => choices.has(value) ? value : 'unknown';
const safeError = () => new Error('Discovery run could not be written.');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function category(value) {
  if (['repository', 'esr'].includes(key(value))) return 'ESR';
  return ['Directory', 'Configuration', 'Metadata', 'Monitoring'].find(label => key(label) === key(value)) || 'Other';
}

function diagnostic(value) {
  if (!record(value)) return undefined;
  const result = projectDiagnostic({ ...value,
    code: Object.hasOwn(LEGACY_CODES, value.code) ? LEGACY_CODES[value.code] : value.code });
  if (typeof value.retryable === 'boolean') result.retryable = value.retryable;
  return result;
}

function project(data, runId, timestamp) {
  const input = record(data) ? data : {};
  const entry = { timestamp, runId, event: allowed(input.event, EVENTS),
    phase: allowed(input.phase, PHASES), tool: TOOLS.has(input.tool) ? input.tool : 'unknown',
    status: allowed(input.status, STATUSES) };
  if (Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599) entry.httpStatus = input.httpStatus;
  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0) entry.durationMs = input.durationMs;
  if (record(input.counts)) {
    entry.counts = {};
    for (const name of COUNT_KEYS) if (integer(input.counts[name])) entry.counts[name] = input.counts[name];
  }
  const detail = diagnostic(input.diagnostic);
  if (detail) entry.diagnostic = detail;
  return entry;
}

function log(entry) {
  // Only this named CAP logger is changed, never the global factory/formatter.
  try {
    const logger = cds.log('pipo-discovery');
    const format = (_label, _level, value) => [`[pipo-discovery] ${JSON.stringify(value)}`];
    logger.setFormat(format);
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
      const level = method === 'log' ? 'info' : method;
      logger[method] = value => {
        if (logger[`_${level}`]) process.stderr.write(`${format(logger.label, logger.level, value)[0]}\n`);
      };
    }
    logger.info(entry);
  } catch { /* Logging must not expose or replace a filesystem failure. */ }
}

function outcome(value) {
  if (['failed', 'error', 'partial', 'unauthorized', 'forbidden', 'timeout', 'needs_parameters'].includes(value.status) ||
      (value.httpStatus >= 400 && ![404, 405, 410, 501, 503].includes(value.httpStatus)) ||
      (Array.isArray(value.errors) ? value.errors.length > 0 :
        record(value.errors) ? Object.keys(value.errors).length > 0 : Boolean(value.errors))) return 'failed';
  if (['unavailable', 'unsupported', 'skipped', 'not-found'].includes(value.status) ||
      [404, 405, 410, 501, 503].includes(value.httpStatus)) return 'unavailable';
  if (value.metadataOnly === true || value.status === 'metadata-only') return 'metadataOnly';
  if (['ok', 'success', 'successful', 'completed', 'reachable'].includes(value.status) ||
      (value.httpStatus >= 200 && value.httpStatus < 300)) return 'successful';
  return 'unknown';
}

function escape(value) {
  // Source URLs belong in discovery.json, not in a portable HTML report.
  return String(value).replace(/(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s<>"']+/gi, '[source URL omitted]')
    .replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function chart(title, values) {
  const maximum = Math.max(1, ...values.map(([, count]) => count));
  const bars = values.map(([label, count], index) => {
    const y = index * 30 + 8;
    return `<text x="0" y="${y + 15}">${escape(label)}</text><rect x="230" y="${y}" width="${Math.round(count / maximum * 270)}" height="20"/><text x="510" y="${y + 15}">${count}</text>`;
  }).join('');
  return `<section><h2>${escape(title)}</h2><svg role="img" aria-label="${escape(title)}" viewBox="0 0 580 ${Math.max(40, values.length * 30 + 10)}">${bars}</svg></section>`;
}

function groupEntries(entries, identity) {
  const groups = new Map();
  for (const entry of entries) {
    const id = JSON.stringify(identity(entry));
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entry);
  }
  return [...groups.values()];
}

function report(runId, status, summary, gaps, files, entries) {
  const outcomes = ['successful', 'metadataOnly', 'failed', 'unavailable', 'unknown'];
  const coverage = summary.coverage || {};
  const reads = summary.readCoverage || {};
  const charts = status === 'failed' ? '' : chart('Endpoint outcomes', outcomes.map(name => [name, coverage[name] || 0])) +
    chart('Artifact types', Object.entries(Object.keys(summary.types || {}).length ? summary.types : summary.exportedTypes || { Other: 0 })) +
    chart('Read coverage', outcomes.map(name => [name, reads[name] || 0]));
  const diagnostics = groupEntries(entries.filter(entry => (entry.diagnostic && entry.diagnostic.code !== 'OK') ||
    ['failed', 'unavailable', 'unknown'].includes(outcome(entry))),
    entry => [entry.tool, entry.httpStatus, entry.diagnostic]);
  const failures = diagnostics.length ? diagnostics.map(group => {
    const entry = group[0];
    const detail = entry.diagnostic || diagnostic({ code: 'RUN_FAILED' });
    const roles = detail.roleAssessment.candidates.map(candidate => `<li>${escape(candidate.role)}: evidence=${escape(candidate.evidence)}; inventory=${candidate.present === true ? 'present' : candidate.present === false ? 'absent' : 'unknown'}</li>`).join('');
    return `<li><strong>${escape(entry.tool)}: ${escape(entry.status)} (${escape(detail.code)})</strong>; HTTP: ${entry.httpStatus ?? 'unknown'}; layer: ${escape(detail.layer)}<p>Reason: ${escape(detail.reason)}</p><p>Remediation: ${escape(detail.remediation)}</p><p>Role inventory: ${escape(detail.roleAssessment.inventory)}; effective permissions: not verified.</p>${roles ? `<ul>${roles}</ul>` : ''}</li>`;
  }).join('') : '<li>No failure diagnostics recorded.</li>';
  const distinct = (group, select) => [...new Set(group.map(select).filter(value => value !== undefined))];
  const rows = groupEntries(entries.filter(entry => TOOLS.has(entry.tool)),
    entry => [entry.tool, entry.status, entry.httpStatus]).map(group => {
    const entry = group[0];
    const cells = [entry.tool, entry.status, entry.httpStatus ?? 'unknown',
      distinct(group, value => value.phase).join(', '), distinct(group, value => value.event).join(', '),
      distinct(group, value => value.counts && JSON.stringify(value.counts)).join('; ') || 'none',
      distinct(group, value => value.diagnostic && JSON.stringify(value.diagnostic)).length];
    return `<tr>${cells.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`;
  }).join('');
  const links = files.map(file => `<li><a href="${file.filename}">${file.filename}</a> (${file.size} bytes; SHA256 ${file.hash})</li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>PI/PO discovery report</title><style>
body{font:16px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#172b4d;background:#f5f7fa}
section{background:white;padding:1rem;margin:1rem 0;border-radius:8px}svg{width:100%;max-width:760px}rect{fill:#176b99}text{fill:#172b4d;font:14px system-ui,sans-serif}
li{margin:.5rem 0;overflow-wrap:anywhere}a{color:#075b90}.warning{border-left:5px solid #b95000;padding:1rem;background:#fff3df}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border:1px solid #ccd5df;padding:.5rem;overflow-wrap:anywhere}
</style></head><body><h1>PI/PO discovery report</h1><p>Run: ${escape(runId)}; status: ${escape(status)}</p>
<p class="warning"><strong>migrationReady=false</strong> — Discovery does not establish migration readiness.</p>
<section><h2>Gaps</h2><ul>${gaps.map(gap => `<li>${escape(typeof gap === 'string' ? gap : JSON.stringify(gap))}</li>`).join('')}</ul></section>
${charts}<section><h2>Endpoint outcomes table</h2><table><thead><tr><th>Tool</th><th>Status</th><th>HTTP status</th><th>Phase</th><th>Event</th><th>Counts</th><th>Distinct diagnostics</th></tr></thead><tbody>${rows}</tbody></table></section>
<section><h2>Failure diagnostics</h2><p>Role inventory presence or absence does not verify effective permissions; an absent role is not a verified missing permission.</p><ul>${failures}</ul></section>
<section><h2>Generated files</h2><ul>${links}<li><a href="manifest.json">manifest.json</a></li></ul></section></body></html>\n`;
}

async function createRun({ outputDir = 'discovery-runs', env = process.env, clock = () => new Date() } = {}) {
  // env is accepted for caller compatibility, but is never persisted or logged.
  void env;
  let directory;
  let runId;
  let startedAt;
  try {
    startedAt = clock().toISOString();
    const parent = path.resolve(outputDir);
    await fs.mkdir(parent, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      runId = `${startedAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
      directory = path.join(parent, runId);
      try { await fs.mkdir(directory); break; }
      catch (error) { if (error.code !== 'EEXIST' || attempt === 4) throw safeError(); }
    }
    await fs.writeFile(path.join(directory, 'events.jsonl'), '', { encoding: 'utf8', flag: 'wx' });
  } catch { throw safeError(); }

  // All module log calls receive projected entries and use stderr only.
  let state = 'open';
  let pending = Promise.resolve();
  const entries = [];
  const files = [];
  const filenames = new Set();
  const timestamp = () => clock().toISOString();

  async function save(filename, content) {
    const bytes = Buffer.from(content, 'utf8');
    const target = path.join(directory, filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
    const entry = { filename, size: bytes.length, hash: digest(bytes) };
    files.push(entry);
    filenames.add(filename);
    return entry;
  }

  async function artifact(group, type, value) {
    const content = json(value);
    const filename = `artifacts/${group}/${type}/${digest(Buffer.from(content, 'utf8'))}.json`;
    // Content-addressed duplicates share a file; existing bytes are never rewritten.
    if (!filenames.has(filename)) await save(filename, content);
    return filename;
  }

  function event(data) {
    if (state !== 'open') return Promise.reject(safeError());
    let entry;
    try { entry = project(data, runId, timestamp()); }
    catch { return Promise.reject(safeError()); }
    pending = pending.then(async () => {
      await fs.appendFile(path.join(directory, 'events.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
      if (entry.status !== 'started') entries.push(entry);
      log(entry);
    });
    // Keep queue failures visible to finish/fail; return only generic errors.
    return pending.catch(() => { throw safeError(); });
  }

  async function recordEvents() {
    const bytes = await fs.readFile(path.join(directory, 'events.jsonl'));
    if (!files.some(file => file.filename === 'events.jsonl')) {
      files.push({ filename: 'events.jsonl', size: bytes.length, hash: digest(bytes) });
    }
  }

  async function finish(output) {
    if (state !== 'open') throw safeError();
    state = 'finishing';
    try {
      await pending;
      const data = record(output) ? output : {};
      const reads = items(data.export?.reads);
      const readCoverage = { total: reads.length, successful: 0, metadataOnly: 0, failed: 0, unavailable: 0, unknown: 0 };
      let exportedDefinitions = 0;
      let esrResponseBodies = 0;
      const exportedTypes = {};
      const artifactIndex = [];
      for (const read of reads) {
        const result = record(read.result) ? read.result : {};
        const readOutcome = outcome(result);
        readCoverage[readOutcome] += 1;
        entries.push(project({ event: 'read-result', phase: 'read', tool: result.tool || read.tool,
          status: result.status || (readOutcome === 'metadataOnly' ? 'metadata-only' : readOutcome),
          httpStatus: result.httpStatus, counts: result.counts,
          diagnostic: result.diagnostic }, runId, timestamp()));
        for (const item of items(result.artifacts)) {
          if (item.hasFullDefinition !== true || item.metadataOnly === true || item.definition == null ||
              read.verifiedDefinition === false || readOutcome !== 'successful') continue;
          const type = Object.hasOwn(TYPES, key(item.type || item.objectType)) ? TYPES[key(item.type || item.objectType)] : 'Other';
          const filename = await artifact(category(item.category || result.category || read.category), type, item);
          artifactIndex.push({ sourceTool: read.sourceTool || result.tool, identifier: read.identifier,
            type, verifiedDefinition: true, filename });
          exportedDefinitions += 1;
          exportedTypes[type] = (exportedTypes[type] || 0) + 1;
        }
        const descriptor = ENDPOINTS.find(endpoint => endpoint.tool === (result.tool || read.tool) || endpoint.path === result.path);
        const isESR = category(result.category || read.category) === 'ESR' || descriptor?.category === 'Repository';
        if (isESR && result.response?.body != null) {
          const filename = await artifact('ESR', 'ReadResponse', result.response.body);
          artifactIndex.push({ sourceTool: read.sourceTool || result.tool, identifier: read.identifier,
            type: 'ReadResponse', verifiedDefinition: false, filename });
          esrResponseBodies += 1;
        }
      }
      const gaps = ['Full definitions, dependencies and target-platform compatibility have not been validated.'];
      if (readCoverage.total === 0) gaps.push('No full-definition Read requests were recorded.');
      if (readCoverage.successful < readCoverage.total) gaps.push('Read coverage is incomplete; some requests did not produce a successful result.');
      if (exportedDefinitions === 0) gaps.push('No full artifact definitions were exported.');
      for (const value of [data.gaps, data.export?.gaps]) {
        if (Array.isArray(value)) for (const gap of value) if (typeof gap === 'string' || record(gap)) gaps.push(gap);
      }
      const summary = { ...summarizeDiscovery(data), readCoverage, exportedDefinitions, exportedTypes,
        esrResponseBodies, migrationReady: false, gaps };
      for (const endpoint of items(data.discovery?.endpoints)) {
        const endpointOutcome = outcome(endpoint);
        entries.push(project({ event: 'endpoint-result', phase: 'discovery', tool: endpoint.tool,
          status: endpoint.status || (endpointOutcome === 'metadataOnly' ? 'metadata-only' : endpointOutcome),
          httpStatus: endpoint.httpStatus, counts: endpoint.counts,
          diagnostic: endpoint.diagnostic }, runId, timestamp()));
      }
      const finishedAt = timestamp();
      await save('discovery.json', json(data));
      await save('artifact-index.json', json(artifactIndex));
      await save('summary.json', json(summary));
      await recordEvents();
      await save('report.html', report(runId, 'completed', summary, gaps, files, entries));
      // A manifest cannot hash itself. Every other generated file is inventoried.
      const manifest = { runId, startedAt, finishedAt, status: 'completed', migrationReady: false, gaps, files: [...files] };
      await save('manifest.json', json(manifest));
      state = 'finished';
      if (!entries.some(entry => entry.event === 'run-finish')) {
        log(project({ event: 'run-finish', phase: 'complete', status: 'completed',
          counts: { exported: exportedDefinitions, reads: reads.length } }, runId, finishedAt));
      }
      return manifest;
    } catch { state = 'write-failed'; throw safeError(); }
  }

  async function fail() {
    if (!['open', 'write-failed'].includes(state)) throw safeError();
    state = 'failing';
    try {
      await pending.catch(() => {});
      const finishedAt = timestamp();
      const gaps = ['Discovery failed. No migration-readiness conclusion can be drawn.'];
      const suppliedFailure = entries.find(entry => entry.event === 'run-failed');
      const failure = suppliedFailure || project({ event: 'run-failed', phase: 'failed', status: 'failed',
        diagnostic: { code: 'RUN_FAILED' } }, runId, finishedAt);
      if (!suppliedFailure) entries.push(failure);
      await recordEvents();
      await save('report.html', report(runId, 'failed', {}, gaps, files, entries));
      const manifest = { runId, startedAt, finishedAt, status: 'failed', migrationReady: false,
        message: 'Discovery failed.', gaps, files: [...files] };
      await save('manifest.json', json(manifest));
      state = 'failed';
      if (!suppliedFailure) log(failure);
      return manifest;
    } catch { state = 'write-failed'; throw safeError(); }
  }

  return { directory, runId, event, finish, fail };
}

module.exports = { createRun };