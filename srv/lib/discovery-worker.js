'use strict';
/**
 * Discovery Worker
 *
 * Processes DiscoveryRequested events from CAP native event queues.
 * Runs PI/PO discovery using the appropriate adapter (Mock or Live).
 *
 * Refactored to work with CAP native transactional outbox.
 * Events are received from cds.outbox.Messages queue.
 *
 * Per North Star Demo Implementation Plan
 */
const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');

const LOG = cds.log('discovery-worker');

// Import adapters
const { MockPiPoAdapter } = require('./mock-pipo-adapter');
// const { LivePiPoAdapter } = require('./live-pipo-adapter'); // TODO: implement

/**
 * Get the appropriate adapter for the tenant
 */
function getAdapter(tenantId, sourceMode, destinationName) {
  if (sourceMode === 'MOCK') {
    return new MockPiPoAdapter(tenantId);
  }
  // TODO: Implement LivePiPoAdapter
  // return new LivePiPoAdapter(tenantId, destinationName);
  throw new Error('LIVE mode not yet implemented');
}

/**
 * Process a DiscoveryRequested event from CAP native event queue
 *
 * @param {Object} payload - Event payload from queue
 * @param {Object} context - Event context with tenantId
 */
async function processDiscoveryEvent(payload, context) {
  const { tenantId, sourceMode, destinationName, runId, triggeredBy } = payload;

  LOG.info('Processing discovery event', { tenantId, sourceMode, triggeredBy });

  const db = await cds.connect.to('db');
  const { DiscoveryRun } = cds.entities('TenantService');
  const { Artifact } = cds.entities('tenant');

  // Get or create discovery run
  let run;
  if (runId) {
    run = await db.run(SELECT.one.from(DiscoveryRun).where({ ID: runId }));
  }

  if (!run) {
    // Create new run
    const newRunId = uuidv4();
    run = {
      ID: newRunId,
      tenantId,
      status: 'RUNNING',
      sourceMode,
      correlationId: 'disc-' + newRunId.substring(0, 8),
      startedAt: new Date().toISOString()
    };
    await db.run(INSERT.into(DiscoveryRun).entries(run));
    LOG.info('Created new discovery run', { runId: run.ID, correlationId: run.correlationId });
  } else {
    // Update existing run
    await db.run(
      UPDATE(DiscoveryRun)
        .set({ status: 'RUNNING', startedAt: new Date().toISOString() })
        .where({ ID: run.ID })
    );
    LOG.info('Updating existing discovery run', { runId: run.ID });
  }

  try {
    // Get adapter
    const adapter = getAdapter(tenantId, sourceMode, destinationName);

    // Test connection first
    LOG.info('Testing PI/PO connection', { tenantId, sourceMode });
    const connTest = await adapter.testConnection();

    if (!connTest.success) {
      throw new Error('Connection test failed: ' + connTest.message);
    }

    // Run discovery
    LOG.info('Starting artifact discovery', { tenantId });
    const artifacts = await adapter.getAllArtifacts();

    LOG.info('Discovered artifacts', { tenantId, count: artifacts.length });

    // Upsert artifacts into tenant database
    let newCount = 0;
    let updatedCount = 0;

    for (const artifact of artifacts) {
      const existingArtifact = await db.run(
        SELECT.one.from(Artifact).where({
          tenantId,
          artifactType: artifact.artifactType,
          objectId: artifact.objectId
        })
      );

      const now = new Date().toISOString();

      if (existingArtifact) {
        // Update existing
        await db.run(
          UPDATE(Artifact)
            .set({
              name: artifact.name,
              description: artifact.description,
              direction: artifact.direction,
              adapterType: artifact.adapterType,
              senderComponent: artifact.senderComponent,
              receiverComponent: artifact.receiverComponent,
              namespace: artifact.namespace,
              piStatus: artifact.piStatus,
              rawDefinition: artifact.rawDefinition,
              modifiedAt: now
            })
            .where({ ID: existingArtifact.ID })
        );
        updatedCount++;
      } else {
        // Insert new
        await db.run(
          INSERT.into(Artifact).entries({
            ID: uuidv4(),
            tenantId,
            artifactType: artifact.artifactType,
            objectId: artifact.objectId,
            artifactKey: artifact.objectId,
            name: artifact.name,
            description: artifact.description,
            direction: artifact.direction,
            adapterType: artifact.adapterType,
            senderComponent: artifact.senderComponent,
            senderInterface: artifact.senderInterface,
            receiverComponent: artifact.receiverComponent,
            receiverInterface: artifact.receiverInterface,
            namespace: artifact.namespace,
            piStatus: artifact.piStatus,
            rawDefinition: artifact.rawDefinition,
            rawFormat: artifact.rawFormat || 'json',
            migrationStatus: 'discovered',
            createdAt: now,
            modifiedAt: now
          })
        );
        newCount++;
      }
    }

    // Update run as completed
    await db.run(
      UPDATE(DiscoveryRun)
        .set({
          status: 'COMPLETED',
          artifactsFound: artifacts.length,
          artifactsNew: newCount,
          artifactsUpdated: updatedCount,
          completedAt: new Date().toISOString()
        })
        .where({ ID: run.ID })
    );

    LOG.info('Discovery completed', {
      tenantId,
      runId: run.ID,
      found: artifacts.length,
      new: newCount,
      updated: updatedCount
    });

  } catch (error) {
    LOG.error('Discovery failed', { tenantId, runId: run.ID, error: error.message });

    // Determine failure type
    const isConnectivityError = error.message.includes('Connection') ||
      error.message.includes('LIVE mode');

    await db.run(
      UPDATE(DiscoveryRun)
        .set({
          status: isConnectivityError ? 'FAILED_CONNECTIVITY' : 'FAILED',
          errorMessage: error.message,
          errorsCount: 1,
          completedAt: new Date().toISOString()
        })
        .where({ ID: run.ID })
    );

    // Throw to let CAP event queue handle retry
    throw error;
  }
}

module.exports = { processDiscoveryEvent };
