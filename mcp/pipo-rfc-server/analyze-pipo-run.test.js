'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { analyzeRun, readInput, writeAnalysis } = require('./analyze-pipo-run');

function esr(type, name, oid, links = [], content = {}) {
  const identifier = { object_type: type, object_key: oid, swc_guid: 'component-guid' };
  const key = (targetType, targetName, targetOid) => ({ '@_typeID': targetType,
    '@_oid': targetOid, 'q:elem': [targetName, 'urn:example'] });
  return { catalog: { name, namespace: 'urn:example', identifier }, read: { identifier,
    verifiedDefinition: false, result: { tool: 'fetch_pi8_repository_read_ext',
      status: 'metadata-only', httpStatus: 200, response: { body: { 'q:xiObj': {
        'q:idInfo': { 'q:key': key(type, name, oid), 'q:vc': { '@_swcGuid': 'component-guid' } },
        'q:generic': { 'q:lnks': { 'q:lnkRole': links.map(link => ({ '@_role': 'DECLARED',
          'q:lnk': { 'q:key': key(link.type, link.name, link.oid) } })) } }, 'q:content': content
      } } } } } };
}

function fixture(rows = []) {
  return { discovery: { endpoints: [{ tool: 'fetch_pi8_repository_simple_query', status: 'ok', httpStatus: 200,
    artifacts: rows.map(row => row.catalog) }] }, export: { reads: rows.map(row => row.read) } };
}

function directory(type, definition) {
  return { verifiedDefinition: true, result: { status: 'ok', httpStatus: 200,
    artifacts: [{ type, hasFullDefinition: true, definition }] } };
}

test('ESR projection checks identity and retains declared links without promoting full definitions', () => {
  const rows = [esr('MAPPING', 'Operation', 'operation-oid', [{ type: 'XI_TRAFO', name: 'Message', oid: 'message-oid' }],
    { 'm:Mapping': { 'm:Category': 'REQUEST', 'm:Kind': 'MESSAGE', 'm:Unknown': 'synthetic-private-value' } }),
  esr('XI_TRAFO', 'Message', 'message-oid', [], { 't:XiTrafo': { 't:SourceCode': {
    't:blob': { '#text': 'synthetic-private-opaque-blob', '@_zipped': 'true' } } } })];
  const output = analyzeRun(fixture(rows));
  assert.equal(output.summary.esrPayloadsAnalyzed, 2);
  assert.equal(output.summary.verifiedDefinitions, 0);
  assert.equal(output.objects[0].details.Category, 'REQUEST');
  assert.equal(output.references[0].match.status, 'matched-in-run');
  assert.equal(output.references[0].match.targetId, output.objects[1].id);
  assert.equal(output.objects[1].details.blobs.SourceCode.present, true);
  assert.equal(output.objects[1].details.blobs.SourceCode.decoded, false);
  assert.doesNotMatch(JSON.stringify(output), /synthetic-private/);
  assert.equal(output.migrationReady, false);
});

test('ESR matches require OID, type and all key elements; duplicate matches stay ambiguous', () => {
  const target = esr('XI_TRAFO', 'Target', 'target');
  const source = esr('MAPPING', 'Source', 'source', [{ type: 'XI_TRAFO', name: 'Wrong', oid: 'target' },
    { type: 'XI_TRAFO', name: 'Target', oid: 'target' }]);
  const output = analyzeRun(fixture([source, target, structuredClone(target)]));
  assert.equal(output.summary.matchedReferences, 0);
  assert.equal(output.summary.unmatchedReferences, 1);
  assert.equal(output.summary.ambiguousReferences, 1);
});

test('ICO references preserve empty parties and match complete channels and component-scoped mappings', () => {
  const input = fixture([esr('MAPPING', 'Operation', 'mapping')]);
  const id = { PartyID: '', ComponentID: 'Component', ChannelID: 'Channel' };
  input.export.reads.push(directory('CommunicationChannel', { CommunicationChannelID: id,
    Direction: 'Sender', AdapterSpecificAttribute: { Name: 'Password', Value: 'synthetic-private-attribute' } }),
  directory('IntegratedConfiguration', { IntegratedConfigurationID: { InterfaceName: 'Interface' },
    InboundProcessing: { CommunicationChannel: id }, OutboundProcessing: { CommunicationChannel: id },
    ReceiverInterfaces: { ReceiverInterfaceRule: { Mapping: { Name: 'Operation', Namespace: 'urn:example',
      SoftwareComponentVersionID: 'component-guid' }, Interface: { Name: 'Interface', Namespace: 'urn:example' } } } }));
  const output = analyzeRun(input);
  assert.equal(output.summary.verifiedDefinitions, 2);
  assert.equal(output.summary.matchedReferences, 3);
  assert.equal(output.summary.unmatchedReferences, 1);
  assert.equal(output.objects[1].identifier.PartyID, '');
  assert.doesNotMatch(JSON.stringify(output), /synthetic-private|AdapterSpecificAttribute/);
});

