-- =============================================================================
-- SDAINTAI — PI/PO & MuleSoft Migration Pattern Recognition Vector Store
-- One-time DDL setup script for SAP HANA Cloud (run in HANA Database Explorer,
-- SQL Console, against the schema/HDI container you want this to live in).
--
-- Purpose: store every PI/PO (ccBPM / Mapping / Adapter / IFlow) and MuleSoft
-- (Flow / DataWeave / Connector) source artifact you migrate, embed it as a
-- native HANA Cloud REAL_VECTOR, and recognize/reuse proven conversion
-- patterns to BTP Integration Suite via server-side COSINE_SIMILARITY() --
-- not application-side looping.
--
-- This is a SEPARATE schema/table set from db/brain-schema.cds's BrainVector
-- table (the general Brain-events vector store already deployed to the
-- AICONX-brain-hana HDI container). Keeping them separate means this can't
-- destabilize the existing Brain vector store, same reasoning mta.yaml
-- already documents for why AICONX-brain-hana is its own HDI container apart
-- from AICONX-db.
--
-- IMPORTANT — read before running:
--   1. EMBEDDING_DIM below (1536) MUST match the output dimension of whatever
--      embedding model you actually call to populate this table. 1536 =
--      OpenAI text-embedding-3-small. SAP AI Core's default embedding model
--      and other providers use different dimensions — change every
--      REAL_VECTOR(1536) below (search/replace) before loading real data.
--      NOTE: srv/ai/vectorStore.js's current textToEmbedding() is a 128-dim
--      deterministic HASH, not a real embedding model -- it is NOT suitable
--      for populating this table if you want genuine semantic pattern
--      recognition. Point this table at a real embedding model instead.
--   2. Section 7 (HNSW vector index) requires HANA Cloud QRC 2/2024 or later.
--      If CREATE ... VECTOR INDEX errors on your tenant, comment that block
--      out — COSINE_SIMILARITY() in Section 8 still works as an exact
--      (brute-force) search without the index, just unoptimized at scale.
--   3. Run this whole script top to bottom, once. It is idempotent via
--      DROP ... IF EXISTS guards, so re-running it is safe during setup.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Schema
-- -----------------------------------------------------------------------------
CREATE SCHEMA SDAINTAI_VECTOR;
SET SCHEMA SDAINTAI_VECTOR;


-- -----------------------------------------------------------------------------
-- 1. Reference table — constrains SOURCE_SYSTEM to the two migration sources
-- -----------------------------------------------------------------------------
DROP TABLE SDAINTAI_SOURCE_SYSTEM IF EXISTS CASCADE;
CREATE TABLE SDAINTAI_SOURCE_SYSTEM (
    SOURCE_SYSTEM   NVARCHAR(20)  NOT NULL,
    DESCRIPTION     NVARCHAR(200),
    PRIMARY KEY (SOURCE_SYSTEM)
);
INSERT INTO SDAINTAI_SOURCE_SYSTEM (SOURCE_SYSTEM, DESCRIPTION) VALUES
    ('PIPO',      'SAP PI/PO — ccBPM, Message Mapping, Adapter config, IFlow');
INSERT INTO SDAINTAI_SOURCE_SYSTEM (SOURCE_SYSTEM, DESCRIPTION) VALUES
    ('MULESOFT',  'MuleSoft — Flow (XML), DataWeave script, Connector config');


