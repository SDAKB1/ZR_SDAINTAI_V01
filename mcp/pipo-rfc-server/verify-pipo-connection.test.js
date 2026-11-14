'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifyPipoConnection, PipoBusinessError } = require('./verify-pipo-connection');

const VALID_FORM = Object.freeze({
  systemName: 'PJ2',
  systemVersion: '7.50',
  address: 'http://nwjava.consultsda.com:443',
  userId: 'SDAINT',
  password: 'test-placeholder-value',
  authType: 'BasicAuthentication',
  proxyType: 'OnPremise',
  locationId: 'SDA_LAB',
  subaccount: 'sda-ai-shared-eu10'
});

const OK_PROBE = async () => ({
  reachable: true,
  via: 'Cloud Connector (OnPremise)',
  destinations: {
    PO_PJ2_ESR: { reachable: true, status: 403 },
    PO_PJ2_DIR: { reachable: true, status: 403 }
  }
});

test('verifyPipoConnection succeeds when form matches subaccount BTP Destination and tunnel is live', async () => {
  const res = await verifyPipoConnection(VALID_FORM, { probeFn: OK_PROBE });
  assert.equal(res.connected, true);
  assert.equal(res.destinationMatch.esrDestination, 'PO_PJ2_ESR');
  assert.equal(res.destinationMatch.dirDestination, 'PO_PJ2_DIR');
  assert.equal(res.virtualHost, 'nwjava.consultsda.com:443');
});

test('verifyPipoConnection rejects virtual host, location ID, auth type, user, and subaccount mismatches with business codes', async () => {
  await assert.rejects(
    () => verifyPipoConnection({ ...VALID_FORM, address: 'http://wrong-vhost.consultsda.com:443' }, { probeFn: OK_PROBE }),
    (err) => err instanceof PipoBusinessError && err.code === 'DEST_VIRTUAL_HOST_MISMATCH' && err.field === 'address'
  );

  await assert.rejects(
    () => verifyPipoConnection({ ...VALID_FORM, locationId: 'OTHER_CC_LOC' }, { probeFn: OK_PROBE }),
    (err) => err instanceof PipoBusinessError && err.code === 'DEST_LOCATION_MISMATCH' && err.field === 'locationId'
  );

  await assert.rejects(
    () => verifyPipoConnection({ ...VALID_FORM, authType: 'OAuth2ClientCredentials' }, { probeFn: OK_PROBE }),
    (err) => err instanceof PipoBusinessError && err.code === 'DEST_AUTH_TYPE_MISMATCH' && err.field === 'authType'
  );

  await assert.rejects(
    () => verifyPipoConnection({ ...VALID_FORM, userId: 'WRONG_USER' }, { probeFn: OK_PROBE }),
    (err) => err instanceof PipoBusinessError && err.code === 'DEST_USER_MISMATCH' && err.field === 'userId'
  );

  await assert.rejects(
    () => verifyPipoConnection({ ...VALID_FORM, subaccount: 'unrelated-subaccount-ap21' }, { probeFn: OK_PROBE }),
    (err) => err instanceof PipoBusinessError && err.code === 'DEST_SUBACCOUNT_MISMATCH' && err.field === 'subaccount'
  );
});

test('verifyPipoConnection maps live BTP Destination Service getDestination() and never leaks secrets on 401', async () => {
  const secretValue = 'super-sensitive-check-value';
  const mockGetDestination = async ({ destinationName }) => ({
    name: destinationName,
    url: 'http://nwjava.consultsda.com:443',
    proxyType: 'OnPremise',
    authentication: 'BasicAuthentication',
    cloudConnectorLocationId: 'SDA_LAB',
    username: 'SDAINT',
    password: secretValue
  });

  await assert.rejects(
    () => verifyPipoConnection({ ...VALID_FORM, password: 'wrong-input' }, { getDestinationFn: mockGetDestination, probeFn: OK_PROBE }),
    (err) => {
      assert.equal(err.code, 'PIPO_AUTH_FAILED');
      assert.equal(err.httpStatus, 401);
      assert.equal(JSON.stringify(err.toJSON()).includes(secretValue), false);
      assert.equal(JSON.stringify(err.toJSON()).includes('wrong-input'), false);
      return true;
    }
  );
});
