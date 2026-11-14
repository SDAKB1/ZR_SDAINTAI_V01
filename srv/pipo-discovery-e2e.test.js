'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const { test } = require('node:test');
const cds = require('@sap/cds');
const express = require('express');

const { createAtomicDiscoveryManager } = require('./utils/pipoAtomicRunner');
const { resetTenantVectorStoreForTests, CdsTenantVectorStore } = require('./ai/pgVectorStore');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function writeSyntheticCompletedRun(stagingParentDir, { corruptHash = false } = {}) {
  const runDir = path.join(stagingParentDir, `2026-11-14T00-00-00Z-${crypto.randomUUID()}`);
  await fs.mkdir(runDir, { recursive: true });

  const discoveryPayload = {
    mode: 'mcp',
    discovery: {
      endpoints: [
        { tool: 'fetch_pi8_integrated_configuration', path: '/IntegratedConfigurationInService', status: 'ok', httpStatus: 200, artifacts: [] },
        { tool: 'fetch_pi8_communication_channel', path: '/CommunicationChannelInService', status: 'ok', httpStatus: 200, artifacts: [] },
        { tool: 'fetch_pi8_receiver_agreement', path: '/ReceiverAgreementInService', status: 'failed', httpStatus: 403, diagnostic: { code: 'FORBIDDEN', layer: 'source', reason: 'ACL or UME role blocked.', remediation: 'Check SAP_XI_API_DISPLAY_J2EE.' } },
        {
          tool: 'fetch_pi8_repository_simple_query',
          path: '/rep/support/SimpleQuery',
          status: 'ok',
          httpStatus: 200,
          artifacts: [
            { name: 'SI_Order_Async', namespace: 'urn:sda:orders', identifier: { object_type: 'ifmmessif', object_key: 'SI_Order_Async|urn:sda:orders', swc_guid: 'SWC1' } },
            { name: 'BPM_Invoice_Approval', namespace: 'urn:sda:fin', identifier: { object_type: 'RepBProcess', object_key: 'BPM_Invoice_Approval|urn:sda:fin', swc_guid: 'SWC1' } },
            { name: 'MM_Order_Transform', namespace: 'urn:sda:orders', identifier: { object_type: 'XI_TRAFO', object_key: 'MM_Order_Transform|urn:sda:orders', swc_guid: 'SWC1' } }
          ]
        }
      ]
    },
    export: {
      reads: [
        {
          verifiedDefinition: true,
          result: {
            tool: 'fetch_pi8_communication_channel',
            status: 'ok',
            httpStatus: 200,
            artifacts: [{
              type: 'CommunicationChannel',
              hasFullDefinition: true,
              metadataOnly: false,
              definition: {
                CommunicationChannelID: { PartyID: '', ComponentID: 'SAP_ECC', ChannelID: 'CC_IDOC_SENDER_MATMAS' },
                Direction: 'Sender',
                TransportProtocol: 'IDoc',
                MessageProtocol: 'IDoc XML',
                AdapterMetadata: { Name: 'IDoc_AAE', Namespace: 'http://sap.com/xi/XI/System', SoftwareComponentVersionID: 'SAP_BASIS' }
              }
            }]
          }
        },
        {
          verifiedDefinition: true,
          result: {
            tool: 'fetch_pi8_integrated_configuration',
            status: 'ok',
            httpStatus: 200,
            artifacts: [{
              type: 'IntegratedConfiguration',
              hasFullDefinition: true,
              metadataOnly: false,
              definition: {
                IntegratedConfigurationID: {
                  SenderPartyID: '',
                  SenderComponentID: 'SAP_ECC',
                  InterfaceName: 'MATMAS07',
                  InterfaceNamespace: 'urn:sap-com:document:sap:idoc:messages',
                  ReceiverPartyID: '',
                  ReceiverComponentID: 'S4_CLOUD'
                },
                InboundProcessing: { CommunicationChannel: { PartyID: '', ComponentID: 'SAP_ECC', ChannelID: 'CC_IDOC_SENDER_MATMAS' } },
                OutboundProcessing: { Receiver: { PartyID: '', ComponentID: 'S4_CLOUD' } },
                ReceiverInterfaces: { Receiver: { PartyID: '', ComponentID: 'S4_CLOUD' } }
              }
            }]
          }
        },
        {
          identifier: { object_type: 'RepBProcess', object_key: 'BPM_Invoice_Approval|urn:sda:fin', swc_guid: 'SWC1' },
          result: {
            tool: 'fetch_pi8_repository_read_ext',
            status: 'metadata-only',
            httpStatus: 200,
            response: {
              body: {
                xiObj: {
                  idInfo: {
                    key: { '@_typeID': 'RepBProcess', '@_oid': 'OID_BPM_1', elem: ['BPM_Invoice_Approval', 'urn:sda:fin'] },
                    vc: { '@_vcType': 'S', '@_swcGuid': 'SWC1', '@_caption': 'SDA_FIN 1.0' }
                  },
                  content: { definition: { process: { step: [{}, {}, {}, {}, {}] } } }
                }
              }
            }
          }
        },
        {
          identifier: { object_type: 'XI_TRAFO', object_key: 'MM_Order_Transform|urn:sda:orders', swc_guid: 'SWC1' },
          result: {
            tool: 'fetch_pi8_repository_read_ext',
            status: 'metadata-only',
            httpStatus: 200,
            response: {
              body: {
                xiObj: {
                  idInfo: {
                    key: { '@_typeID': 'XI_TRAFO', '@_oid': 'OID_MM_1', elem: ['MM_Order_Transform', 'urn:sda:orders'] },
                    vc: { '@_vcType': 'S', '@_swcGuid': 'SWC1', '@_caption': 'SDA_ORD 1.0' }
                  },
                  content: { XiTrafo: { Multiplicity: '1:1', ByteCodeJar: { '@_zipped': 'true', blob: 'UEsDBBQAAAAIA==' } } }
                }
              }
            }
          }
        }
      ]
    }
  };

  const discBytes = Buffer.from(JSON.stringify(discoveryPayload, null, 2) + '\n', 'utf8');
  await fs.writeFile(path.join(runDir, 'discovery.json'), discBytes);
  const manifest = {
    runId: 'test-run',
    status: 'completed',
    files: [{ filename: 'discovery.json', size: discBytes.length, hash: corruptHash ? '0'.repeat(64) : sha256(discBytes) }]
  };
  await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { runDir };
}