-- -----------------------------------------------------------------------------
-- 2. Source artifacts — the raw PI/PO or MuleSoft objects being migrated
-- -----------------------------------------------------------------------------
DROP TABLE SDAINTAI_SOURCE_ARTIFACT IF EXISTS CASCADE;
CREATE TABLE SDAINTAI_SOURCE_ARTIFACT (
    ARTIFACT_ID           NVARCHAR(36)  NOT NULL DEFAULT SYSUUID,
    SOURCE_SYSTEM         NVARCHAR(20)  NOT NULL,
    OBJECT_TYPE           NVARCHAR(40)  NOT NULL,  -- IFLOW|CCBPM|MESSAGE_MAPPING|ADAPTER|SCRIPT_UDF|SCRIPT_GROOVY
                                                     -- |FLOW|DATAWEAVE|CONNECTOR|SUBFLOW (extend as needed)
    OBJECT_NAME           NVARCHAR(200) NOT NULL,
    NAMESPACE_OR_PROJECT  NVARCHAR(200),
    CONTENT               NCLOB         NOT NULL,   -- raw XML / Groovy / DataWeave / adapter config text
    CONTENT_HASH          NVARCHAR(64),             -- SHA-256 of CONTENT; application-side de-dupe guard
    COMPLEXITY_TIER       NVARCHAR(1),              -- A|B|C, same lay-person tier convention as the other cockpits
    CREATED_AT            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CREATED_BY            NVARCHAR(100)          DEFAULT CURRENT_USER,
    PRIMARY KEY (ARTIFACT_ID),
    CONSTRAINT FK_ARTIFACT_SOURCE FOREIGN KEY (SOURCE_SYSTEM)
        REFERENCES SDAINTAI_SOURCE_SYSTEM (SOURCE_SYSTEM)
);


-- -----------------------------------------------------------------------------
-- 3. Embeddings — native HANA Cloud vector column, one row per artifact (or
--    per chunk, for long content split across multiple embedding calls)
-- -----------------------------------------------------------------------------
DROP TABLE SDAINTAI_PATTERN_EMBEDDING IF EXISTS CASCADE;
CREATE TABLE SDAINTAI_PATTERN_EMBEDDING (
    EMBEDDING_ID    NVARCHAR(36)   NOT NULL DEFAULT SYSUUID,
    ARTIFACT_ID     NVARCHAR(36)   NOT NULL,
    CHUNK_SEQ       INTEGER        NOT NULL DEFAULT 0,  -- 0 = whole-artifact embedding; >0 = chunk index
    CHUNK_TEXT      NCLOB,                               -- exact text that was embedded, for citation/debug
    EMBEDDING       REAL_VECTOR(1536),                   -- <-- native vector type; match your embedding model's dim
    EMBEDDING_MODEL NVARCHAR(100)  NOT NULL,              -- e.g. 'text-embedding-3-small', 'sap-ai-core-embedding'
    CREATED_AT      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (EMBEDDING_ID),
    CONSTRAINT FK_EMBEDDING_ARTIFACT FOREIGN KEY (ARTIFACT_ID)
        REFERENCES SDAINTAI_SOURCE_ARTIFACT (ARTIFACT_ID)
);


-- -----------------------------------------------------------------------------
-- 4. Target pattern library — proven BTP Integration Suite designs you match
--    new source artifacts against once validated conversions exist
-- -----------------------------------------------------------------------------
DROP TABLE SDAINTAI_TARGET_PATTERN IF EXISTS CASCADE;
CREATE TABLE SDAINTAI_TARGET_PATTERN (
    PATTERN_ID          NVARCHAR(36)  NOT NULL DEFAULT SYSUUID,
    PATTERN_NAME        NVARCHAR(200) NOT NULL,
    IS_ARTIFACT_TYPE     NVARCHAR(40)  NOT NULL,  -- IFLOW|GROOVY_SCRIPT|XSLT_MAPPING|VALUE_MAPPING|...
    DESCRIPTION          NCLOB,
    REFERENCE_PACKAGE     NVARCHAR(200),          -- the BTP Integration Suite package this pattern lives in
    USAGE_COUNT          INTEGER       NOT NULL DEFAULT 0,
    CREATED_AT            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (PATTERN_ID)
);


