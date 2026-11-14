'use strict';

const crypto = require('node:crypto');
const cds = require('@sap/cds');

const EMBEDDING_DIM = 384;

// SAP PI/PO domain semantic clusters so offline/local embeddings produce strong
// cosine similarity across synonyms (e.g., "auth failure" <-> "403 FORBIDDEN UME ACL",
// "complex orchestration" <-> "ccBPM IntegrationProcess correlation steps").
const SEMANTIC_CLUSTERS = [
  ['idoc', 'idoc_aae', 'matmas', 'debmas', 'cremas', 'orders05', 'invoic02', 'desadv', 'fidccp', 'segment', 'ale'],
  ['ccbpm', 'repbprocess', 'integrationprocess', 'orchestration', 'stateful', 'correlation', 'step', 'bpm', 'bpmfacade'],
  ['mapping', 'operationmapping', 'messagemapping', 'xitrafo', 'xi_trafo', 'xslt', 'udf', 'java', 'bytecodejar', 'graphical', 'valuemapping'],
  ['channel', 'communicationchannel', 'adapter', 'sender', 'receiver', 'rest', 'soap', 'rfc', 'file', 'sftp', 'jdbc', 'as2', 'jms', 'bc'],
  ['error', 'fail', 'failed', 'failure', '401', '403', '404', '500', '502', '503', 'forbidden', 'unauthorized', 'acl', 'ume', 'diagnostic', 'soap_fault'],
  ['esr', 'repository', 'design', 'serviceinterface', 'ifmmessif', 'swcv', 'namespace', 'template', 'channeltemplate'],
  ['directory', 'dir', 'runtime', 'ico', 'integratedconfiguration', 'receiveragreement', 'senderagreement', 'determination'],
  ['wave', 'plan', 'simple', 'medium', 'complex', 'effort', 'hours', 'risk', 'tier', 'iflow', 'btp', 'migration'],
  ['dependency', 'reference', 'matched', 'unmatched', 'orphan', 'unreferenced', 'coverage', 'verified', 'metadata']
];

function hashToken(str, seed = 0) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function localSemanticEmbed(text) {
  const vec = new Float32Array(EMBEDDING_DIM);
  const normalized = String(text || '').toLowerCase().replace(/[^a-z0-9_./:-]+/g, ' ').trim();
  if (!normalized) {
    vec[0] = 1;
    return Array.from(vec);
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const idx1 = hashToken(tok, 11) % 256;
    const sign1 = (hashToken(tok, 23) & 1) ? 1 : -1;
    vec[idx1] += sign1 * 1.6;
    // Character 3-grams for morphological/prefix similarity (MATMAS05 ~ MATMAS07)
    const padded = `^${tok}$`;
    for (let i = 0; i <= padded.length - 3; i++) {
      const tri = padded.slice(i, i + 3);
      const idx2 = 256 + (hashToken(tri, 37) % 96);
      vec[idx2] += 0.45;
    }
    // Domain semantic concept projection into slots 352..383
    for (let c = 0; c < SEMANTIC_CLUSTERS.length; c++) {
      if (SEMANTIC_CLUSTERS[c].some((kw) => tok === kw || (tok.length >= 4 && (tok.includes(kw) || kw.includes(tok))))) {
        vec[352 + c] += 2.4;
      }
    }
  }
  let normSq = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) normSq += vec[i] * vec[i];
  const norm = Math.sqrt(normSq) || 1;
  return Array.from(vec, (v) => Number((v / norm).toFixed(6)));
}

async function embedText(text, env = process.env) {
  const apiUrl = env.EMBEDDING_API_URL || (env.OPENAI_API_KEY ? 'https://api.openai.com/v1/embeddings' : '');
  const apiKey = env.EMBEDDING_API_KEY || env.OPENAI_API_KEY || '';
  if (apiUrl && apiKey) {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: String(text || '').slice(0, 8000),
          model: env.EMBEDDING_MODEL || 'text-embedding-3-small',
          dimensions: EMBEDDING_DIM
        })
      });
      if (res.ok) {
        const body = await res.json();
        const emb = body?.data?.[0]?.embedding;
        if (Array.isArray(emb) && emb.length === EMBEDDING_DIM) return emb;
      }
    } catch { /* Fall back deterministically to local semantic embedding without failing discovery/chat */ }
  }
  return localSemanticEmbed(text);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function formatPgVector(vec) {
  return `[${vec.map((n) => (Number.isFinite(n) ? Number(n).toFixed(6) : '0')).join(',')}]`;
}

