'use strict';

const cds = require('@sap/cds');

const LOG = cds.log('idempotency');

/**
 * Default TTL in seconds (1 hour)
 */
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Status constants
 */
const STATUS = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/**
 * Idempotency Service
 *
 * Ensures exactly-once processing for critical operations.
 * Critical for async operations, webhook handlers, and retry scenarios.
 * Uses tenant-isolated storage in HANA HDI containers.
 */

/**
 * Checks if an operation is already in progress or completed, and locks it if not
 * @param {string} tenantId - Tenant identifier for isolation
 * @param {string} key - Unique idempotency key for the operation
 * @param {string} operation - Operation type (e.g., 'discovery_start', 'artifact_upsert')
 * @param {number} [ttlSeconds=3600] - Time-to-live in seconds for the record
 * @returns {Promise<object>} Result object with status and existing result if already processed
 */
async function checkAndLock(tenantId, key, operation, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const { IdempotencyRecord } = cds.entities('idempotency');

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    throw new Error('Tenant context required for idempotency check');
  }

  if (!key) {
    throw new Error('Idempotency key is required');
  }

  if (!operation) {
    throw new Error('Operation type is required');
  }

  try {
    // Check for existing record
    const existing = await SELECT.one.from(IdempotencyRecord).where({ tenantId: effectiveTenant, idempotencyKey: key });

    if (existing) {
      // Check if expired
      if (existing.expiresAt && new Date(existing.expiresAt) < new Date()) {
        // Expired - delete and allow new processing
        await DELETE.from(IdempotencyRecord).where({ ID: existing.ID });

        LOG.debug('Expired idempotency record deleted', { tenantId: effectiveTenant, key });
      } else {
        // Not expired - return existing status and result
        let result = null;
        try {
          result = existing.result ? JSON.parse(existing.result) : null;
        } catch (e) {
          LOG.warn('Failed to parse idempotency result', { key, error: e.message });
        }

        LOG.debug('Existing idempotency record found', {
          tenantId: effectiveTenant,
          key,
          status: existing.status,
        });

        return {
          locked: false,
          alreadyProcessed: existing.status === STATUS.COMPLETED,
          alreadyFailed: existing.status === STATUS.FAILED,
          inProgress: existing.status === STATUS.PROCESSING,
          status: existing.status,
          result,
          createdAt: existing.createdAt,
        };
      }
    }

    // No existing record (or expired one was deleted) - create new lock
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const newId = cds.utils.uuid();

    await INSERT.into(IdempotencyRecord).entries({
      ID: newId,
      tenantId: effectiveTenant,
      idempotencyKey: key,
      operation,
      status: STATUS.PROCESSING,
      expiresAt,
      createdAt: now.toISOString(),
    });

    LOG.info('Idempotency lock acquired', { tenantId: effectiveTenant, key, operation });

    return {
      locked: true,
      alreadyProcessed: false,
      alreadyFailed: false,
      inProgress: false,
      status: STATUS.PROCESSING,
    };
  } catch (error) {
    // Handle unique constraint violation (race condition)
    if (
      error.code === 'SQLITE_CONSTRAINT' ||
      error.message?.includes('unique constraint') ||
      error.message?.includes('duplicate key')
    ) {
      LOG.warn('Concurrent idempotency lock attempt', { tenantId: effectiveTenant, key });

      return {
        locked: false,
        alreadyProcessed: false,
        alreadyFailed: false,
        inProgress: true,
        status: STATUS.PROCESSING,
      };
    }

    LOG.error('Error checking idempotency', { tenantId: effectiveTenant, key, error: error.message });
    throw error;
  }
}

/**
 * Marks an operation as completed with its result
 * @param {string} tenantId - Tenant identifier for isolation
 * @param {string} key - Unique idempotency key for the operation
 * @param {*} result - Result of the operation (will be JSON serialized)
 * @returns {Promise<boolean>} true if record was updated, false if not found
 */
async function complete(tenantId, key, result) {
  const { IdempotencyRecord } = cds.entities('idempotency');

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    throw new Error('Tenant context required for idempotency complete');
  }

  if (!key) {
    throw new Error('Idempotency key is required');
  }

  try {
    const resultJson = JSON.stringify(result);

    const updated = await UPDATE(IdempotencyRecord)
      .set({
        status: STATUS.COMPLETED,
        result: resultJson,
      })
      .where({ tenantId: effectiveTenant, idempotencyKey: key });

    if (updated > 0) {
      LOG.info('Idempotency record completed', { tenantId: effectiveTenant, key });
      return true;
    } else {
      LOG.warn('Idempotency record not found for completion', { tenantId: effectiveTenant, key });
      return false;
    }
  } catch (error) {
    LOG.error('Error completing idempotency record', { tenantId: effectiveTenant, key, error: error.message });
    throw error;
  }
}