-- -----------------------------------------------------------------------------
-- 5. Conversion matches — ground truth linking a source artifact to the
--    target pattern it was actually converted to, with the confidence score
--    at match time. This is what the similarity search is "trained" against.
-- -----------------------------------------------------------------------------
DROP TABLE SDAINTAI_CONVERSION_MATCH IF EXISTS CASCADE;
CREATE TABLE SDAINTAI_CONVERSION_MATCH (
    MATCH_ID        NVARCHAR(36)  NOT NULL DEFAULT SYSUUID,
    ARTIFACT_ID     NVARCHAR(36)  NOT NULL,
    PATTERN_ID      NVARCHAR(36)  NOT NULL,
    CONFIDENCE      DECIMAL(5,4),             -- cosine similarity score at match time (0.0000-1.0000)
    CONFIRMED_BY    NVARCHAR(100),            -- human reviewer who validated this match
    CONFIRMED_AT    TIMESTAMP,
    CREATED_AT      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (MATCH_ID),
    CONSTRAINT FK_MATCH_ARTIFACT FOREIGN KEY (ARTIFACT_ID)
        REFERENCES SDAINTAI_SOURCE_ARTIFACT (ARTIFACT_ID),
    CONSTRAINT FK_MATCH_PATTERN FOREIGN KEY (PATTERN_ID)
        REFERENCES SDAINTAI_TARGET_PATTERN (PATTERN_ID)
);


-- -----------------------------------------------------------------------------
-- 6. Supporting indexes (ordinary B-tree, always safe to create)
-- -----------------------------------------------------------------------------
CREATE INDEX IDX_ARTIFACT_SOURCE_TYPE ON SDAINTAI_SOURCE_ARTIFACT (SOURCE_SYSTEM, OBJECT_TYPE);
CREATE INDEX IDX_EMBEDDING_ARTIFACT   ON SDAINTAI_PATTERN_EMBEDDING (ARTIFACT_ID);
CREATE INDEX IDX_MATCH_ARTIFACT       ON SDAINTAI_CONVERSION_MATCH (ARTIFACT_ID);
CREATE INDEX IDX_MATCH_PATTERN        ON SDAINTAI_CONVERSION_MATCH (PATTERN_ID);


-- -----------------------------------------------------------------------------
-- 7. Native vector (HNSW) index for fast approximate nearest-neighbor search.
--    Requires HANA Cloud QRC 2/2024 or later. COMMENT THIS BLOCK OUT if your
--    tenant doesn't support CREATE VECTOR INDEX yet -- everything in Section 8
--    still works as an exact brute-force search without it.
-- -----------------------------------------------------------------------------
CREATE HNSW VECTOR INDEX IDX_EMBEDDING_HNSW
    ON SDAINTAI_PATTERN_EMBEDDING (EMBEDDING)
    SIMILARITY FUNCTION COSINE_SIMILARITY
    BUILD CONFIGURATION '{"efConstruction": 200, "m": 64}'
    SEARCH CONFIGURATION '{"efSearch": 200}';


-- -----------------------------------------------------------------------------
-- 8. Pattern-recognition procedure: given a query vector, return the top-K
--    most similar PAST source artifacts and whatever target pattern they were
--    actually converted to -- "find the closest proven conversion to reuse."
-- -----------------------------------------------------------------------------
DROP PROCEDURE SDAINTAI_FIND_SIMILAR_PATTERNS IF EXISTS;
CREATE PROCEDURE SDAINTAI_FIND_SIMILAR_PATTERNS(
    IN  QUERY_EMBEDDING  REAL_VECTOR(1536),
    IN  P_SOURCE_SYSTEM  NVARCHAR(20),          -- 'PIPO' | 'MULESOFT' | NULL for both
    IN  TOP_K            INTEGER,
    OUT RESULTS          TABLE (
        ARTIFACT_ID        NVARCHAR(36),
        OBJECT_NAME        NVARCHAR(200),
        OBJECT_TYPE        NVARCHAR(40),
        SOURCE_SYSTEM      NVARCHAR(20),
        SIMILARITY         DOUBLE,
        PATTERN_NAME       NVARCHAR(200),
        REFERENCE_PACKAGE  NVARCHAR(200)
    )
)
LANGUAGE SQLSCRIPT
SQL SECURITY INVOKER
READS SQL DATA
AS
BEGIN
    RESULTS =
        SELECT
            a.ARTIFACT_ID,
            a.OBJECT_NAME,
            a.OBJECT_TYPE,
            a.SOURCE_SYSTEM,
            COSINE_SIMILARITY(e.EMBEDDING, :QUERY_EMBEDDING) AS SIMILARITY,
            p.PATTERN_NAME,
            p.REFERENCE_PACKAGE
        FROM SDAINTAI_PATTERN_EMBEDDING e
        JOIN SDAINTAI_SOURCE_ARTIFACT  a ON a.ARTIFACT_ID = e.ARTIFACT_ID
        LEFT JOIN SDAINTAI_CONVERSION_MATCH m ON m.ARTIFACT_ID = a.ARTIFACT_ID
        LEFT JOIN SDAINTAI_TARGET_PATTERN   p ON p.PATTERN_ID  = m.PATTERN_ID
        WHERE e.CHUNK_SEQ = 0
          AND (:P_SOURCE_SYSTEM IS NULL OR a.SOURCE_SYSTEM = :P_SOURCE_SYSTEM)
        ORDER BY SIMILARITY DESC
        LIMIT :TOP_K;
    -- NOTE: if your HANA version rejects a parameterized LIMIT inside
    -- SQLScript, replace ":TOP_K" above with a literal (e.g. LIMIT 10) or
    -- build the SELECT as a dynamic statement (EXEC) keyed on TOP_K instead.
