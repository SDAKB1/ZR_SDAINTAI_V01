'use strict';
/**
 * CAP Server Bootstrap
 *
 * Initializes the CAP server with:
 * - CAP Native Event Queues (built-in transactional outbox)
 * - DPP audit logging
 * - REST API endpoints for discovery, brain chat, tenant systems, and design requests
 *
 * NOTE: Custom outbox processor removed. CAP handles event queue processing
 * automatically via cds.outbox.Messages table with built-in retry and DLQ.
 *
 * Per North Star: "use cds logs in the entire repo"
 */
const cds = require('@sap/cds');
const express = require('express');
const path = require('path');
const fs = require('fs');

const LOG = cds.log('server');

// In-memory store for discovery job progress (production would use Redis/HANA)
const discoveryJobs = new Map();
const discoveryClients = new Map();

// Bootstrap sequence
cds.on('bootstrap', async app => {
  LOG.info('Server bootstrap started');

  // Increase JSON body limit for large document uploads
  app.use(express.json({ limit: '25mb' }));

  // Health endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // ==================== SSE ENDPOINT FOR DISCOVERY EVENTS ====================
  // Streams discovery progress events to subscribed clients
  app.get('/api/discovery/events/:jobId', (req, res) => {
    const { jobId } = req.params;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ status: 'connected', jobId })}\n\n`);

    // Register client for this job
    if (!discoveryClients.has(jobId)) {
      discoveryClients.set(jobId, new Set());
    }
    discoveryClients.get(jobId).add(res);

    // Check if job already exists and send current status
    const job = discoveryJobs.get(jobId);
    if (job) {
      res.write(`data: ${JSON.stringify(job)}\n\n`);
    }

    // Cleanup on client disconnect
    req.on('close', () => {
      const clients = discoveryClients.get(jobId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) {
          discoveryClients.delete(jobId);
        }
      }
    });
  });

  // Helper to broadcast discovery progress to all subscribed clients
  function broadcastDiscoveryProgress(jobId, event) {
    discoveryJobs.set(jobId, event);
    const clients = discoveryClients.get(jobId);
    if (clients) {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      clients.forEach((client) => {
        try {
          client.write(data);
        } catch (e) {
          LOG.warn(`[SSE] Failed to write to client for job ${jobId}:`, e.message);
        }
      });
    }
  }

  // Make broadcast function available globally for other modules
  app.locals.broadcastDiscoveryProgress = broadcastDiscoveryProgress;

  // ==================== BRAIN CHAT ENDPOINT ====================
  // Accepts chat messages and returns AI responses from BrainService
  app.post('/api/brain/chat', async (req, res) => {
    const { message, threadId } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    try {
      // Get tenant context if available
      const tenantId = req.headers['x-tenant-id'] || cds.context?.tenant || 'default';

      // Try to call BrainService if available
      const BrainService = await cds.connect.to('BrainService').catch(() => null);

      if (BrainService) {
        // Call the chat action on BrainService
        const result = await BrainService.send('chat', {
          message: message.trim(),
          threadId: threadId || null,
          tenantId,
        });

        return res.json({
          message: result.response || result.message || 'No response',
          threadId: result.threadId || threadId || `thread_${Date.now()}`,
          toolUsage: result.toolUsage || [],
        });
      }

      // Fallback: Mock response when BrainService is not available
      LOG.info(`[Brain Chat] Received: "${message.trim()}" (threadId: ${threadId || 'new'})`);

      const mockResponses = {
        default: `I received your message: "${message.trim()}". The Brain service is currently in mock mode. Once connected to the full LangGraph backend, I'll be able to help you explore PI/PO artifacts, analyze dependencies, and answer questions about your integration landscape.`,
        artifact: `Based on the discovered artifacts, I can see patterns in your PI/PO landscape. The most common integration patterns include IDoc-based master data replication and synchronous RFC calls. Would you like me to analyze specific artifacts or dependencies?`,
        mapping: `Message mappings in your PI/PO system typically transform between different message formats. I can help you understand the transformation logic and suggest equivalent patterns for SAP Integration Suite.`,
        dependency: `Understanding dependencies is crucial for migration planning. I can trace how interfaces, mappings, and channels relate to each other to help identify migration waves.`,
      };

      const lowerMessage = message.toLowerCase();
      let response = mockResponses.default;

      if (lowerMessage.includes('artifact') || lowerMessage.includes('ico') || lowerMessage.includes('interface')) {
        response = mockResponses.artifact;
      } else if (lowerMessage.includes('mapping') || lowerMessage.includes('transform')) {
        response = mockResponses.mapping;
      } else if (lowerMessage.includes('depend') || lowerMessage.includes('relation')) {
        response = mockResponses.dependency;
      }

      return res.json({
        message: response,
        threadId: threadId || `thread_${Date.now()}`,
        toolUsage: [],
      });
    } catch (err) {
      LOG.error('[Brain Chat] Error:', err);
      return res.status(500).json({
        error: err.message || 'Internal server error',
        message: 'Sorry, I encountered an error processing your request.',
      });
    }
  });

  // ==================== TENANT PI/PO SYSTEMS ENDPOINT ====================
  // DEV MODE: Saves PI/PO system configuration for the current tenant
  // In production, use OData endpoint: POST /odata/v4/tenant/savePipoSystem
  app.post('/api/tenant/pipo-systems', async (req, res) => {
    const config = req.body;

    if (!config || !config.systemName) {
      return res.status(400).json({ error: 'System name is required' });
    }

    try {
      const tenantId = req.headers['x-tenant-id'] || cds.context?.tenant || 'default';

      // Try to call the real TenantService first
      try {
        const TenantService = await cds.connect.to('TenantService');
        if (TenantService) {
          const result = await TenantService.send('savePipoSystem', {
            systemConfig: config,
          });

          LOG.info('[PI/PO Config] System saved via TenantService', {
            systemName: config.systemName,
            tenantId,
          });

          return res.status(201).json(result);
        }
      } catch (serviceError) {
        LOG.warn('[PI/PO Config] TenantService not available, using mock response', {
          error: serviceError.message,
        });
      }

      // Fallback to mock response for development
      const systemId = `${tenantId}_${config.systemName}_${Date.now()}`;
      LOG.info(`[PI/PO Config] Mock: Saved system ${config.systemName} for tenant ${tenantId}`);

      return res.status(201).json({
        id: systemId,
        systemId: systemId,
        ...config,
        tenantId,
        createdAt: new Date().toISOString(),
        _mock: true,
        _note: 'Mock response - TenantService not available. Use POST /odata/v4/tenant/savePipoSystem in production.',
      });
    } catch (err) {
      LOG.error('[PI/PO Config] Error:', err);
      return res.status(500).json({ error: err.message || 'Failed to save configuration' });
    }
  });

  // ==================== TEST CONNECTION ENDPOINT ====================
  // DEV MODE: Tests PI/PO system connection
  // In production, use OData endpoint: POST /odata/v4/tenant/testConnection
  app.post('/api/tenant/test-connection', async (req, res) => {
    const { systemId } = req.body;

    if (!systemId) {
      return res.status(400).json({ error: 'System ID is required' });
    }

    try {
      // Try to call the real TenantService first
      try {
        const TenantService = await cds.connect.to('TenantService');
        if (TenantService) {
          const result = await TenantService.send('testConnection', { systemId });

          LOG.info('[Connection Test] Tested via TenantService', { systemId });

          return res.json(result);
        }
      } catch (serviceError) {
        LOG.warn('[Connection Test] TenantService not available, using mock response', {
          error: serviceError.message,
        });
      }

      // Fallback to mock connection test for development
      LOG.info(`[Connection Test] Mock: Testing system ${systemId}`);

      // Simulate connection test delay
      await new Promise((resolve) => setTimeout(resolve, 500));

      return res.json({
        success: true,
        message: 'Connection successful (mock)',
        systemId,
        testedAt: new Date().toISOString(),
        _mock: true,
        _note: 'Mock response - TenantService not available. Use POST /odata/v4/tenant/testConnection in production.',
      });
    } catch (err) {
      LOG.error('[Connection Test] Error:', err);
      return res.status(500).json({
        success: false,
        error: err.message || 'Connection test failed',
      });
    }
  });

  // ==================== TRIGGER DISCOVERY ENDPOINT ====================
  // DEV MODE: Triggers PI/PO artifact discovery
  // In production, use OData endpoint: POST /odata/v4/discovery/startDiscovery
  app.post('/api/pipo/systems/:systemId/discover', async (req, res) => {
    const { systemId } = req.params;

    if (!systemId) {
      return res.status(400).json({ error: 'System ID is required' });
    }

    try {
      const tenantId = req.headers['x-tenant-id'] || cds.context?.tenant || 'default';

      // Try to call the real DiscoveryService first
      try {
        const DiscoveryService = await cds.connect.to('DiscoveryService');
        if (DiscoveryService) {
          const result = await DiscoveryService.send('startDiscovery', {
            systemId,
            includeInactive: req.body?.includeInactive || false,
            includeHistory: req.body?.includeHistory || false,
          });

          LOG.info('[Discovery] Started via DiscoveryService', { systemId, jobId: result.jobId });

          return res.status(202).json(result);
        }
      } catch (serviceError) {
        LOG.warn('[Discovery] DiscoveryService not available, using mock process', {
          error: serviceError.message,
        });
      }

      // Fallback to mock discovery for development
      const jobId = `discovery_${systemId}_${Date.now()}`;

      // Initialize job state
      const initialState = {
        jobId,
        systemId,
        tenantId,
        status: 'started',
        progress: 0,
        phase: 'Initializing',
        artifactsFound: 0,
        startedAt: new Date().toISOString(),
        _mock: true,
        _note:
          'Mock discovery - DiscoveryService not available. Use POST /odata/v4/discovery/startDiscovery in production.',
      };

      discoveryJobs.set(jobId, initialState);

      // Start mock discovery process
      simulateDiscoveryProcess(jobId, systemId, app.locals.broadcastDiscoveryProgress);

      return res.status(202).json({
        jobId,
        systemId,
        status: 'started',
        message: 'Discovery job started (mock)',
        _mock: true,
      });
    } catch (err) {
      LOG.error('[Discovery] Error starting job:', err);
      return res.status(500).json({ error: err.message || 'Failed to start discovery' });
    }
  });

  // ==================== GET DISCOVERY JOB STATUS ====================
  app.get('/api/pipo/jobs/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = discoveryJobs.get(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.json(job);
  });

  // ==================== DESIGN REQUESTS ENDPOINTS ====================
  // Design-request intake for the UX/UI Design Studio (btp_cockpit_UXUI.html).
  //
  // Every submission is written to a local JSON file for instant UI feedback
  // (list her own history, works even if the GitHub step below fails or isn't
  // configured), AND — the durable path — committed straight into
  // docs/ux-change-requests/ in the real GitHub repo via the Contents API, so
  // the request survives this container's next restart/redeploy without
  // needing a human to manually archive it first.
  const designRequestsFile = path.join(__dirname, '..', 'data', 'design-requests.json');

  function readDesignRequests() {
    try {
      return JSON.parse(fs.readFileSync(designRequestsFile, 'utf8'));
    } catch (e) {
      return [];
    }
  }

  function writeDesignRequests(list) {
    fs.mkdirSync(path.dirname(designRequestsFile), { recursive: true });
    fs.writeFileSync(designRequestsFile, JSON.stringify(list, null, 2));
  }

  function buildDesignRequestMarkdown(entry) {
    return (
      `# UX Change Request — ${entry.id}\n\n` +
      `- **Requester:** ${entry.requester}\n` +
      `- **Submitted:** ${entry.submittedAt} (via btp_cockpit_UXUI.html)\n` +
      `- **Status:** Pending Review\n\n` +
      `## Request\n\n> ${entry.message.replace(/\n/g, '\n> ')}\n\n` +
      `## SDA Analysis\n\n_Pending — run CHECKUX to analyze and propose a solution._\n\n` +
      `## Decision\n\n- [ ] Approved by Ayman\n- [ ] Rejected by Ayman\n- [ ] Needs clarification from the requester\n`
    );
  }

  async function commitDesignRequestToGitHub(entry) {
    const token = process.env.GITHUB_PAT;
    if (!token) throw new Error('GITHUB_PAT not configured — saved locally only, not committed to git');
    const owner = process.env.GITHUB_REPO_OWNER || 'SDAKB1';
    const repo = process.env.GITHUB_REPO_NAME || 'SDAINTAI';
    const branch = process.env.GITHUB_REPO_BRANCH || 'main';
    const dateStr = entry.submittedAt.slice(0, 10);
    const filePath = `docs/ux-change-requests/${dateStr}-${entry.id}.md`;
    const content = buildDesignRequestMarkdown(entry);

    const fetchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'sdaintai-design-studio',
      },
      body: JSON.stringify({
        message: `UX change request ${entry.id} from ${entry.requester}: ${entry.message.slice(0, 72)}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
      }),
    });
    if (!fetchRes.ok) {
      const errText = await fetchRes.text();
      throw new Error(`GitHub API ${fetchRes.status}: ${errText.slice(0, 300)}`);
    }
  }

  app.post('/api/design-requests', async (req, res) => {
    const message = String((req.body && req.body.message) || '').trim();
    if (!message) return res.status(400).json({ error: 'message is required' });
    const requester = String((req.body && req.body.requester) || 'UX Reviewer')
      .trim()
      .slice(0, 80);
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      requester,
      message: message.slice(0, 4000),
      submittedAt: new Date().toISOString(),
      status: 'submitted',
      gitCommitted: false,
      gitError: null,
    };
    try {
      await commitDesignRequestToGitHub(entry);
      entry.gitCommitted = true;
    } catch (e) {
      entry.gitError = e.message;
      LOG.warn('[design-requests] GitHub commit skipped/failed:', e.message);
    }
    const list = readDesignRequests();
    list.push(entry);
    writeDesignRequests(list);
    res.status(201).json(entry);
  });

  app.get('/api/design-requests', (req, res) => {
    res.json(readDesignRequests());
  });

  // Serves the frontend (btp_cockpit.html etc.) from this same app/origin,
  // so its relative fetch('/odata/v4/documents/...') calls reach this backend
  // instead of 404ing against a separate static-only host.
  app.use(express.static(path.join(__dirname, '..', 'app', 'aiconx', 'webapp')));
});

// ==================== MOCK DISCOVERY PROCESS ====================
// Simulates the PI/PO discovery process with progress updates
// In production, this would be handled by DiscoveryService with real PI/PO API calls
function simulateDiscoveryProcess(jobId, systemId, broadcastFn) {
  const phases = [
    { name: 'Connecting to Integration Directory', duration: 800, progress: 10 },
    { name: 'Querying ICO configurations', duration: 1200, progress: 25 },
    { name: 'Reading channel adapters', duration: 1000, progress: 40 },
    { name: 'Fetching message mappings from ESR', duration: 1500, progress: 55 },
    { name: 'Resolving value mappings', duration: 800, progress: 70 },
    { name: 'Analyzing dependencies', duration: 1200, progress: 85 },
    { name: 'Normalizing and validating artifacts', duration: 600, progress: 95 },
    { name: 'Finalizing discovery', duration: 400, progress: 100 },
  ];

  // Mock artifacts that would be discovered
  const mockArtifacts = [
    { name: 'MATMAS_Material_Master', type: 'ICO' },
    { name: 'DEBMAS_Customer_Master', type: 'ICO' },
    { name: 'ORDERS_Sales_Order', type: 'ICO' },
    { name: 'DESADV_Delivery', type: 'ICO' },
    { name: 'INVOIC_Invoice', type: 'ICO' },
    { name: 'FIDOC_FI_Document', type: 'ICO' },
    { name: 'MATMAS07_to_MM01', type: 'MessageMapping' },
    { name: 'DEBMAS08_to_BP', type: 'MessageMapping' },
    { name: 'ORDERS05_to_VA01', type: 'MessageMapping' },
    { name: 'SalesOrg_ValueMap', type: 'ValueMapping' },
    { name: 'GLAccount_ValueMap', type: 'ValueMapping' },
    { name: 'MATMAS_Sender_File', type: 'Sender' },
    { name: 'MATMAS_Receiver_IDoc', type: 'Receiver' },
    { name: 'DEBMAS_Sender_IDoc', type: 'Sender' },
    { name: 'ORDERS_Sender_HTTP', type: 'Sender' },
  ];

  let currentPhaseIndex = 0;
  let artifactsFound = 0;

  function processNextPhase() {
    if (currentPhaseIndex >= phases.length) {
      // Discovery complete
      broadcastFn(jobId, {
        jobId,
        systemId,
        status: 'completed',
        progress: 100,
        phase: 'Complete',
        artifactsCount: mockArtifacts.length,
        artifacts: mockArtifacts,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    const phase = phases[currentPhaseIndex];

    // Simulate finding artifacts during certain phases
    if (phase.progress >= 40 && phase.progress < 95) {
      artifactsFound = Math.min(mockArtifacts.length, Math.floor(mockArtifacts.length * (phase.progress / 100) * 1.2));
    } else if (phase.progress >= 95) {
      artifactsFound = mockArtifacts.length;
    }

    broadcastFn(jobId, {
      jobId,
      systemId,
      status: 'in_progress',
      progress: phase.progress,
      phase: phase.name,
      currentPhase: phase.name,
      message: `${phase.name}...`,
      artifactsFound,
    });

    currentPhaseIndex++;
    setTimeout(processNextPhase, phase.duration);
  }

  // Start the discovery process
  setTimeout(processNextPhase, 500);
}

// Server served - CAP native event queues are auto-started
cds.on('served', async () => {
  LOG.info('All services served');

  // CAP native event queues are enabled by default
  // Events queued via cds.queued(srv).emit() are automatically processed
  // by the built-in background runner with retry and dead letter support

  // Log queue configuration for observability
  const queueConfig = cds.env.requires?.outbox || {};
  LOG.info('CAP Event Queue active', {
    kind: queueConfig.kind || 'persistent-outbox',
    maxAttempts: queueConfig.maxAttempts || 10,
    chunkSize: queueConfig.chunkSize || 100,
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  LOG.info('SIGTERM received, shutting down gracefully');
  // CAP handles event queue cleanup automatically
  process.exit(0);
});

module.exports = cds.server;
