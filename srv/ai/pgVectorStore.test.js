'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PgVectorStore, localSemanticEmbed, cosineSimilarity, EMBEDDING_DIM } = require('./pgVectorStore');

test('localSemanticEmbed produces normalized 384-dim vectors with strong domain cosine similarity', () => {
  const q = localSemanticEmbed('Why did ReceiverAgreement fail with HTTP 403 forbidden UME role?');
  const match = localSemanticEmbed('Discovery endpoint /ReceiverAgreementInService status=failed HTTP=403 code=FORBIDDEN UME role ACL');
  const unrelated = localSemanticEmbed('Material Master MATMAS07 IDoc_AAE sender channel simple wave 1');
  assert.equal(q.length, EMBEDDING_DIM);
  assert.ok(cosineSimilarity(q, match) > cosineSimilarity(q, unrelated) + 0.15);
});

test('Live PostgreSQL + pgvector HNSW cosine similarity (<=>) and strict tenant isolation', { skip: !process.env.TEST_PGVECTOR_URL }, async (t) => {
  const store = new PgVectorStore(process.env.TEST_PGVECTOR_URL);
  t.after(async () => { await store.close(); });

  await store.ensureSchema();
  await store.upsertRunChunks('tenant-a', 'run-1', [
    { artifactId: 'ICO_MATMAS07', chunkKind: 'interface', contentText: 'IntegratedConfiguration MATMAS07 IDoc_AAE Material Master replication to S/4HANA', metadata: { wave: 1 } },
    { artifactId: 'BPM_INVOICE_SYNC', chunkKind: 'interface', contentText: 'IntegrationProcess ccBPM stateful invoice approval orchestration with 12 correlation steps', metadata: { wave: 3 } },
    { artifactId: 'EP_RCV_AGR_403', chunkKind: 'diagnostic', contentText: 'Endpoint /ReceiverAgreementInService failed HTTP 403 FORBIDDEN UME role SAP_XI_API_DISPLAY_J2EE', metadata: { http: 403 } }
  ]);
  await store.upsertRunChunks('tenant-b', 'run-2', [
    { artifactId: 'SECRET_TENANT_B_FLOW', chunkKind: 'interface', contentText: 'IntegrationProcess ccBPM stateful invoice approval orchestration for Tenant B only', metadata: { wave: 3 } }
  ]);

  const hitsA = await store.searchTenant('tenant-a', 'stateful ccBPM orchestration correlation steps', { topK: 3 });
  assert.equal(hitsA.length, 3);
  assert.equal(hitsA[0].artifactId, 'BPM_INVOICE_SYNC');
  assert.ok(hitsA[0].score > 0.35);
  assert.equal(hitsA.some((h) => h.artifactId === 'SECRET_TENANT_B_FLOW'), false);

  // Purge tenant-a run and confirm tenant-b remains untouched
  await store.purgeTenantRun('tenant-a', 'run-1');
  const afterPurgeA = await store.searchTenant('tenant-a', 'invoice', { topK: 5 });
  assert.equal(afterPurgeA.length, 0);

  const hitsB = await store.searchTenant('tenant-b', 'invoice orchestration', { topK: 5 });
  assert.equal(hitsB.length, 1);
  assert.equal(hitsB[0].artifactId, 'SECRET_TENANT_B_FLOW');
});
