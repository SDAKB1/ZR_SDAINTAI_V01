'use strict';

/**
 * SSE Progress Stream Handler
 *
 * Provides Server-Sent Events (SSE) endpoint for real-time discovery progress updates.
 * Clients subscribe to job progress via EventSource API.
 *
 * Features:
 * - Per-job subscription management
 * - Heartbeat mechanism to keep connections alive
 * - Automatic cleanup on client disconnect
 * - Tenant isolation via JWT validation
 *
 * Usage:
 *   GET /api/discovery/progress/{jobId}/stream
 *   Headers: Accept: text/event-stream, Authorization: Bearer <jwt>
 *
 * @module sse/progressStream
 */

const cds = require('@sap/cds');
const LOG = cds.log('sse-progress');

// Active SSE connections by job ID
const connections = new Map();

// Heartbeat interval (30 seconds)
const HEARTBEAT_INTERVAL = 30000;

// Connection timeout (5 minutes of inactivity)
const CONNECTION_TIMEOUT = 300000;

/**
 * Initialize SSE handler for Express app
 * @param {Express.Application} app - Express application
 */
function initializeSSE(app) {
  // SSE endpoint for discovery progress
  app.get('/api/discovery/progress/:jobId/stream', async (req, res) => {
    const { jobId } = req.params;

    // Validate authentication
    const tenantId = req.user?.tenant || 'default';
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    LOG.info('SSE connection requested', { jobId, tenantId });

    // Validate job exists and belongs to tenant
    const { DiscoveryJob } = cds.entities('tenant');
    const job = await SELECT.one
      .from(DiscoveryJob)
      .where({ ID: jobId, tenantId });

    if (!job) {
      return res.status(404).json({ error: 'Discovery job not found' });
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });

    // Send initial connection event
    res.write(`event: connected\n`);
    res.write(`data: ${JSON.stringify({ jobId, status: job.status, timestamp: new Date().toISOString() })}\n\n`);

    // Register connection
    const connectionId = `${jobId}_${Date.now()}`;
    const connection = {
      id: connectionId,
      jobId,
      tenantId,
      response: res,
      lastActivity: Date.now(),
    };

    if (!connections.has(jobId)) {
      connections.set(jobId, new Map());
    }
    connections.get(jobId).set(connectionId, connection);

    LOG.debug('SSE connection established', { connectionId, jobId, tenantId });

    // Send current job status
    sendJobStatus(connection, job);

    // Setup heartbeat
    const heartbeatId = setInterval(() => {
      try {
        res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
        connection.lastActivity = Date.now();
      } catch (error) {
        clearInterval(heartbeatId);
        removeConnection(jobId, connectionId);
      }
    }, HEARTBEAT_INTERVAL);

    // Handle client disconnect
    req.on('close', () => {
      LOG.debug('SSE connection closed', { connectionId, jobId });
      clearInterval(heartbeatId);
      removeConnection(jobId, connectionId);
    });

    // Handle errors
    req.on('error', (error) => {
      LOG.warn('SSE connection error', { connectionId, jobId, error: error.message });
      clearInterval(heartbeatId);
      removeConnection(jobId, connectionId);
    });
  });

  // Endpoint to list active connections (admin/debug)
  app.get('/api/discovery/progress/connections', (req, res) => {
    const stats = {
      totalJobs: connections.size,
      connections: [],
    };

    connections.forEach((jobConnections, jobId) => {
      stats.connections.push({
        jobId,
        connectionCount: jobConnections.size,
      });
    });

    res.json(stats);
  });

  LOG.info('SSE progress stream handler initialized');
}

/**
 * Send job status to a connection
 * @param {object} connection - SSE connection
 * @param {object} job - Discovery job record
 */
