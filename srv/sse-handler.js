'use strict';
/**
 * Server-Sent Events (SSE) Handler for Discovery Progress
 *
 * Provides real-time progress streaming for discovery jobs.
 * Alternative to Event Mesh polling for UI responsiveness.
 */
const cds = require('@sap/cds');
const { SELECT } = cds;

// CDS Logger - per North Star "use cds logs in the entire repo"
const LOG = cds.log('sse-handler');

// Active SSE connections per tenant/job
const connections = new Map();

/**
 * Register SSE endpoint with Express app.
 * Call this from server.js: require('./sse-handler').register(app)
 */
function register(app) {
  // SSE endpoint for discovery progress
  app.get('/sse/discovery/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const tenantId = req.user?.tenant || 'default';

    LOG.info('Client connected for job', { jobId, tenantId });

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Create connection key
    const connectionKey = `${tenantId}:${jobId}`;

    // Store connection
    if (!connections.has(connectionKey)) {
      connections.set(connectionKey, new Set());
    }
    connections.get(connectionKey).add(res);

    // Send initial connection event
    sendEvent(res, 'connected', { jobId, timestamp: new Date().toISOString() });

    // Send current job status immediately
    try {
      const status = await getJobStatus(jobId, tenantId);
      if (status) {
        sendEvent(res, 'status', status);
      }
    } catch (error) {
      sendEvent(res, 'error', { message: error.message });
    }

    // Keep-alive ping every 30 seconds
    const pingInterval = setInterval(() => {
      if (!res.writableEnded) {
        sendEvent(res, 'ping', { timestamp: new Date().toISOString() });
      }
    }, 30000);

    // Handle client disconnect
    req.on('close', () => {
      LOG.debug('Client disconnected', { jobId });
      clearInterval(pingInterval);
      const conns = connections.get(connectionKey);
      if (conns) {
        conns.delete(res);
        if (conns.size === 0) {
          connections.delete(connectionKey);
        }
      }
    });
  });

  // SSE endpoint for all tenant discovery jobs
  app.get('/sse/discovery', async (req, res) => {
    const tenantId = req.user?.tenant || 'default';

    LOG.info('Client connected for all jobs', { tenantId });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const connectionKey = `${tenantId}:*`;

    if (!connections.has(connectionKey)) {
      connections.set(connectionKey, new Set());
    }
    connections.get(connectionKey).add(res);

    sendEvent(res, 'connected', { tenantId, timestamp: new Date().toISOString() });

    // Send current active jobs
    try {
      const activeJobs = await getActiveJobs(tenantId);
      sendEvent(res, 'active-jobs', { jobs: activeJobs });
    } catch (error) {
      sendEvent(res, 'error', { message: error.message });
    }

    const pingInterval = setInterval(() => {
      if (!res.writableEnded) {
        sendEvent(res, 'ping', { timestamp: new Date().toISOString() });
      }
    }, 30000);

    req.on('close', () => {
      LOG.debug('Client disconnected for all jobs');
      clearInterval(pingInterval);
      const conns = connections.get(connectionKey);
      if (conns) {
        conns.delete(res);
        if (conns.size === 0) {
          connections.delete(connectionKey);
        }
      }
    });
  });

  LOG.info('Discovery progress SSE endpoints registered');
}

/**
 * Send an SSE event to a response stream.
 */
function sendEvent(res, event, data) {
  if (res.writableEnded) return;

  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (error) {
    LOG.error('Error sending SSE event', { error: error.message });
  }
}

/**
 * Broadcast progress update to all connected clients for a job.
 */
function broadcastProgress(tenantId, jobId, progress) {
  // Send to specific job subscribers
  const jobKey = `${tenantId}:${jobId}`;
  const jobConns = connections.get(jobKey);
  if (jobConns) {
    for (const res of jobConns) {
      sendEvent(res, 'progress', progress);
    }
  }

  // Send to all-jobs subscribers for this tenant
  const allKey = `${tenantId}:*`;
  const allConns = connections.get(allKey);
  if (allConns) {
    for (const res of allConns) {
      sendEvent(res, 'progress', { jobId, ...progress });
    }
  }
}