test('unsafe values, hidden bodies and attributes are omitted; endpoint diagnostics are projected', () => {
  const row = esr('ifmmessif', 'Interface', 'interface', [], { serviceInterface: {
    '@_category': 'Outbound', '@_securityProfile': 'synthetic-private-profile',
    xmlPayloadNs: 'https://user:synthetic-private-password@example.invalid' } });
  const input = fixture([row]);
  input.discovery.endpoints.push({ tool: 'fetch_pi8_bpm_facade', status: 'failed', httpStatus: 500,
    path: 'synthetic-private-path', response: { body: 'synthetic-private-body' },
    diagnostic: { code: 'HTTP_ERROR', layer: 'source', reason: 'synthetic-private-reason' } });
  const output = analyzeRun(input);
  assert.equal(output.objects[0].details.category, 'Outbound');
  assert.equal(output.objects[0].details.xmlPayloadNs, undefined);
  assert.equal(output.endpoints[1].path, '/BPMFacadeBeanImplService');
  assert.doesNotMatch(JSON.stringify(output), /synthetic-private/);
  const withSecret = analyzeRun(input, { env: { PIPO_MCP_PASS: 'Outbound' } });
  assert.equal(withSecret.objects[0].details.category, undefined);
});

test('mismatched catalog identity, failed reads and missing Directory definitions cannot create objects', () => {
  const row = esr('ifmmessif', 'Interface', 'interface');
  row.catalog.name = 'Different';
  const failed = esr('XI_TRAFO', 'Message', 'message');
  failed.read.result.httpStatus = 503;
  const input = fixture([row, failed]);
  input.export.reads.push(directory('CommunicationChannel', null), directory('IntegratedConfiguration', 'invalid'));
  const output = analyzeRun(input);
  assert.equal(output.summary.rejectedESR, 2);
  assert.equal(output.summary.objects, 0);
});

test('WSDL analysis retains contract names, not addresses, arbitrary XML or injected text', () => {
  const input = fixture();
  input.discovery.endpoints.push({ tool: 'fetch_pi8_value_mapping', status: 'metadata-only', artifacts: [
    { type: 'WSDL', definition: { 'w:definitions': { 'w:service': { '@_name': 'ValueMapping',
      's:address': { '@_location': 'https://user:synthetic-private@example.invalid' } },
    'w:portType': { 'w:operation': [{ '@_name': 'Read' }, { '@_name': 'Query' }] } } } } ] });
  const output = analyzeRun(input);
  assert.deepEqual(output.metadataDocuments[0].operations, ['Read', 'Query']);
  assert.equal(output.summary.metadataDocuments, 1);
  assert.doesNotMatch(JSON.stringify(output), /synthetic-private|address/);
});

test('analysis is deterministic, does not mutate inputs and rejects excessive nesting', () => {
  const input = fixture([esr('ifmmessif', 'Interface', 'interface')]);
  const before = JSON.stringify(input);
  assert.deepEqual(analyzeRun(input), analyzeRun(input));
  assert.equal(JSON.stringify(input), before);
  let nested = {};
  for (let i = 0; i < 55; i++) nested = { nested };
  input.discovery.endpoints[0].artifacts.push({ type: 'WSDL', definition: nested });
  assert.throws(() => analyzeRun(input), /nesting limit/);
});

test('UTF16 export loading is hashed and exclusive output never overwrites source or prior analysis', async () => {
  const temp = process.env.TMPDIR || process.env.TEMP || process.env.TMP;
  assert.ok(temp);
  const directory = await fs.mkdtemp(path.join(temp, 'pipo-analysis-test-'));
  const source = path.join(directory, 'source.json');
  const output = path.join(directory, 'analysis.json');
  const bytes = Buffer.from('\uFEFF' + JSON.stringify(fixture()), 'utf16le');
  await fs.writeFile(source, bytes, { flag: 'wx' });
  const loaded = await readInput(source);
  assert.equal(loaded.hash, createHash('sha256').update(bytes).digest('hex'));
  await writeAnalysis(source, output);
  await assert.rejects(writeAnalysis(source, output), { code: 'EEXIST' });
  await assert.rejects(writeAnalysis(source, source), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(source), bytes);
});