const BASE_FORM = Object.freeze({
  systemName: 'PJ2',
  systemVersion: '7.50',
  address: 'http://nwjava.consultsda.com:443',
  userId: 'SDAINT',
  password: 'redacted-test-secret',
  authType: 'BasicAuthentication',
  proxyType: 'OnPremise',
  locationId: 'SDA_LAB',
  subaccount: 'sda-ai-shared-eu10',
  projectId: 'PIPO32Migration'
});

const { password: _unusedPw, ...DISCOVERY_META_FORM } = BASE_FORM;

test('End-to-end Atomic Discovery, 5-View Architect Report, Tenant Isolation, Re-run Wipe & LangGraph Persona MCP RBAC', { concurrency: false }, async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pipo-e2e-'));
  const sqliteFile = path.join(tempRoot, 'e2e.sqlite');
  const runsDir = path.join(tempRoot, 'discovery-runs');
  let exportDelayMs = 80;
  let shouldCorruptManifest = false;
  let server;

  resetTenantVectorStoreForTests(new CdsTenantVectorStore());

  const model = await cds.load([
    path.join(__dirname, '../db/pipo-cache-schema.cds'),
    path.join(__dirname, '../db/pipo-discovery-schema.cds'),
    path.join(__dirname, '../db/aiconx-schema.cds'),
    path.join(__dirname, '../db/brain-schema.cds'),
    path.join(__dirname, './pipo-cockpit-service.cds'),
    path.join(__dirname, './brain-service.cds')
  ]);
  cds.model = cds.compile.for.nodejs(model);
  cds.db = await cds.connect.to({ kind: 'sqlite', credentials: { url: sqliteFile } });
  await cds.deploy(model).to(cds.db);

  const customAtomic = createAtomicDiscoveryManager({
    baseRunsDir: runsDir,
    executeExportFn: async ({ stagingParentDir, onProgress }) => {
      onProgress?.({ phase: 'endpoints', progressPct: 35, progressMessage: 'Probing endpoints…' });
      await new Promise((r) => setTimeout(r, exportDelayMs));
      return writeSyntheticCompletedRun(stagingParentDir, { corruptHash: shouldCorruptManifest });
    }
  });

  const app = express();
  app.use(express.json());
  const pipoSrv = await cds.serve('PipoCockpitService').from(model).in(app);
  pipoSrv._customAtomicManager = customAtomic;
  pipoSrv._customVerifyRunner = async (form) => {
    if (form.locationId !== 'SDA_LAB') {
      return { connected: false, code: 'DEST_LOCATION_MISMATCH', field: 'locationId', layer: 'destination', userMessage: 'Location ID mismatch.' };
    }
    return {
      connected: true,
      virtualHost: 'nwjava.consultsda.com:443',
      destinationMatch: { verified: true, esrDestination: 'PO_PJ2_ESR', dirDestination: 'PO_PJ2_DIR' },
      tunnel: { reachable: true },
      userMessage: 'Connected to PJ2.'
    };
  };
  await cds.serve('BrainService').from(model).in(app);

  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    resetTenantVectorStoreForTests(null);
    if (server?.listening) await new Promise((r) => server.close(r));
    await cds.db?.disconnect?.().catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  });

  async function callApi(urlPath, body, { persona = 'Admin', tenant = 'tenant-alpha' } = {}) {
    const res = await fetch(`${baseUrl}${urlPath.replace('/odata/v4/pipo-discovery/', '/odata/v4/pipo-cockpit/')}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SDAINTAI-Dev-Persona': persona,
        'X-SDAINTAI-Dev-Tenant': tenant
      },
      body: JSON.stringify(body || {})
    });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { status: res.status, body: Object.hasOwn(json, 'value') && typeof json.value === 'string' ? JSON.parse(json.value) : json };
  }

  // 1. Viewer & Approver cannot run verifyConnection or startDiscovery
  const viewerVerify = await callApi('/odata/v4/pipo-discovery/verifyConnection', BASE_FORM, { persona: 'Viewer' });
  assert.equal(viewerVerify.status, 403);

  // 2. Destination mismatch returns structured business error without issuing token
  const badLoc = await callApi('/odata/v4/pipo-discovery/verifyConnection', { ...BASE_FORM, locationId: 'BAD_LOC' }, { persona: 'Admin' });
  assert.equal(badLoc.status, 200);
  assert.equal(badLoc.body.connected, false);
  assert.equal(badLoc.body.code, 'DEST_LOCATION_MISMATCH');
  assert.equal(badLoc.body.connectionToken, '');

  // 3. Valid connection issues HMAC connectionToken; changing form invalidates token (412)
  const goodConn = await callApi('/odata/v4/pipo-discovery/verifyConnection', BASE_FORM, { persona: 'Admin', tenant: 'tenant-alpha' });
  assert.equal(goodConn.status, 200);
  assert.equal(goodConn.body.connected, true);
  assert.ok(goodConn.body.connectionToken.length > 20);

  const tamperedStart = await callApi('/odata/v4/pipo-discovery/startDiscovery', {
    ...DISCOVERY_META_FORM,
    address: 'http://changed-after-test.consultsda.com:443',
    connectionToken: goodConn.body.connectionToken
  }, { persona: 'Admin', tenant: 'tenant-alpha' });
  assert.equal(tamperedStart.status, 412);

  // 4. Corrupted SHA-256 manifest rolls back atomically (status -> FAILED, 0 artifacts leaked)
  shouldCorruptManifest = true;
  exportDelayMs = 20;
  const corruptStart = await callApi('/odata/v4/pipo-discovery/startDiscovery', {
    ...DISCOVERY_META_FORM,
    connectionToken: goodConn.body.connectionToken
  }, { persona: 'Admin', tenant: 'tenant-alpha' });
  assert.equal(corruptStart.status, 200);

  let st;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 40));
    st = (await callApi('/odata/v4/pipo-discovery/getDiscoveryStatus', { runId: corruptStart.body.runId, projectId: 'PIPO32Migration' }, { persona: 'Viewer', tenant: 'tenant-alpha' })).body;
    if (st.status !== 'RUNNING') break;
  }
  assert.equal(st.status, 'FAILED');
  assert.equal(st.errorCode, 'MANIFEST_HASH_MISMATCH');

  // 5. Re-run after failure wipes failed run & executes clean non-cancellable atomic run
  shouldCorruptManifest = false;
  exportDelayMs = 140;
  const rerun1 = await callApi('/odata/v4/pipo-discovery/rerunDiscovery', {
    ...DISCOVERY_META_FORM,
    connectionToken: goodConn.body.connectionToken,
    confirmInvalidateApprovals: true
  }, { persona: 'Admin', tenant: 'tenant-alpha' });
  assert.equal(rerun1.status, 200);
  assert.equal(rerun1.body.status, 'RUNNING');

  // While running: cancelDiscovery MUST fail with 409 ATOMIC_JOB_LOCKED & duplicate start MUST fail with 409
  const cancelAttempt = await callApi('/odata/v4/pipo-discovery/cancelDiscovery', { runId: rerun1.body.runId }, { persona: 'Admin', tenant: 'tenant-alpha' });
  assert.equal(cancelAttempt.status, 409);

  const dupStart = await callApi('/odata/v4/pipo-discovery/startDiscovery', {
    ...DISCOVERY_META_FORM,
    connectionToken: goodConn.body.connectionToken
  }, { persona: 'Admin', tenant: 'tenant-alpha' });
  assert.equal(dupStart.status, 409);

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    st = (await callApi('/odata/v4/pipo-discovery/getDiscoveryStatus', { runId: rerun1.body.runId, projectId: 'PIPO32Migration' }, { persona: 'Viewer', tenant: 'tenant-alpha' })).body;
    if (st.status === 'COMPLETED') break;
  }
  assert.equal(st.status, 'COMPLETED');
  assert.equal(st.totalObjects, 4);
  assert.equal(st.icoCount, 1);
  assert.equal(st.channelCount, 1);
  assert.equal(st.mappingCount, 1);
  assert.equal(st.ccBpmCount, 1);

  // 6. All 5 Deep-Dive Architect Report views + Auto-Wave 1-3 propagation
  for (const filter of ['interfaces', 'failures', 'complexities', 'coverage', 'esr_vs_dir']) {
    const repRes = await callApi('/odata/v4/pipo-discovery/getArchitectReport', { runId: rerun1.body.runId, projectId: 'PIPO32Migration', filter }, { persona: 'Viewer', tenant: 'tenant-alpha' });
    assert.equal(repRes.status, 200);
    assert.equal(repRes.body.activeFilter, filter);
    assert.ok(repRes.body.deepDive.rows.length >= 1);
    assert.ok(repRes.body.wavePlan.items.length >= 2);
  }

  // 7. Strict Multi-Tenant Isolation: tenant-beta sees ZERO data from tenant-alpha
  const betaReport = await callApi('/odata/v4/pipo-discovery/getArchitectReport', { runId: rerun1.body.runId, projectId: 'PIPO32Migration', filter: 'interfaces' }, { persona: 'Admin', tenant: 'tenant-beta' });
  assert.equal(betaReport.status, 404);

  const betaSearch = await callApi('/odata/v4/pipo-discovery/semanticSearchArtifacts', { query: 'MATMAS07 IDoc invoice ccBPM', projectId: 'PIPO32Migration' }, { persona: 'Admin', tenant: 'tenant-beta' });
  assert.equal(betaSearch.status, 200);
  assert.equal(betaSearch.body.results.length, 0);

  const alphaSearch = await callApi('/odata/v4/pipo-discovery/semanticSearchArtifacts', { query: 'ReceiverAgreement 403 forbidden error', projectId: 'PIPO32Migration' }, { persona: 'Viewer', tenant: 'tenant-alpha' });
  assert.equal(alphaSearch.status, 200);
  assert.ok(alphaSearch.body.results.length >= 1);
  assert.equal(alphaSearch.body.results[0].artifactId, 'fetch_pi8_receiver_agreement');

  // 8. LangGraph Grounded Chat + Persona-Scoped MCP Tools (Viewer vs Approver vs Admin)
  const viewerFailQ = await callApi('/odata/v4/brain/lumiChat', { sessionId: 's1', projectId: 'PIPO32Migration', message: 'Why did ReceiverAgreement fail with 403?' }, { persona: 'Viewer', tenant: 'tenant-alpha' });
  assert.equal(viewerFailQ.status, 200);
  assert.match(viewerFailQ.body.reply, /ReceiverAgreementInService/);

  const viewerApproveTry = await callApi('/odata/v4/brain/lumiChat', { sessionId: 's1', projectId: 'PIPO32Migration', message: 'Approve wave plan now' }, { persona: 'Viewer', tenant: 'tenant-alpha' });
  assert.match(viewerApproveTry.body.reply, /Action Blocked \(MCP_TOOL_FORBIDDEN\)/);

  const adminPreApproveDeploy = await callApi('/odata/v4/brain/lumiChat', { sessionId: 's1', projectId: 'PIPO32Migration', message: 'Deploy wave 1 to BTP' }, { persona: 'Admin', tenant: 'tenant-alpha' });
  assert.match(adminPreApproveDeploy.body.reply, /Action Blocked \(APPROVAL_REQUIRED\)/);

  const approverApprove = await callApi('/odata/v4/brain/lumiChat', { sessionId: 's1', projectId: 'PIPO32Migration', message: 'Approve wave plan for cutover' }, { persona: 'Approver', tenant: 'tenant-alpha' });
  assert.match(approverApprove.body.reply, /Wave Plan Approved/);

  const approverDeployTry = await callApi('/odata/v4/brain/lumiChat', { sessionId: 's1', projectId: 'PIPO32Migration', message: 'Deploy wave 1 to BTP' }, { persona: 'Approver', tenant: 'tenant-alpha' });
  assert.match(approverDeployTry.body.reply, /Action Blocked \(MCP_TOOL_FORBIDDEN\)/);

  const adminPostApproveDeploy = await callApi('/odata/v4/brain/lumiChat', { sessionId: 's1', projectId: 'PIPO32Migration', message: 'Deploy wave 1 to BTP' }, { persona: 'Admin', tenant: 'tenant-alpha' });
  assert.match(adminPostApproveDeploy.body.reply, /Wave 1 Deployed/);

  // 9. Re-run confirmation gate when APPROVED record exists
  const rerunUnconfirmed = await callApi('/odata/v4/pipo-discovery/rerunDiscovery', {
    ...DISCOVERY_META_FORM,
    connectionToken: goodConn.body.connectionToken,
    confirmInvalidateApprovals: false
  }, { persona: 'Admin', tenant: 'tenant-alpha' });
  assert.equal(rerunUnconfirmed.status, 200);
  assert.equal(rerunUnconfirmed.body.confirmationRequired, true);
  assert.equal(rerunUnconfirmed.body.hasActiveApproval, true);
});

module.exports = { writeSyntheticCompletedRun };
