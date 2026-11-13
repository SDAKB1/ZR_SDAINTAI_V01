'use strict';

// Offline, allowlisted projection. Never emit raw response bodies, adapter
// attributes, process properties, mapping blobs, headers or runtime credentials.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ENDPOINTS } = require('./pipo-endpoints');
const { projectDiagnostic } = require('./discovery-diagnostics');

const MAX_INPUT = 100 * 1024 * 1024;
const TYPES = Object.freeze({ ifmmessif: 'ServiceInterface', MAPPING: 'OperationMapping',
  XI_TRAFO: 'MessageMapping', ChannelTemplate: 'ChannelTemplate', RepBProcess: 'IntegrationProcess' });
const STATUSES = new Set(['ok', 'failed', 'metadata-only', 'unsupported', 'unavailable', 'needs_parameters']);
const entries = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const local = key => key.replace(/^@_/, '').split(':').pop();
const children = (value, name) => entries(value).filter(([key]) => !key.startsWith('@_') && local(key) === name)
  .flatMap(([, item]) => list(item));
const child = (value, name) => children(value, name)[0];
const attr = (value, name) => entries(value).find(([key]) => key.startsWith('@_') && local(key) === name)?.[1];
const digest = value => createHash('sha256').update(value).digest('hex');

function projector(env) {
  const secrets = ['PIPO_MCP_USER', 'PIPO_MCP_PASS', 'PIPO_CAP_TOKEN', 'PIPO_CAP_USER', 'PIPO_CAP_PASS']
    .map(key => env[key]).filter(value => typeof value === 'string' && value);
  return value => {
    value = typeof value === 'string' ? value : value?.['#text'];
    if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f<>]/.test(value) ||
        /\[(?:OMITTED|REDACTED)/i.test(value) || /\b(?:Basic|Bearer)\s+/i.test(value) ||
        /(?:password|passwd|pwd|token|secret|api[-_]?key|authorization|cookie)\s*[=:]/i.test(value) ||
        /https?:\/\/[^\s/@]+:[^\s/@]+@/i.test(value) || /[?&](?:token|password|secret|key)=/i.test(value) ||
        secrets.some(secret => value.includes(secret))) return null;
    return value;
  };
}

function walk(value, visit, depth = 0) {
  if (depth > 48) throw new Error('Analysis input exceeds the nesting limit.');
  for (const [key, item] of entries(value)) for (const node of list(item)) {
    visit(local(key), node);
    if (node && typeof node === 'object') walk(node, visit, depth + 1);
  }
}

