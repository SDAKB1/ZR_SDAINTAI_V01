'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { z } = require('zod');
const { ENDPOINTS, getEndpoint } = require('./pipo-endpoints');
const { createEndpointFetcher, endpointSchema, parseSimpleQuery, parseResponse, MAX_BYTES, TIMEOUT } = require('./endpoint-fetcher');
const { exportDefinitions } = require('./definition-export');

const BASIS = 'http://sap.com/xi/BASIS';
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const ACTION = 'http://sap.com/xi/WebService/soap1.1';
const paths = [
  '/AdapterFramework/ChannelAdminServlet', '/AlertRuleInService', '/BPMFacadeBeanImplService',
  '/BusinessComponentInService', '/CPACache', '/CommunicationChannelInService', '/ConfigurationScenarioInService',
  '/IntegratedConfiguration750InService', '/IntegratedConfigurationInService', '/IntegrationProcessInService',
  '/InterfaceDeterminationInService', '/ReceiverAgreementInService', '/ReceiverDeterminationInService',
  '/ReceiverRuleInService', '/SenderAgreementInService', '/ValueMappingInService', '/dir/query/ext',
  '/dir/read/ext', '/mdt', '/rep/query/ext', '/rep/query/int', '/rep/read/ext', '/rep/support/SimpleQuery'
];
const suffixes = ['channel_admin', 'alert_rule', 'bpm_facade', 'business_component', 'cpa_cache',
  'communication_channel', 'configuration_scenario', 'integrated_configuration_750', 'integrated_configuration',
  'integration_process', 'interface_determination', 'receiver_agreement', 'receiver_determination', 'receiver_rule',
  'sender_agreement', 'value_mapping', 'directory_query_ext', 'directory_read_ext', 'message_diagnostics',
  'repository_query_ext', 'repository_query_int', 'repository_read_ext', 'repository_simple_query'];

function wsdl(entity = 'BusinessComponent', options = {}) {
  const idShape = options.idShape || (options.stringID ? '<x:element name="Identifier" type="x:string"/>' :
    `<x:element name="${entity}ID"><x:complexType><x:sequence>
      <x:element name="PartyID" type="x:string" minOccurs="0"/>
      <x:element name="ServiceID" type="x:string"/>
    </x:sequence></x:complexType></x:element>`);
  return `<w:definitions xmlns:w="http://schemas.xmlsoap.org/wsdl/" xmlns:x="http://www.w3.org/2001/XMLSchema"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:b="${BASIS}"
    xmlns:t="urn:offline" targetNamespace="urn:offline">
    <w:import namespace="urn:external" location="http://169.254.169.254/never-fetch"/>
    <w:types><x:schema targetNamespace="${BASIS}" elementFormDefault="qualified">
      ${options.types || ''}
      <x:element name="${entity}QueryRequest"><x:complexType><x:sequence>
        <x:element name="Query" type="x:string" minOccurs="0" maxOccurs="unbounded"/>
      </x:sequence></x:complexType></x:element>
      ${options.requestType ? `<x:element name="${entity}ReadRequest" type="${options.requestType}"/>` :
        `<x:element name="${entity}ReadRequest"><x:complexType><x:sequence>${idShape}${options.readFields || ''}</x:sequence></x:complexType></x:element>`}
    </x:schema></w:types>
    <w:message name="Q"><w:part name="parameters" element="b:${entity}QueryRequest"/></w:message>
    <w:message name="R"><w:part name="parameters" element="b:${entity}ReadRequest"/></w:message>
    <w:portType name="P">
      <w:operation name="query"><w:input message="t:Q"/></w:operation>
      <w:operation name="read"><w:input message="t:R"/></w:operation>
    </w:portType>
    <w:binding name="B" type="t:P"><soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
      <w:operation name="query"><soap:operation soapAction="${options.action || ACTION}"/></w:operation>
      <w:operation name="read"><soap:operation soapAction="${options.action || ACTION}"/></w:operation>
    </w:binding><w:service name="S"><w:port name="p" binding="t:B">
      <soap:address location="http://169.254.169.254/never-fetch"/>
    </w:port></w:service></w:definitions>`;
}

// Minimal synthetic contracts matching the local type structure of the supplied
// Directory WSDLs. No uploaded object data or service addresses are retained.
function directoryWsdl(entity) {
  const fields = entity === 'CommunicationChannel'
    ? [['PartyID', 'CommunicationPartyID', true], ['ComponentID', 'CommunicationComponentComponentID'],
      ['ChannelID', 'CommunicationChannelChannelID']]
    : [['SenderPartyID', 'CommunicationPartyID', true], ['SenderComponentID', 'CommunicationComponentComponentID'],
      ['InterfaceName', 'DesignObjectName'], ['InterfaceNamespace', 'DesignObjectNamespace'],
      ['ReceiverPartyID', 'CommunicationPartyID', true], ['ReceiverComponentID', 'CommunicationComponentComponentID', true]];
  const idType = entity === 'CommunicationChannel' ? 'CommunicationChannelID' : 'MessageHeaderID';
  return wsdl(entity, {
    requestType: `${entity}ReadIn`,
    types: `<x:simpleType name="ReadContextCode"><x:restriction base="x:token">
      <x:enumeration value="User"/><x:enumeration value="Active"/>
    </x:restriction></x:simpleType>` + [
      ['CommunicationPartyID', 'token', 60], ['CommunicationComponentComponentID', 'token', 60],
      ['CommunicationChannelChannelID', 'token', 60], ['DesignObjectName', 'string', 120],
      ['DesignObjectNamespace', 'token', 255]
    ].map(([name, base, max]) => `<x:simpleType name="${name}"><x:restriction base="x:${base}">
      <x:maxLength value="${max}"/>
    </x:restriction></x:simpleType>`).join('') + `
    <x:complexType name="${idType}"><x:sequence>${fields.map(([name, type, optional]) =>
      `<x:element name="${name}" type="${type}"${optional ? ' minOccurs="0"' : ''}/>`).join('')}
    </x:sequence></x:complexType>
    <x:complexType name="${entity}ReadIn"><x:sequence>
      <x:element default="User" minOccurs="0" name="ReadContext" type="ReadContextCode"/>
      <x:element maxOccurs="unbounded" minOccurs="0" name="${entity}ID" type="${idType}"/>
    </x:sequence></x:complexType>`
  }).replace('elementFormDefault="qualified"', `xmlns="${BASIS}"`);
}

function envelope(body) {
  return `<s:Envelope xmlns:s="${SOAP}" xmlns:b="${BASIS}"><s:Body>${body}</s:Body></s:Envelope>`;
}

function reply(data, status = 200, contentType = 'text/xml') {
  return { status, data, headers: { 'content-type': contentType, 'set-cookie': 'synthetic-private-header' } };
}

