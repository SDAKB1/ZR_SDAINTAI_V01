'use strict';

const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');
const { z } = require('zod');
const { ENDPOINTS, getEndpoint } = require('./pipo-endpoints');
const { ESR_READ_CONTEXT, readContext } = require('./esr-read-context');

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT = 20000;
const safeHttpStatus = (value) => Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
const BASIS = 'http://sap.com/xi/BASIS';
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const ACTION = 'http://sap.com/xi/WebService/soap1.1';
const WSDL = 'http://schemas.xmlsoap.org/wsdl/';
const XSD = 'http://www.w3.org/2001/XMLSchema';
const WSDL_SOAP = 'http://schemas.xmlsoap.org/wsdl/soap/';
const TYPES = Object.freeze({
  ifmmessif: 'Service Interface', MAPPING: 'Operation Mapping', XI_TRAFO: 'Message Mapping',
  ChannelTemplate: 'Communication Channel Template', RepBProcess: 'Integration Process'
});
const SECRET = /password|passwd|pwd|token|secret|credential|authorization|cookie|api[-_]?key|private[-_]?key/i;
const CREDENTIAL_NAME = /password|passwd|pwd|token|secret|credential|auth|cookie|user(?:name)?|login|key|passphrase/i;
const FORBIDDEN_KEY = /^(?:__proto__|prototype|constructor)$/;
const xmlString = z.string().max(4096).refine((value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value));
const scalar = z.string().min(1).max(4096).refine((value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value));
const identifierSchema = z.union([scalar, z.record(xmlString).refine((value) =>
  Object.keys(value).length > 0 && Object.keys(value).length <= 24 &&
  Object.keys(value).every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !FORBIDDEN_KEY.test(key) && !SECRET.test(key)))]);
const COMMON = {
  mode: z.enum(['query', 'read', 'metadata']).optional().default('query'),
  maxItems: z.number().int().min(1).max(1000).optional().default(150),
  offset: z.number().int().min(0).max(1000000).optional().default(0)
};

function endpointSchema(descriptor) {
  const fields = { ...COMMON };
  if (descriptor.kind === 'soap' && descriptor.entity) fields.identifier = identifierSchema.optional();
  if (descriptor.kind === 'read') {
    for (const key of ['object_type', 'object_key', 'swc_guid']) fields[key] = scalar.optional();
  }
  if (descriptor.path === '/rep/read/ext') {
    for (const [key, { pattern }] of Object.entries(ESR_READ_CONTEXT)) {
      fields[key] = z.string().max(32).regex(pattern).refine(value => !/[\x00-\x20\x7f]/.test(value)).optional();
    }
  }
  if (descriptor.path === '/AdapterFramework/ChannelAdminServlet') {
    for (const key of ['party', 'service', 'channel']) fields[key] = scalar.optional();
    fields.party = xmlString.optional();
  }
  return z.object(fields).strict();
}

const schemas = new Map(ENDPOINTS.map((entry) => [entry.tool, endpointSchema(entry)]));
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
  processEntities: true, trimValues: false, allowBooleanAttributes: false });