/**
 * Marks an operation as failed with error details
 * @param {string} tenantId - Tenant identifier for isolation
 * @param {string} key - Unique idempotency key for the operation
 * @param {Error|object|string} error - Error details
 * @returns {Promise<boolean>} true if record was updated, false if not found
 */
async function fail(tenantId, key, error) {
  const { IdempotencyRecord } = cds.entities('idempotency');

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    throw new Error('Tenant context required for idempotency fail');
  }

  if (!key) {
    throw new Error('Idempotency key is required');
  }

  try {
    // Normalize error to serializable format
    let errorData;
    if (error instanceof Error) {
      errorData = {
        message: error.message,
        name: error.name,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      };
    } else if (typeof error === 'string') {
      errorData = { message: error, timestamp: new Date().toISOString() };
    } else {
      errorData = { ...error, timestamp: new Date().toISOString() };
    }

    const resultJson = JSON.stringify({ error: errorData });

    const updated = await UPDATE(IdempotencyRecord)
      .set({
        status: STATUS.FAILED,
        result: resultJson,
      })
      .where({ tenantId: effectiveTenant, idempotencyKey: key });

    if (updated > 0) {
      LOG.info('Idempotency record marked as failed', { tenantId: effectiveTenant, key });
      return true;
    } else {
      LOG.warn('Idempotency record not found for failure marking', { tenantId: effectiveTenant, key });
      return false;
    }
  } catch (err) {
    LOG.error('Error marking idempotency record as failed', { tenantId: effectiveTenant, key, error: err.message });
    throw err;
  }
}

/**
 * Cleans up expired idempotency records for a tenant
 * @param {string} tenantId - Tenant identifier for isolation
 * @returns {Promise<number>} Number of records deleted
 */
async function cleanExpired(tenantId) {
  const { IdempotencyRecord } = cds.entities('idempotency');

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    throw new Error('Tenant context required for idempotency cleanup');
  }

  try {
    const now = new Date().toISOString();

    const result = await DELETE.from(IdempotencyRecord).where({ tenantId: effectiveTenant }).and('expiresAt <', now);

    LOG.info('Expired idempotency records cleaned', { tenantId: effectiveTenant, count: result });

    return result;
  } catch (error) {
    LOG.error('Error cleaning expired idempotency records', { tenantId: effectiveTenant, error: error.message });
    throw error;
  }
}

/**
 * Gets the status of an idempotency record
 * @param {string} tenantId - Tenant identifier for isolation
 * @param {string} key - Unique idempotency key
 * @returns {Promise<object|null>} Record status or null if not found
 */
async function getStatus(tenantId, key) {
  const { IdempotencyRecord } = cds.entities('idempotency');

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    throw new Error('Tenant context required for idempotency status check');
  }

  try {
    const record = await SELECT.one.from(IdempotencyRecord).where({ tenantId: effectiveTenant, idempotencyKey: key });

    if (!record) {
      return null;
    }

    let result = null;
    try {
      result = record.result ? JSON.parse(record.result) : null;
    } catch (e) {
      LOG.warn('Failed to parse idempotency result', { key, error: e.message });
    }

    return {
      key: record.idempotencyKey,
      operation: record.operation,
      status: record.status,
      result,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      isExpired: record.expiresAt ? new Date(record.expiresAt) < new Date() : false,
    };
  } catch (error) {
    LOG.error('Error getting idempotency status', { tenantId: effectiveTenant, key, error: error.message });
    throw error;
  }
}

/**
 * Removes an idempotency record (for cleanup or retry scenarios)
 * @param {string} tenantId - Tenant identifier for isolation
 * @param {string} key - Unique idempotency key
 * @returns {Promise<boolean>} true if record was deleted, false if not found
 */
async function remove(tenantId, key) {
  const { IdempotencyRecord } = cds.entities('idempotency');

  const effectiveTenant = tenantId || cds.context?.tenant;
  if (!effectiveTenant) {
    throw new Error('Tenant context required for idempotency remove');
  }

  if (!key) {
    throw new Error('Idempotency key is required');
  }

  try {
    const result = await DELETE.from(IdempotencyRecord).where({ tenantId: effectiveTenant, idempotencyKey: key });

    if (result > 0) {
      LOG.info('Idempotency record removed', { tenantId: effectiveTenant, key });
      return true;
    } else {
      LOG.debug('Idempotency record not found for removal', { tenantId: effectiveTenant, key });
      return false;
    }
  } catch (error) {
    LOG.error('Error removing idempotency record', { tenantId: effectiveTenant, key, error: error.message });
    throw error;
  }
}

module.exports = {
  checkAndLock,
  complete,
  fail,
  cleanExpired,
  getStatus,
  remove,
  STATUS,
  DEFAULT_TTL_SECONDS,
};