function fixture(responses, options = {}) {
  const calls = [];
  let index = 0;
  const fetch = createEndpointFetcher({
    buildPipoAuthHeaders: () => options.auth || {},
    executeHttpRequest: async (destination, request) => {
      calls.push({ destination, request });
      const response = typeof responses === 'function' ? responses(request, index++) : responses[index++];
      if (response instanceof Error) throw response;
      assert.ok(response, 'Unexpected extra HTTP request');
      return response;
    }
  });
  return { fetch, calls };
}

function resultHtml(count = 3, reported = count) {
  return '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html><body>' +
    `<p>Amount of objects: ${reported}</p><table>` + Array.from({ length: count }, (_, i) =>
      `<tr><td>Object ${i}</td><td>SWCV</td><td><a class="raw" href='/untrusted/read?KEY=Object${i}%7Curn%3Aexample&amp;TYPE=ifmmessif&amp;SWCGUID=005056a1-2345-1edf-9abc-${i.toString(16).padStart(12, '0')}'>R</a></td></tr>`
    ).join('') + '</table></body></html>';
}

test('registry contains exactly the 23 fixed paths and stable unique tool names', () => {
  assert.deepEqual(ENDPOINTS.map((entry) => entry.path), paths);
  assert.deepEqual(ENDPOINTS.map((entry) => entry.tool), suffixes.map((suffix) => `fetch_pi8_${suffix}`));
  assert.equal(new Set(ENDPOINTS.map((entry) => entry.tool)).size, 23);
  assert.ok(Object.isFrozen(ENDPOINTS));
  for (const entry of ENDPOINTS) {
    assert.equal(getEndpoint(entry.tool), entry);
    assert.equal(getEndpoint(entry.path), entry);
    assert.ok(Object.isFrozen(entry));
    assert.equal(entry.destination, entry.path.startsWith('/rep/') ? 'PO_PJ2_ESR' : 'PO_PJ2_DIR');
  }
  assert.equal(getEndpoint('/unknown'), undefined);
  assert.equal(getEndpoint('https://example.invalid/mdt'), undefined);
  assert.equal(getEndpoint('/CPACache?refresh=true'), undefined);
  assert.equal(getEndpoint('/IntegratedConfiguration750InService').entity, 'IntegratedConfiguration');
  const source = readFileSync(join(__dirname, 'pipo-endpoints.js'), 'utf8');
  assert.doesNotMatch(source, /require\s*\(/); // Registry remains importable without server dependencies.
});

test('every shared server schema is strict and bounds paging/mode', () => {
  for (const descriptor of ENDPOINTS) {
    const schema = endpointSchema(descriptor);
    assert.deepEqual(schema.parse({}), { mode: 'query', maxItems: 150, offset: 0 });
    assert.equal(schema.safeParse({ path: '/evil' }).success, false);
    for (const invalid of [{ maxItems: 1001 }, { maxItems: 0 }, { offset: -1 }, { offset: 1.2 }, { mode: 'delete' }]) {
      assert.equal(schema.safeParse(invalid).success, false);
    }
  }
});

test('server registers exactly the 23 registry tools without launching HTTP/RFC or touching existing tools', () => {
  const registered = [];
  const legacy = [];
  const source = readFileSync(join(__dirname, 'server.js'), 'utf8');
  const start = source.indexOf('function buildMcpServer()');
  const end = source.indexOf('// --- HTTP wiring', start);
  assert.ok(start >= 0 && end > start);
  runInNewContext(source.slice(start, end) + '\nbuildMcpServer();', {
    McpServer: class {
      tool(name) { legacy.push(name); }
      registerTool(name, config) { registered.push({ name, config }); }
    },
    z, ENDPOINTS, endpointSchema, createEndpointFetcher,
    executeHttpRequest: () => { throw new Error('Must not run at registration time'); },
    buildPipoAuthHeaders: () => ({})
  });
  assert.deepEqual(registered.map(({ name }) => name), ENDPOINTS.map(({ tool }) => tool));
  assert.deepEqual(legacy, ['call_rfc', 'get_rfc_metadata', 'get_pi8_status', 'list_pi8_esr_objects']);
  for (const { config } of registered) {
    assert.equal(config.inputSchema.safeParse({ action: 'stop' }).success, false);
    assert.equal(config.annotations.readOnlyHint, true);
  }
});

test('unknown descriptors, SSRF inputs and mutation parameters never make requests', async () => {
  const { fetch, calls } = fixture([]);
  for (const target of ['http://169.254.169.254/', '/CPACache?refresh=1', { ...getEndpoint('/CPACache') }]) {
    assert.equal((await fetch(target)).status, 'unsupported');
  }
  for (const params of [{ url: 'http://example.invalid' }, { path: '/start' }, { SOAPAction: 'delete' },
    { action: 'stop' }, { headers: {} }, { destination: 'OTHER' }, { mode: 'start' }, { maxItems: 1001 }]) {
    assert.equal((await fetch('/CPACache', params)).status, 'needs_parameters');
  }
  const invalid = { mode: 'read', identifier: { ServiceID: { nested: 'not flat' } } };
  assert.equal((await fetch('/BusinessComponentInService', invalid)).status, 'needs_parameters');
  assert.equal(calls.length, 0);
});

test('SOAP query uses verified WSDL root and fixed action, with direct IDs and local pagination', async () => {
  const query = envelope('<b:BusinessComponentQueryResponse>' +
    '<b:BusinessComponentID><b:ServiceID>First</b:ServiceID></b:BusinessComponentID>' +
    '<b:BusinessComponentID><b:ServiceID>Second</b:ServiceID></b:BusinessComponentID>' +
    '</b:BusinessComponentQueryResponse>');
  const { fetch, calls } = fixture([reply(wsdl()), reply(query)]);
  const output = await fetch('fetch_pi8_business_component', { maxItems: 1, offset: 1 });
  assert.equal(output.status, 'ok');
  assert.equal(output.actualCount, 2);
  assert.equal(output.returned, 1);
  assert.equal(output.truncated, true);
  assert.equal(output.artifacts[0].identifier.ServiceID, 'Second');
  assert.ok(endpointSchema(getEndpoint('/BusinessComponentInService')).safeParse({
    mode: 'read', identifier: output.artifacts[0].identifier
  }).success);
  assert.equal(output.artifacts[0].hasFullDefinition, false);
  assert.equal(output.response.format, 'xml');
  assert.deepEqual(calls.map(({ request }) => request.url), [
    '/BusinessComponentInService/BusinessComponentInImplBean?wsdl', '/BusinessComponentInService/BusinessComponentInImplBean'
  ]);
  assert.equal(calls[1].request.headers.SOAPAction, ACTION);
  assert.match(calls[1].request.data, /<b:BusinessComponentQueryRequest\s*\/>/);
  assert.doesNotMatch(calls[1].request.data, /<b:Query|169\.254/);
});

test('SOAP read escapes structured identifiers and returns only the full known entity', async () => {
  const read = envelope(`<b:BusinessComponentReadResponse><b:BusinessComponent>
    <b:BusinessComponentID><b:ServiceID>Safe</b:ServiceID></b:BusinessComponentID>
    <b:Description>Definition</b:Description><b:Password>synthetic-pw</b:Password>
    <b:AdapterSpecificAttribute><b:Name>OAuthToken</b:Name><b:Value>synthetic-oauth</b:Value></b:AdapterSpecificAttribute>
    <b:AdapterSpecificAttribute Name="Password" Value="synthetic-attribute"/>
  </b:BusinessComponent></b:BusinessComponentReadResponse>`);
  const { fetch, calls } = fixture([reply(wsdl()), reply(read)]);
  const output = await fetch('/BusinessComponentInService', { mode: 'read', identifier: { ServiceID: 'A&<b:Delete/>' } });
  assert.equal(output.status, 'ok');
  assert.equal(output.actualCount, 1); // Nested entity IDs are not extra artifacts.
  assert.equal(output.artifacts[0].hasFullDefinition, true);
  assert.match(calls[1].request.data, /A&amp;&lt;b:Delete\s*\/&gt;/);
  assert.doesNotMatch(calls[1].request.data, /<b:Delete/);
  assert.doesNotMatch(JSON.stringify(output), /synthetic-pw|synthetic-oauth|synthetic-attribute/);
  assert.equal(output.artifacts[0].definition['b:Description'], 'Definition');
});

test('read accepts string identifiers only where the WSDL establishes a scalar ID', async () => {
  const data = envelope('<b:BusinessComponentReadResponse><b:BusinessComponent><Name>Example</Name></b:BusinessComponent></b:BusinessComponentReadResponse>');
  const scalar = fixture([reply(wsdl('BusinessComponent', { stringID: true })), reply(data)]);
  assert.equal((await scalar.fetch('/BusinessComponentInService', { mode: 'read', identifier: 'A&B' })).status, 'ok');
  assert.match(scalar.calls[1].request.data, /<b:Identifier>A&amp;B<\/b:Identifier>/);
  const structured = fixture([reply(wsdl())]);
  assert.equal((await structured.fetch('/BusinessComponentInService', { mode: 'read', identifier: 'A' })).status, 'needs_parameters');
  assert.equal(structured.calls.length, 1);
  const missing = fixture([]);
  assert.equal((await missing.fetch('/BusinessComponentInService', { mode: 'read' })).status, 'needs_parameters');
});

test('SOAP read emits Active for a required named ReadContext with a typed Identifier', async () => {
  const contract = wsdl('BusinessComponent', {
    idShape: '<x:element name="Identifier" type="b:BusinessComponentIdentifier"/>',
    readFields: '<x:element name="ReadContext" type="b:ReadContext"/>',
    types: `<x:complexType name="BusinessComponentIdentifier"><x:sequence>
      <x:element name="PartyID" type="x:string"/>
      <x:element name="ServiceID" type="b:ComponentName"/>
    </x:sequence></x:complexType>
    <x:simpleType name="ComponentName"><x:restriction base="x:string"/></x:simpleType>
    <x:simpleType name="ReadContext"><x:restriction base="x:string">
      <x:enumeration value="Active"/><x:enumeration value="User"/>
    </x:restriction></x:simpleType>`
  });
  const data = envelope('<b:BusinessComponentReadResponse><b:BusinessComponent><b:Description>Definition</b:Description></b:BusinessComponent></b:BusinessComponentReadResponse>');
  const { fetch, calls } = fixture([reply(contract), reply(data)]);
  const output = await fetch('/BusinessComponentInService', {
    mode: 'read', identifier: { PartyID: '', ServiceID: 'Example&<Component>' }
  });
  assert.equal(output.status, 'ok');
  assert.equal(output.actualCount, 1);
  assert.equal(output.artifacts[0].hasFullDefinition, true);
  assert.deepEqual(calls.map(({ request }) => request.method), ['get', 'post']);
  assert.match(calls[1].request.data, /<b:Identifier><b:PartyID\s*\/><b:ServiceID>Example&amp;&lt;Component&gt;<\/b:ServiceID><\/b:Identifier><b:ReadContext>Active<\/b:ReadContext>/);
  assert.doesNotMatch(calls[1].request.data, />User<|169\.254/);
});

test('SOAP read supports direct string ReadContext and omits unknown optional fields', async () => {
  const contract = wsdl('BusinessComponent', { stringID: true, readFields:
    '<x:element name="ReadContext" type="x:string"/><x:element name="Unknown" type="x:string" minOccurs="0"/>' });
  const { fetch, calls } = fixture([reply(contract), reply(envelope('<b:BusinessComponentReadResponse/>'))]);
  assert.equal((await fetch('/BusinessComponentInService', { mode: 'read', identifier: 'Example' })).status, 'ok');
  assert.equal(calls.length, 2);
  assert.match(calls[1].request.data, /<b:ReadContext>Active<\/b:ReadContext>/);
  assert.doesNotMatch(calls[1].request.data, /Unknown/);
});

test('Directory Reads support named token restrictions and unqualified composite IDs', async () => {
  for (const [entity, path, identifier, expectedID] of [
    ['CommunicationChannel', '/CommunicationChannelInService',
      { ChannelID: 'Channel&One', ComponentID: 'Component', PartyID: '' },
      '<CommunicationChannelID><PartyID/><ComponentID>Component</ComponentID><ChannelID>Channel&amp;One</ChannelID></CommunicationChannelID>'],
    ['IntegratedConfiguration', '/IntegratedConfigurationInService',
      { ReceiverComponentID: '', InterfaceNamespace: 'urn:offline', InterfaceName: 'Interface',
        SenderComponentID: 'Sender', SenderPartyID: '', ReceiverPartyID: '' },
      '<IntegratedConfigurationID><SenderPartyID/><SenderComponentID>Sender</SenderComponentID><InterfaceName>Interface</InterfaceName><InterfaceNamespace>urn:offline</InterfaceNamespace><ReceiverPartyID/><ReceiverComponentID/></IntegratedConfigurationID>']
  ]) {
    const data = envelope(`<b:${entity}ReadResponse><${entity}><Description>Definition</Description></${entity}></b:${entity}ReadResponse>`);
    const { fetch, calls } = fixture([reply(directoryWsdl(entity)), reply(data)]);
    const output = await fetch(path, { mode: 'read', identifier });
    assert.equal(output.status, 'ok');
    assert.equal(output.actualCount, 1);
    assert.equal(output.artifacts[0].hasFullDefinition, true);
    assert.deepEqual(calls.map(({ request }) => [request.method, request.url]), [
      ['get', `${path}/${path.slice(1).replace(/Service$/, '')}ImplBean?wsdl`],
      ['post', `${path}/${path.slice(1).replace(/Service$/, '')}ImplBean`]
    ]);
    assert.ok(calls[1].request.data.includes(`<b:${entity}ReadRequest><ReadContext>Active</ReadContext>${expectedID}</b:${entity}ReadRequest>`));
    assert.equal(calls[1].request.headers.SOAPAction, ACTION);
    assert.doesNotMatch(calls[1].request.data, />User<|169\.254/);
  }
});

test('Directory string length limits count Unicode characters and allow optional ID omission', async () => {
  const { fetch, calls } = fixture([reply(directoryWsdl('IntegratedConfiguration')),
    reply(envelope('<b:IntegratedConfigurationReadResponse/>'))]);
  const output = await fetch('/IntegratedConfigurationInService', { mode: 'read', identifier: {
    SenderComponentID: 'S'.repeat(60), InterfaceName: '😀'.repeat(120), InterfaceNamespace: 'n'.repeat(255)
  } });
  assert.equal(output.status, 'ok');
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].request.data, /SenderPartyID|ReceiverPartyID|ReceiverComponentID/);
});

