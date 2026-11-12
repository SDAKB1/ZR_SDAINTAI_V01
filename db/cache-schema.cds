using { cuid, managed } from '@sap/cds/common';
namespace cache;

// -------------------------------------------------------------------------------
// ARTIFACT CACHE - Durable cache for discovered PI/PO artifacts
// -------------------------------------------------------------------------------

/**
 * Cache layer for PI/PO artifacts with TTL support.
 * Reduces load on PI/PO systems and improves response times.
 * Supports indefinite caching (ttlSeconds = -1) for test systems.
 */
@assert.unique: { cache_lookup: [tenantId, cacheKey] }
entity ArtifactCache : cuid, managed {
  tenantId        : String(36) not null;  // Tenant identifier for isolation
  cacheKey        : String(512) not null; // Unique cache key (artifactType:artifactId or resource:id)
  artifactType    : String(100);          // ICO, CHANNEL, MAPPING, VALUE_MAP, etc.
  payload         : LargeString;          // JSON serialized artifact data
  metadata        : LargeString;          // JSON metadata (source, version, dependencies, etc.)
  ttlSeconds      : Integer default -1;   // Time-to-live in seconds (-1 = indefinite/never expires)
  expiresAt       : Timestamp;            // Calculated expiration timestamp (null if indefinite)
  hitCount        : Integer default 0;    // Number of cache hits for analytics
  lastAccessedAt  : Timestamp;            // Last access time for LRU eviction
  version         : Integer default 1;    // Version for optimistic locking / change detection
  checksum        : String(64);           // SHA-256 checksum for content integrity validation
}
