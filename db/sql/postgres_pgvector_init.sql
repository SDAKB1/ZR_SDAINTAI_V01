-- =============================================================================
-- SDAINTAI Multi-Tenant PI/PO Discovery — PostgreSQL + pgvector Bootstrap
-- Idempotent DDL for semantic retrieval via cosine distance (<=>).
-- Every query MUST filter by tenant_id to enforce strict tenant isolation.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS pipo_artifact_embeddings (
  id              UUID PRIMARY KEY,
  tenant_id       VARCHAR(64)  NOT NULL,
  run_id          VARCHAR(36)  NOT NULL,
  artifact_id     VARCHAR(120) NOT NULL,
  chunk_kind      VARCHAR(40)  NOT NULL, -- interface | mapping | channel | diagnostic | dependency | pattern
  content_text    TEXT         NOT NULL,
  metadata_json   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  embedding       vector(384)  NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipo_emb_tenant_run
  ON pipo_artifact_embeddings (tenant_id, run_id);

CREATE INDEX IF NOT EXISTS idx_pipo_emb_tenant_kind
  ON pipo_artifact_embeddings (tenant_id, chunk_kind);

CREATE INDEX IF NOT EXISTS idx_pipo_emb_hnsw_cosine
  ON pipo_artifact_embeddings USING hnsw (embedding vector_cosine_ops);