test('Directory Reads reject overlong, incomplete, unknown and noncanonical token IDs without posting', async () => {
  const identifier = { PartyID: '', ComponentID: 'Component', ChannelID: 'Channel' };
  for (const invalid of [
    { ...identifier, PartyID: 'p'.repeat(61) },
    { ...identifier, ComponentID: 'c'.repeat(61) },
    { ...identifier, ChannelID: 'c'.repeat(61) },
    { ...identifier, ComponentID: ' Component' },
    { ...identifier, ComponentID: 'Component ' },
    { ...identifier, ComponentID: 'Two  Words' },
    { ...identifier, ComponentID: 'Two\tWords' },
    { ...identifier, Unknown: 'value' },
    { PartyID: '', ChannelID: 'Channel' }
  ]) {
    const { fetch, calls } = fixture([reply(directoryWsdl('CommunicationChannel'))]);
    const output = await fetch('/CommunicationChannelInService', { mode: 'read', identifier: invalid });
    assert.equal(output.status, 'needs_parameters');
    assert.equal(calls.length, 1);
  }
  for (const field of ['InterfaceName', 'InterfaceNamespace']) {
    const { fetch, calls } = fixture([reply(directoryWsdl('IntegratedConfiguration'))]);
    assert.equal((await fetch('/IntegratedConfigurationInService', { mode: 'read', identifier: {
      SenderComponentID: 'Sender', InterfaceName: 'Interface', InterfaceNamespace: 'urn:offline',
      [field]: 'x'.repeat(field === 'InterfaceName' ? 121 : 256)
    } })).status, 'needs_parameters');
    assert.equal(calls.length, 1);
  }
});

