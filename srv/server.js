'use strict';
/**
 * CAP Server Bootstrap
 *
 * Initializes the CAP server with:
 * - CAP Native Event Queues (built-in transactional outbox)
 * - DPP audit logging
 *
 * NOTE: Custom outbox processor removed. CAP handles event queue processing
 * automatically via cds.outbox.Messages table with built-in retry and DLQ.
 *
 * Per North Star: "use cds logs in the entire repo"
 */
const cds = require('@sap/cds');

const LOG = cds.log('server');

// Bootstrap sequence
cds.on('bootstrap', async app => {
  LOG.info('Server bootstrap started');

  // Health endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
  });
});

// Server served - CAP native event queues are auto-started
cds.on('served', async () => {
  LOG.info('All services served');

  // CAP native event queues are enabled by default
  // Events queued via cds.queued(srv).emit() are automatically processed
  // by the built-in background runner with retry and dead letter support

  // Log queue configuration for observability
  const queueConfig = cds.env.requires?.queue || {};
  LOG.info('CAP Event Queue active', {
    maxAttempts: queueConfig.maxAttempts || 10,
    timeout: queueConfig.timeout || '1h',
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  LOG.info('SIGTERM received, shutting down gracefully');
  // CAP handles event queue cleanup automatically
  process.exit(0);
});

module.exports = cds.server;
