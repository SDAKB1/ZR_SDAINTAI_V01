'use strict';
/**
 * @deprecated DEPRECATED - CAP Native Event Queues Now Used
 *
 * This custom outbox processor has been replaced by CAP's built-in
 * transactional event queues. The functionality is now provided by:
 *
 * 1. cds.queued(srv).emit() - Queue events in same transaction
 * 2. cds.outbox.Messages - Built-in persistent queue table
 * 3. CAP background runner - Automatic retry and dead letter queue
 *
 * Migration notes:
 * - OutboxEvent entity removed from tenant-service.cds
 * - Events are now emitted via: cds.queued(this).emit('EventName', payload)
 * - Event handlers registered via: this.on('EventName', handler)
 * - Configuration via cds.requires.queue in package.json
 *
 * See CAP documentation: https://cap.cloud.sap/docs/node.js/event-queues
 *
 * This file is kept for reference only and can be safely deleted.
 */
const cds = require('@sap/cds');

const LOG = cds.log('outbox-deprecated');

LOG.warn('outbox-processor.js is deprecated - CAP native event queues are now used');

// Stub exports for backward compatibility during transition
module.exports = {
  on: () => LOG.warn('Custom outbox deprecated - use CAP native event queues'),
  start: () => LOG.warn('Custom outbox deprecated - CAP auto-starts event queue'),
  stop: () => LOG.warn('Custom outbox deprecated - CAP handles shutdown')
};