test('Directory Reads fail closed on unsupported or invalid facets and ReadContext values', async () => {
  const contract = directoryWsdl('CommunicationChannel');
  for (const invalid of [
    contract.replace('<x:maxLength value="60"/>', '<x:pattern value=".*"/>'),
    contract.replace('<x:maxLength value="60"/>', '<x:maxLength value="-1"/>'),
    contract.replace('<x:maxLength value="60"/>', '<x:maxLength value="invalid"/>'),
    contract.replace('<x:maxLength value="60"/>', '<x:maxLength value="9007199254740992"/>'),
    contract.replace('<x:maxLength value="60"/>', '<x:maxLength value="60"/><x:maxLength value="50"/>'),
    contract.replace('<x:maxLength value="60"/>', '<b:maxLength value="60"/>'),
    contract.replace('<x:enumeration value="Active"/>', ''),
    contract.replace('<x:enumeration value="Active"/>', '<x:enumeration value="Active"/><x:maxLength value="5"/>'),
    contract.replace('type="ReadContextCode"', 'type="t:ReadContextCode"')
  ]) {
    const { fetch, calls } = fixture([reply(invalid)]);
    assert.equal((await fetch('/CommunicationChannelInService', { mode: 'read', identifier: {
      PartyID: '', ComponentID: 'Component', ChannelID: 'Channel'
    } })).status, 'needs_parameters');
    assert.equal(calls.length, 1);
  }
});

test('SOAP read never posts unsupported ReadContext or unknown required fields', async () => {
  const types = `<x:simpleType name="ReadContext"><x:restriction base="x:string">
    <x:enumeration value="Active"/><x:enumeration value="User"/>
  </x:restriction></x:simpleType>`;
  const contract = wsdl('BusinessComponent', { stringID: true, types,
    readFields: '<x:element name="ReadContext" type="b:ReadContext"/>' });
  for (const invalid of [
    contract.replace('<x:enumeration value="Active"/>', ''),
    contract.replace(/<x:enumeration value="(?:Active|User)"\/>/g, ''),
    contract.replace('base="x:string"', 'base="x:int"'),
    contract.replace('type="b:ReadContext"', 'type="t:ReadContext"'),
    contract.replace('type="b:ReadContext"', 'type="x:int"'),
    contract.replace('type="b:ReadContext"', 'type="x:token"'),
    contract.replace('<x:enumeration value="Active"/>', '<x:pattern value="User"/><x:enumeration value="Active"/>'),
    contract.replace('name="ReadContext" type="b:ReadContext"', 'name="UnknownRequired" type="x:string"'),
    contract.replace('type="b:ReadContext"/>', 'type="b:ReadContext"/><x:element name="UnknownRequired" type="x:string"/>')
  ]) {
    const { fetch, calls } = fixture([reply(invalid)]);
    const output = await fetch('/BusinessComponentInService', { mode: 'read', identifier: 'Example' });
    assert.equal(output.status, 'needs_parameters');
    assert.equal(output.actualCount, undefined);
    assert.deepEqual(calls.map(({ request }) => request.method), ['get']);
  }
});

