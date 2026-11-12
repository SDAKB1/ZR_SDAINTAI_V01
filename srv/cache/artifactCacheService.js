'use strict';

const cds = require('@sap/cds');
const crypto = require('crypto');

const LOG = cds.log('cache');

/**
 * Artifact Cache Service
 *
 * Provides tenant-isolated caching for PI/PO discovery artifacts.
 * Supports TTL-based expiration, indefinite caching (TTL=-1),
 * cache invalidation patterns, and cache warming from discovery.
 */

/**
 * Computes SHA-256 checksum for content integrity validation
 * @param {string} content - Content to hash
 * @returns {string} SHA-256 hex digest
 */
function computeChecksum(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Checks if a cache record is expired
 * @param {object} record - Cache record from database
 * @returns {boolean} true if expired, false otherwise
 */
function _isExpired(record) {
  if (!record) return true;

  // TTL=-1 means indefinite (never expires)
  if (record.ttlSeconds === -1) return false;

  // Check explicit expiresAt timestamp
  if (record.expiresAt) {
    return new Date(record.expiresAt) < new Date();
  }

  // No expiration set - treat as valid
  return false;
}

/**
 * Retrieves a cached artifact by key
 * @param {string} tenantId - Tenant identifier for isolation
 * @param {string} key - Cache key (e.g., 'ICO:InterfaceId123')
 * @returns {Promise<object|null>} Cached value with metadata, or null if not found/expired
 */
async function get(tenantId, key) {
  const { ArtifactCache } = cds.entities('cache');

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    LOG.warn('get() called without tenant context', { key });
    return null;
  }

  try {
    const record = await SELECT.one.from(ArtifactCache).where({ tenantId: effectiveTenant, cacheKey: key });

    if (!record) {
      LOG.debug('Cache miss', { tenantId: effectiveTenant, key });
      return null;
    }

    if (_isExpired(record)) {
      LOG.debug('Cache entry expired', { tenantId: effectiveTenant, key, expiresAt: record.expiresAt });
      // Clean up expired entry
      await DELETE.from(ArtifactCache).where({ tenantId: effectiveTenant, cacheKey: key });
      return null;
    }

    // Increment hit count and update last accessed time
    await UPDATE(ArtifactCache)
      .set({
        hitCount: record.hitCount + 1,
        lastAccessedAt: new Date().toISOString(),
      })
      .where({ ID: record.ID });

    LOG.debug('Cache hit', { tenantId: effectiveTenant, key, hitCount: record.hitCount + 1 });

    // Parse and return the cached data
    let payload = null;
    let metadata = null;

    try {
      payload = record.payload ? JSON.parse(record.payload) : null;
    } catch (e) {
      LOG.warn('Failed to parse cached payload', { key, error: e.message });
    }

    try {
      metadata = record.metadata ? JSON.parse(record.metadata) : null;
    } catch (e) {
      LOG.warn('Failed to parse cached metadata', { key, error: e.message });
    }

    return {
      key: record.cacheKey,
      value: payload,
      metadata,
      artifactType: record.artifactType,
      version: record.version,
      checksum: record.checksum,
      hitCount: record.hitCount + 1,
      createdAt: record.createdAt,
      lastAccessedAt: new Date().toISOString(),
    };
  } catch (error) {
    LOG.error('Error retrieving cache entry', { tenantId: effectiveTenant, key, error: error.message });
    throw error;
  }
}

/**
 * Stores or updates a cached artifact
 * @param {string} tenantId - Tenant identifier for isolation
 * @param {string} key - Cache key (e.g., 'ICO:InterfaceId123')
 * @param {*} value - Value to cache (will be JSON serialized)
 * @param {number} [ttl=-1] - Time-to-live in seconds (-1 for indefinite)
 * @param {object} [metadata={}] - Additional metadata to store
 * @returns {Promise<object>} Created/updated cache record info
 */
