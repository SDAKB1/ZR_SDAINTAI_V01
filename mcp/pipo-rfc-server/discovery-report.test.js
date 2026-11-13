'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { summarizeDiscovery, logSummary } = require('./discovery-report');

test('legacy cap of 150 does not turn the server total of 243 into extracted interfaces', () => {
  const items = Array.from({ length: 150 }, (_, index) => ({
    type: index < 60 ? 'ifmmessif' : index < 100 ? 'MAPPING' : 'XI_TRAFO',
    // Deliberately wrong: technical types, not labels, determine the counts.
    typeLabel: 'Service Interface', name: `Object${index}`
  }));
  const output = { objects: { totalCount: 243, returned: 150, items } };
  const before = JSON.stringify(output);
  const summary = summarizeDiscovery(output);
  assert.equal(summary.source, 'legacy');
  assert.equal(summary.catalogIdentifiers, 150);
  assert.equal(summary.interfaces, 60);
  assert.equal(summary.fullDefinitions, 0);
  assert.equal(summary.reportedTotal, 243);
  assert.equal(summary.reportedReturned, 150);
  assert.deepEqual(summary.types, {
    'Service Interface': 60, 'Operation Mapping': 40, 'Message Mapping': 50
  });
  assert.equal(summary.categories.ESR.catalogIdentifiers, 150);
  assert.equal(summary.coverage.total, 0);
  assert.equal(JSON.stringify(output), before);
});

test('legacy types include channel templates, processes, labels and unknown types safely', () => {
  const summary = summarizeDiscovery({ objects: { returned: 99, totalCount: 243, items: [
    { type: 'ChannelTemplate' }, { type: 'RepBProcess' }, { typeLabel: 'Service Interface' },
    { type: 'new-private-type', typeLabel: 'Service Interface' }, { type: '__proto__' },
    { type: 'constructor' }
  ] } });
  assert.equal(summary.catalogIdentifiers, 6);
  assert.equal(summary.interfaces, 1);
  assert.equal(summary.types['Communication Channel Template'], 1);
  assert.equal(summary.types['Integration Process'], 1);
  assert.equal(summary.types.Other, 3);
  assert.equal(summary.reportedReturned, 99);
});

test('expanded records are counted per category with explicit definitions kept separate', () => {
  const summary = summarizeDiscovery({ discovery: { artifacts: [
    { category: 'ESR', type: 'ifmmessif', name: 'CatalogOnly' },
    { category: 'esr', type: 'MAPPING', definition: '<mapping />' },
    { category: 'Directory', type: 'CommunicationChannel', definition: { protocol: 'HTTP' } },
    { category: 'Configuration', type: 'IntegratedConfiguration', hasFullDefinition: true },
    { category: 'Configuration', type: 'Unrecognized', name: 'StillAnIdentifier' },
    { category: 'unknown-category', type: 'Unrecognized' }
  ] } });
  assert.equal(summary.source, 'discovery');
  assert.equal(summary.catalogIdentifiers, 6);
  assert.equal(summary.fullDefinitions, 3);
  assert.equal(summary.interfaces, 1);
  assert.equal(summary.categories.ESR.catalogIdentifiers, 2);
  assert.equal(summary.categories.Directory.catalogIdentifiers, 1);
  assert.equal(summary.categories.Configuration.catalogIdentifiers, 2);
  assert.equal(summary.categories.Other.catalogIdentifiers, 1);
  assert.deepEqual(summary.categories.Configuration.types, { 'Integrated Configuration': 1, Other: 1 });
});

test('real fetcher categories and metadata-only diagnostics retain their intended metrics', () => {
  const summary = summarizeDiscovery({ discovery: { endpoints: [
    { category: 'Repository', status: 'ok', artifacts: [
      { category: 'Repository', type: 'ifmmessif', hasFullDefinition: false, definition: { partial: true } }
    ], cache: { hit: true, backend: 'cap-db' } },
    { category: 'Directory', status: 'ok', truncated: true, artifacts: [
      { type: 'IntegratedConfiguration' }, { type: 'ConfigurationScenario' }
    ], cache: { hit: false, backend: 'cap-db' } },
    { category: 'Monitoring', status: 'metadata-only', httpStatus: 200, metadataOnly: true,
      artifacts: [{ category: 'Monitoring', type: 'DiagnosticSnapshot', metadataOnly: true }],
      cache: { hit: false, backend: 'none' } },
    { category: 'Directory', status: 'needs_parameters', httpStatus: 200 }
  ] } });
  assert.equal(summary.categories.ESR.interfaces, 1);
  assert.equal(summary.categories.Configuration.catalogIdentifiers, 2);
  assert.equal(summary.categories.Monitoring.diagnosticSnapshots, 1);
  assert.equal(summary.metadataDocuments, 0);
  assert.equal(summary.fullDefinitions, 0);
  assert.equal(summary.coverage.failed, 1);
  assert.equal(summary.truncatedEndpoints, 1);
  assert.deepEqual(summary.cache, { hits: 1, misses: 1, bypassed: 1 });
  const lines = [];
  logSummary(summary, line => lines.push(line));
  assert.match(lines.join('\n'), /CAP cache: 1 hits; 1 persisted misses; 1 uncached responses/);
  assert.match(lines.join('\n'), /Partial extraction: 1 endpoints truncated/);
});

