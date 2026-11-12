'use strict';

const cds = require('@sap/cds');

const LOG = cds.log('checkpoint');

/**
 * CAP Checkpoint Saver for LangGraph
 *
 * Implements the LangGraph BaseCheckpointSaver interface for durable
 * checkpoint storage in tenant-isolated HANA HDI containers.
 * Enables recovery from timeouts, errors, and system restarts.
 */
class CapCheckpointSaver {
  /**
   * Creates a new CapCheckpointSaver instance
   * @param {string} tenantId - Tenant identifier for isolation
   */
  constructor(tenantId) {
    this.tenantId = tenantId;
    LOG.debug('CapCheckpointSaver initialized', { tenantId });
  }

  /**
   * Gets the effective tenant ID from constructor or CDS context
   * @returns {string} Tenant identifier
   * @throws {Error} If no tenant context is available
   */
  _getEffectiveTenant() {
    const tenant = this.tenantId || cds.context?.tenant;
    if (!tenant) {
      throw new Error('Tenant context required for checkpoint operations');
    }
    return tenant;
  }

  /**
   * Saves a checkpoint to the database
   * @param {object} config - Checkpoint configuration
   * @param {string} config.configurable.thread_id - Thread identifier
   * @param {string} [config.configurable.checkpoint_id] - Checkpoint identifier (auto-generated if not provided)
   * @param {object} checkpoint - Checkpoint state data
   * @param {object} [metadata={}] - Additional metadata
   * @returns {Promise<object>} The saved checkpoint configuration
   */
  async put(config, checkpoint, metadata = {}) {
    const { LangGraphCheckpoint } = cds.entities('checkpoint');
    const tenantId = this._getEffectiveTenant();

    const threadId = config?.configurable?.thread_id;
    if (!threadId) {
      throw new Error('thread_id is required in config.configurable');
    }

    // Generate checkpoint ID if not provided
    const checkpointId =
      config?.configurable?.checkpoint_id || `cp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    // Get parent checkpoint ID if available
    const parentId = config?.configurable?.parent_checkpoint_id || null;

    const stateJson = JSON.stringify(checkpoint);
    const metadataJson = JSON.stringify({
      ...metadata,
      savedAt: new Date().toISOString(),
    });

    try {
      // Check if checkpoint exists
      const existing = await SELECT.one
        .from(LangGraphCheckpoint)
        .columns('ID')
        .where({ tenantId, threadId, checkpointId });

      if (existing) {
        // Update existing checkpoint
        await UPDATE(LangGraphCheckpoint)
          .set({
            state: stateJson,
            metadata: metadataJson,
            parentId,
          })
          .where({ ID: existing.ID });

        LOG.info('Checkpoint updated', { tenantId, threadId, checkpointId });
      } else {
        // Insert new checkpoint
        const newId = cds.utils.uuid();
        await INSERT.into(LangGraphCheckpoint).entries({
          ID: newId,
          tenantId,
          threadId,
          checkpointId,
          parentId,
          state: stateJson,
          metadata: metadataJson,
        });

        LOG.info('Checkpoint created', { tenantId, threadId, checkpointId });
      }

      // Return the configuration with checkpoint ID
      return {
        configurable: {
          thread_id: threadId,
          checkpoint_id: checkpointId,
          parent_checkpoint_id: parentId,
        },
      };
    } catch (error) {
      LOG.error('Error saving checkpoint', { tenantId, threadId, checkpointId, error: error.message });
      throw error;
    }
  }

  /**
   * Retrieves the latest checkpoint for a thread
   * @param {object} config - Checkpoint configuration
   * @param {string} config.configurable.thread_id - Thread identifier
   * @returns {Promise<object|undefined>} The checkpoint state, or undefined if not found
   */
  async get(config) {
    const { LangGraphCheckpoint } = cds.entities('checkpoint');
    const tenantId = this._getEffectiveTenant();

    const threadId = config?.configurable?.thread_id;
    if (!threadId) {
      throw new Error('thread_id is required in config.configurable');
    }

    try {
      // Get the latest checkpoint by createdAt
      const record = await SELECT.one.from(LangGraphCheckpoint).where({ tenantId, threadId }).orderBy('createdAt desc');

      if (!record) {
        LOG.debug('No checkpoint found', { tenantId, threadId });
        return undefined;
      }

      LOG.debug('Checkpoint retrieved', { tenantId, threadId, checkpointId: record.checkpointId });

      // Parse and return state
      try {
        return JSON.parse(record.state);
      } catch (e) {
        LOG.warn('Failed to parse checkpoint state', { tenantId, threadId, error: e.message });
        return undefined;
      }
    } catch (error) {
      LOG.error('Error retrieving checkpoint', { tenantId, threadId, error: error.message });
      throw error;
    }
  }

  /**
   * Lists checkpoints for a thread
   * @param {object} config - Checkpoint configuration
   * @param {string} config.configurable.thread_id - Thread identifier
   * @param {object} [options={}] - List options
   * @param {number} [options.limit=10] - Maximum number of checkpoints to return
   * @param {string} [options.before] - Return checkpoints created before this checkpoint ID
   * @returns {AsyncGenerator<object>} Async generator yielding checkpoint tuples
   */
  async *list(config, options = {}) {
    const { LangGraphCheckpoint } = cds.entities('checkpoint');
    const tenantId = this._getEffectiveTenant();

    const threadId = config?.configurable?.thread_id;
    if (!threadId) {
      throw new Error('thread_id is required in config.configurable');
    }

    const { limit = 10, before } = options;

    try {
      let query = SELECT.from(LangGraphCheckpoint).where({ tenantId, threadId }).orderBy('createdAt desc').limit(limit);

      // If 'before' is specified, get checkpoints older than the reference
      if (before) {
        const refCheckpoint = await SELECT.one
          .from(LangGraphCheckpoint)
          .columns('createdAt')
          .where({ tenantId, threadId, checkpointId: before });

        if (refCheckpoint) {
          query = query.and('createdAt <', refCheckpoint.createdAt);
        }
      }

      const records = await query;

      LOG.debug('Listing checkpoints', { tenantId, threadId, count: records.length });

      for (const record of records) {
        let state = null;
        let metadata = null;

        try {
          state = record.state ? JSON.parse(record.state) : null;
        } catch (e) {
          LOG.warn('Failed to parse checkpoint state', { checkpointId: record.checkpointId });
        }

        try {
          metadata = record.metadata ? JSON.parse(record.metadata) : null;
        } catch (e) {
          LOG.warn('Failed to parse checkpoint metadata', { checkpointId: record.checkpointId });
        }

        yield {
          config: {
            configurable: {
              thread_id: threadId,
              checkpoint_id: record.checkpointId,
              parent_checkpoint_id: record.parentId,
            },
          },
          checkpoint: state,
          metadata,
          createdAt: record.createdAt,
        };
      }
    } catch (error) {
      LOG.error('Error listing checkpoints', { tenantId, threadId, error: error.message });
      throw error;
    }
  }

  /**
   * Returns the checkpoint and config tuple for resuming a workflow
   * @param {object} config - Checkpoint configuration
   * @param {string} config.configurable.thread_id - Thread identifier
   * @param {string} [config.configurable.checkpoint_id] - Specific checkpoint ID (optional, gets latest if not specified)
   * @returns {Promise<object|undefined>} Object with checkpoint and config, or undefined if not found
   */
  async getTuple(config) {
    const { LangGraphCheckpoint } = cds.entities('checkpoint');
    const tenantId = this._getEffectiveTenant();

    const threadId = config?.configurable?.thread_id;
    if (!threadId) {
      throw new Error('thread_id is required in config.configurable');
    }

    const checkpointId = config?.configurable?.checkpoint_id;

    try {
      let record;

      if (checkpointId) {
        // Get specific checkpoint
        record = await SELECT.one.from(LangGraphCheckpoint).where({ tenantId, threadId, checkpointId });
      } else {
        // Get latest checkpoint
        record = await SELECT.one.from(LangGraphCheckpoint).where({ tenantId, threadId }).orderBy('createdAt desc');
      }

      if (!record) {
        LOG.debug('No checkpoint tuple found', { tenantId, threadId, checkpointId });
        return undefined;
      }

      let state = null;
      let metadata = null;

      try {
        state = record.state ? JSON.parse(record.state) : null;
      } catch (e) {
        LOG.warn('Failed to parse checkpoint state', { checkpointId: record.checkpointId });
      }

      try {
        metadata = record.metadata ? JSON.parse(record.metadata) : null;
      } catch (e) {
        LOG.warn('Failed to parse checkpoint metadata', { checkpointId: record.checkpointId });
      }

      LOG.debug('Checkpoint tuple retrieved', { tenantId, threadId, checkpointId: record.checkpointId });

      return {
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_id: record.checkpointId,
            parent_checkpoint_id: record.parentId,
          },
        },
        checkpoint: state,
        metadata,
        createdAt: record.createdAt,
      };
    } catch (error) {
      LOG.error('Error getting checkpoint tuple', { tenantId, threadId, error: error.message });
      throw error;
    }
  }

  /**
   * Deletes checkpoints for a thread
   * @param {string} threadId - Thread identifier
   * @returns {Promise<number>} Number of checkpoints deleted
   */
  async deleteThread(threadId) {
    const { LangGraphCheckpoint } = cds.entities('checkpoint');
    const tenantId = this._getEffectiveTenant();

    if (!threadId) {
      throw new Error('threadId is required');
    }

    try {
      const result = await DELETE.from(LangGraphCheckpoint).where({ tenantId, threadId });

      LOG.info('Thread checkpoints deleted', { tenantId, threadId, count: result });
      return result;
    } catch (error) {
      LOG.error('Error deleting thread checkpoints', { tenantId, threadId, error: error.message });
      throw error;
    }
  }
}

/**
 * Wraps an async operation with automatic checkpoint saving on error
 * Creates a checkpoint before rethrowing errors to enable recovery
 *
 * @param {CapCheckpointSaver} saver - Checkpoint saver instance
 * @param {object} config - Checkpoint configuration with thread_id
 * @param {Function} asyncFn - Async function to wrap
 * @param {object} [metadata={}] - Additional metadata for error checkpoint
 * @returns {Promise<*>} Result of asyncFn, or throws with checkpoint saved
 */
async function saveOnError(saver, config, asyncFn, metadata = {}) {
  const threadId = config?.configurable?.thread_id;

  if (!saver || !threadId) {
    throw new Error('saver and config.configurable.thread_id are required');
  }

  try {
    return await asyncFn();
  } catch (error) {
    LOG.warn('Error occurred, saving checkpoint before rethrowing', {
      threadId,
      error: error.message,
    });

    // Get current state from the latest checkpoint or use empty state
    let currentState = {};
    try {
      const existing = await saver.get(config);
      if (existing) {
        currentState = existing;
      }
    } catch (e) {
      LOG.warn('Could not retrieve existing checkpoint for error save', { error: e.message });
    }

    // Save error checkpoint with error details
    const errorCheckpoint = {
      ...currentState,
      _error: {
        message: error.message,
        name: error.name,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      },
      _errorRecoveryPending: true,
    };

    try {
      await saver.put(
        {
          configurable: {
            thread_id: threadId,
            checkpoint_id: `error_${Date.now()}`,
          },
        },
        errorCheckpoint,
        {
          ...metadata,
          errorCheckpoint: true,
          errorMessage: error.message,
          savedAt: new Date().toISOString(),
        }
      );
    } catch (saveError) {
      LOG.error('Failed to save error checkpoint', { error: saveError.message });
    }

    // Rethrow the original error
    throw error;
  }
}

module.exports = {
  CapCheckpointSaver,
  saveOnError,
};