test('unknown WSDL contract/action and BPM remain metadata-only without following imports/addresses', async () => {
  for (const data of [wsdl('UnexpectedEntity'), wsdl('BusinessComponent', { action: 'urn:delete' }),
    wsdl().replace('element="b:BusinessComponentQueryRequest"', 'element="t:BusinessComponentQueryRequest"'),
    wsdl().replace('<x:sequence>\n        <x:element name="Query"', '<x:choice>\n        <x:element name="Query"').replace('</x:sequence></x:complexType></x:element>', '</x:choice></x:complexType></x:element>')]) {
    const { fetch, calls } = fixture([reply(data)]);
    const output = await fetch('/BusinessComponentInService');
    assert.equal(output.status, 'metadata-only');
    assert.equal(output.artifacts[0].type, 'WSDL');
    assert.equal(output.artifacts[0].category, 'Metadata');
    assert.equal(output.artifacts[0].metadataOnly, true);
    assert.equal(output.actualCount, undefined);
    assert.equal(calls.length, 1);
  }
  const bpm = fixture([reply(wsdl())]);
  assert.equal((await bpm.fetch('/BPMFacadeBeanImplService')).status, 'metadata-only');
  assert.equal(bpm.calls[0].request.url, '/BPMFacadeBeanImplService?wsdl');
  assert.equal(bpm.calls.length, 1);
});

test('IntegratedConfiguration750 queries the IntegratedConfiguration entity', async () => {
  const { fetch, calls } = fixture([reply(wsdl('IntegratedConfiguration')),
    reply(envelope('<b:IntegratedConfigurationQueryResponse><b:IntegratedConfigurationID>ICO</b:IntegratedConfigurationID></b:IntegratedConfigurationQueryResponse>'))]);
  const output = await fetch('/IntegratedConfiguration750InService');
  assert.equal(output.status, 'ok');
  assert.equal(output.artifacts[0].type, 'IntegratedConfiguration');
  assert.match(calls[1].request.data, /b:IntegratedConfigurationQueryRequest/);
  assert.doesNotMatch(calls[1].request.data, /750QueryRequest/);
});

test('WSDL fallback is exact base?wsdl and occurs only for a missing implementation URL', async () => {
  const { fetch, calls } = fixture([reply('Not found', 404), reply(wsdl())]);
  const output = await fetch('/BusinessComponentInService', { mode: 'metadata' });
  assert.equal(output.status, 'metadata-only');
  assert.equal(output.failureLayer, undefined);
  assert.equal(output.failureCode, undefined);
  assert.equal(output.httpStatus, 200);
  assert.equal(calls[1].request.url, '/BusinessComponentInService?wsdl');
  const unverified = await fixture([reply('Not found', 404), reply('<Protocol/>')]).fetch('/BusinessComponentInService');
  assert.equal(unverified.status, 'metadata-only');
  assert.equal(unverified.failureLayer, undefined);
  assert.equal(unverified.httpStatus, 200);
  for (const status of [302, 401, 500]) {
    const blocked = fixture([reply('No', status)]);
    assert.equal((await blocked.fetch('/BusinessComponentInService')).status, 'failed');
    assert.equal(blocked.calls.length, 1);
  }
});

test('HTTP 200 SOAP faults and login HTML are failures, not successful artifacts', async () => {
  const fault = envelope('<s:Fault><faultcode>s:Server</faultcode><faultstring>Not available</faultstring></s:Fault>');
  for (const response of [reply(fault), reply('<html><form><input type="password" value="synthetic-password"></form></html>', 200, 'text/html'),
    reply('<?xml version="1.0"?><h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:input type="password" value="synthetic-password"/></h:html>')]) {
    const { fetch } = fixture([reply(wsdl()), response]);
    const output = await fetch('/BusinessComponentInService');
    assert.equal(output.status, 'failed');
    assert.equal(output.failureLayer, 'source');
    assert.equal(output.failureCode, response.data === fault ? 'SOAP_FAULT' : 'AUTH_REQUIRED');
    assert.deepEqual(output.artifacts, []);
    assert.equal(output.actualCount, undefined);
    assert.deepEqual(output.response, { format: 'omitted', body: null });
    assert.doesNotMatch(JSON.stringify(output), /synthetic-password/);
  }
});

test('unparsed or unexpected SOAP response is not reported as a zero-record success', async () => {
  for (const data of ['not XML', '<unclosed>', envelope('<b:BusinessComponentQueryResponse>unparsed</b:BusinessComponentQueryResponse>'),
    envelope('<b:BusinessComponentQueryResponse><UnknownID>s</UnknownID></b:BusinessComponentQueryResponse>'),
    envelope('<b:BusinessComponentQueryResponse><b:BusinessComponentID/></b:BusinessComponentQueryResponse>')]) {
    const { fetch } = fixture([reply(wsdl()), reply(data)]);
    const output = await fetch('/BusinessComponentInService');
    assert.equal(output.status, 'metadata-only');
    assert.equal(output.actualCount, undefined);
    assert.ok(output.artifacts.every((entry) => entry.type === 'WSDL'));
  }
  const empty = fixture([reply(wsdl()), reply(envelope('<b:BusinessComponentQueryResponse/>'))]);
  assert.equal((await empty.fetch('/BusinessComponentInService')).actualCount, 0);
});

test('top-level query ID fields count as one only when they match the fetched Read contract', async () => {
  const { fetch } = fixture([reply(wsdl()), reply(envelope('<b:BusinessComponentQueryResponse>' +
    '<b:PartyID/><b:ServiceID>Example</b:ServiceID></b:BusinessComponentQueryResponse>'))]);
  const output = await fetch('/BusinessComponentInService');
  assert.equal(output.status, 'ok');
  assert.equal(output.actualCount, 1);
  assert.deepEqual(output.artifacts[0].identifier, { PartyID: '', ServiceID: 'Example' });
  assert.equal(output.artifacts[0].hasFullDefinition, false);
  assert.equal(output.artifacts[0].identifierSource, 'top-level-fields');
});

test('SimpleQuery parses all raw links with real GUID identifiers and applies local paging', async () => {
  const { fetch, calls } = fixture([reply(resultHtml(170, 171), 200, 'text/html')]);
  const output = await fetch('/rep/support/SimpleQuery', { maxItems: 4, offset: 150 });
  assert.equal(output.status, 'ok');
  assert.equal(output.actualCount, 170);
  assert.equal(output.reportedCount, 171);
  assert.equal(output.returned, 4);
  assert.equal(output.truncated, true);
  assert.equal(output.artifacts[0].name, 'Object150');
  assert.equal(output.artifacts[0].type, 'Service Interface');
  assert.equal(output.artifacts[0].identifier.object_key, 'Object150|urn:example');
  assert.equal(output.artifacts[0].identifier.swc_guid, '005056a1-2345-1edf-9abc-000000000096');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.url, '/rep/support/SimpleQuery');
  const form = new URLSearchParams(calls[0].request.data);
  assert.deepEqual(form.getAll('types'), ['ifmmessif', 'MAPPING', 'XI_TRAFO', 'ChannelTemplate', 'RepBProcess']);
  assert.equal(form.has('userL'), false);
  assert.equal(form.get('action'), 'Start query');
  assert.doesNotMatch(JSON.stringify(output), /<html|href=/);
});

