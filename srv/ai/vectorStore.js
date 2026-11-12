const cds = require('@sap/cds');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const LOG = cds.log('brain-vectorstore');

const STORE_FILE = path.join(__dirname, '../../.brain-vectors.json');
const HANA_SERVICE_NAME = 'AICONX-brain-hana';

// Deterministic 128-dim pseudo-embedding from text (works without any API key)
// For production, swap this with SapAiCoreEmbeddings or OpenAI/Anthropic embeddings.
function textToEmbedding(text) {
  const vec = new Float32Array(128).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  words.forEach((w, wi) => {
    for (let i = 0; i < w.length; i++) {
      vec[(wi * 7 + i * 13) % 128] += w.codePointAt(i) / 1000;
    }
  });
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return Array.from(vec).map(v => v / norm);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Local JSON-file store — used whenever AICONX-brain-hana isn't bound (local
// dev, or this specific instance not wired up yet). Ephemeral on Cloud Foundry
// (app filesystem resets on redeploy), which is exactly the limitation the
// HANA-backed store below exists to fix.
class LocalVectorStore {
  constructor() {
    this._vectors = this._load();
  }
  _load() {
    try {
      if (fs.existsSync(STORE_FILE)) return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    } catch { /* file absent or corrupt — start empty */ }
    return [];
  }
  _save() {
    try { fs.writeFileSync(STORE_FILE, JSON.stringify(this._vectors)); } catch { /* non-fatal: ephemeral FS */ }
  }
  async add(content, metadata = {}) {
    const id = `v_${crypto.randomUUID()}`;
    const embedding = textToEmbedding(content);
    this._vectors.push({ id, content, embedding, metadata, ts: new Date().toISOString() });
    this._save();
    return id;
  }
  async search(queryText, k = 5) {
    const qe = textToEmbedding(queryText);
    return this._vectors
      .map(v => ({ ...v, score: cosineSimilarity(qe, v.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
  async getAll() { return this._vectors; }
  async count() { return this._vectors.length; }
  async replaceAll(vectors) {
    this._vectors = vectors;
    this._save();
  }
}

// HANA-backed store — BRAIN_BRAINVECTOR table in the dedicated AICONX-brain-hana
// HDI container (see mta.yaml + db/brain-schema.cds). Deployed once via a
// standalone `cds deploy` (Sep 2026 session, see brain-schema.cds comment);
// this class only ever does DML (INSERT/SELECT/DELETE) against the already-
// existing table using the container's least-privilege runtime (_RT) user —
// it never attempts DDL. Survives redeploys because the HDI container is a
// managed CF service, not app-local disk.
// BUG-H3 fix: Proper connection lifecycle management with close() method
class HanaVectorStore {
  constructor(creds) {
    this._creds = creds;
    this._client = null;
    this._connecting = null;
    this._lastActivity = Date.now();
    this._idleTimeout = 300000; // 5 minutes idle timeout
    this._idleCheckInterval = null;
  }
  _table() { return `"${this._creds.schema}"."BRAIN_BRAINVECTOR"`; }
  _getClient() {
    if (this._client) {
      this._lastActivity = Date.now();
      return Promise.resolve(this._client);
    }
    if (this._connecting) return this._connecting;
    const hdb = require('hdb');
    const client = hdb.createClient({
      host: this._creds.host,
      port: Number(this._creds.port),
      user: this._creds.user,
      password: this._creds.password,
      useTLS: true,
    });
    client.on('error', (err) => {
      LOG.error('HANA connection error', { error: err.message });
      this._cleanup();
    });
    this._connecting = new Promise((resolve, reject) => {
      client.connect((err) => {
        this._connecting = null;
        if (err) return reject(err);
        this._client = client;
        this._lastActivity = Date.now();
        this._startIdleCheck();
        resolve(client);
      });
    });
    return this._connecting;
  }
  _startIdleCheck() {
    if (this._idleCheckInterval) return;
    this._idleCheckInterval = setInterval(() => {
      if (Date.now() - this._lastActivity > this._idleTimeout) {
        LOG.info('HANA connection idle, closing');
        this.close();
      }
    }, 60000); // Check every minute
  }
  _cleanup() {
    if (this._idleCheckInterval) {
      clearInterval(this._idleCheckInterval);
      this._idleCheckInterval = null;
    }
    this._client = null;
    this._connecting = null;
  }
  /**
   * Close the HANA connection and release resources
   */
  close() {
    if (this._client) {
      try {
        this._client.end();
      } catch (err) {
        LOG.warn('Error closing HANA connection', { error: err.message });
      }
    }
    this._cleanup();
  }
  async _exec(sql, params) {
    const client = await this._getClient();
    this._lastActivity = Date.now();
    if (!params) return new Promise((resolve, reject) => client.exec(sql, (err, rows) => err ? reject(err) : resolve(rows)));
    return new Promise((resolve, reject) => {
      client.prepare(sql, (err, statement) => {
        if (err) return reject(err);
        statement.exec(params, (err, rows) => err ? reject(err) : resolve(rows));
      });
    });
  }
  static _text(v) {
    if (v == null) return '';
    return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
  }
  async add(content, metadata = {}) {
    const id = crypto.randomUUID();
    const embedding = textToEmbedding(content);
    await this._exec(
      `INSERT INTO ${this._table()} (ID, CREATEDAT, MODIFIEDAT, CONTENT, EMBEDDING, METADATA, TS) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [id, content, JSON.stringify(embedding), JSON.stringify(metadata)]
    );
    return id;
  }
  async search(queryText, k = 5) {
    const all = await this.getAll();
    const qe = textToEmbedding(queryText);
    return all.map(v => ({ ...v, score: cosineSimilarity(qe, v.embedding) })).sort((a, b) => b.score - a.score).slice(0, k);
  }
  async getAll() {
    const rows = await this._exec(`SELECT ID, CONTENT, EMBEDDING, METADATA, TS FROM ${this._table()}`);
    return rows.map(r => {
      let embedding = [], metadata = {};
      try { embedding = JSON.parse(HanaVectorStore._text(r.EMBEDDING) || '[]'); } catch { /* malformed — default to [] */ }
      try { metadata = JSON.parse(HanaVectorStore._text(r.METADATA) || '{}'); } catch { /* malformed — default to {} */ }
      return { id: r.ID, content: HanaVectorStore._text(r.CONTENT), embedding, metadata, ts: r.TS };
    });
  }
  async count() {
    const rows = await this._exec(`SELECT COUNT(*) AS N FROM ${this._table()}`);
    return Number(rows[0].N);
  }
  async replaceAll(vectors) {
    await this._exec(`DELETE FROM ${this._table()}`);
    for (const v of vectors) {
      // eslint-disable-next-line no-await-in-loop
      await this._exec(
        `INSERT INTO ${this._table()} (ID, CREATEDAT, MODIFIEDAT, CONTENT, EMBEDDING, METADATA, TS) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [v.id || crypto.randomUUID(), v.content, JSON.stringify(v.embedding), JSON.stringify(v.metadata || {})]
      );
    }
  }
}

// Finds the AICONX-brain-hana user-provided service in VCAP_SERVICES (bound
// via mta.yaml's `existing-service` resource) and returns its credentials, or
// null if not bound — the local-dev / not-yet-configured case.
function findBrainHanaCredentials() {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
    const upsList = vcap['user-provided'] || [];
    const entry = upsList.find(s => s.name === HANA_SERVICE_NAME);
    return entry ? entry.credentials : null;
  } catch {
    return null;
  }
}

let _instance = null;
function getVectorStore() {
  if (!_instance) {
    const creds = findBrainHanaCredentials();
    _instance = creds ? new HanaVectorStore(creds) : new LocalVectorStore();
    LOG.info('vector store initialized', { type: creds ? 'HANA-backed (AICONX-brain-hana, persists across redeploys)' : 'local-file (ephemeral)' });
  }
  return _instance;
}

module.exports = { getVectorStore, textToEmbedding };