async function set(tenantId, key, value, ttl = -1, metadata = {}) {
  const { ArtifactCache } = cds.entities('cache');

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    throw new Error('Tenant context required for cache set operation');
  }

  const payload = JSON.stringify(value);
  const checksum = computeChecksum(payload);
  const metadataJson = JSON.stringify(metadata);
  const now = new Date();

  // Calculate expiration timestamp
  let expiresAt = null;
  if (ttl > 0) {
    expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  }
  // ttl === -1 means indefinite, expiresAt stays null

  // Extract artifact type from key if present (format: 'TYPE:id')
  const artifactType = key.includes(':') ? key.split(':')[0] : null;

  try {
    // Check if entry exists
    const existing = await SELECT.one
      .from(ArtifactCache)
      .columns('ID', 'version')
      .where({ tenantId: effectiveTenant, cacheKey: key });

    if (existing) {
      // Update existing entry with incremented version
      await UPDATE(ArtifactCache)
        .set({
          payload,
          metadata: metadataJson,
          ttlSeconds: ttl,
          expiresAt,
          checksum,
          version: existing.version + 1,
          lastAccessedAt: now.toISOString(),
        })
        .where({ ID: existing.ID });

      LOG.info('Cache entry updated', { tenantId: effectiveTenant, key, version: existing.version + 1 });

      return {
        key,
        version: existing.version + 1,
        checksum,
        expiresAt,
        operation: 'update',
      };
    } else {
      // Insert new entry
      const newId = cds.utils.uuid();
      await INSERT.into(ArtifactCache).entries({
        ID: newId,
        tenantId: effectiveTenant,
        cacheKey: key,
        artifactType,
        payload,
        metadata: metadataJson,
        ttlSeconds: ttl,
        expiresAt,
        hitCount: 0,
        lastAccessedAt: now.toISOString(),
        version: 1,
        checksum,
      });

      LOG.info('Cache entry created', { tenantId: effectiveTenant, key, version: 1 });

      return {
        key,
        version: 1,
        checksum,
        expiresAt,
        operation: 'insert',
      };
    }
  } catch (error) {
    LOG.error('Error setting cache entry', { tenantId: effectiveTenant, key, error: error.message });
    throw error;
  }
}

/**
 * Invalidates (deletes) a specific cache entry
 * @param {string} tenantId - Tenant identifier for isolation
 * @param {string} key - Cache key to invalidate
 * @returns {Promise<boolean>} true if entry was deleted, false if not found
 */
async function invalidate(tenantId, key) {
  const { ArtifactCache } = cds.entities('cache');

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    throw new Error('Tenant context required for cache invalidate operation');
  }

  try {
    const result = await DELETE.from(ArtifactCache).where({ tenantId: effectiveTenant, cacheKey: key });

    const deleted = result > 0;
    LOG.info('Cache entry invalidated', { tenantId: effectiveTenant, key, deleted });

    return deleted;
  } catch (error) {
    LOG.error('Error invalidating cache entry', { tenantId: effectiveTenant, key, error: error.message });
    throw error;
  }
}

/**
 * Invalidates cache entries matching a pattern
 * @param {string} tenantId - Tenant identifier for isolation
 * @param {string} pattern - Pattern to match (uses SQL LIKE syntax, e.g., 'ICO:%')
 * @returns {Promise<number>} Number of entries deleted
 */
