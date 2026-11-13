'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { diagnose, validateRoles } = require('./discovery-diagnostics');
const { getEndpoint } = require('./pipo-endpoints');

const DIRECTORY = '/BusinessComponentInService';
const API_DISPLAY = 'SAP_XI_API_DISPLAY_J2EE';
const DISPLAY = 'SAP_XI_DISPLAY_USER_J2EE';
const MONITOR = 'SAP_XI_MONITOR_J2EE';

test('diagnostics distinguish safe HTTP failures without echoing input details', () => {
  for (const [httpStatus, code] of [[401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'], [503, 'UNAVAILABLE'], [500, 'HTTP_ERROR'], [502, 'HTTP_ERROR'], [599, 'HTTP_ERROR']]) {
    const output = diagnose(DIRECTORY, { status: 'failed', httpStatus,
      response: { body: 'synthetic-private-body' }, warnings: ['synthetic-private-warning'],
      error: 'synthetic-private-error', headers: { authorization: 'synthetic-private-auth' } });
    assert.equal(output.code, code);
    assert.equal(output.layer, 'source');
    assert.equal(output.roleAssessment.effectivePermissionsVerified, false);
    assert.deepEqual(Object.keys(output), ['code', 'layer', 'reason', 'remediation', 'roleAssessment']);
    assert.doesNotMatch(JSON.stringify(output), /synthetic-private|authorization|headers/);
  }
});

test('only integer HTTP statuses in 100..599 participate in classification', () => {
  for (const httpStatus of ['401', '503', null, undefined, {}, [], true, NaN, Infinity, 99, 600, -401, 401.5]) {
    assert.equal(diagnose(DIRECTORY, { status: 'failed', httpStatus }).code, 'FAILED');
  }
  for (const httpStatus of [100, 199, 300, 400, 499, 599]) {
    assert.equal(diagnose(DIRECTORY, { status: 'failed', httpStatus }).code, 'HTTP_ERROR');
  }
});

test('SOAP fault and login markers are allowlisted and do not mask specific HTTP failures', () => {
  for (const httpStatus of [undefined, 200, 500]) {
    assert.equal(diagnose(DIRECTORY, { status: 'failed', httpStatus, failureCode: 'SOAP_FAULT' }).code, 'SOAP_FAULT');
  }
  assert.equal(diagnose(DIRECTORY, { status: 'failed', httpStatus: 200, failureCode: 'AUTH_REQUIRED' }).code, 'AUTH_REQUIRED');
  for (const [httpStatus, expected] of [[401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'], [503, 'UNAVAILABLE']]) {
    assert.equal(diagnose(DIRECTORY, { httpStatus, failureCode: 'SOAP_FAULT' }).code, expected);
  }
  assert.equal(diagnose(DIRECTORY, { failureCode: 'synthetic-private-code' }).code, 'FAILED');
});

test('generic failure, parameters, metadata and successful results stay distinct', () => {
  for (const [status, expected] of [['failed', 'FAILED'], ['unsupported', 'FAILED'],
    ['needs_parameters', 'NEEDS_PARAMETERS'], ['metadata-only', 'METADATA_ONLY'], ['ok', 'OK']]) {
    const output = diagnose(DIRECTORY, { status });
    assert.equal(output.code, expected);
    if (expected !== 'FAILED') assert.deepEqual(output.roleAssessment.candidates, []);
  }
  for (const result of [null, undefined, [], 'synthetic-private-status', {}]) {
    assert.equal(diagnose(DIRECTORY, result).code, 'FAILED');
  }
});

test('Directory SOAP has documented API display evidence, without asserting effective access', () => {
  const output = diagnose(getEndpoint(DIRECTORY), { httpStatus: 403 }, { roles: { PO_PJ2_DIR: [API_DISPLAY] } });
  assert.deepEqual(output.roleAssessment, { inventory: 'supplied',
    candidates: [{ role: API_DISPLAY, evidence: 'documented', present: true }], effectivePermissionsVerified: false });
  assert.doesNotMatch(JSON.stringify(output), /SAP_XI_(?:API_DEVELOP|ADMINISTRATOR|DEVELOPER|.*SERV_USER)/);
});

test('role absence differs from empty inventory and inventory is destination scoped', () => {
  const cases = [[{}, 'unavailable', null], [{ PO_PJ2_DIR: [] }, 'supplied', false],
    [{ PO_PJ2_DIR: [DISPLAY] }, 'supplied', false], [{ PO_PJ2_ESR: [API_DISPLAY] }, 'unavailable', null]];
  for (const [roles, inventory, present] of cases) {
    const output = diagnose(DIRECTORY, { httpStatus: 403 }, { roles });
    assert.equal(output.roleAssessment.inventory, inventory);
    assert.equal(output.roleAssessment.candidates[0].present, present);
    assert.equal(output.roleAssessment.effectivePermissionsVerified, false);
  }
});

test('ESR and directory servlet read roles are suggestions, not documented API display claims', () => {
  for (const endpoint of ['/rep/query/ext', '/rep/query/int', '/rep/read/ext', '/rep/support/SimpleQuery', '/dir/query/ext', '/dir/read/ext']) {
    const destination = getEndpoint(endpoint).destination;
    const output = diagnose(endpoint, { httpStatus: 403 }, { roles: { [destination]: [DISPLAY, API_DISPLAY] } });
    assert.deepEqual(output.roleAssessment.candidates, [{ role: DISPLAY, evidence: 'suggested', present: true }]);
    assert.doesNotMatch(JSON.stringify(output), /SAP_XI_API_DISPLAY_J2EE/);
  }
});

test('monitoring candidates are suggested MONITOR only and never elevated or service users', () => {
  for (const endpoint of ['/mdt', '/CPACache', '/AdapterFramework/ChannelAdminServlet']) {
    const output = diagnose(endpoint, { httpStatus: 403 }, { roles: { PO_PJ2_DIR: [MONITOR] } });
    assert.deepEqual(output.roleAssessment.candidates, [{ role: MONITOR, evidence: 'suggested', present: true }]);
    assert.equal(output.roleAssessment.effectivePermissionsVerified, false);
  }
});

test('MCP, CAP and client failures never receive PI role advice', () => {
  for (const layer of ['mcp', 'cap', 'client']) {
    for (const httpStatus of [401, 403, 503]) {
      for (const options of [{ layer }, {}]) {
        const output = diagnose(DIRECTORY, { httpStatus, failureLayer: layer },
          { roles: { PO_PJ2_DIR: [API_DISPLAY] }, ...options });
        assert.equal(output.layer, layer);
        assert.deepEqual(output.roleAssessment.candidates, []);
        assert.doesNotMatch(JSON.stringify(output), /SAP_XI_|source owner|source destination/);
        assert.match(output.remediation, /does not establish a source authorization failure/);
      }
    }
    assert.equal(diagnose(DIRECTORY, { failureLayer: 'source', httpStatus: 403 }, { layer }).layer, layer);
  }
  const invalid = diagnose(DIRECTORY, { httpStatus: 403 }, { layer: 'synthetic-private-layer' });
  assert.equal(invalid.layer, 'client');
  assert.deepEqual(invalid.roleAssessment.candidates, []);
  assert.doesNotMatch(JSON.stringify(invalid), /synthetic-private/);
});

test('unknown endpoint metadata cannot invent candidates or leak arbitrary names', () => {
  const endpoint = { path: '/synthetic-private-path', category: 'Directory', kind: 'soap', destination: 'PO_PJ2_DIR' };
  const output = diagnose(endpoint, { httpStatus: 403 }, { roles: { PO_PJ2_DIR: [API_DISPLAY] } });
  assert.deepEqual(output.roleAssessment.candidates, []);
  assert.equal(output.roleAssessment.inventory, 'unavailable');
  assert.doesNotMatch(JSON.stringify(output), /synthetic-private/);
  const spoof = { ...getEndpoint('/rep/read/ext'), category: 'Directory', kind: 'soap', destination: 'PO_PJ2_DIR' };
  assert.deepEqual(diagnose(spoof, { httpStatus: 403 }).roleAssessment.candidates,
    [{ role: DISPLAY, evidence: 'suggested', present: null }]);
});

test('role validation filters unknown names, deduplicates and preserves supplied empty arrays', () => {
  const input = { PO_PJ2_DIR: [API_DISPLAY, API_DISPLAY, 'synthetic-private-role', 'SAP_XI_ADMINISTRATOR_J2EE'],
    PO_PJ2_ESR: [DISPLAY, MONITOR] };
  const snapshot = JSON.stringify(input);
  const output = validateRoles(input);
  assert.deepEqual(output, { PO_PJ2_DIR: [API_DISPLAY], PO_PJ2_ESR: [DISPLAY, MONITOR] });
  assert.equal(JSON.stringify(input), snapshot);
  assert.notEqual(output.PO_PJ2_DIR, input.PO_PJ2_DIR);
  assert.deepEqual(validateRoles({ PO_PJ2_ESR: ['synthetic-private-role'] }), { PO_PJ2_ESR: [] });
  assert.deepEqual(validateRoles({ PO_PJ2_DIR: [] }), { PO_PJ2_DIR: [] });
  assert.deepEqual(validateRoles({}), {});
  assert.deepEqual(validateRoles(undefined), {});
});

test('malformed role inventories reject the whole file with a static safe error', () => {
  for (const input of [null, [], 'synthetic-private-json', 401,
    { PO_PJ2_DIR: API_DISPLAY }, { PO_PJ2_DIR: null }, { PO_PJ2_DIR: [null] },
    { PO_PJ2_DIR: [API_DISPLAY], PO_PJ2_ESR: [{}] }, { PO_PJ2_DIR: [new String(DISPLAY)] },
    { PO_PJ2_DIR: new Array(2) }, { 'synthetic-private-destination': [] },
    JSON.parse('{"__proto__":[]}'), Object.create({ PO_PJ2_DIR: [] })]) {
    assert.throws(() => validateRoles(input), (error) => {
      assert.ok(error instanceof TypeError);
      assert.doesNotMatch(error.message, /synthetic-private|SAP_XI_|__proto__/);
      return true;
    });
    const diagnostic = diagnose(DIRECTORY, { httpStatus: 403 }, { roles: input });
    assert.equal(diagnostic.roleAssessment.inventory, 'unavailable');
    assert.equal(diagnostic.roleAssessment.candidates[0].present, null);
  }
});

test('1000-entry bound applies before filtering and across all destination arrays', () => {
  assert.deepEqual(validateRoles({ PO_PJ2_DIR: new Array(1000).fill(API_DISPLAY) }), { PO_PJ2_DIR: [API_DISPLAY] });
  assert.throws(() => validateRoles({ PO_PJ2_DIR: new Array(1001).fill('synthetic-private-role') }), TypeError);
  assert.throws(() => validateRoles({ PO_PJ2_DIR: new Array(600).fill(API_DISPLAY),
    PO_PJ2_ESR: new Array(401).fill(DISPLAY) }), TypeError);
});