function sendJobStatus(connection, job) {
  const data = {
    jobId: job.ID,
    status: job.status,
    phase: job.currentPhase,
    phaseName: job.currentPhaseName,
    progressPercent: job.progressPercent,
    artifactsFound: job.artifactsFound,
    artifactsNew: job.artifactsNew,
    artifactsUpdated: job.artifactsUpdated,
    errorsCount: job.errorsCount,
    timestamp: new Date().toISOString(),
  };

  try {
    connection.response.write(`event: status\n`);
    connection.response.write(`data: ${JSON.stringify(data)}\n\n`);
    connection.lastActivity = Date.now();
  } catch (error) {
    LOG.warn('Failed to send status', { connectionId: connection.id, error: error.message });
  }
}

/**
 * Broadcast progress event to all connections for a job
 * @param {string} jobId - Discovery job ID
 * @param {object} event - Progress event data
 */
function broadcastProgress(jobId, event) {
  const jobConnections = connections.get(jobId);
  if (!jobConnections || jobConnections.size === 0) {
    return;
  }

  const eventData = JSON.stringify(event);
  const eventType = event.type || 'progress';

  jobConnections.forEach((connection, connectionId) => {
    try {
      connection.response.write(`event: ${eventType}\n`);
      connection.response.write(`data: ${eventData}\n\n`);
      connection.lastActivity = Date.now();
    } catch (error) {
      LOG.warn('Failed to broadcast to connection', { connectionId, error: error.message });
      removeConnection(jobId, connectionId);
    }
  });

  LOG.debug('Progress broadcast', { jobId, connectionCount: jobConnections.size, eventType });
}

/**
 * Remove a connection from tracking
 * @param {string} jobId - Discovery job ID
 * @param {string} connectionId - Connection ID
 */
function removeConnection(jobId, connectionId) {
  const jobConnections = connections.get(jobId);
  if (jobConnections) {
    jobConnections.delete(connectionId);
    if (jobConnections.size === 0) {
      connections.delete(jobId);
    }
  }
}

/**
 * Close all connections for a job
 * @param {string} jobId - Discovery job ID
 */
function closeJobConnections(jobId) {
  const jobConnections = connections.get(jobId);
  if (!jobConnections) return;

  jobConnections.forEach((connection, connectionId) => {
    try {
      connection.response.write(`event: close\n`);
      connection.response.write(`data: ${JSON.stringify({ reason: 'job_complete' })}\n\n`);
      connection.response.end();
    } catch (error) {
      // Ignore errors during close
    }
  });

  connections.delete(jobId);
  LOG.debug('Job connections closed', { jobId });
}

/**
 * Cleanup stale connections
 */
function cleanupStaleConnections() {
  const now = Date.now();

  connections.forEach((jobConnections, jobId) => {
    jobConnections.forEach((connection, connectionId) => {
      if (now - connection.lastActivity > CONNECTION_TIMEOUT) {
        LOG.debug('Removing stale connection', { connectionId, jobId });
        try {
          connection.response.end();
        } catch (error) {
          // Ignore
        }
        removeConnection(jobId, connectionId);
      }
    });
  });
}

// Cleanup interval (every minute)
setInterval(cleanupStaleConnections, 60000);

/**
 * Event handler for CDS DiscoveryProgress events
 * Bridges CDS events to SSE broadcasts
 */
async function handleDiscoveryProgressEvent(event) {
  const { jobId, ...data } = event;
  if (jobId) {
    broadcastProgress(jobId, data);
  }
}

/**
 * Event handler for CDS DiscoveryComplete events
 */
async function handleDiscoveryCompleteEvent(event) {
  const { jobId, ...data } = event;
  if (jobId) {
    broadcastProgress(jobId, { type: 'complete', ...data });
    // Close connections after a short delay to ensure clients receive the event
    setTimeout(() => closeJobConnections(jobId), 5000);
  }
}

module.exports = {
  initializeSSE,
  broadcastProgress,
  closeJobConnections,
  handleDiscoveryProgressEvent,
  handleDiscoveryCompleteEvent,
};
