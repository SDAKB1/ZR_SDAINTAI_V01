/**
 * HANA Vector Search for PI/PO Artifact Semantic Search
 * Uses HANA Cloud Vector Engine for similarity-based artifact discovery
 *
 * Based on north_star.md architecture specification
 */
const cds = require('@sap/cds');
const LOG = cds.log('vector-search');

class HANAVectorSearch {
  constructor(tenantId, embeddingClient = null) {
    this.tenantId = tenantId;
    this.embeddingClient = embeddingClient; // OpenAI, Bedrock, SAP GenAI Hub, etc.
    this.embeddingDimension = 1536; // Default for OpenAI ada-002 / text-embedding-3-small
  }

  /**
   * Set embedding client (OpenAI, Bedrock, SAP GenAI Hub)
   */
  setEmbeddingClient(client) {
    this.embeddingClient = client;
  }

  /**
   * Generate embedding for text content
   * Falls back to deterministic hash-based embedding if no client configured
   */
  async generateEmbedding(text) {
    if (this.embeddingClient) {
      try {
        const response = await this.embeddingClient.embed(text);
        return response.embedding || response;
      } catch (error) {
        LOG.warn('Embedding client error, using fallback', { error: error.message });
      }
    }

    // Fallback: deterministic hash-based embedding (128-dim for local dev)
    return this._hashBasedEmbedding(text, 128);
  }

  /**
   * Simple deterministic embedding for local development
   * Not semantically meaningful, but enables testing the infrastructure
   */
  _hashBasedEmbedding(text, dimension = 128) {
    const embedding = new Array(dimension).fill(0);
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const words = normalized.split(/\s+/).filter(w => w.length > 0);

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      for (let j = 0; j < word.length; j++) {
        const idx = (word.charCodeAt(j) * (i + 1) * (j + 1)) % dimension;
        embedding[idx] += 1 / (words.length * word.length);
      }
    }