test('metadata documents and diagnostic snapshots are not catalog artifacts or interfaces', () => {
  const summary = summarizeDiscovery({ discovery: {
    endpoints: [
      { category: 'ESR', status: 'reachable', httpStatus: 200, artifactCount: 100 },
      { category: 'Metadata', status: 'ok', metadataOnly: true, artifactCount: 200 },
      { category: 'Monitoring', status: 'ok', artifactCount: 300 }
    ],
    artifacts: [
      { category: 'Metadata', type: 'Service Interface' },
      { category: 'ESR', type: 'WSDL' },
      { type: 'WSDL Document' },
      { category: 'Directory', type: 'Service Interface', metadataOnly: true },
      { category: 'Monitoring', type: 'Service Interface' },
      { type: 'Diagnostic Snapshot' },
      { category: 'Configuration', kind: 'snapshot' }
    ]
  } });
  assert.equal(summary.catalogIdentifiers, 0);
  assert.equal(summary.interfaces, 0);
  assert.equal(summary.fullDefinitions, 0);
  assert.equal(summary.metadataDocuments, 4);
  assert.equal(summary.diagnosticSnapshots, 3);
  assert.deepEqual(summary.types, {});
  assert.equal(summary.categories.Metadata.metadataDocuments, 2);
  assert.equal(summary.categories.Monitoring.diagnosticSnapshots, 2);
  assert.equal(summary.coverage.total, 3);
  assert.equal(summary.coverage.successful, 3);
  assert.equal(summary.coverage.metadataOnly, 1);
});

test('expanded artifacts are authoritative even when the same ESR records exist in old and endpoint arrays', () => {
  const item = { category: 'ESR', type: 'ifmmessif', name: 'Shared', namespace: 'urn:test' };
  const summary = summarizeDiscovery({
    objects: { items: [item], totalCount: 243, returned: 1 },
    discovery: { artifacts: [item], endpoints: [{ category: 'ESR', status: 'ok', artifacts: [item] }] }
  });
  assert.equal(summary.source, 'discovery');
  assert.equal(summary.catalogIdentifiers, 1);
  assert.equal(summary.interfaces, 1);
  assert.equal(summary.reportedTotal, 243);
  assert.equal(summarizeDiscovery({ objects: { items: [item] }, discovery: { artifacts: [] } }).catalogIdentifiers, 0);
});

test('legacy items are the fallback when the aggregate is absent, not combined with endpoint copies', () => {
  const summary = summarizeDiscovery({
    objects: { items: [{ type: 'MAPPING' }] },
    discovery: { endpoints: [{ category: 'ESR', artifacts: [{ type: 'MAPPING' }] }] }
  });
  assert.equal(summary.source, 'legacy');
  assert.equal(summary.catalogIdentifiers, 1);
});

test('endpoint-local artifacts are usable without aggregates; counts and probes alone are not records', () => {
  const summary = summarizeDiscovery({ discovery: { endpoints: [
    { category: 'Directory', status: 'ok', artifacts: [{ type: 'CommunicationChannel' }] },
    { category: 'Metadata', status: 'ok', metadataOnly: true, artifacts: [{ type: 'ifmmessif' }] },
    { category: 'Monitoring', status: 'ok', artifacts: [{ type: 'status' }] },
    { category: 'ESR', status: 'ok', artifactCount: 999 }
  ] } });
  assert.equal(summary.source, 'endpoints');
  assert.equal(summary.catalogIdentifiers, 1);
  assert.equal(summary.interfaces, 0);
  assert.equal(summary.metadataDocuments, 1);
  assert.equal(summary.diagnosticSnapshots, 1);
  const probes = summarizeDiscovery({ discovery: { endpoints: [
    { category: 'Metadata', status: 'ok', metadataOnly: true, artifactCount: 999 }
  ] } });
  assert.equal(probes.catalogIdentifiers, 0);
  assert.equal(probes.metadataDocuments, 0);
  assert.equal(probes.coverage.metadataOnly, 1);
});