END;


-- -----------------------------------------------------------------------------
-- 9. Convenience view for browsing everything in HANA Database Explorer
--    without calling the procedure (handy while loading/validating data)
-- -----------------------------------------------------------------------------
DROP VIEW SDAINTAI_V_ARTIFACT_PATTERNS IF EXISTS;
CREATE VIEW SDAINTAI_V_ARTIFACT_PATTERNS AS
SELECT
    a.ARTIFACT_ID, a.SOURCE_SYSTEM, a.OBJECT_TYPE, a.OBJECT_NAME, a.COMPLEXITY_TIER,
    e.EMBEDDING_MODEL, e.CREATED_AT AS EMBEDDED_AT,
    p.PATTERN_NAME, p.REFERENCE_PACKAGE, m.CONFIDENCE, m.CONFIRMED_BY
FROM SDAINTAI_SOURCE_ARTIFACT a
LEFT JOIN SDAINTAI_PATTERN_EMBEDDING e ON e.ARTIFACT_ID = a.ARTIFACT_ID AND e.CHUNK_SEQ = 0
LEFT JOIN SDAINTAI_CONVERSION_MATCH  m ON m.ARTIFACT_ID = a.ARTIFACT_ID
LEFT JOIN SDAINTAI_TARGET_PATTERN    p ON p.PATTERN_ID  = m.PATTERN_ID;


-- =============================================================================
-- 10. SMOKE TEST — ad-hoc examples, safe to run once the above is created.
--     Delete or leave as reference; they don't affect real data.
-- =============================================================================

-- 10a. Insert a sample artifact + a (fake, all-zero-but-one) embedding so you
--      can confirm the pipeline end-to-end before wiring a real embedding model.
--      TO_REAL_VECTOR('[...]') is how a plain SQL console turns a bracketed
--      literal into the REAL_VECTOR type -- your Node/hdb ingestion code will
--      bind a real float array the same way a driver binds any other type.
INSERT INTO SDAINTAI_SOURCE_ARTIFACT
    (ARTIFACT_ID, SOURCE_SYSTEM, OBJECT_TYPE, OBJECT_NAME, CONTENT, COMPLEXITY_TIER)
VALUES
    (SYSUUID, 'PIPO', 'MESSAGE_MAPPING', 'MM_SalesOrder_ECC_to_S4', 'Sample mapping content for smoke test only.', 'B');

-- 10b. Smoke-test the similarity procedure (expect 1 row back, your sample):
-- CALL SDAINTAI_FIND_SIMILAR_PATTERNS(
--     TO_REAL_VECTOR('[0.1, 0.2, 0.0, ... ]'),  -- must be exactly 1536 values
--     'PIPO',
--     5,
--     ?
-- );

-- 10c. Clean up the smoke-test row once you've confirmed it works:
-- DELETE FROM SDAINTAI_SOURCE_ARTIFACT WHERE OBJECT_NAME = 'MM_SalesOrder_ECC_to_S4';