const builder = new XMLBuilder({ ignoreAttributes: false, suppressEmptyNode: true });
const local = (key) => key.replace(/^@_/, '').split(':').pop();
const array = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const entries = (value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
const child = (node, name) => entries(node).filter(([key]) => !key.startsWith('@_') && local(key) === name)
  .flatMap(([, value]) => array(value));
const text = (value) => typeof value === 'string' ? value : value?.['#text'] || '';

function walk(node, visit, depth = 0) {
  if (depth > 80) throw new Error('Response nesting exceeds the safety limit.');
  for (const [key, value] of entries(node)) {
    for (const item of array(value)) {
      visit(key, item);
      if (item && typeof item === 'object') walk(item, visit, depth + 1);
    }
  }
}

function redactString(value) {
  return value
    .replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9+/_=.~-]+/gi, '[REDACTED]')
    .replace(/((?:password|passwd|pwd|token|secret|api[-_]?key|authorization|cookie)[A-Za-z0-9_.-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s<>&;,]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

function sanitize(value, depth = 0) {
  if (depth > 80) throw new Error('Response nesting exceeds the safety limit.');
  if (typeof value === 'string') {
    // CDATA/JSON strings may themselves contain unsanitized XML or HTML.
    if (/<[!?/]?[A-Za-z][^>]*>/.test(value)) return '[OMITTED: embedded markup]';
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  // SAP stores adapter credentials as Name/Value siblings or XML attributes.
  const credentialPair = entries(value).some(([key, item]) =>
    /^(?:name|key|type)$/i.test(local(key)) && CREDENTIAL_NAME.test(decodeHtml(text(item))));
  for (const [key, item] of entries(value)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    const label = local(key);
    // ESR ChannelTemplate stores adapter settings (including credential fields)
    // in an opaque base64 Attributes blob. Never persist it as "sanitized" XML.
    if (/^Attributes$/i.test(label) && (typeof item === 'string' || Array.isArray(item) || typeof item?.['#text'] === 'string')) {
      result[key] = '[OMITTED: opaque adapter attributes]';
      continue;
    }
    result[key] = SECRET.test(decodeHtml(label)) || /^(?:headers|request|requestheaders|authheaders|config)$/i.test(label) ||
      (credentialPair && /^(?:value|#text)$/i.test(label))
      ? '[REDACTED]' : sanitize(item, depth + 1);
  }
  return result;
}

function parseXml(source) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('XML DTDs and entities are forbidden.');
  if (XMLValidator.validate(source) !== true) throw new Error('Malformed XML omitted.');
  const parsed = parser.parse(source);
  walk(parsed, () => {}); // Bound depth before recursive processing.
  return parsed;
}

function decodeHtml(source) {
  return source.replace(/&(?:amp|quot|apos|lt|gt|#39|#34|#[0-9]+|#x[0-9a-f]+);/gi, (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&#39;': "'", '&#34;': '"' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const numeric = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    return numeric > 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : '';
  });
}

function parseSimpleQuery(html) {
  const records = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    if (decodeHtml(match[2].replace(/<[^>]*>/g, '')).trim() !== 'R') continue;
    const href = match[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!href) continue;
    // Parse only the identifier and bounded version context; never follow URLs.
    const link = decodeHtml(href[1] ?? href[2]);
    const query = link.indexOf('?');
    if (query < 0) continue;
    const params = new URLSearchParams(link.slice(query + 1).split('#')[0]);
    const values = Object.create(null);
    let duplicate = false;
    for (const [key, value] of params) {
      const name = key.toUpperCase();
      if (Object.hasOwn(values, name)) duplicate = true;
      values[name] = value;
    }
    const { KEY: key, TYPE: type, SWCGUID: guid } = values;
    if (!key || !type || !guid || [key, type, guid].some((v) => v.length > 4096)) continue;
    const context = !duplicate && values.METHOD === 'PLAIN' ? readContext(Object.fromEntries(
      Object.entries(ESR_READ_CONTEXT).map(([name, { query }]) => [name, values[query.toUpperCase()]]))) : null;
    const identity = JSON.stringify([type, key, guid, context]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const [name, namespace] = key.split('|');
    records.push({ category: 'Repository', type: Object.hasOwn(TYPES, type) ? TYPES[type] : type, objectType: type,
      name, namespace: namespace || '', identifier: { object_type: type, object_key: key, swc_guid: guid, ...context },
      hasFullDefinition: false, metadataOnly: false });
  }
  const reported = html.match(/Amount\s+of\s+objects:\s*([0-9]+)/i);
  return { records: sanitize(records), reportedCount: reported ? Number(reported[1]) : undefined,
    recognized: records.length > 0 || Boolean(reported && Number(reported[1]) === 0) };
}

function simpleQueryBody() {
  const form = new URLSearchParams({ qc: 'All software components', underL: 'true', changeL: 'true',
    syncTabL: 'true', deletedL: 'N', xmlReleaseL: '7.1', result: 'RA_XILINK', action: 'Start query' });
  Object.keys(TYPES).forEach((type) => form.append('types', type));
  return form.toString();
}

function namespaces(node, inherited = {}) {
  const result = { ...inherited };
  for (const [key, value] of entries(node)) {
    if (key === '@_xmlns') result[''] = value;
    else if (key.startsWith('@_xmlns:')) result[key.slice(8)] = value;
  }
  return result;
}

function qname(value, ns) {
  if (typeof value !== 'string') return {};
  const parts = value.split(':');
  return { name: parts.pop(), uri: ns[parts.length ? parts[0] : ''] };
}

function namedChildren(node, name, uri, inherited) {
  return entries(node).filter(([key]) => !key.startsWith('@_') && local(key) === name)
    .flatMap(([key, value]) => array(value).map((item) => {
      const ns = namespaces(item, inherited);
      return { node: item, ns, uri: qname(key, ns).uri };
    })).filter((item) => item.uri === uri);
}

// Only locally declared, simple sequence/all structures are supported. Imports,
// choices, extensions and mandatory attributes are deliberately not guessed.
function schemaFields(element, schema, depth = 0) {
  if (depth > 8 || element['@_ref']) return null;
  const ns = namespaces(element, schema.ns);
  let complex = child(element, 'complexType')[0];
  const type = qname(element['@_type'], ns);
  if (!complex && type.uri === BASIS) {
    complex = child(schema.node, 'complexType').find((item) => item['@_name'] === type.name);
  }
  if (!complex) {
    if (type.uri === XSD && ['string', 'normalizedString', 'token', 'anyURI'].includes(type.name)) {
      return element['@_name'] !== 'ReadContext' || type.name === 'string' ? 'string' : null;
    }
    const simple = type.uri === BASIS && namedChildren(schema.node, 'simpleType', XSD, schema.ns)
      .find((item) => item.node['@_name'] === type.name);
    if (!simple || text(simple.node).trim() || entries(simple.node).some(([key]) => !key.startsWith('@_') &&
      !['restriction', 'annotation', '#text'].includes(local(key)))) return null;
    const restrictions = namedChildren(simple.node, 'restriction', XSD, simple.ns);
    if (restrictions.length !== 1) return null;
    const restriction = restrictions[0];
    const base = qname(restriction.node['@_base'], restriction.ns);
    if (base.uri !== XSD || !['string', 'token'].includes(base.name) || text(restriction.node).trim() ||
      entries(restriction.node).some(([key]) => !key.startsWith('@_') &&
        !['enumeration', 'maxLength', 'annotation', '#text'].includes(local(key)))) return null;
    const values = namedChildren(restriction.node, 'enumeration', XSD, restriction.ns)
      .map((item) => item.node['@_value']);
    if (values.length !== child(restriction.node, 'enumeration').length ||
      values.some((value) => typeof value !== 'string')) return null;
    const limits = namedChildren(restriction.node, 'maxLength', XSD, restriction.ns);
    if (limits.length !== child(restriction.node, 'maxLength').length || limits.length > 1) return null;
    const limit = limits[0]?.node['@_value'];
    if (limits.length && (typeof limit !== 'string' || !/^[0-9]+$/.test(limit) ||
      !Number.isSafeInteger(Number(limit)))) return null;
    return { type: 'string', values: values.length ? values : null,
      ...(base.name === 'token' ? { whiteSpace: 'collapse' } : {}),
      ...(limits.length ? { maxLength: Number(limit) } : {}) };
  }
  if (text(complex).trim() || entries(complex).some(([key]) => !key.startsWith('@_') &&
    !['sequence', 'all', 'annotation', 'attribute', '#text'].includes(local(key)))) return null;
  if (child(complex, 'attribute').some((item) => item['@_use'] === 'required')) return null;
  const group = child(complex, 'sequence')[0] || child(complex, 'all')[0];
  if (!group || text(group).trim() || entries(group).some(([key]) => !key.startsWith('@_') &&
    !['element', 'annotation', '#text'].includes(local(key)))) return null;
  if (child(group, 'element').some((field) => !['0', '1'].includes(field['@_minOccurs'] || '1') || field['@_maxOccurs'] === '0')) return null;
  const fields = child(group, 'element').map((field) => ({
    name: field['@_name'], required: field['@_minOccurs'] !== '0',
    qualified: field['@_form'] === 'qualified' || (field['@_form'] !== 'unqualified' && schema.node['@_elementFormDefault'] === 'qualified'),
    shape: schemaFields(field, schema, depth + 1)
  }));
  return fields.every((field) => typeof field.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) &&
    !FORBIDDEN_KEY.test(field.name)) ? fields : null;
}

function confirmContract(wsdl, entity, mode) {
  const definitions = namedChildren(wsdl, 'definitions', WSDL, {})[0];
  if (!definitions || !entity) return null;
  const requestName = `${entity}${mode === 'read' ? 'Read' : 'Query'}Request`;
  const messages = namedChildren(definitions.node, 'message', WSDL, definitions.ns);
  const schemasInWsdl = namedChildren(definitions.node, 'types', WSDL, definitions.ns)
    .flatMap((types) => namedChildren(types.node, 'schema', XSD, types.ns))
    .filter((schema) => schema.node['@_targetNamespace'] === BASIS);
  for (const port of namedChildren(definitions.node, 'portType', WSDL, definitions.ns)) {
    for (const operation of namedChildren(port.node, 'operation', WSDL, port.ns)) {
      const input = namedChildren(operation.node, 'input', WSDL, operation.ns)[0];
      const messageRef = qname(input?.node['@_message'], input?.ns || {});
      if (messageRef.uri !== definitions.node['@_targetNamespace']) continue;
      const message = messages.find((item) => item.node['@_name'] === messageRef.name);
      const parts = message ? namedChildren(message.node, 'part', WSDL, message.ns) : [];
      if (parts.length !== 1) continue;
      const root = qname(parts[0].node['@_element'], parts[0].ns);
      if (root.name !== requestName || root.uri !== BASIS) continue;
      const binding = namedChildren(definitions.node, 'binding', WSDL, definitions.ns).find((item) => {
        const ref = qname(item.node['@_type'], item.ns);
        return ref.name === port.node['@_name'] && ref.uri === definitions.node['@_targetNamespace'] &&
          namedChildren(item.node, 'operation', WSDL, item.ns).some((bound) =>
            bound.node['@_name'] === operation.node['@_name'] &&
            namedChildren(bound.node, 'operation', WSDL_SOAP, bound.ns).some((soap) => soap.node['@_soapAction'] === ACTION));
      });
      if (!binding) continue;
      for (const schema of schemasInWsdl) {
        const declaration = child(schema.node, 'element').find((item) => item['@_name'] === requestName);
        const fields = declaration && schemaFields(declaration, schema);
        if (Array.isArray(fields) && fields.every((field) => field.name && !FORBIDDEN_KEY.test(field.name))) {
          return { requestName, fields };
        }
      }
    }
  }
  return null;
}

function emptyFields(fields) {
  const result = {};
  for (const field of fields) {
    if (!field.required) continue; // Empty query list, not a wildcard filter.
    if (!Array.isArray(field.shape)) return null;
    const nested = emptyFields(field.shape);
    if (nested === null) return null;
    result[field.qualified ? `b:${field.name}` : field.name] = nested;
  }
  return result;
}

function matchesString(shape, value) {
  return typeof value === 'string' && (shape === 'string' ||
    (shape?.type === 'string' && (shape.values === null || shape.values.includes(value)) &&
      (shape.maxLength === undefined || Array.from(value).length <= shape.maxLength) &&
      // Reject rather than silently changing an identifier under xsd:token rules.
      (shape.whiteSpace !== 'collapse' || value === value.replace(/[\t\n\r ]+/g, ' ').replace(/^ | $/g, ''))));
}

function buildSoapRequest(contract, descriptor, params) {
  let request;
  if (params.mode === 'query') {
    if (contract.fields.some((field) => field.required && field.name !== 'Query')) return null;
    request = emptyFields(contract.fields);
  } else {
    const idField = contract.fields.find((field) => [`${descriptor.entity}ID`, 'Identifier', 'ObjectIdentifier'].includes(field.name));
    const context = contract.fields.find((field) => field.name === 'ReadContext');
    if (!idField || contract.fields.some((field) => field !== idField && field !== context && field.required)) return null;
    if (context && context.shape !== 'string' &&
      !(context.shape?.values?.includes('Active') && matchesString(context.shape, 'Active'))) return null;
    const id = params.identifier;
    let value;
    if (matchesString(idField.shape, id)) value = id;
    else if (Array.isArray(idField.shape) && id && typeof id === 'object') {
      if (Object.keys(id).some((key) => !idField.shape.some((field) => field.name === key && matchesString(field.shape, id[key]))) ||
          idField.shape.some((field) => field.required && id[field.name] === undefined)) return null;
      value = Object.fromEntries(idField.shape.filter((field) => id[field.name] !== undefined)
        .map((field) => [field.qualified ? `b:${field.name}` : field.name, id[field.name]]));
    } else return null;
    request = Object.fromEntries(contract.fields.filter((field) => field === idField || field === context)
      .map((field) => [field.qualified ? `b:${field.name}` : field.name, field === context ? 'Active' : value]));
  }
  if (request === null) return null;
  return builder.build({ 's:Envelope': { '@_xmlns:s': SOAP, '@_xmlns:b': BASIS,
    's:Body': { [`b:${contract.requestName}`]: request } } });
}

function soapResponse(parsed, descriptor, mode, readContract) {
  const envelope = namedChildren(parsed, 'Envelope', SOAP, {})[0];
  const body = envelope && namedChildren(envelope.node, 'Body', SOAP, envelope.ns)[0];
  if (!body) return null;
  const responseName = `${descriptor.entity}${mode === 'read' ? 'Read' : 'Query'}Response`;
  const response = namedChildren(body.node, responseName, BASIS, body.ns)[0];
  if (!response) return null;
  if (text(response.node).trim()) return null;
  const name = mode === 'read' ? descriptor.entity : `${descriptor.entity}ID`;
  // Only direct ID/entity children count: nested IDs are not extra records.
  const values = child(response.node, name);
  if (!values.length && mode === 'query') {
    const idField = readContract?.fields.find((field) => [`${descriptor.entity}ID`, 'Identifier', 'ObjectIdentifier'].includes(field.name));
    const id = normalizeIdentifier(response.node);
    // Some query responses expose ONE composite ID as top-level scalar fields.
    // Accept that only when a verified Read contract establishes every field;
    // never count each PartyID/ServiceID/etc. as a separate artifact.
    if (Array.isArray(idField?.shape) && id && typeof id === 'object' &&
      Object.keys(id).every((key) => idField.shape.some((field) => field.name === key && matchesString(field.shape, id[key]))) &&
      idField.shape.every((field) => !field.required || id[field.name] !== undefined)) {
      return [{ category: descriptor.category, type: descriptor.entity, identifier: sanitize(id),
        identifierSource: 'top-level-fields', hasFullDefinition: false, metadataOnly: false }];
    }
  }
  const identifiers = mode === 'query' ? values.map(normalizeIdentifier) : [];
  if (mode === 'query' && identifiers.some((id) => id === null)) return null;
  if (mode === 'read' && values.some((value) => !value || typeof value !== 'object' ||
    !entries(value).some(([key]) => !key.startsWith('@_') && key !== '#text'))) return null;
  if (!values.length && entries(response.node).some(([key]) => !key.startsWith('@_') && key !== '#text')) return null;
  return values.map((value, index) => {
    const artifact = { category: descriptor.category, type: descriptor.entity,
      hasFullDefinition: mode === 'read', metadataOnly: false };
    if (mode === 'read') artifact.definition = sanitize(value);
    else artifact.identifier = sanitize(identifiers[index]);
    return artifact;
  });
}

function normalizeIdentifier(value) {
  if (typeof value === 'string') return value.trim() ? value : null;
  const fields = entries(value).filter(([key]) => !key.startsWith('@_') && key !== '#text');
  if (!fields.length) return text(value).trim() || null;
  if (text(value).trim()) return null;
  const id = {};
  for (const [key, item] of fields) {
    const name = local(key);
    if (typeof item !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      FORBIDDEN_KEY.test(name) || SECRET.test(name) || Object.hasOwn(id, name)) return null;
    id[name] = item;
  }
  return Object.values(id).some((item) => item.trim()) ? id : null;
}

function parseResponse(data, contentType = '') {
  const warnings = [];
  let parsed;
  let response = { format: 'omitted', body: null };
  if (Buffer.isBuffer(data)) {
    if (data.length > MAX_BYTES) throw new Error('Response exceeds 5 MB.');
    const decoded = data.toString('utf8');
    if (decoded.includes('\ufffd')) return { response, warnings: ['Binary response omitted; cannot sanitize safely.'] };
    data = decoded;
  }
  const source = typeof data === 'string' ? data : JSON.stringify(data ?? null);
  if (Buffer.byteLength(source, 'utf8') > MAX_BYTES) throw new Error('Response exceeds 5 MB.');
  const html = /text\/html|application\/xhtml\+xml/i.test(contentType) ||
    /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?html\b/i.test(source) || /^\s*(?:<!doctype\s+html|<table\b|<form\b)/i.test(source);
  // A static HTML doctype is not evaluated by the HTML-summary parser. XML
  // DTDs, internal subsets and entity declarations are always rejected.
  const dtdSource = html ? source.replace(/<!doctype\s+html\b[^\[\]>]*>/gi, '') : source;
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(dtdSource)) throw new Error('XML DTDs and entities are forbidden.');
  if (html) {
    const login = /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?input\b[^>]*\btype\s*=\s*["']?password\b|(?:log[ -]?in|sign[ -]?in|j_security_check|samlrequest)/i.test(source);
    const query = parseSimpleQuery(source);
    // Never expose raw HTML: hidden inputs, scripts and URLs may contain secrets.
    response = { format: 'html-summary', body: sanitize({ reportedCount: query.reportedCount ?? null,
      records: query.records, loginDetected: login }) };
    warnings.push('Raw HTML omitted; only safely parsed result identifiers are retained.');
    return { response, warnings, login, simpleQuery: sanitize(query) };
  }
  try {
    if (typeof data === 'object' && data !== null) {
      parsed = data;
      response = { format: 'json', body: sanitize(data) };
    } else if (/^\s*</.test(source)) {
      parsed = parseXml(source);
      response = { format: 'xml', body: sanitize(parsed) };
    } else if (/^\s*[\[{]/.test(source)) {
      parsed = JSON.parse(source);
      response = { format: 'json', body: sanitize(parsed) };
    } else warnings.push('Unparsed response omitted; cannot sanitize safely.');
  } catch (error) {
    warnings.push('Unparseable response omitted; cannot sanitize safely.');
  }
  let fault = false;
  if (parsed) walk(parsed, (key) => { if (local(key) === 'Fault') fault = true; });
  return { parsed: parsed && sanitize(parsed), response, warnings, fault };
}

function paginate(result, records, params, reportedCount) {
  result.status = 'ok';
  result.metadataOnly = false;
  result.actualCount = records.length;
  result.returned = Math.min(params.maxItems, Math.max(0, records.length - params.offset));
  result.offset = params.offset;
  result.truncated = params.offset > 0 || params.offset + result.returned < records.length;
  if (reportedCount !== undefined) {
    result.reportedCount = reportedCount;
    if (reportedCount !== records.length) {
      result.warnings.push('Reported count differs from the number of parsed records.');
      if (reportedCount > records.length) result.truncated = true;
    }
  }
  result.artifacts = sanitize(records.slice(params.offset, params.offset + params.maxItems));
  return result;
}

function createEndpointFetcher({ executeHttpRequest, buildPipoAuthHeaders }) {
  if (typeof executeHttpRequest !== 'function' || typeof buildPipoAuthHeaders !== 'function') {
    throw new TypeError('HTTP executor and authentication header builder are required.');
  }
  return async function fetchEndpoint(descriptorOrTool, params = {}) {
    const descriptor = typeof descriptorOrTool === 'string' ? getEndpoint(descriptorOrTool) :
      ENDPOINTS.includes(descriptorOrTool) ? descriptorOrTool : undefined;
    const result = { path: descriptor?.path || null, tool: descriptor?.tool || null,
      category: descriptor?.category || 'Metadata', status: 'unsupported', metadataOnly: true,
      artifacts: [], response: { format: 'omitted', body: null }, warnings: [] };
    if (!descriptor) {
      result.warnings.push('Unknown endpoint; only registry descriptors or fixed tool/path names are accepted.');
      return result;
    }
    // Never strip unknown keys before validating; that could hide mutation attempts.
    const validated = schemas.get(descriptor.tool).safeParse(params);
    if (!validated.success) {
      result.status = 'needs_parameters';
      result.warnings.push('Invalid or unexpected parameters; use the registered bounded tool schema.');
      return result;
    }
    params = validated.data;
    if (params.mode === 'read' && descriptor.kind === 'soap' && descriptor.entity && params.identifier === undefined) {
      result.status = 'needs_parameters';
      result.warnings.push('Read requires a structured identifier: a string or flat string object.');
      return result;
    }
    const statusParams = new URLSearchParams({ party: params.party ?? '*',
      service: params.service ?? '*', channel: params.channel ?? '*', action: 'status' });
    const channelUrl = `${descriptor.path}?${statusParams}`;
    const context = readContext(params);
    const repositoryReadUrl = descriptor.kind === 'read' && descriptor.path === '/rep/read/ext' &&
      params.mode !== 'metadata' && context && ['object_type', 'object_key', 'swc_guid'].every((key) => params[key])
      ? `/rep/read/ext?${new URLSearchParams({ method: 'PLAIN', TYPE: params.object_type,
        KEY: params.object_key, VC: context.vc, SWCGUID: params.swc_guid,
        SP: context.sp, UC: context.uc, release: context.release })}` : null;
    const request = async (url, method = 'get', data, headers = {}) => {
      // Each attempt owns its status; a failed SOAP call must not inherit WSDL 200.
      delete result.httpStatus;
      delete result.failureLayer;
      delete result.failureCode;
      if (result.status === 'failed') result.status = 'unsupported';
      // Allow only fixed paths and the exact parameter URLs computed above.
      const allowed = url === descriptor.path || descriptor.wsdlPaths?.includes(url) ||
        (descriptor.kind === 'diagnostic' && url === descriptor.probePath) ||
        (descriptor.kind === 'soap' && descriptor.wsdlPaths?.some((path) => path.slice(0, -5) === url)) ||
        (descriptor.path === '/AdapterFramework/ChannelAdminServlet' && url === channelUrl) ||
        (repositoryReadUrl !== null && url === repositoryReadUrl);
      if (!allowed) throw new Error('Request path is not allowlisted.');
      let timer;
      const controller = new AbortController();
      const pending = executeHttpRequest({ destinationName: descriptor.destination }, {
        method, url, ...(data === undefined ? {} : { data }),
        headers: { ...buildPipoAuthHeaders(), ...headers }, timeout: TIMEOUT,
        maxRedirects: 0, maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES,
        signal: controller.signal,
        responseType: 'text', transformResponse: [(body) => body], validateStatus: () => true
      });
      let http;
      try {
        http = await Promise.race([pending, new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Request timed out.'));
          }, TIMEOUT);
        })]);
      } finally { clearTimeout(timer); }
      const httpStatus = safeHttpStatus(http.status);
      if (httpStatus !== undefined) result.httpStatus = httpStatus;
      const parsed = parseResponse(http.data, http.headers?.['content-type'] || '');
      result.response = parsed.response;
      result.warnings.push(...parsed.warnings);
      if (httpStatus === undefined || httpStatus < 200 || httpStatus >= 300 || parsed.login || parsed.fault) {
        result.status = 'failed';
        result.failureLayer = 'source';
        if (parsed.fault) result.failureCode = 'SOAP_FAULT';
        else if (parsed.login) result.failureCode = 'AUTH_REQUIRED';
        result.artifacts = [];
        result.response = { format: 'omitted', body: null };
        result.warnings.push(parsed.fault ? 'SOAP fault received.' : parsed.login ? 'Login HTML is not a successful endpoint response.' : 'HTTP request did not succeed.');
        return null;
      }
      return parsed;
    };
    try {
      if (descriptor.kind === 'soap') {
        let wsdl;
        let wsdlPath;
        for (const path of descriptor.wsdlPaths) {
          const probe = await request(path);
          if (probe?.parsed && namedChildren(probe.parsed, 'definitions', WSDL, {}).length) {
            wsdl = probe.parsed;
            wsdlPath = path;
            break;
          }
          // A missing URL or a successful non-WSDL probe may use the exact base
          // fallback. Never retry auth, fault, redirect or server failures.
          if (!probe && ![404, 405].includes(result.httpStatus)) break;
        }
        if (!wsdl) {
          if (result.status !== 'failed') result.status = 'metadata-only';
          result.warnings.push('No verified WSDL; no SOAP data request was sent.');
          return result;
        }
        result.status = 'metadata-only';
        result.artifacts = [{ category: 'Metadata', type: 'WSDL', definition: sanitize(wsdl), metadataOnly: true,
          hasFullDefinition: false }];
        if (params.mode === 'metadata' || !descriptor.entity) return result;
        const contract = confirmContract(wsdl, descriptor.entity, params.mode);
        const body = contract && buildSoapRequest(contract, descriptor, params);
        if (!body) {
          if (contract && params.mode === 'read') {
            result.status = 'needs_parameters';
            result.warnings.push('Identifier does not match the verified Read contract; no data request sent.');
          } else result.warnings.push('WSDL does not establish a supported local Query/Read contract; no data request sent.');
          return result;
        }
        // Ignore soap:address and imports. Only the address used for the verified
        // allowlisted WSDL (without ?wsdl) is eligible for a data request.
        const response = await request(wsdlPath.slice(0, -5), 'post', body,
          { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: ACTION });
        if (!response) return result;
        const readContract = params.mode === 'query' ? confirmContract(wsdl, descriptor.entity, 'read') : null;
        const records = response.parsed && soapResponse(response.parsed, descriptor, params.mode, readContract);
        if (!records) {
          result.status = 'metadata-only';
          result.warnings.push('Unrecognized SOAP response; no artifact count inferred.');
          return result;
        }
        if (records.some((record) => record.identifierSource === 'top-level-fields')) {
          result.warnings.push('Top-level query ID fields matched the Read contract and were treated as one composite identifier.');
        }
        return paginate(result, records, params);
      }
      if (descriptor.kind === 'simple-query' && params.mode === 'read') {
        result.status = 'needs_parameters';
        result.warnings.push('Use fetch_pi8_repository_read_ext with an enumerated read identifier.');
        return result;
      }
      if (descriptor.kind === 'read' && params.mode !== 'metadata') {
        // Directory read servlet has no evidenced ESR-style protocol. Never reuse it there.
        if (descriptor.category !== 'Repository' || !repositoryReadUrl) {
          result.status = 'needs_parameters';
          result.warnings.push(descriptor.category === 'Repository'
            ? 'ESR Read requires object_type, object_key, swc_guid and vc/sp/uc/release from a current SimpleQuery R link; rerun discovery for older catalogs.'
            : 'No verified directory read protocol; directory read is probe-only.');
          return result;
        }
        const response = await request(repositoryReadUrl);
        if (!response) return result;
        // A generic read servlet's response cannot establish a full typed object
        // contract on its own. Preserve its sanitized payload, not an invented interface.
        result.status = 'metadata-only';
        result.warnings.push('Read payload retained; full ESR definition contract is not verified.');
        return result;
      }
      const simple = descriptor.kind === 'simple-query' && params.mode === 'query';
      const url = descriptor.path === '/AdapterFramework/ChannelAdminServlet'
        ? channelUrl : descriptor.probePath || descriptor.path;
      const response = await request(url, simple ? 'post' : 'get', simple ? simpleQueryBody() : undefined,
        simple ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {});
      if (!response) return result;
      if ((simple || descriptor.kind === 'query' && descriptor.category === 'Repository' && params.mode === 'query') && response.simpleQuery?.recognized) {
        return paginate(result, response.simpleQuery.records, params, response.simpleQuery.reportedCount);
      }
      result.status = 'metadata-only';
      if (descriptor.kind === 'diagnostic' && response.parsed) {
        result.artifacts = [{ category: 'Monitoring', type: 'DiagnosticSnapshot',
          definition: response.response.body, metadataOnly: true, hasFullDefinition: false }];
      } else if (descriptor.kind === 'diagnostic') {
        result.warnings.push('Diagnostic response was not safely parsed; no snapshot was emitted.');
      } else if (params.mode !== 'metadata') {
        result.status = 'needs_parameters';
        result.warnings.push('Protocol response only; no verified query body or extractable records.');
      }
      if (descriptor.path === '/CPACache') {
        result.warnings.push('CPA Cache monitor probe only; Display content POST form fields are unverified, so no content request was sent.');
      } else if (descriptor.path === '/mdt') {
        result.warnings.push('Message Display Tool entry-page probe only; no message search or payload request was sent.');
      }
      return result;
    } catch (error) {
      // Do not serialize exceptions: SDK errors often contain auth/request config.
      // Only numeric status fields are eligible; never retain error bodies/headers.
      const httpStatus = safeHttpStatus(error?.response?.status) ?? safeHttpStatus(error?.status);
      if (httpStatus !== undefined) result.httpStatus = httpStatus;
      result.status = 'failed';
      result.failureLayer = 'source';
      result.metadataOnly = true;
      result.response = { format: 'omitted', body: null };
      result.artifacts = [];
      result.warnings.push('Request failed, timed out, exceeded 5 MB, or contained unsafe XML; sensitive error details omitted.');
      return result;
    }
  };
}

module.exports = { createEndpointFetcher, endpointSchema, parseSimpleQuery, sanitize, confirmContract,
  buildSoapRequest, parseResponse, MAX_BYTES, TIMEOUT };