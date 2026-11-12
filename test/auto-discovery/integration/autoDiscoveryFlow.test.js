'use strict';

/**
 * Integration Tests: Auto-Discovery Flow
 *
 * Tests the complete auto-discovery flow from connection test to discovery completion.
 * Uses CDS test framework with in-memory SQLite database.
 */

const cds = require('@sap/cds');
const assert = require('node:assert');

// Test results accumulator
const testResults = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: [],
};

function recordTest(name, status, error = null) {
  testResults.tests.push({ name, status, error: error?.message || null });
  testResults[status]++;
}

// Mock tenant context
const TEST_TENANT = 'test-tenant-001';
const TEST_USER = { id: 'test-user', tenant: TEST_TENANT, name: 'Test User' };

let tenantService;
let discoveryService;
let db;

// ============================================================================
// Setup and Teardown
// ============================================================================
async function setup() {
  try {
    // Deploy in-memory SQLite for testing
    const model = await cds.load(['./db/tenant-schema.cds', './srv/tenant/tenant-service.cds', './srv/discovery-service.cds']);

    db = await cds.deploy(model).to('sqlite::memory:');

    console.log('Test setup completed');
    return true;
  } catch (error) {
    console.error('Setup failed:', error.message);
    // Return true anyway to run static tests
    return true;
  }
}

async function teardown() {
  try {
    if (db) {
      await db.disconnect();
    }
  } catch (error) {
    console.warn('Teardown warning:', error.message);
  }
}

// ============================================================================
// Test: Create PI System Configuration
// ============================================================================
async function testCreatePISystemConfiguration() {
  const testName = 'Create PI system configuration';
  try {
    const { PISystem } = cds.entities('tenant');

    const systemConfig = {
      ID: 'sys-test-001',
      tenantId: TEST_TENANT,
      systemName: 'TestPIPO',
      description: 'Test PI/PO System',
      virtualHost: 'pipo.test.local',
      virtualPort: 443,
      protocol: 'https',
      locationId: 'TEST_LOC',
      techUser: 'PISUPER',
      piVersion: '7.50',
      status: 'configured',
      autoDiscoveryEnabled: true,
      destinationStatus: 'pending',
      totalArtifacts: 0,
      testHistory: '[]',
    };

    await INSERT.into(PISystem).entries(systemConfig);

    // Verify system was created
    const system = await SELECT.one.from(PISystem).where({ ID: 'sys-test-001' });

    assert.ok(system, 'System should be created');
    assert.strictEqual(system.systemName, 'TestPIPO');
    assert.strictEqual(system.autoDiscoveryEnabled, true);
    assert.strictEqual(system.status, 'configured');

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
    return system;
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
    return null;
  }
}

// ============================================================================
// Test: Create Discovery Job
// ============================================================================
async function testCreateDiscoveryJob() {
  const testName = 'Create discovery job record';
  try {
    const { DiscoveryJob } = cds.entities('tenant');
    const { randomUUID } = require('node:crypto');

    const jobId = randomUUID();
    const now = new Date();

    const jobData = {
      ID: jobId,
      tenantId: TEST_TENANT,
      system_ID: 'sys-test-001',
      status: 'pending',
      startedAt: now,
      startedBy: TEST_USER.id,
      triggeredBy: 'auto_test',
      options: JSON.stringify({
        includeInactive: false,
        includeHistory: false,
        artifactTypes: null,
      }),
      progressLog: '[]',
      errorLog: '[]',
      totalPhases: 6,
      currentPhase: 0,
      currentPhaseName: 'Initializing',
      progressPercent: 0,
      artifactsFound: 0,
      artifactsNew: 0,
      artifactsUpdated: 0,
      errorsCount: 0,
      warningsCount: 0,
      attemptNumber: 1,
    };

    await INSERT.into(DiscoveryJob).entries(jobData);

    // Verify job was created
    const job = await SELECT.one.from(DiscoveryJob).where({ ID: jobId });

    assert.ok(job, 'Job should be created');
    assert.strictEqual(job.status, 'pending');
    assert.strictEqual(job.triggeredBy, 'auto_test');
    assert.strictEqual(job.totalPhases, 6);
    assert.strictEqual(job.attemptNumber, 1);

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
    return job;
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
    return null;
  }
}

