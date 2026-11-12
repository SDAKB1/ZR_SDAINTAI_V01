'use strict';
/**
 * Tenant Onboarding Service Implementation
 *
 * Implements the North Star multitenancy flow:
 * 1. Profile submission after subscription
 * 2. CAP native event queues for discovery triggering (cds.queued)
 * 3. Tenant readiness tracking
 *
 * Refactored to use CAP Native Event Queues instead of custom OutboxEvent.
 * Events are persisted in cds.outbox.Messages and processed asynchronously.
 */
const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');

// CDS logger for this module
const LOG = cds.log('tenant');

module.exports = class TenantService extends cds.ApplicationService {

  async init() {
    const { TenantProfile, DiscoveryRun } = this.entities;

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENT HANDLER: DiscoveryRequested - Process discovery events from queue
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('DiscoveryRequested', async (req) => {
      const { tenantId, runId, sourceMode, destinationName, triggeredBy } = req.data;
      LOG.info('Processing DiscoveryRequested event from queue', { tenantId, runId, triggeredBy });

      try {
        // Import and call the discovery worker
        const { processDiscoveryEvent } = require('../lib/discovery-worker');
        await processDiscoveryEvent(req.data, { tenantId });
        LOG.info('Discovery event processed successfully', { tenantId, runId });
      } catch (error) {
        LOG.error('Discovery event processing failed', { tenantId, runId, error: error.message });
        throw error; // Let CAP event queue handle retry
      }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ACTION: submitProfile
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('submitProfile', async (req) => {
      const tenantId = req.tenant || cds.context.tenant;
      const { organizationName, locale, sourceMode, destinationName } = req.data;

      LOG.info('Profile submission started', { tenantId, organizationName, sourceMode });

      // Validate inputs
      if (!organizationName) {
        req.error(400, 'Organization name is required', 'organizationName');
        return;
      }

      if (sourceMode && !['MOCK', 'LIVE'].includes(sourceMode)) {
        req.error(400, 'Source mode must be MOCK or LIVE', 'sourceMode');
        return;
      }

      if (sourceMode === 'LIVE' && !destinationName) {
        req.error(400, 'Destination name is required for LIVE mode', 'destinationName');
        return;
      }

      const db = await cds.connect.to('db');

      try {
        // Check for existing profile (idempotent update)
        let profile = await db.run(
          SELECT.one.from(TenantProfile).where({ tenantId })
        );

        const now = new Date().toISOString();

        if (profile) {
          // Update existing profile with optimistic concurrency
          const newVersion = profile.profileVersion + 1;
          await db.run(
            UPDATE(TenantProfile)
              .set({
                organizationName,
                locale: locale || 'en',
                sourceMode: sourceMode || 'MOCK',
                destinationName,
                status: 'ACTIVE',
                profileVersion: newVersion,
                modifiedAt: now
              })
              .where({ tenantId, profileVersion: profile.profileVersion })
          );
          profile = await db.run(SELECT.one.from(TenantProfile).where({ tenantId }));
          LOG.info('Profile updated', { tenantId, version: newVersion });
        } else {
          // Create new profile
          profile = {
            tenantId,
            organizationName,
            locale: locale || 'en',
            sourceMode: sourceMode || 'MOCK',
            destinationName,
            status: 'ACTIVE',
            profileVersion: 1,
            createdAt: now,
            modifiedAt: now
          };
          await db.run(INSERT.into(TenantProfile).entries(profile));
          LOG.info('Profile created', { tenantId });
        }

        // Queue discovery event using CAP native event queues
        // The event is persisted in the same transaction as profile changes
        const queuedService = cds.queued(this);
        await queuedService.emit('DiscoveryRequested', {
          tenantId,
          sourceMode: sourceMode || 'MOCK',
          destinationName,
          triggeredBy: 'profile_submission',
          timestamp: now
        });
        LOG.info('Discovery event queued via CAP native queue', { tenantId });

        // Emit domain event for audit
        await this._emitAuditEvent(tenantId, 'profile_submitted', {
          organizationName,
          sourceMode: sourceMode || 'MOCK'
        });

        return profile;

      } catch (error) {
        LOG.error('Profile submission failed', { tenantId, error: error.message });
        req.error(500, 'Failed to submit profile: ' + error.message);
      }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // FUNCTION: getTenantReadiness
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('getTenantReadiness', async (req) => {
      const tenantId = req.tenant || cds.context.tenant;
      LOG.debug('Checking tenant readiness', { tenantId });

      const db = await cds.connect.to('db');

      const profile = await db.run(
        SELECT.one.from(TenantProfile).where({ tenantId })
      );

      const lastRun = await db.run(
        SELECT.one.from(DiscoveryRun)
          .where({ tenantId })
          .orderBy({ completedAt: 'desc' })
      );

      const subscriptionStatus = profile ? 'SUBSCRIBED' : 'NOT_SUBSCRIBED';
      const profileStatus = profile?.status || 'PROFILE_PENDING';
      const discoveryStatus = lastRun?.status || 'NONE';

      const isReady = profileStatus === 'ACTIVE' &&
        ['COMPLETED', 'PARTIAL'].includes(discoveryStatus);

      return {
        tenantId,
        subscriptionStatus,
        profileStatus,
        discoveryStatus,
        isReady,
        lastDiscoveryRun: lastRun
      };
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ACTION: triggerDiscovery
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('triggerDiscovery', async (req) => {
      const tenantId = req.tenant || cds.context.tenant;
      LOG.info('Manual discovery trigger', { tenantId });

      const db = await cds.connect.to('db');

      const profile = await db.run(
        SELECT.one.from(TenantProfile).where({ tenantId })
      );

      if (!profile) {
        req.error(404, 'Tenant profile not found. Please submit profile first.');
        return;
      }

      const now = new Date().toISOString();
      const runId = uuidv4();
      const correlationId = 'disc-' + runId.substring(0, 8);

      const discoveryRun = {
        ID: runId,
        tenantId,
        status: 'PENDING',
        sourceMode: profile.sourceMode,
        correlationId,
        startedAt: now
      };

      await db.run(INSERT.into(DiscoveryRun).entries(discoveryRun));

      // Queue event using CAP native event queues
      const queuedService = cds.queued(this);
      await queuedService.emit('DiscoveryRequested', {
        tenantId,
        runId,
        sourceMode: profile.sourceMode,
        destinationName: profile.destinationName,
        triggeredBy: 'manual',
        timestamp: now
      });

      LOG.info('Discovery run created and event queued', { tenantId, runId, correlationId });

      return discoveryRun;
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // ACTION: switchSourceMode
    // ═══════════════════════════════════════════════════════════════════════════
    this.on('switchSourceMode', async (req) => {
      const tenantId = req.tenant || cds.context.tenant;
      const { mode } = req.data;

      if (!['MOCK', 'LIVE'].includes(mode)) {
        req.error(400, 'Mode must be MOCK or LIVE');
        return;
      }

      LOG.info('Source mode switch requested', { tenantId, mode });

      const db = await cds.connect.to('db');

      const profile = await db.run(
        SELECT.one.from(TenantProfile).where({ tenantId })
      );

      if (!profile) {
        req.error(404, 'Tenant profile not found');
        return;
      }

      if (mode === 'LIVE' && !profile.destinationName) {
        req.error(400, 'Cannot switch to LIVE mode without a configured destination');
        return;
      }

      const now = new Date().toISOString();
      await db.run(
        UPDATE(TenantProfile)
          .set({
            sourceMode: mode,
            profileVersion: profile.profileVersion + 1,
            modifiedAt: now
          })
          .where({ tenantId })
      );

      await this._emitAuditEvent(tenantId, 'source_mode_switched', {
        previousMode: profile.sourceMode,
        newMode: mode
      });

      LOG.info('Source mode switched', { tenantId, from: profile.sourceMode, to: mode });

      return await db.run(SELECT.one.from(TenantProfile).where({ tenantId }));
    });

    await super.init();
  }

  /**
   * Emit audit event for DPP compliance
   */
  async _emitAuditEvent(tenantId, action, details) {
    try {
      const auditLog = await cds.connect.to('audit-log');
      if (auditLog) {
        await auditLog.emit('tenant.action', {
          tenant: tenantId,
          action,
          details,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      // Non-critical, log and continue
      LOG.warn('Audit event emission failed', { tenantId, action, error: error.message });
    }
  }
};
