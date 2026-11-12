using { cuid, managed } from '@sap/cds/common';
namespace checkpoint;

// -------------------------------------------------------------------------------
// LANGGRAPH CHECKPOINT - Durable state checkpoints for AI workflow resumption
// -------------------------------------------------------------------------------

/**
 * Stores LangGraph workflow checkpoints for resumable AI operations.
 * Enables recovery from timeouts, errors, and system restarts.
 * Each checkpoint represents a state snapshot that can be restored.
 */
@assert.unique: { checkpoint_lookup: [tenantId, threadId, checkpointId] }
entity LangGraphCheckpoint : cuid, managed {
  tenantId        : String(36) not null;  // Tenant identifier for isolation
  threadId        : String(128) not null; // Conversation/workflow thread identifier
  checkpointId    : String(128) not null; // Unique checkpoint identifier within thread
  parentId        : String(128);          // Parent checkpoint for branching/history traversal
  state           : LargeString;          // JSON serialized workflow state
  metadata        : LargeString;          // JSON metadata (graph name, step, context, etc.)
  createdAt       : Timestamp default $now; // Checkpoint creation timestamp
}

// -------------------------------------------------------------------------------
// LANGGRAPH MESSAGE - Conversation message history for AI workflows
// -------------------------------------------------------------------------------

/**
 * Stores conversation messages for LangGraph workflows.
 * Maintains full message history for context and audit.
 * Supports tool calls tracking for AI agent interactions.
 */
@assert.unique: { message_lookup: [tenantId, threadId, messageId] }
entity LangGraphMessage : cuid, managed {
  tenantId        : String(36) not null;  // Tenant identifier for isolation
  threadId        : String(128) not null; // Conversation/workflow thread identifier
  messageId       : String(128) not null; // Unique message identifier
  role            : String(20);           // user | assistant | system | tool
  content         : LargeString;          // Message content (text or JSON for structured)
  toolCalls       : LargeString;          // JSON array of tool calls and results
  createdAt       : Timestamp default $now; // Message creation timestamp
}