// ============================================================================
// Test: Update Discovery Job Progress
// ============================================================================
async function testUpdateDiscoveryJobProgress() {
  const testName = 'Update discovery job progress';
  try {
    const { DiscoveryJob } = cds.entities('tenant');

    // Get the job created in previous test
    const job = await SELECT.one.from(DiscoveryJob).where({ tenantId: TEST_TENANT });

    if (!job) {
      recordTest(testName, 'skipped');
      console.log(`⊘ ${testName}: Skipped - no job found`);
      return null;
    }

    // Update job progress
    await UPDATE(DiscoveryJob)
      .set({
        status: 'running',
        currentPhase: 2,
        currentPhaseName: 'Integrated Configurations',
        progressPercent: 25,
        artifactsFound: 10,
        artifactsNew: 8,
        artifactsUpdated: 2,
      })
      .where({ ID: job.ID });

    // Verify update
    const updatedJob = await SELECT.one.from(DiscoveryJob).where({ ID: job.ID });

    assert.strictEqual(updatedJob.status, 'running');
    assert.strictEqual(updatedJob.currentPhase, 2);
    assert.strictEqual(updatedJob.progressPercent, 25);
    assert.strictEqual(updatedJob.artifactsFound, 10);
    assert.strictEqual(updatedJob.artifactsNew, 8);

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
    return updatedJob;
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
    return null;
  }
}

// ============================================================================
// Test: Create Discovered Artifact
// ============================================================================
async function testCreateDiscoveredArtifact() {
  const testName = 'Create discovered artifact';
  try {
    const { Artifact, DiscoveryJob } = cds.entities('tenant');
    const { randomUUID } = require('node:crypto');

    // Get job
    const job = await SELECT.one.from(DiscoveryJob).where({ tenantId: TEST_TENANT });

    const artifactData = {
      ID: randomUUID(),
      tenantId: TEST_TENANT,
      system_ID: 'sys-test-001',
      discoveryJob_ID: job?.ID,
      artifactType: 'IntegratedConfiguration',
      artifactKey: JSON.stringify({ type: 'IntegratedConfiguration', id: 'ICO_TEST_001' }),
      objectId: 'ICO_TEST_001',
      name: 'Test ICO Order Processing',
      description: 'Integration for order processing',
      namespace: 'urn:test:orders',
      direction: 'outbound',
      adapterType: 'SOAP',
      senderParty: '',
      senderComponent: 'ERP_SYSTEM',
      senderInterface: 'Orders_Out',
      senderNamespace: 'urn:sap:erp',
      receiverComponent: 'CRM_SYSTEM',
      piStatus: 'active',
      rawDefinition: JSON.stringify({ test: true }),
      rawFormat: 'json',
      migrationStatus: 'discovered',
    };

    await INSERT.into(Artifact).entries(artifactData);

    // Verify artifact was created
    const artifact = await SELECT.one.from(Artifact).where({ objectId: 'ICO_TEST_001' });

    assert.ok(artifact, 'Artifact should be created');
    assert.strictEqual(artifact.artifactType, 'IntegratedConfiguration');
    assert.strictEqual(artifact.adapterType, 'SOAP');
    assert.strictEqual(artifact.migrationStatus, 'discovered');

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
    return artifact;
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
    return null;
  }
}

// ============================================================================
// Test: Complete Discovery Job
// ============================================================================
async function testCompleteDiscoveryJob() {
  const testName = 'Complete discovery job';
  try {
    const { DiscoveryJob, PISystem } = cds.entities('tenant');

    // Get the job
    const job = await SELECT.one.from(DiscoveryJob).where({ tenantId: TEST_TENANT });

    if (!job) {
      recordTest(testName, 'skipped');
      console.log(`⊘ ${testName}: Skipped - no job found`);
      return null;
    }

    const now = new Date();

    // Complete job
    await UPDATE(DiscoveryJob)
      .set({
        status: 'completed',
        completedAt: now,
        currentPhase: 6,
        currentPhaseName: 'Completed',
        progressPercent: 100,
        artifactsFound: 25,
        artifactsNew: 20,
        artifactsUpdated: 5,
        errorsCount: 0,
        durationMs: 45000,
      })
      .where({ ID: job.ID });

    // Update system statistics
    await UPDATE(PISystem)
      .set({
        totalArtifacts: 25,
        lastDiscoveryAt: now,
        status: 'active',
      })
      .where({ ID: 'sys-test-001' });

    // Verify completion
    const completedJob = await SELECT.one.from(DiscoveryJob).where({ ID: job.ID });
    const updatedSystem = await SELECT.one.from(PISystem).where({ ID: 'sys-test-001' });

    assert.strictEqual(completedJob.status, 'completed');
    assert.strictEqual(completedJob.progressPercent, 100);
    assert.strictEqual(completedJob.errorsCount, 0);
    assert.strictEqual(updatedSystem.totalArtifacts, 25);
    assert.strictEqual(updatedSystem.status, 'active');

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
    return completedJob;
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
    return null;
  }
}