function resolvePostgresUrl(env = process.env) {
  if (env.POSTGRES_URL) return env.POSTGRES_URL;
  if (env.DATABASE_URL && /^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL)) return env.DATABASE_URL;
  try {
    const vcap = JSON.parse(env.VCAP_SERVICES || '{}');
    for (const key of Object.keys(vcap)) {
      if (/postgres/i.test(key) && vcap[key]?.[0]?.credentials?.uri) {
        return vcap[key][0].credentials.uri;
      }
    }
  } catch { /* ignore invalid VCAP JSON */ }
  return null;
}

function assertTenant(tenantId) {
  if (typeof tenantId !== 'string' || !tenantId.trim() || tenantId.length > 64) {
    throw new Error('Vector operation requires a valid tenantId.');
  }
  return tenantId.trim();
}

class PgVectorStore {
  constructor(connectionString, { maxPool = 10, env = process.env } = {}) {
    const { Pool } = require('pg');
    this.backend = 'postgres-pgvector';
    this._env = env;
    this._pool = new Pool({
      connectionString,
      max: maxPool,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000
    });
    this._ready = null;
  }

  async ensureSchema() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      const client = await this._pool.connect();
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector');
        await client.query(`
          CREATE TABLE IF NOT EXISTS pipo_artifact_embeddings (
            id            UUID PRIMARY KEY,
            tenant_id     VARCHAR(64)  NOT NULL,
            run_id        VARCHAR(36)  NOT NULL,
            artifact_id   VARCHAR(120) NOT NULL,
            chunk_kind    VARCHAR(40)  NOT NULL,
            content_text  TEXT         NOT NULL,
            metadata_json JSONB        NOT NULL DEFAULT '{}'::jsonb,
            embedding     vector(${EMBEDDING_DIM}) NOT NULL,
            created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_pipo_emb_tenant_run ON pipo_artifact_embeddings (tenant_id, run_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_pipo_emb_tenant_kind ON pipo_artifact_embeddings (tenant_id, chunk_kind)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_pipo_emb_hnsw_cosine ON pipo_artifact_embeddings USING hnsw (embedding vector_cosine_ops)');
      } finally {
        client.release();
      }
    })().catch((err) => {
      this._ready = null;
      throw err;
    });
    return this._ready;
  }

  async upsertRunChunks(tenantId, runId, chunks, externalClient = null) {
    const tId = assertTenant(tenantId);
    if (!runId || !Array.isArray(chunks)) throw new Error('runId and chunks array are required.');
    await this.ensureSchema();
    const prepared = [];
    for (const chunk of chunks) {
      const vec = Array.isArray(chunk.embedding) && chunk.embedding.length === EMBEDDING_DIM
        ? chunk.embedding
        : await embedText(chunk.contentText, this._env);
      prepared.push({
        id: chunk.id || crypto.randomUUID(),
        artifactId: String(chunk.artifactId || 'unknown').slice(0, 120),
        chunkKind: String(chunk.chunkKind || 'artifact').slice(0, 40),
        contentText: String(chunk.contentText || ''),
        metadataJson: JSON.stringify(chunk.metadata || {}),
        vectorLiteral: formatPgVector(vec)
      });
    }
    const ownClient = !externalClient;
    const client = externalClient || await this._pool.connect();
    try {
      if (ownClient) await client.query('BEGIN');
      await client.query('DELETE FROM pipo_artifact_embeddings WHERE tenant_id = $1 AND run_id = $2', [tId, runId]);
      for (const row of prepared) {
        await client.query(
          `INSERT INTO pipo_artifact_embeddings
             (id, tenant_id, run_id, artifact_id, chunk_kind, content_text, metadata_json, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::vector)`,
          [row.id, tId, runId, row.artifactId, row.chunkKind, row.contentText, row.metadataJson, row.vectorLiteral]
        );
      }
      if (ownClient) await client.query('COMMIT');
      return prepared.length;
    } catch (err) {
      if (ownClient) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (ownClient) client.release();
    }
  }

  async searchTenant(tenantId, queryText, { runId = null, chunkKind = null, topK = 6 } = {}) {
    const tId = assertTenant(tenantId);
    await this.ensureSchema();
    const limit = Math.max(1, Math.min(50, Number(topK) || 6));
    const qVec = formatPgVector(await embedText(queryText, this._env));
    const { rows } = await this._pool.query(
      `SELECT id, run_id AS "runId", artifact_id AS "artifactId", chunk_kind AS "chunkKind",
              content_text AS "contentText", metadata_json AS "metadata",
              1 - (embedding <=> $1::vector) AS score
         FROM pipo_artifact_embeddings
        WHERE tenant_id = $2
          AND ($3::varchar IS NULL OR run_id = $3)
          AND ($4::varchar IS NULL OR chunk_kind = $4)
        ORDER BY embedding <=> $1::vector ASC
        LIMIT $5`,
      [qVec, tId, runId, chunkKind, limit]
    );
    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      artifactId: r.artifactId,
      chunkKind: r.chunkKind,
      contentText: r.contentText,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {}),
      score: Number(Number(r.score || 0).toFixed(4))
    }));
  }

  async purgeTenantRun(tenantId, runId = null) {
    const tId = assertTenant(tenantId);
    await this.ensureSchema();
    const res = runId
      ? await this._pool.query('DELETE FROM pipo_artifact_embeddings WHERE tenant_id = $1 AND run_id = $2', [tId, runId])
      : await this._pool.query('DELETE FROM pipo_artifact_embeddings WHERE tenant_id = $1', [tId]);
    return res.rowCount || 0;
  }

  getPoolStats() {
    return {
      backend: this.backend,
      totalCount: this._pool.totalCount,
      idleCount: this._pool.idleCount,
      waitingCount: this._pool.waitingCount
    };
  }

  async close() {
    await this._pool.end();
  }
}

class CdsTenantVectorStore {
  constructor({ env = process.env } = {}) {
    this.backend = 'cds-tenant-vectors';
    this._env = env;
  }

  _entity() {
    if (!cds.db) throw new Error('CDS database is not connected.');
    return cds.entities('pipo.discovery')?.ArtifactVectors || 'pipo.discovery.ArtifactVectors';
  }

  async upsertRunChunks(tenantId, runId, chunks, tx = null) {
    const tId = assertTenant(tenantId);
    const Entity = this._entity();
    const entries = [];
    const now = new Date().toISOString();
    for (const chunk of chunks) {
      const vec = Array.isArray(chunk.embedding) && chunk.embedding.length === EMBEDDING_DIM
        ? chunk.embedding
        : await embedText(chunk.contentText, this._env);
      entries.push({
        ID: chunk.id || crypto.randomUUID(),
        tenantId: tId,
        runId,
        artifactId: String(chunk.artifactId || 'unknown').slice(0, 120),
        chunkKind: String(chunk.chunkKind || 'artifact').slice(0, 40),
        contentText: String(chunk.contentText || ''),
        metadataJson: JSON.stringify(chunk.metadata || {}),
        embeddingJson: JSON.stringify(vec),
        createdAt: now
      });
    }
    const exec = async (contextTx) => {
      await contextTx.run(cds.ql.DELETE.from(Entity).where({ tenantId: tId, runId }));
      if (entries.length) await contextTx.run(cds.ql.INSERT.into(Entity).entries(entries));
    };
    if (tx) await exec(tx);
    else if (cds.context) await exec(cds.db);
    else await cds.db.tx(exec);
    return entries.length;
  }

  async searchTenant(tenantId, queryText, { runId = null, chunkKind = null, topK = 6 } = {}) {
    const tId = assertTenant(tenantId);
    const Entity = this._entity();
    const where = { tenantId: tId };
    if (runId) where.runId = runId;
    if (chunkKind) where.chunkKind = chunkKind;
    const rows = await cds.db.run(cds.ql.SELECT.from(Entity).where(where));
    const qVec = await embedText(queryText, this._env);
    const limit = Math.max(1, Math.min(50, Number(topK) || 6));
    return rows
      .map((r) => {
        let vec = [], meta = {};
        try { vec = JSON.parse(r.embeddingJson || '[]'); } catch { /* ignore */ }
        try { meta = JSON.parse(r.metadataJson || '{}'); } catch { /* ignore */ }
        return {
          id: r.ID,
          runId: r.runId,
          artifactId: r.artifactId,
          chunkKind: r.chunkKind,
          contentText: r.contentText,
          metadata: meta,
          score: Number(cosineSimilarity(qVec, vec).toFixed(4))
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async purgeTenantRun(tenantId, runId = null, tx = null) {
    const tId = assertTenant(tenantId);
    const Entity = this._entity();
    const where = runId ? { tenantId: tId, runId } : { tenantId: tId };
    const runner = tx || cds.db;
    return runner.run(cds.ql.DELETE.from(Entity).where(where));
  }

  getPoolStats() {
    return { backend: this.backend, totalCount: 1, idleCount: 1, waitingCount: 0 };
  }

  async close() {}
}

let _sharedStore = null;
function getTenantVectorStore(env = process.env) {
  if (_sharedStore) return _sharedStore;
  const pgUrl = resolvePostgresUrl(env);
  _sharedStore = pgUrl ? new PgVectorStore(pgUrl, { env }) : new CdsTenantVectorStore({ env });
  return _sharedStore;
}

function resetTenantVectorStoreForTests(customStore = null) {
  _sharedStore = customStore;
}

module.exports = {
  EMBEDDING_DIM,
  localSemanticEmbed,
  embedText,
  cosineSimilarity,
  formatPgVector,
  resolvePostgresUrl,
  PgVectorStore,
  CdsTenantVectorStore,
  getTenantVectorStore,
  resetTenantVectorStoreForTests
};