test('SimpleQuery preserves distinct GUIDs, supports every type, and does not infer false zeros', async () => {
  const html = resultHtml(1).replace('</table>',
    '<a href="/read?KEY=Other%7Curn%3Ax&amp;TYPE=MAPPING&amp;SWCGUID=005056a1-2345-1edf-9abc-012345678999">R</a></table>');
  const records = parseSimpleQuery(html).records;
  assert.equal(records.length, 2);
  assert.equal(records[1].type, 'Operation Mapping');
  assert.equal(parseSimpleQuery(html + html).records.length, 2);
  for (const [objectType, expected] of [['XI_TRAFO', 'Message Mapping'], ['ChannelTemplate', 'Communication Channel Template'],
    ['RepBProcess', 'Integration Process'], ['custom_type', 'custom_type']]) {
    assert.equal(parseSimpleQuery(resultHtml(1).replace('TYPE=ifmmessif', `TYPE=${objectType}`)).records[0].type, expected);
  }
  const unknown = fixture([reply('<html>Amount of objects: 7</html>', 200, 'text/html')]);
  const output = await unknown.fetch('/rep/support/SimpleQuery');
  assert.equal(output.status, 'needs_parameters');
  assert.equal(output.actualCount, undefined);
  const empty = fixture([reply(resultHtml(0), 200, 'text/html')]);
  assert.equal((await empty.fetch('/rep/support/SimpleQuery')).actualCount, 0);
});

test('query servlets are fixed-path GET probes, not invented universal POSTs', async () => {
  for (const path of ['/dir/query/ext', '/rep/query/ext', '/rep/query/int']) {
    const { fetch, calls } = fixture([reply('<protocol><Version>7.5</Version></protocol>')]);
    const output = await fetch(path);
    assert.equal(output.status, 'needs_parameters');
    assert.deepEqual(output.artifacts, []);
    assert.equal(output.actualCount, undefined);
    assert.equal(calls[0].request.method, 'get');
    assert.equal(calls[0].request.url, path);
    assert.equal(calls[0].request.data, undefined);
    assert.equal(output.response.body.protocol.Version, '7.5');
  }
});

test('read ext uses encoded uppercase GET parameters and never applies ESR protocol to directory', async () => {
  const noRequest = fixture([]);
  assert.equal((await noRequest.fetch('/rep/read/ext', { mode: 'read' })).status, 'needs_parameters');
  const params = { mode: 'read', object_type: 'ifmmessif', object_key: 'Interface A+B|urn:x&action=delete#fragment',
    swc_guid: '005056a1-2345-1edf-9abc-012345678999', vc: 'SWC', sp: '-1', uc: 'false', release: '7.0' };
  for (const key of ['object_type', 'object_key', 'swc_guid', 'vc', 'sp', 'uc', 'release']) {
    const incomplete = { ...params };
    delete incomplete[key];
    assert.equal((await noRequest.fetch('/rep/read/ext', incomplete)).status, 'needs_parameters');
  }
  for (const unexpected of [{ TYPE: 'ifmmessif' }, { method: 'PLAIN' }, { url: '/rep/read/ext' }]) {
    assert.equal((await noRequest.fetch('/rep/read/ext', { ...params, ...unexpected })).status, 'needs_parameters');
  }
  assert.equal((await noRequest.fetch('/dir/read/ext', params)).status, 'needs_parameters');
  assert.equal(noRequest.calls.length, 0);
  const { fetch, calls } = fixture([reply('<ServiceInterface><Name>Interface</Name><secret>synthetic-secret</secret></ServiceInterface>')]);
  const output = await fetch('/rep/read/ext', params);
  assert.equal(output.status, 'metadata-only');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.method, 'get');
  assert.equal(calls[0].request.data, undefined);
  assert.equal(calls[0].request.url, '/rep/read/ext?method=PLAIN&TYPE=ifmmessif&KEY=Interface+A%2BB%7Curn%3Ax%26action%3Ddelete%23fragment&VC=SWC&SWCGUID=005056a1-2345-1edf-9abc-012345678999&SP=-1&UC=false&release=7.0');
  const query = new URLSearchParams(calls[0].request.url.split('?')[1]);
  assert.deepEqual([...query], [['method', 'PLAIN'], ['TYPE', params.object_type],
    ['KEY', params.object_key], ['VC', 'SWC'], ['SWCGUID', params.swc_guid],
    ['SP', '-1'], ['UC', 'false'], ['release', '7.0']]);
  assert.doesNotMatch(JSON.stringify(output), /synthetic-secret/);
  const directoryProbe = fixture([reply('<protocol><Version>7.5</Version></protocol>')]);
  assert.equal((await directoryProbe.fetch('/dir/read/ext', { mode: 'metadata', object_type: params.object_type,
    object_key: params.object_key, swc_guid: params.swc_guid })).status, 'metadata-only');
  assert.equal(directoryProbe.calls[0].request.method, 'get');
  assert.equal(directoryProbe.calls[0].request.url, '/dir/read/ext');
  assert.equal(directoryProbe.calls[0].request.data, undefined);
});

test('SimpleQuery context survives export into a fixed-path ESR Read without retaining opaque settings', async () => {
  const encoded = Buffer.from('<AdapterTypeData><Attribute><Name>logonPassword</Name><Value>synthetic-adapter-value</Value></Attribute></AdapterTypeData>').toString('base64');
  const link = 'http://169.254.169.254/untrusted?method=PLAIN&TYPE=ChannelTemplate&KEY=Template%7Curn%3Aoffline&VC=SWC&SWCGUID=fixture-guid&SP=-1&UC=false&release=7.0&session=synthetic-session';
  const html = `<html>Amount of objects: 1<a href="${link.replaceAll('&', '&amp;')}">R</a></html>`;
  const xml = `<p:xiObj xmlns:p="urn:sap-com:xi"><p:content><c:ChannelTemplate xmlns:c="urn:sap-com:xi:xiRepChannelTemplate"><Direction>O</Direction><Attributes>${encoded}</Attributes></c:ChannelTemplate></p:content></p:xiObj>`;
  const { fetch, calls } = fixture([reply(html, 200, 'text/html'), reply(xml)]);
  const catalog = await fetch('/rep/support/SimpleQuery');
  const identifier = { object_type: 'ChannelTemplate', object_key: 'Template|urn:offline', swc_guid: 'fixture-guid',
    vc: 'SWC', sp: '-1', uc: 'false', release: '7.0' };
  assert.deepEqual(catalog.artifacts[0].identifier, identifier);
  const output = await exportDefinitions({ discovery: { endpoints: [catalog] }, fetchEndpoint: fetch });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].destination, { destinationName: 'PO_PJ2_ESR' });
  assert.equal(calls[1].request.url, '/rep/read/ext?method=PLAIN&TYPE=ChannelTemplate&KEY=Template%7Curn%3Aoffline&VC=SWC&SWCGUID=fixture-guid&SP=-1&UC=false&release=7.0');
  assert.deepEqual(output.reads[0].identifier, identifier);
  assert.equal(output.coverage.reads, 1);
  assert.equal(output.coverage.metadataOnly, 1);
  assert.equal(output.coverage.verifiedDefinitions, 0);
  assert.equal(output.reads[0].result.response.body['p:xiObj']['p:content']['c:ChannelTemplate'].Direction, 'O');
  for (const marker of [encoded, 'synthetic-adapter-value', 'synthetic-session', '169.254.169.254']) {
    assert.ok(!JSON.stringify({ catalog, output }).includes(marker));
  }
});

