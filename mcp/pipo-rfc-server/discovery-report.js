'use strict';

// Only these labels may reach the logger. Unknown upstream labels are not safe
// to print: they can contain response bodies, credentials or terminal escapes.
const CATEGORIES = ['ESR', 'Directory', 'Configuration', 'Metadata', 'Monitoring', 'Other'];
const TYPE_LABELS = {
  ifmmessif: 'Service Interface',
  serviceinterface: 'Service Interface',
  mapping: 'Operation Mapping',
  operationmapping: 'Operation Mapping',
  xitrafo: 'Message Mapping',
  messagemapping: 'Message Mapping',
  channeltemplate: 'Communication Channel Template',
  communicationchanneltemplate: 'Communication Channel Template',
  repbprocess: 'Integration Process',
  integrationprocess: 'Integration Process',
  datatype: 'Data Type',
  messagetype: 'Message Type',
  externaldefinition: 'External Definition',
  communicationchannel: 'Communication Channel',
  businesssystem: 'Business System',
  businesscomponent: 'Business Component',
  alertrule: 'Alert Rule',
  receiverrule: 'Receiver Rule',
  configurationscenario: 'Configuration Scenario',
  integratedconfiguration: 'Integrated Configuration',
  integratedconfigurationobject: 'Integrated Configuration',
  receiverdetermination: 'Receiver Determination',
  interfacedetermination: 'Interface Determination',
  receiveragreement: 'Receiver Agreement',
  senderagreement: 'Sender Agreement',
  valuesmapping: 'Value Mapping',
  valuemapping: 'Value Mapping'
};
const SAFE_TYPES = [...new Set(Object.values(TYPE_LABELS)), 'Other'];
const METADATA_TYPES = new Set(['wsdl', 'wsdldocument', 'metadata', 'metadatadocument', 'servicemetadata']);
const DIAGNOSTIC_TYPES = new Set(['diagnostic', 'diagnostics', 'snapshot', 'diagnosticsnapshot', 'monitoringsnapshot']);
const ENDPOINT_TYPES = new Set(['endpoint', 'reachableendpoint', 'probe', 'httpprobe']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function key(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

function category(value, fallback = 'Other') {
  if (key(value) === 'repository') return 'ESR';
  return CATEGORIES.find((label) => key(label) === key(value)) || fallback;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function reportedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function emptyCounts() {
  return { catalogIdentifiers: 0, fullDefinitions: 0, interfaces: 0,
    metadataDocuments: 0, diagnosticSnapshots: 0, types: {} };
}

function emptyCoverage() {
  return { total: 0, successful: 0, metadataOnly: 0, failed: 0, unavailable: 0, unknown: 0 };
}

function endpointOutcome(endpoint) {
  const status = key(endpoint.status);
  const httpStatus = Number.isInteger(endpoint.httpStatus) ? endpoint.httpStatus : 0;
  if (['unavailable', 'unreachable', 'unsupported', 'notfound', 'notconfigured', 'skipped', 'disabled'].includes(status) ||
      [404, 405, 410, 501, 503].includes(httpStatus)) return 'unavailable';
  const errors = endpoint.errors;
  const hasErrors = Array.isArray(errors) ? errors.length > 0 :
    record(errors) ? Object.keys(errors).length > 0 : Boolean(errors);
  if (['failed', 'failure', 'error', 'partial', 'needsparameters', 'unauthorized', 'forbidden', 'timeout'].includes(status) ||
      httpStatus >= 400 || hasErrors) return 'failed';
  if (['ok', 'success', 'successful', 'available', 'reachable'].includes(status) ||
      (httpStatus >= 200 && httpStatus < 300)) return 'successful';
  return 'unknown';
}

function hasDefinition(item) {
  if (item.hasFullDefinition === false) return false;
  const kind = key(item.kind);
  return item.hasFullDefinition === true || item.isFullDefinition === true ||
    ['definition', 'fulldefinition'].includes(kind) ||
    (typeof item.definition === 'string' && item.definition.trim().length > 0) ||
    (record(item.definition) && Object.keys(item.definition).length > 0);
}

function classify(item, fallbackCategory, metadataOnly) {
  let group = category(item.category, fallbackCategory);
  // A technical type wins over a display label, even when it is unknown.
  const type = key(item.type || item.typeLabel);
  const kind = key(item.kind);
  if (ENDPOINT_TYPES.has(type) || ENDPOINT_TYPES.has(kind)) return null;
  if (group === 'Monitoring' || DIAGNOSTIC_TYPES.has(type) || DIAGNOSTIC_TYPES.has(kind)) {
    if (group === 'Other') group = 'Monitoring';
    return { group, metric: 'diagnosticSnapshots' };
  }
  if (metadataOnly || item.metadataOnly === true || group === 'Metadata' ||
      METADATA_TYPES.has(type) || METADATA_TYPES.has(kind) || type.startsWith('wsdl')) {
    if (group === 'Other') group = 'Metadata';
    return { group, metric: 'metadataDocuments' };
  }
  if (group === 'Directory' && ['integratedconfiguration', 'configurationscenario'].includes(type)) group = 'Configuration';
  if (![item.type, item.typeLabel, item.name].some((value) => typeof value === 'string' && value.trim())) return null;
  const label = Object.hasOwn(TYPE_LABELS, type) ? TYPE_LABELS[type] : 'Other';
  return { group, metric: 'catalogIdentifiers', label };
}

/**
 * Summarize extracted records, never endpoint reachability or artifactCount.
 * types contains catalog-only counts keyed by safe display labels. Explicit
 * full definitions are a subset of catalogIdentifiers, not an extra artifact.
 * Metadata/snapshot counts require records; a successful probe alone is not one.
 */
function summarizeDiscovery(output = {}) {
  const data = record(output) ? output : {};
  const discovery = record(data.discovery) ? data.discovery : {};
  const objects = record(data.objects) ? data.objects : {};
  const endpoints = Array.isArray(discovery.endpoints) ? discovery.endpoints.filter(record) : [];
  const pages = Array.isArray(discovery.pages) ? discovery.pages.filter(record) : [];
  const summary = { source: 'none', ...emptyCounts(),
    reportedTotal: reportedCount(objects.totalCount),
    reportedReturned: reportedCount(objects.returned),
    cache: { hits: 0, misses: 0, bypassed: 0 },
    truncatedEndpoints: 0,
    categories: {}, coverage: { ...emptyCoverage(), categories: {} } };

  for (const endpoint of endpoints) {
    if (endpoint.cache?.backend === 'cap-db') {
      summary.cache[endpoint.cache.hit === true ? 'hits' : 'misses'] += 1;
    } else if (endpoint.cache?.backend === 'none') summary.cache.bypassed += 1;
    if (endpoint.truncated === true) summary.truncatedEndpoints += 1;
    const group = category(endpoint.category);
    const coverage = summary.coverage.categories[group] ||= emptyCoverage();
    summary.categories[group] ||= emptyCounts();
    const outcome = endpointOutcome(endpoint);
    for (const counts of [summary.coverage, coverage]) {
      counts.total += 1;
      counts[outcome] += 1;
      if (endpoint.metadataOnly === true) counts.metadataOnly += 1;
    }
  }

  let entries;
  if (Array.isArray(discovery.artifacts)) {
    summary.source = 'discovery';
    entries = discovery.artifacts.map((item) => ({ item, group: 'Other', metadataOnly: false }));
  } else if (Array.isArray(objects.items)) {
    summary.source = 'legacy';
    entries = objects.items.map((item) => ({ item, group: 'ESR', metadataOnly: false }));
  } else {
    // Endpoint-local records are a fallback, not another copy of the aggregate.
    summary.source = endpoints.some((endpoint) => Array.isArray(endpoint.artifacts)) ? 'endpoints' : 'none';
    entries = [...endpoints, ...pages].flatMap((endpoint) => (Array.isArray(endpoint.artifacts) ? endpoint.artifacts : [])
      .map((item) => ({ item, group: category(endpoint.category), metadataOnly: endpoint.metadataOnly === true })));
  }

  for (const { item, group, metadataOnly } of entries) {
    if (!record(item)) continue;
    const classified = classify(item, group, metadataOnly);
    if (!classified) continue;
    const counts = summary.categories[classified.group] ||= emptyCounts();
    const definition = classified.metric === 'catalogIdentifiers' && hasDefinition(item);
    for (const target of [summary, counts]) {
      target[classified.metric] += 1;
      if (classified.metric !== 'catalogIdentifiers') continue;
      target.types[classified.label] = (target.types[classified.label] || 0) + 1;
      if (classified.label === 'Service Interface') target.interfaces += 1;
      if (definition) target.fullDefinitions += 1;
    }
  }
  return summary;
}

// Read only fixed keys and format only validated integers. Even a summary that
// did not come from summarizeDiscovery cannot inject upstream text into logs.
function logSummary(summary, log) {
  if (typeof log !== 'function') throw new TypeError('A summary logger function is required.');
  const data = record(summary) ? summary : {};
  log(`Extracted catalog identifiers: ${count(data.catalogIdentifiers)}; service interfaces: ${count(data.interfaces)}.`);
  log(`Full definitions: ${count(data.fullDefinitions)}; metadata documents: ${count(data.metadataDocuments)}; diagnostic snapshots: ${count(data.diagnosticSnapshots)}.`);
  if (reportedCount(data.reportedTotal) !== null || reportedCount(data.reportedReturned) !== null) {
    const total = reportedCount(data.reportedTotal);
    const returned = reportedCount(data.reportedReturned);
    if (total !== null) log(`Server-reported catalog total: ${total} (not the extracted count).`);
    if (returned !== null) log(`Server-reported returned records: ${returned}.`);
  }
  const categories = record(data.categories) ? data.categories : {};
  for (const group of CATEGORIES) {
    if (!Object.hasOwn(categories, group) || !record(categories[group])) continue;
    const counts = categories[group];
    log(`${group}: ${count(counts.catalogIdentifiers)} catalog identifiers; ${count(counts.fullDefinitions)} full definitions; ${count(counts.metadataDocuments)} metadata documents; ${count(counts.diagnosticSnapshots)} diagnostic snapshots.`);
    const types = record(counts.types) ? counts.types : {};
    for (const label of SAFE_TYPES) {
      if (count(types[label]) > 0) log(`${group} / ${label}: ${count(types[label])}.`);
    }
  }
  const coverage = record(data.coverage) ? data.coverage : {};
  const cache = record(data.cache) ? data.cache : {};
  if (count(cache.hits) + count(cache.misses) + count(cache.bypassed) > 0) {
    log(`CAP cache: ${count(cache.hits)} hits; ${count(cache.misses)} persisted misses; ${count(cache.bypassed)} uncached responses.`);
  }
  if (count(data.truncatedEndpoints) > 0) log(`Partial extraction: ${count(data.truncatedEndpoints)} endpoints truncated; fetch further offsets to retrieve remaining records.`);
  log(`Endpoint coverage: ${count(coverage.total)} checked; ${count(coverage.successful)} successful; ${count(coverage.metadataOnly)} metadata-only; ${count(coverage.failed)} failed; ${count(coverage.unavailable)} unavailable; ${count(coverage.unknown)} unknown.`);
  const groups = record(coverage.categories) ? coverage.categories : {};
  for (const group of CATEGORIES) {
    if (!Object.hasOwn(groups, group) || !record(groups[group])) continue;
    const counts = groups[group];
    log(`${group} coverage: ${count(counts.total)} checked; ${count(counts.successful)} successful; ${count(counts.metadataOnly)} metadata-only; ${count(counts.failed)} failed; ${count(counts.unavailable)} unavailable; ${count(counts.unknown)} unknown.`);
  }
}

module.exports = { summarizeDiscovery, logSummary };