test('failed, unavailable and unknown endpoint coverage stays separate from extracted counts', () => {
  const summary = summarizeDiscovery({ discovery: { endpoints: [
    { category: 'ESR', status: 'ok', httpStatus: 200 },
    { category: 'Directory', status: 'ok', httpStatus: 403, errors: ['private response'] },
    { category: 'Configuration', status: 'unavailable' },
    { category: 'Metadata', status: 'ok', httpStatus: 404, metadataOnly: true },
    { category: 'Monitoring', status: 'failed', httpStatus: 200 },
    { category: 'ESR', httpStatus: 200, errors: { message: 'private response' } },
    { category: 'Directory', status: 'partial', httpStatus: 200 },
    { category: 'Configuration', httpStatus: 503 },
    { category: 'Metadata', httpStatus: 204, errors: [] },
    { category: 'unexpected', status: 'unrecognized' }
  ] } });
  const { categories, ...coverage } = summary.coverage;
  assert.deepEqual(coverage, { total: 10, successful: 2, metadataOnly: 1,
    failed: 4, unavailable: 3, unknown: 1 });
  assert.equal(categories.Directory.failed, 2);
  assert.equal(categories.Configuration.unavailable, 2);
  assert.equal(summary.categories.Directory.catalogIdentifiers, 0);
  assert.equal(summary.catalogIdentifiers, 0);
});

test('empty or malformed optional data never invents artifacts from advertised counts', () => {
  for (const output of [undefined, null, [], { objects: null }, { discovery: null },
    { objects: { totalCount: 243, returned: 150 } },
    { objects: { totalCount: -1, returned: '150', items: [null, 'not a record', [], {}, { name: '' }] },
      discovery: { artifacts: null, endpoints: [null, 'not an endpoint'] } }]) {
    const summary = summarizeDiscovery(output);
    assert.equal(summary.catalogIdentifiers, 0);
    assert.equal(summary.interfaces, 0);
    assert.equal(summary.coverage.total, 0);
  }
});

test('endpoint records and WSDL variants cannot be mistaken for catalog identifiers', () => {
  const summary = summarizeDiscovery({ discovery: { artifacts: [
    { type: 'endpoint', name: 'Reachable', status: 'ok' },
    { kind: 'probe', type: 'ifmmessif', name: 'NotAnInterface' },
    { type: 'WSDL Service', name: 'Service' },
    { type: 'WSDL Definition', definition: '<definitions />' }
  ] } });
  assert.equal(summary.catalogIdentifiers, 0);
  assert.equal(summary.interfaces, 0);
  assert.equal(summary.fullDefinitions, 0);
  assert.equal(summary.metadataDocuments, 2);
});

test('logging uses only the injected callback, leaving stdout and stderr to the caller', (t) => {
  t.mock.method(console, 'log', () => assert.fail('Unexpected stdout logging'));
  t.mock.method(console, 'error', () => assert.fail('Unexpected stderr logging'));
  const lines = [];
  logSummary(summarizeDiscovery(), (line) => lines.push(line));
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => typeof line === 'string'));
});

test('logging includes useful counts but never raw names, paths, credentials, labels or error bodies', () => {
  const marker = 'PRIVATE-credential-body\n\u001b[31m';
  const summary = summarizeDiscovery({ credentials: marker,
    objects: { totalCount: 243, returned: 150 }, discovery: {
      artifacts: [
        { category: 'ESR', type: 'ifmmessif', name: marker, namespace: marker, definition: marker },
        { category: marker, type: marker, typeLabel: marker, raw: marker }
      ],
      endpoints: [{ category: 'Directory', path: marker, status: 'failed', httpStatus: 500, errors: [marker] }]
    }
  });
  const lines = [];
  logSummary(summary, (line) => lines.push(line));
  const text = lines.join('\n');
  assert.match(text, /Extracted catalog identifiers: 2; service interfaces: 1/);
  assert.match(text, /Full definitions: 1/);
  assert.match(text, /Server-reported catalog total: 243 \(not the extracted count\)/);
  assert.match(text, /ESR \/ Service Interface: 1/);
  assert.match(text, /Other \/ Other: 1/);
  assert.match(text, /Directory coverage: 1 checked; 0 successful; 0 metadata-only; 1 failed/);
  assert.ok(!text.includes(marker));
  assert.ok(!JSON.stringify(summary).includes(marker));
});

test('the injected logger receives only safe fixed labels and validated numeric values', () => {
  const marker = 'PRIVATE-raw-text';
  const lines = [];
  logSummary({ catalogIdentifiers: marker, interfaces: Infinity, fullDefinitions: -1,
    reportedTotal: marker, categories: {
      [marker]: { catalogIdentifiers: 99 },
      ESR: { catalogIdentifiers: 1, types: { [marker]: 99, 'Service Interface': 1 } }
    }, coverage: { total: marker, categories: { [marker]: { failed: 1 } } }
  }, (line) => lines.push(line));
  assert.ok(lines.every((line) => typeof line === 'string' && !line.includes(marker)));
  assert.match(lines[0], /identifiers: 0; service interfaces: 0/);
  assert.throws(() => logSummary({}, null), /logger function is required/);
});