test('ESR context is not guessed, duplicate parameters are rejected, and generated releases are preserved', async () => {
  const base = '/rep/read/ext?method=PLAIN&TYPE=XI_TRAFO&KEY=Mapping%7Curn%3Aoffline&SWCGUID=fixture-guid';
  const context = '&VC=SWC&SP=3&UC=true&release=7.31';
  const parse = link => parseSimpleQuery(`<a href="${link.replaceAll('&', '&amp;')}">R</a>`).records[0].identifier;
  assert.deepEqual(parse(base + context), { object_type: 'XI_TRAFO', object_key: 'Mapping|urn:offline',
    swc_guid: 'fixture-guid', vc: 'SWC', sp: '3', uc: 'true', release: '7.31' });
  for (const link of [base, base + context + '&release=7.0', (base + context).replace('PLAIN', 'DELETE'),
    (base + context).replace('UC=true', 'UC=invalid'), (base + context).replace('VC=SWC', 'VC=unsupported'),
    (base + context).replace('SP=3', 'SP=-2'), base + '&VC=SWC&SP=-1&UC=false&release=7.0%0A']) {
    const identifier = parse(link);
    assert.equal(Object.hasOwn(identifier, 'release'), false);
    const noRequest = fixture([]);
    assert.equal((await noRequest.fetch('/rep/read/ext', { mode: 'read', ...identifier })).status, 'needs_parameters');
    assert.equal(noRequest.calls.length, 0);
  }
  const { fetch, calls } = fixture([reply('<Object/>')]);
  await fetch('/rep/read/ext', { mode: 'read', ...parse(base + context) });
  assert.match(calls[0].request.url, /&SP=3&UC=true&release=7\.31$/);
  const noRequest = fixture([]);
  for (const invalid of [{ release: '7.0\n' }, { sp: '3&action=delete' }, { uc: true }, { vc: 'OTHER' }]) {
    assert.equal((await noRequest.fetch('/rep/read/ext', { mode: 'read', ...parse(base + context), ...invalid })).status, 'needs_parameters');
  }
  assert.equal(noRequest.calls.length, 0);
});

test('opaque ESR adapter Attributes cannot leak through strings, namespaced text nodes or repeated elements', () => {
  const encoded = Buffer.from('<Attribute><Name>logonPassword</Name><Value>synthetic-opaque-value</Value></Attribute>').toString('base64');
  for (const attributes of [{ Attributes: encoded }, { 'c:Attributes': { '#text': encoded, '@_encoding': 'base64' } },
    { Attributes: [encoded, encoded] }]) {
    const output = parseResponse({ ChannelTemplate: { Direction: 'O', ...attributes } });
    assert.equal(output.response.body.ChannelTemplate.Direction, 'O');
    assert.ok(!JSON.stringify(output).includes(encoded));
    assert.match(JSON.stringify(output), /OMITTED: opaque adapter attributes/);
  }
});

test('diagnostics are bare GET snapshots and ChannelAdmin cannot start/stop/refresh', async () => {
  for (const path of ['/CPACache', '/mdt', '/AdapterFramework/ChannelAdminServlet']) {
    const { fetch, calls } = fixture([reply('<Status><State>Available</State></Status>')]);
    const output = await fetch(path);
    assert.equal(output.status, 'metadata-only');
    assert.equal(output.artifacts[0].category, 'Monitoring');
    assert.equal(output.artifacts[0].type, 'DiagnosticSnapshot');
    assert.equal(output.artifacts[0].metadataOnly, true);
    assert.equal(output.actualCount, undefined);
    assert.equal(calls[0].request.method, 'get');
    assert.equal(calls[0].request.url, path + (path.includes('ChannelAdmin') ? '?action=status' : ''));
  }
  const { fetch, calls } = fixture([reply('<Status/>')]);
  await fetch('/AdapterFramework/ChannelAdminServlet', { channel: 'Example&action=stop' });
  const query = new URLSearchParams(calls[0].request.url.split('?')[1]);
  assert.deepEqual(query.getAll('action'), ['status']);
  assert.equal(query.get('channel'), 'Example&action=stop');
});

test('response redaction covers namespaced fields, adapter Name/Value, attributes and embedded markup', () => {
  const response = parseResponse(`<Root xmlns:a="urn:a"><Password>synthetic-pw</Password>
    <a:Token>synthetic-token</a:Token><secret>synthetic-secret</secret>
    <AdapterSpecificAttribute><Name>Password</Name><Value>synthetic-pair</Value></AdapterSpecificAttribute>
    <AdapterSpecificAttribute Name="UserName" Value="synthetic-user"/>
    <AdapterSpecificAttribute Name="Pass&#119;ord" Value="synthetic-encoded"/>
    <Raw><![CDATA[<Password>synthetic-cdata</Password>]]></Raw>
    <Safe>Preserved</Safe></Root>`);
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /synthetic-(?:pw|token|secret|pair|user|encoded|cdata)/);
  assert.equal(response.response.body.Root.Safe, 'Preserved');
  const json = parseResponse({ secret: 'synthetic-json', nested: { Name: 'clientSecret', Value: 'synthetic-client' },
    raw: '<Password>synthetic-raw</Password>', headers: { Custom: 'synthetic-header' } });
  assert.doesNotMatch(JSON.stringify(json), /synthetic-/);
});

test('unparseable and binary bodies are omitted rather than leaked', () => {
  for (const data of ['synthetic-plaintext-password', '<Password>synthetic-malformed', Buffer.from([255, 254, 0])]) {
    const result = parseResponse(data);
    assert.equal(result.response.format, 'omitted');
    assert.equal(result.response.body, null);
    assert.ok(result.warnings.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-/);
  }
});