async function invalidateByPattern(tenantId, pattern) {
  const { ArtifactCache } = cds.entities('cache');

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    throw new Error('Tenant context required for cache invalidateByPattern operation');
  }

  try {
    const result = await DELETE.from(ArtifactCache).where({ tenantId: effectiveTenant }).and('cacheKey like', pattern);

    LOG.info('Cache entries invalidated by pattern', { tenantId: effectiveTenant, pattern, count: result });

    return result;
  } catch (error) {
    LOG.error('Error invalidating cache entries by pattern', {
      tenantId: effectiveTenant,
      pattern,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Pre-populates cache from discovery results for a specific PI/PO system
 * @param {string} tenantId - Tenant identifier for isolation
 * @param {string} systemId - PI/PO system identifier to warm cache for
 * @param {object} [options={}] - Warming options
 * @param {number} [options.ttl=-1] - TTL for cached entries (-1 for indefinite)
 * @returns {Promise<object>} Summary of cache warming operation
 */
async function warmCache(tenantId, systemId, options = {}) {
  const { ttl = -1 } = options;

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    throw new Error('Tenant context required for cache warm operation');
  }

  if (!systemId) {
    throw new Error('System ID required for cache warming');
  }

  LOG.info('Starting cache warming', { tenantId: effectiveTenant, systemId });

  try {
    // Fetch discovered artifacts from tenant HDI
    const { Artifact } = cds.entities('tenant');

    const artifacts = await SELECT.from(Artifact).where({ tenantId: effectiveTenant, system_ID: systemId });

    if (!artifacts || artifacts.length === 0) {
      LOG.info('No artifacts found for cache warming', { tenantId: effectiveTenant, systemId });
      return {
        systemId,
        processed: 0,
        cached: 0,
        errors: 0,
      };
    }

    let cached = 0;
    let errors = 0;

    for (const artifact of artifacts) {
      try {
        const cacheKey = `${artifact.artifactType}:${artifact.objectId || artifact.ID}`;
        const value = {
          artifactId: artifact.objectId || artifact.ID,
          artifactType: artifact.artifactType,
          name: artifact.name,
          description: artifact.description,
          rawDefinition: artifact.rawDefinition,
          system_ID: artifact.system_ID,
        };
        const metadata = {
          source: 'discovery',
          systemId,
          discoveredAt: artifact.createdAt,
          warmedAt: new Date().toISOString(),
        };

        await set(effectiveTenant, cacheKey, value, ttl, metadata);
        cached++;
      } catch (error) {
        LOG.warn('Failed to cache artifact during warming', {
          artifactId: artifact.objectId || artifact.ID,
          error: error.message,
        });
        errors++;
      }
    }

    LOG.info('Cache warming completed', {
      tenantId: effectiveTenant,
      systemId,
      processed: artifacts.length,
      cached,
      errors,
    });

    return {
      systemId,
      processed: artifacts.length,
      cached,
      errors,
    };
  } catch (error) {
    LOG.error('Error during cache warming', { tenantId: effectiveTenant, systemId, error: error.message });
    throw error;
  }
}

/**
 * Cleans up all expired cache entries for a tenant
 * @param {string} tenantId - Tenant identifier for isolation
 * @returns {Promise<number>} Number of entries deleted
 */
async function cleanExpired(tenantId) {
  const { ArtifactCache } = cds.entities('cache');

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    throw new Error('Tenant context required for cache cleanup operation');
  }

  try {
    const now = new Date().toISOString();

    // Delete entries that have expired (expiresAt is set and in the past)
    // Entries with ttlSeconds=-1 have null expiresAt and won't be deleted
    const result = await DELETE.from(ArtifactCache)
      .where({ tenantId: effectiveTenant })
      .and('expiresAt is not null')
      .and('expiresAt <', now);

    LOG.info('Expired cache entries cleaned', { tenantId: effectiveTenant, count: result });

    return result;
  } catch (error) {
    LOG.error('Error cleaning expired cache entries', { tenantId: effectiveTenant, error: error.message });
    throw error;
  }
}

/**
 * Gets cache statistics for a tenant
 * @param {string} tenantId - Tenant identifier for isolation
 * @returns {Promise<object>} Cache statistics
 */
async function getStats(tenantId) {
  const { ArtifactCache } = cds.entities('cache');

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    throw new Error('Tenant context required for cache stats operation');
  }

  try {
    const entries = await SELECT.from(ArtifactCache)
      .columns('artifactType', 'hitCount', 'ttlSeconds', 'expiresAt')
      .where({ tenantId: effectiveTenant });

    const now = new Date();
    let totalEntries = entries.length;
    let indefiniteEntries = 0;
    let expiredEntries = 0;
    let totalHits = 0;
    const byType = {};

    for (const entry of entries) {
      totalHits += entry.hitCount || 0;

      if (entry.ttlSeconds === -1) {
        indefiniteEntries++;
      } else if (entry.expiresAt && new Date(entry.expiresAt) < now) {
        expiredEntries++;
      }

      const type = entry.artifactType || 'unknown';
      byType[type] = (byType[type] || 0) + 1;
    }

    return {
      tenantId: effectiveTenant,
      totalEntries,
      indefiniteEntries,
      expiredEntries,
      activeEntries: totalEntries - expiredEntries,
      totalHits,
      byArtifactType: byType,
    };
  } catch (error) {
    LOG.error('Error getting cache stats', { tenantId: effectiveTenant, error: error.message });
    throw error;
  }
}

module.exports = {
  get,
  set,
  invalidate,
  invalidateByPattern,
  warmCache,
  cleanExpired,
  getStats,
  _isExpired,
};