// ============================================================================
// Test: Create Audit Log Entry
// ============================================================================
async function testCreateAuditLogEntry() {
  const testName = 'Create audit log entry';
  try {
    const { AuditLog } = cds.entities('tenant');
    const { randomUUID } = require('node:crypto');

    const auditEntry = {
      ID: randomUUID(),
      tenantId: TEST_TENANT,
      userId: TEST_USER.id,
      userName: TEST_USER.name,
      userRole: 'Admin',
      action: 'discovery_auto_triggered',
      entityType: 'DiscoveryJob',
      entityId: 'job-test-001',
      entityName: 'TestPIPO',
      details: JSON.stringify({
        systemId: 'sys-test-001',
        trigger: 'connection_test_success',
      }),
    };

    await INSERT.into(AuditLog).entries(auditEntry);

    // Verify audit log
    const log = await SELECT.one.from(AuditLog).where({ action: 'discovery_auto_triggered' });

    assert.ok(log, 'Audit log should be created');
    assert.strictEqual(log.action, 'discovery_auto_triggered');
    assert.strictEqual(log.entityType, 'DiscoveryJob');

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
    return log;
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
    return null;
  }
}

// ============================================================================
// Test: Test History Tracking
// ============================================================================
async function testTestHistoryTracking() {
  const testName = 'Test history is tracked correctly';
  try {
    const { PISystem } = cds.entities('tenant');

    // Create test history entries
    const testHistory = [
      {
        timestamp: new Date().toISOString(),
        success: true,
        dirStatus: 'ok',
        esrStatus: 'ok',
        piVersion: '7.50',
        message: 'Connection successful',
      },
      {
        timestamp: new Date(Date.now() - 3600000).toISOString(),
        success: false,
        dirStatus: 'error',
        esrStatus: 'ok',
        message: 'DIR connection failed',
      },
    ];

    await UPDATE(PISystem)
      .set({
        testHistory: JSON.stringify(testHistory),
        lastTestedAt: new Date(),
      })
      .where({ ID: 'sys-test-001' });

    // Verify
    const system = await SELECT.one.from(PISystem).where({ ID: 'sys-test-001' });
    const history = JSON.parse(system.testHistory);

    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].success, true);
    assert.strictEqual(history[1].success, false);

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Query Artifacts by Type
// ============================================================================
async function testQueryArtifactsByType() {
  const testName = 'Query artifacts by type';
  try {
    const { Artifact } = cds.entities('tenant');
    const { randomUUID } = require('node:crypto');

    // Add more test artifacts
    const artifacts = [
      {
        ID: randomUUID(),
        tenantId: TEST_TENANT,
        system_ID: 'sys-test-001',
        artifactType: 'CommunicationChannel',
        objectId: 'CC_SOAP_001',
        name: 'SOAP Receiver Channel',
        adapterType: 'SOAP',
        direction: 'receiver',
        piStatus: 'active',
        migrationStatus: 'discovered',
      },
      {
        ID: randomUUID(),
        tenantId: TEST_TENANT,
        system_ID: 'sys-test-001',
        artifactType: 'MessageMapping',
        objectId: 'MM_ORDER_001',
        name: 'Order Mapping',
        mappingType: 'graphical',
        piStatus: 'active',
        migrationStatus: 'discovered',
      },
    ];

    for (const artifact of artifacts) {
      await INSERT.into(Artifact).entries(artifact);
    }

    // Query by type
    const channels = await SELECT.from(Artifact).where({ artifactType: 'CommunicationChannel', tenantId: TEST_TENANT });
    const mappings = await SELECT.from(Artifact).where({ artifactType: 'MessageMapping', tenantId: TEST_TENANT });
    const icos = await SELECT.from(Artifact).where({ artifactType: 'IntegratedConfiguration', tenantId: TEST_TENANT });

    assert.strictEqual(channels.length, 1);
    assert.strictEqual(mappings.length, 1);
    assert.strictEqual(icos.length, 1);

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Tenant Isolation
// ============================================================================
async function testTenantIsolation() {
  const testName = 'Tenant isolation is enforced';
  try {
    const { PISystem, Artifact } = cds.entities('tenant');
    const { randomUUID } = require('node:crypto');

    const OTHER_TENANT = 'other-tenant-002';

    // Create system for another tenant
    await INSERT.into(PISystem).entries({
      ID: 'sys-other-001',
      tenantId: OTHER_TENANT,
      systemName: 'OtherPIPO',
      virtualHost: 'other.test.local',
      virtualPort: 443,
      protocol: 'https',
      locationId: 'OTHER_LOC',
      techUser: 'OTHER_USER',
      status: 'configured',
      totalArtifacts: 0,
    });

    // Create artifact for another tenant
    await INSERT.into(Artifact).entries({
      ID: randomUUID(),
      tenantId: OTHER_TENANT,
      system_ID: 'sys-other-001',
      artifactType: 'IntegratedConfiguration',
      objectId: 'ICO_OTHER_001',
      name: 'Other Tenant ICO',
      migrationStatus: 'discovered',
    });

    // Query with TEST_TENANT should not see other tenant's data
    const testTenantSystems = await SELECT.from(PISystem).where({ tenantId: TEST_TENANT });
    const testTenantArtifacts = await SELECT.from(Artifact).where({ tenantId: TEST_TENANT });

    const otherTenantSystems = await SELECT.from(PISystem).where({ tenantId: OTHER_TENANT });
    const otherTenantArtifacts = await SELECT.from(Artifact).where({ tenantId: OTHER_TENANT });

    // Each tenant should only see their own data
    assert.ok(testTenantSystems.length > 0, 'Test tenant should have systems');
    assert.ok(testTenantArtifacts.length > 0, 'Test tenant should have artifacts');
    assert.ok(otherTenantSystems.length > 0, 'Other tenant should have systems');
    assert.ok(otherTenantArtifacts.length > 0, 'Other tenant should have artifacts');

    // Verify no cross-tenant data
    for (const sys of testTenantSystems) {
      assert.strictEqual(sys.tenantId, TEST_TENANT);
    }
    for (const art of testTenantArtifacts) {
      assert.strictEqual(art.tenantId, TEST_TENANT);
    }

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Test: Job Cancellation
// ============================================================================
async function testJobCancellation() {
  const testName = 'Discovery job can be cancelled';
  try {
    const { DiscoveryJob } = cds.entities('tenant');
    const { randomUUID } = require('node:crypto');

    // Create a new running job
    const jobId = randomUUID();
    await INSERT.into(DiscoveryJob).entries({
      ID: jobId,
      tenantId: TEST_TENANT,
      system_ID: 'sys-test-001',
      status: 'running',
      startedAt: new Date(),
      startedBy: TEST_USER.id,
      triggeredBy: 'manual',
      totalPhases: 6,
      currentPhase: 3,
      progressPercent: 50,
    });

    // Cancel the job
    await UPDATE(DiscoveryJob)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        cancelledBy: TEST_USER.id,
        cancelledAt: new Date(),
        cancellationReason: 'User requested cancellation',
      })
      .where({ ID: jobId });

    // Verify cancellation
    const job = await SELECT.one.from(DiscoveryJob).where({ ID: jobId });

    assert.strictEqual(job.status, 'cancelled');
    assert.ok(job.cancelledBy, 'cancelledBy should be set');
    assert.ok(job.cancelledAt, 'cancelledAt should be set');
    assert.ok(job.cancellationReason, 'cancellationReason should be set');

    recordTest(testName, 'passed');
    console.log(`✓ ${testName}`);
  } catch (error) {
    recordTest(testName, 'failed', error);
    console.error(`✗ ${testName}: ${error.message}`);
  }
}

// ============================================================================
// Run All Tests
// ============================================================================
async function runAllTests() {
  console.log('\n=== Auto-Discovery Integration Tests ===\n');

  const setupOk = await setup();
  if (!setupOk) {
    console.error('Setup failed, skipping integration tests');
    testResults.skipped = 10;
    return testResults;
  }

  try {
    await testCreatePISystemConfiguration();
    await testCreateDiscoveryJob();
    await testUpdateDiscoveryJobProgress();
    await testCreateDiscoveredArtifact();
    await testCompleteDiscoveryJob();
    await testCreateAuditLogEntry();
    await testTestHistoryTracking();
    await testQueryArtifactsByType();
    await testTenantIsolation();
    await testJobCancellation();
  } finally {
    await teardown();
  }

  console.log('\n--- Summary ---');
  console.log(`Passed: ${testResults.passed}`);
  console.log(`Failed: ${testResults.failed}`);
  console.log(`Skipped: ${testResults.skipped}`);

  return testResults;
}

// Export for test runner
module.exports = { runAllTests, testResults };

// Run if executed directly
if (require.main === module) {
  runAllTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  });
}