test('XML DTD and external entities are rejected before parsing', async () => {
  for (const data of ['<!DOCTYPE Root [<!ENTITY x SYSTEM "file:///not-readable">]><Root>&x;</Root>',
    '<!DOCTYPE Root SYSTEM "http://169.254.169.254/never-fetch"><Root/>']) {
    assert.throws(() => parseResponse(data), /DTD/);
    const { fetch, calls } = fixture([reply(data)]);
    const output = await fetch('/CPACache');
    assert.equal(output.status, 'failed');
    assert.equal(output.response.body, null);
    assert.equal(calls.length, 1);
  }
});

test('requests enforce 5 MB, 20-second timeout, redirects disabled, and no default credentials', async () => {
  const { fetch, calls } = fixture([reply('x'.repeat(MAX_BYTES + 1))]);
  const output = await fetch('/CPACache');
  assert.equal(output.status, 'failed');
  assert.equal(output.response.body, null);
  const request = calls[0].request;
  assert.equal(request.maxContentLength, MAX_BYTES);
  assert.equal(request.maxBodyLength, MAX_BYTES);
  assert.equal(request.timeout, TIMEOUT);
  assert.equal(request.timeout, 20000);
  assert.equal(request.maxRedirects, 0);
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(request.headers, {});
  assert.throws(() => parseResponse(Buffer.alloc(MAX_BYTES + 1)), /5 MB/);
});

test('SDK errors/auth config never appear in output and redirects do not produce artifacts', async () => {
  const error = Object.assign(new Error('synthetic-private-error'), { config: { headers: { Authorization: 'synthetic-private-auth' } } });
  const { fetch } = fixture([error], { auth: { Authorization: 'synthetic-private-auth' } });
  const output = await fetch('/CPACache');
  assert.equal(output.status, 'failed');
  assert.doesNotMatch(JSON.stringify(output), /synthetic-private|Authorization|config/);
  const redirect = fixture([reply('<Status/>', 302)]);
  assert.equal((await redirect.fetch('/CPACache')).status, 'failed');
  assert.equal(redirect.calls.length, 1);
  const httpError = fixture([reply('<Error><Message>synthetic-private-error-body</Message></Error>', 500)]);
  const failed = await httpError.fetch('/CPACache');
  assert.deepEqual(failed.response, { format: 'omitted', body: null });
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-private-error-body/);
});

test('SDK exceptions retain only safe numeric source HTTP failure status', async () => {
  for (const status of [401, 403, 503]) {
    const error = Object.assign(new Error('synthetic-private-error'), {
      response: { status, data: 'synthetic-private-body', headers: { authorization: 'synthetic-private-header' } },
      config: { url: 'synthetic-private-url', auth: { password: 'synthetic-private-password' } }
    });
    const { fetch } = fixture([error]);
    const output = await fetch('/CPACache');
    assert.equal(output.status, 'failed');
    assert.equal(output.failureLayer, 'source');
    assert.equal(output.httpStatus, status);
    assert.equal(output.failureCode, undefined);
    assert.deepEqual(output.response, { format: 'omitted', body: null });
    assert.deepEqual(output.artifacts, []);
    assert.doesNotMatch(JSON.stringify(output), /synthetic-private|authorization|headers|config/);
  }
});

test('SDK status fallback is numeric only and never traverses error details', async () => {
  const error = Object.assign(new Error('synthetic-private-error'), { response: { status: 403 }, status: 503 });
  for (const field of ['data', 'headers', 'config']) {
    Object.defineProperty(error.response, field, { get() { throw new Error('Unsafe error field accessed'); } });
    Object.defineProperty(error, field, { get() { throw new Error('Unsafe error field accessed'); } });
  }
  assert.equal((await fixture([error]).fetch('/CPACache')).httpStatus, 403);
  const fallback = Object.assign(new Error('synthetic-private-error'), { response: { status: '401' }, status: 503 });
  assert.equal((await fixture([fallback]).fetch('/CPACache')).httpStatus, 503);
  for (const status of ['401', null, {}, [], NaN, Infinity, 99, 600, 401.5]) {
    const invalid = Object.assign(new Error('synthetic-private-error'), { response: { status }, status });
    const output = await fixture([invalid]).fetch('/CPACache');
    assert.equal(Object.hasOwn(output, 'httpStatus'), false);
    assert.equal(output.failureLayer, 'source');
    assert.doesNotMatch(JSON.stringify(output), /synthetic-private/);
  }
});

test('failed SOAP SDK call resets successful WSDL status instead of reporting stale 200', async () => {
  for (const status of [undefined, 401, 403, 503, '403']) {
    const error = Object.assign(new Error('synthetic-private-error'), { response: { status, data: 'synthetic-private-body' } });
    const { fetch, calls } = fixture([reply(wsdl()), error]);
    const output = await fetch('/BusinessComponentInService');
    assert.equal(calls.length, 2);
    assert.equal(output.status, 'failed');
    assert.equal(output.failureLayer, 'source');
    assert.equal(output.httpStatus, typeof status === 'number' ? status : undefined);
    assert.deepEqual(output.artifacts, []);
    assert.doesNotMatch(JSON.stringify(output), /synthetic-private/);
  }
});

test('HTTP errors preserve status even when body parsing throws and omit all unsafe payload', async () => {
  for (const status of [401, 403, 503]) {
    for (const data of ['<!DOCTYPE Root [<!ENTITY x "synthetic-private-body">]><Root>&x;</Root>',
      'synthetic-private-body'.repeat(Math.ceil(MAX_BYTES / 10))]) {
      const output = await fixture([reply(data, status)]).fetch('/CPACache');
      assert.equal(output.status, 'failed');
      assert.equal(output.httpStatus, status);
      assert.equal(output.failureLayer, 'source');
      assert.deepEqual(output.response, { format: 'omitted', body: null });
      assert.doesNotMatch(JSON.stringify(output), /synthetic-private/);
    }
  }
});

test('invalid HTTP response statuses cannot leak into results or become successes', async () => {
  for (const status of ['401', 'synthetic-private-status', {}, [], NaN, Infinity, 99, 600, 200.5]) {
    const output = await fixture([reply('<Status/>', status)]).fetch('/CPACache');
    assert.equal(output.status, 'failed');
    assert.equal(output.failureLayer, 'source');
    assert.equal(Object.hasOwn(output, 'httpStatus'), false);
    assert.doesNotMatch(JSON.stringify(output), /synthetic-private/);
  }
});

test('20-second deadline aborts a stalled request without waiting in offline tests', async (t) => {
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 20000);
    queueMicrotask(callback);
    return 1;
  });
  t.mock.method(global, 'clearTimeout', () => {});
  const { fetch, calls } = fixture(() => new Promise(() => {}));
  let output;
  try { output = await fetch('/CPACache'); }
  finally { t.mock.restoreAll(); }
  assert.equal(output.status, 'failed');
  assert.equal(calls[0].request.signal.aborted, true);
  assert.deepEqual(output.artifacts, []);
});