    // Normalize to unit vector
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return magnitude > 0 ? embedding.map(v => v / magnitude) : embedding;
  }

  /**
   * Convert artifact to searchable text
   */
  _artifactToText(artifact, artifactType) {
    const parts = [];

    switch (artifactType) {
      case 'ICO':
        parts.push(`Integrated Configuration Object: ${artifact.name || artifact.interfaceName}`);
        if (artifact.senderComponent) parts.push(`Sender: ${artifact.senderComponent}`);
        if (artifact.senderInterface) parts.push(`Interface: ${artifact.senderInterface}`);
        if (artifact.namespace) parts.push(`Namespace: ${artifact.namespace}`);
        if (artifact.receivers) {
          artifact.receivers.forEach(r => {
            parts.push(`Receiver: ${r.component} ${r.interface}`);
          });
        }
        if (artifact.description) parts.push(artifact.description);
        break;

      case 'CHANNEL':
        parts.push(`Communication Channel: ${artifact.name}`);
        if (artifact.adapterType) parts.push(`Adapter: ${artifact.adapterType}`);
        if (artifact.direction) parts.push(`Direction: ${artifact.direction}`);
        if (artifact.protocol) parts.push(`Protocol: ${artifact.protocol}`);
        if (artifact.component) parts.push(`Component: ${artifact.component}`);
        break;

      case 'MAPPING':
        parts.push(`Message Mapping: ${artifact.name}`);
        if (artifact.sourceInterface) parts.push(`Source: ${artifact.sourceInterface}`);
        if (artifact.targetInterface) parts.push(`Target: ${artifact.targetInterface}`);
        if (artifact.mappingType) parts.push(`Type: ${artifact.mappingType}`);
        break;

      case 'VALUE_MAP':
        parts.push(`Value Mapping: ${artifact.groupName || artifact.name}`);
        if (artifact.representations) {
          artifact.representations.forEach(r => {
            parts.push(`Representation: ${r.agency} ${r.schema}`);
          });
        }
        break;

      default:
        parts.push(`${artifactType}: ${artifact.name}`);
        if (artifact.namespace) parts.push(`Namespace: ${artifact.namespace}`);
        if (artifact.description) parts.push(artifact.description);
    }

    return parts.join(' | ');
  }

  /**
   * Index an artifact for semantic search
   */
  async indexArtifact(artifactId, artifact, artifactType, metadata = {}) {
    const db = await cds.connect.to('db');
    const { PIPOEmbeddings } = db.entities('tenant');

    const textContent = this._artifactToText(artifact, artifactType);
    const embedding = await this.generateEmbedding(textContent);

    await UPSERT.into(PIPOEmbeddings).entries({
      tenant_ID: this.tenantId,
      resourceType: artifactType,
      resourceId: artifactId,
      chunkIndex: 0,
      contentText: textContent,
      embedding: JSON.stringify(embedding),
      metadata: JSON.stringify({ ...metadata, artifactName: artifact.name }),
      createdAt: new Date(),
    });

    return { indexed: true, artifactId, textLength: textContent.length };
  }

  /**
   * Bulk index multiple artifacts
   */
  async indexArtifacts(artifacts, artifactType) {
    const results = [];
    for (const artifact of artifacts) {
      const artifactId =
        artifact.id ||
        artifact.ID ||
        artifact.artifactId ||
        `${artifactType}:${artifact.name}:${artifact.namespace || 'default'}`;
      try {
        const result = await this.indexArtifact(artifactId, artifact, artifactType);
        results.push(result);
      } catch (error) {
        results.push({ indexed: false, artifactId, error: error.message });
      }
    }
    return results;
  }

  /**
   * Search for similar artifacts
   * @param {string} query - Search query text
   * @param {object} options - Search options
   */
  async search(query, options = {}) {
    const { topK = 5, threshold = 0.5, artifactType = null, includeContent = true } = options;

    const db = await cds.connect.to('db');
    const { PIPOEmbeddings } = db.entities('tenant');

    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);

    // Build where clause
    const where = { tenant_ID: this.tenantId };
    if (artifactType) where.resourceType = artifactType;

    // Get all embeddings for this tenant (in production, use HANA VECTOR_SEARCH)
    const embeddings = await SELECT.from(PIPOEmbeddings).where(where);

    // Calculate similarities (in production, HANA Vector Engine does this natively)
    const results = embeddings
      .map(row => {
        let storedEmbedding;
        try {
          storedEmbedding = JSON.parse(row.embedding);
        } catch (e) {
          return null;
        }

        const similarity = this._cosineSimilarity(queryEmbedding, storedEmbedding);

        return {
          artifactId: row.resourceId,
          artifactType: row.resourceType,
          similarity: similarity,
          content: includeContent ? row.contentText : undefined,
          metadata: row.metadata ? JSON.parse(row.metadata) : {},
        };
      })
      .filter(r => r && r.similarity >= threshold);

    // Sort by similarity and take top K
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * Find similar artifacts to a given artifact
   */
  async findSimilar(artifactId, options = {}) {
    const db = await cds.connect.to('db');
    const { PIPOEmbeddings } = db.entities('tenant');

    // Get the source artifact embedding
    const source = await SELECT.one.from(PIPOEmbeddings).where({
      tenant_ID: this.tenantId,
      resourceId: artifactId,
    });

    if (!source) {
      return [];
    }

    // Search using the source text as query
    return this.search(source.contentText, {
      ...options,
      // Exclude the source artifact from results
    }).then(results => results.filter(r => r.artifactId !== artifactId));
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  _cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) {
      // Handle dimension mismatch by truncating to smaller
      const minLen = Math.min(vecA.length, vecB.length);
      vecA = vecA.slice(0, minLen);
      vecB = vecB.slice(0, minLen);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude > 0 ? dotProduct / magnitude : 0;
  }

  /**
   * Delete embeddings for an artifact
   */
  async deleteEmbedding(artifactId) {
    const db = await cds.connect.to('db');
    const { PIPOEmbeddings } = db.entities('tenant');

    await DELETE.from(PIPOEmbeddings).where({
      tenant_ID: this.tenantId,
      resourceId: artifactId,
    });
  }

  /**
   * Clear all embeddings for tenant
   */
  async clearAll() {
    const db = await cds.connect.to('db');
    const { PIPOEmbeddings } = db.entities('tenant');

    await DELETE.from(PIPOEmbeddings).where({
      tenant_ID: this.tenantId,
    });
  }

  /**
   * Get embedding statistics
   */
  async getStats() {
    const db = await cds.connect.to('db');
    const { PIPOEmbeddings } = db.entities('tenant');

    const total = await SELECT.one
      .from(PIPOEmbeddings)
      .columns('count(*) as count')
      .where({ tenant_ID: this.tenantId });

    const byType = await SELECT.from(PIPOEmbeddings)
      .columns('resourceType', 'count(*) as count')
      .where({ tenant_ID: this.tenantId })
      .groupBy('resourceType');

    return {
      tenantId: this.tenantId,
      totalEmbeddings: total?.count || 0,
      byArtifactType: byType.reduce((acc, row) => {
        acc[row.resourceType] = row.count;
        return acc;
      }, {}),
    };
  }
}

/**
 * Factory function
 */
function createVectorSearch(tenantId, embeddingClient = null) {
  return new HANAVectorSearch(tenantId, embeddingClient);
}

module.exports = { HANAVectorSearch, createVectorSearch };
