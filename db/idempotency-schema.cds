using { cuid, managed } from '@sap/cds/common';
namespace idempotency;

// -------------------------------------------------------------------------------
// IDEMPOTENCY RECORD - Ensures exactly-once processing for critical operations
// -------------------------------------------------------------------------------

/**
 * Tracks idempotency keys for operations to prevent duplicate processing.
 * Critical for async operations, webhook handlers, and retry scenarios.
 * Supports configurable TTL for automatic cleanup of old records.
 */
@assert.unique: { idempotency_lookup: [tenantId, idempotencyKey] }
entity IdempotencyRecord : cuid, managed {
  tenantId        : String(36) not null;  // Tenant identifier for isolation
  idempotencyKey  : String(256) not null; // Unique key for the operation (hash of request params)
  operation       : String(100);          // Operation type (discovery_start, artifact_upsert, etc.)
  status          : String(20);           // pending | processing | completed | failed
  result          : LargeString;          // JSON serialized result or error details
  expiresAt       : Timestamp;            // When this record can be cleaned up
  createdAt       : Timestamp default $now; // Record creation timestamp
}