/**
 * Broadcast job completion to all connected clients.
 */
function broadcastCompletion(tenantId, jobId, result) {
  const progress = {
    jobId,
    status: result.status,
    progressPercent: 100,
    artifactsFound: result.artifactsFound,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
  };

  const jobKey = `${tenantId}:${jobId}`;
  const jobConns = connections.get(jobKey);
  if (jobConns) {
    for (const res of jobConns) {
      sendEvent(res, 'completed', progress);
    }
  }

  const allKey = `${tenantId}:*`;
  const allConns = connections.get(allKey);
  if (allConns) {
    for (const res of allConns) {
      sendEvent(res, 'completed', progress);
    }
  }
}

/**
 * Broadcast job error to all connected clients.
 */
function broadcastError(tenantId, jobId, error) {
  const errorData = {
    jobId,
    status: 'failed',
    error: error.message,
    timestamp: new Date().toISOString(),
  };

  const jobKey = `${tenantId}:${jobId}`;
  const jobConns = connections.get(jobKey);
  if (jobConns) {
    for (const res of jobConns) {
      sendEvent(res, 'error', errorData);
    }
  }

  const allKey = `${tenantId}:*`;
  const allConns = connections.get(allKey);
  if (allConns) {
    for (const res of allConns) {
      sendEvent(res, 'error', errorData);
    }
  }
}

/**
 * Get current job status from database.
 */
async function getJobStatus(jobId, tenantId) {
  const db = await cds.connect.to('db');
  // BUG-M2 fix: Defensive check for cds.entities availability
  const entities = cds.entities('tenant') || cds.entities;
  const DiscoveryJob = entities?.DiscoveryJob;
  if (!DiscoveryJob) {
    LOG.warn('DiscoveryJob entity not available');
    return null;
  }

  const job = await db.run(
    SELECT.one
      .from(DiscoveryJob)
      .columns(
        'ID',
        'status',
        'currentPhase',
        'currentPhaseName',
        'progressPercent',
        'artifactsFound',
        'errorsCount',
        'startedAt',
        'completedAt'
      )
      .where({ ID: jobId, tenantId })
  );

  if (!job) return null;

  return {
    jobId: job.ID,
    status: job.status,
    phase: job.currentPhase,
    phaseName: job.currentPhaseName,
    progressPercent: job.progressPercent,
    artifactsFound: job.artifactsFound,
    errorsCount: job.errorsCount,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

/**
 * Get all active jobs for a tenant.
 */
async function getActiveJobs(tenantId) {
  const db = await cds.connect.to('db');
  // BUG-M2 fix: Defensive check for cds.entities availability
  const entities = cds.entities('tenant') || cds.entities;
  const DiscoveryJob = entities?.DiscoveryJob;
  if (!DiscoveryJob) {
    LOG.warn('DiscoveryJob entity not available');
    return [];
  }

  const jobs = await db.run(
    SELECT.from(DiscoveryJob)
      .columns(
        'ID',
        'status',
        'currentPhase',
        'currentPhaseName',
        'progressPercent',
        'artifactsFound',
        'startedAt',
        'system_ID'
      )
      .where({ tenantId, status: { in: ['pending', 'running'] } })
      .orderBy('startedAt desc')
  );

  return jobs.map(job => ({
    jobId: job.ID,
    systemId: job.system_ID,
    status: job.status,
    phase: job.currentPhase,
    phaseName: job.currentPhaseName,
    progressPercent: job.progressPercent,
    artifactsFound: job.artifactsFound,
    startedAt: job.startedAt,
  }));
}

/**
 * Get connection count for monitoring.
 */
function getConnectionCount() {
  let count = 0;
  for (const conns of connections.values()) {
    count += conns.size;
  }
  return count;
}

module.exports = {
  register,
  broadcastProgress,
  broadcastCompletion,
  broadcastError,
  getConnectionCount,
};