function analyzeRun(data, { env = {}, sourceHash = null } = {}) {
  if (!data || !Array.isArray(data.discovery?.endpoints) || !Array.isArray(data.export?.reads)) {
    throw new Error('A discovery export with endpoint and Read arrays is required.');
  }
  if (data.export.reads.length > 100000) throw new Error('Too many Read results.');
  const text = projector(env);
  const fields = (node, names, attributes = false) => Object.fromEntries(names.flatMap(name => {
    const value = text(attributes ? attr(node, name) : child(node, name));
    return value === null ? [] : [[name, value]];
  }));
  const objects = [];
  const edges = [];
  const rawIdentities = new Map();
  let rejectedESR = 0;
  const append = (object, identity = {}) => {
    object.id = `object-${String(objects.length + 1).padStart(5, '0')}`;
    objects.push(object);
    rawIdentities.set(object.id, identity);
    return object;
  };
  const edge = (source, kind, target, role = null) => {
    if (Object.keys(target).length) edges.push({ sourceId: source.id, kind, role: text(role), target });
  };
  const channelRef = node => fields(node, ['PartyID', 'ComponentID', 'ChannelID']);

  for (const read of data.export.reads) {
    const result = read?.result;
    if (result?.tool !== 'fetch_pi8_repository_read_ext') continue;
    const root = child(result.response?.body, 'xiObj');
    const info = child(root, 'idInfo');
    const key = child(info, 'key');
    const typeId = text(attr(key, 'typeID'));
    const elements = children(key, 'elem').map(text);
    const catalogType = read.identifier?.object_type;
    // Require the saved request identity and returned key to agree. This only
    // establishes identity for analysis, never a verified full ESR definition.
    if (result.httpStatus !== 200 || !['ok', 'metadata-only'].includes(result.status) ||
        !Object.hasOwn(TYPES, typeId || '') || typeId !== catalogType ||
        elements.length < 2 || elements.some(item => item === null)) {
      rejectedESR += 1;
      continue;
    }
    const catalog = data.discovery.endpoints.flatMap(e => list(e.artifacts)).find(item =>
      item.identifier?.object_type === catalogType && item.identifier?.object_key === read.identifier?.object_key &&
      item.identifier?.swc_guid === read.identifier?.swc_guid);
    if (!catalog || text(catalog.name) !== elements[0] || text(catalog.namespace) !== elements[1]) {
      rejectedESR += 1;
      continue;
    }
    const vc = child(info, 'vc');
    const object = append({ source: 'ESR', type: TYPES[typeId], name: elements[0], namespace: elements[1],
      typeId, oid: text(attr(key, 'oid')), keyElements: elements,
      versionContext: fields(vc, ['vcType', 'swcGuid', 'sp', 'caption'], true),
      verifiedDefinition: false, identityChecked: true, details: {} }, { typeId, elements, oid: text(attr(key, 'oid')) });
    for (const role of children(child(child(root, 'generic'), 'lnks'), 'lnkRole')) {
      for (const link of children(role, 'lnk')) for (const targetKey of children(link, 'key')) {
        const target = { ...fields(targetKey, ['typeID', 'oid'], true),
          keyElements: children(targetKey, 'elem').map(text) };
        if (target.keyElements.some(value => value === null)) continue;
        edge(object, 'ESR-declared-link', target, attr(role, 'role'));
      }
    }
    const content = child(root, 'content');
    if (typeId === 'ifmmessif') {
      const node = child(content, 'serviceInterface');
      object.details = { ...fields(node, ['category', 'interfacePattern', 'isdocumentOriented',
        'isPtoPDisabled', 'isSensitive', 'objectState'], true), ...fields(node, ['xmlPayloadNs']) };
    } else if (typeId === 'MAPPING') {
      object.details = fields(child(content, 'Mapping'), ['Category', 'Kind', 'Multiplicity']);
    } else if (typeId === 'XI_TRAFO') {
      const node = child(content, 'XiTrafo');
      object.details = { ...fields(node, ['Multiplicity']), blobs: {} };
      for (const name of ['MetaData', 'SourceCode', 'ByteCodeJar', 'AdditionalMetaData']) {
        const blob = child(child(node, name), 'blob');
        const value = typeof blob === 'string' ? blob : blob?.['#text'];
        if (typeof value === 'string') object.details.blobs[name] = {
          present: !/\[(?:OMITTED|REDACTED)/i.test(value), encodedCharacters: value.length,
          compressed: attr(blob, 'zipped') === 'true', decoded: false, contentVerified: false
        };
      }
    } else if (typeId === 'RepBProcess') {
      const node = child(content, 'definition');
      object.details.operations = children(child(node, 'operations'), 'operation').map(operation => ({
        ...fields(operation, ['role', 'name', 'namespace', 'swcv', 'sp'], true),
        serviceInterface: fields(child(operation, 'serviceInterface'), ['name', 'namespace', 'swcv', 'sp'], true)
      }));
      let stepCount = 0;
      walk(child(node, 'process'), name => { if (name === 'step') stepCount += 1; });
      object.details.processStepCount = stepCount;
    } else if (typeId === 'ChannelTemplate') {
      const node = child(content, 'ChannelTemplate');
      object.details = fields(node, ['Direction', 'TransProto', 'TransProtoVers', 'MessageProto', 'MessageProtoVers']);
      object.details.modules = [];
      walk(child(node, 'PipelineAttributes'), (name, value) => {
        if (name !== 'PipelineConfig') return;
        const module = fields(value, ['ModuleName', 'ModuleType', 'ModuleNs', 'Position']);
        if (Object.keys(module).length) object.details.modules.push(module);
      });
    }
  }

  for (const read of data.export.reads) {
    if (read?.verifiedDefinition !== true || read.result?.status !== 'ok' || read.result.httpStatus !== 200) continue;
    for (const artifact of list(read.result.artifacts)) {
      if (!artifact || artifact.hasFullDefinition !== true || artifact.metadataOnly === true) continue;
      const definition = artifact.definition;
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) continue;
      if (artifact.type === 'CommunicationChannel') {
        const identifier = channelRef(child(definition, 'CommunicationChannelID'));
        const object = append({ source: 'Directory', type: 'CommunicationChannel', identifier,
          verifiedDefinition: true, details: { ...fields(definition, ['Direction', 'TransportProtocol', 'MessageProtocol']),
            adapter: fields(child(definition, 'AdapterMetadata'), ['Name', 'Namespace', 'SoftwareComponentVersionID']),
            modules: children(child(definition, 'ModuleProcess'), 'ProcessStep')
              .map(node => fields(node, ['ModuleName', 'ModuleType'])) } });
        rawIdentities.set(object.id, { channel: identifier });
      } else if (artifact.type === 'IntegratedConfiguration') {
        const object = append({ source: 'Directory', type: 'IntegratedConfiguration',
          identifier: fields(child(definition, 'IntegratedConfigurationID'), ['SenderPartyID', 'SenderComponentID',
            'InterfaceName', 'InterfaceNamespace', 'ReceiverPartyID', 'ReceiverComponentID']), verifiedDefinition: true });
        for (const inbound of children(definition, 'InboundProcessing')) {
          for (const node of children(inbound, 'CommunicationChannel')) edge(object, 'inbound-channel', channelRef(node));
        }
        for (const outbound of children(definition, 'OutboundProcessing')) {
          for (const node of children(outbound, 'CommunicationChannel')) edge(object, 'outbound-channel', channelRef(node));
          for (const node of children(outbound, 'Receiver')) edge(object, 'receiver-component', fields(node, ['PartyID', 'ComponentID']));
        }
        for (const interfaces of children(definition, 'ReceiverInterfaces')) {
          for (const node of children(interfaces, 'Receiver')) edge(object, 'receiver-component', fields(node, ['PartyID', 'ComponentID']));
          for (const rule of children(interfaces, 'ReceiverInterfaceRule')) {
            for (const node of children(rule, 'Mapping')) edge(object, 'operation-mapping', fields(node, ['Name', 'Namespace', 'SoftwareComponentVersionID']));
            for (const node of children(rule, 'Interface')) edge(object, 'receiver-interface', fields(node, ['Name', 'Namespace', 'SoftwareComponentVersionID']));
          }
        }
      }
    }
  }

  const oidIndex = new Map();
  const add = (map, key, id) => { if (key) map.set(key, [...(map.get(key) || []), id]); };
  for (const [id, identity] of rawIdentities) add(oidIndex, identity.oid, id);
  const uniqueEdges = [...new Map(edges.map(item => [JSON.stringify(item), item])).values()];
  for (const item of uniqueEdges) {
    let candidates = [];
    let method = null;
    if (item.kind === 'ESR-declared-link') {
      candidates = (oidIndex.get(item.target.oid) || []).filter(id => {
        const identity = rawIdentities.get(id);
        return identity.typeId === item.target.typeID && JSON.stringify(identity.elements) === JSON.stringify(item.target.keyElements);
      });
      method = 'oid-type-and-key';
      // A name match without OID cannot prove the version/context of an ESR link.
    } else if (['inbound-channel', 'outbound-channel'].includes(item.kind) &&
        ['PartyID', 'ComponentID', 'ChannelID'].every(key => Object.hasOwn(item.target, key))) {
      candidates = objects.filter(object => object.type === 'CommunicationChannel' &&
        ['PartyID', 'ComponentID', 'ChannelID'].every(key => object.identifier[key] === item.target[key])).map(o => o.id);
      method = 'channel-composite-identifier';
    } else if (item.kind === 'operation-mapping' && item.target.Name && item.target.Namespace && item.target.SoftwareComponentVersionID) {
      candidates = objects.filter(object => object.type === 'OperationMapping' && object.name === item.target.Name &&
        object.namespace === item.target.Namespace && object.versionContext.swcGuid === item.target.SoftwareComponentVersionID).map(o => o.id);
      method = 'mapping-name-namespace-component';
    }
    item.match = { status: candidates.length === 1 ? 'matched-in-run' : candidates.length > 1 ? 'ambiguous' : 'not-matched',
      method, targetId: candidates.length === 1 ? candidates[0] : null };
  }

  const endpoints = data.discovery.endpoints.flatMap(result => {
    const descriptor = ENDPOINTS.find(endpoint => endpoint.tool === result?.tool);
    if (!descriptor) return [];
    return [{ tool: descriptor.tool, path: descriptor.path,
      status: STATUSES.has(result.status) ? result.status : 'unknown',
      httpStatus: Number.isInteger(result.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599 ? result.httpStatus : null,
      diagnostic: projectDiagnostic(result.diagnostic) }];
  });
  const metadataDocuments = data.discovery.endpoints.flatMap(endpoint => {
    const descriptor = ENDPOINTS.find(item => item.tool === endpoint?.tool);
    if (!descriptor) return [];
    return list(endpoint.artifacts).filter(item => item?.type === 'WSDL').map(item => {
      const operations = new Set();
      const services = new Set();
      walk(item.definition, (name, node) => {
        const value = text(attr(node, 'name'));
        if (name === 'operation' && value) operations.add(value);
        if (name === 'service' && value) services.add(value);
      });
      return { tool: descriptor.tool, type: 'WSDL', operations: [...operations], services: [...services] };
    });
  });
  const counts = values => values.reduce((result, value) => ({ ...result, [value]: (result[value] || 0) + 1 }), {});
  return { schemaVersion: 1, sourceSha256: sourceHash, analysisOnly: true, migrationReady: false,
    summary: { objects: objects.length, types: counts(objects.map(o => o.type)),
      verifiedDefinitions: objects.filter(o => o.verifiedDefinition).length,
      esrPayloadsAnalyzed: objects.filter(o => o.source === 'ESR').length, rejectedESR,
      references: uniqueEdges.length, referenceKinds: counts(uniqueEdges.map(e => e.kind)),
      matchedReferences: uniqueEdges.filter(e => e.match.status === 'matched-in-run').length,
      unmatchedReferences: uniqueEdges.filter(e => e.match.status === 'not-matched').length,
      ambiguousReferences: uniqueEdges.filter(e => e.match.status === 'ambiguous').length,
      metadataDocuments: metadataDocuments.length },
    endpoints, objects, references: uniqueEdges, metadataDocuments,
    limitations: ['ESR payloads remain unverified full definitions; this is an allowlisted metadata projection.',
      'Only explicit references are extracted; missing, ambiguous and external targets are not inferred.',
      'A match identifies an object in this run, not complete dependency closure or runtime compatibility.',
      'Mapping blobs, adapter attribute values, process properties, credentials and binaries are not emitted or executed.'] };
}

async function readInput(filename) {
  const file = await fs.open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT) throw new Error();
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size) throw new Error();
    const input = bytes.subarray(0, length);
    const encoding = input[0] === 255 && input[1] === 254 ? 'utf16le' : 'utf8';
    return { data: JSON.parse(input.toString(encoding).replace(/^\uFEFF/, '')), hash: digest(input) };
  } finally { await file.close(); }
}

async function writeAnalysis(input, output, { env = process.env } = {}) {
  const { data, hash } = await readInput(input);
  const analysis = analyzeRun(data, { env, sourceHash: hash });
  // The caller chooses a NEW output file. Never overwrite a source, manifest,
  // existing analysis or a symlink. No response-selected path is ever followed.
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, JSON.stringify(analysis, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return analysis.summary;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('Usage: node analyze-pipo-run.js INPUT_DISCOVERY_JSON NEW_OUTPUT_JSON');
    process.exitCode = 1;
  } else {
    writeAnalysis(args[0], args[1]).then(summary => console.log(JSON.stringify(summary))).catch(() => {
      console.error('Offline analysis failed. Check the export, size limits and a new output filename; sensitive details omitted.');
      process.exitCode = 1;
    });
  }
}

module.exports = { analyzeRun, readInput, writeAnalysis };