# Auto-Discovery Feature Documentation

**Version:** 1.0  
**Last Updated:** 2025-01-XX  
**Status:** Complete

---

## Table of Contents

1. [User Documentation](#1-user-documentation)
2. [API Documentation](#2-api-documentation)
3. [Developer Documentation](#3-developer-documentation)

---

## 1. User Documentation

### 1.1 Overview

The Auto-Discovery feature enables automatic extraction of PI/PO artifacts after successfully configuring and testing a PI/PO system connection. When you save your PI/PO system configuration and test the connection successfully, the platform automatically begins discovering all integration artifacts (ICOs, channels, mappings, agreements, etc.) from your PI/PO system.

### 1.2 How to Use the Feature

#### Step 1: Configure Your PI/PO System

1. Navigate to **Settings → PI/PO Systems** in the application
2. Click **Add System**
3. Enter the required configuration:

| Field | Description | Example |
|-------|-------------|---------|
| **System Name** | A friendly identifier for this PI/PO system | `PO_PRODUCTION` |
| **Description** | Optional description | `Production PI/PO 7.50` |
| **Virtual Host** | Cloud Connector virtual host for your PI/PO | `pipo-prod.internal` |
| **Virtual Port** | Port number (default: 443) | `443` |
| **Protocol** | HTTP or HTTPS | `https` |
| **Cloud Connector Location ID** | Your Cloud Connector location identifier | `SDA_DATACENTER_1` |
| **Technical User** | PI/PO user with read access to Directory and ESR | `PIPO_TECH_USER` |
| **Password** | Password for the technical user | (securely stored) |
| **PI/PO Version** | Your PI/PO version (7.31, 7.40, or 7.50) | `7.50` |

4. Click **Save**

#### Step 2: Test the Connection

1. After saving, click **Test Connection**
2. The system validates connectivity to:
   - **Integration Directory API** - For ICOs, channels, and agreements
   - **Enterprise Services Repository (ESR)** - For mappings and interfaces
3. Review the test results:
   - ✅ **Success**: Both APIs are accessible
   - ⚠️ **Partial**: One API accessible (check Cloud Connector configuration)
   - ❌ **Failed**: Check credentials and network connectivity

#### Step 3: Automatic Discovery Starts

When the connection test succeeds:

1. Discovery job is automatically queued
2. A notification appears: *"Discovery has been scheduled for [System Name]"*
3. Progress bar shows current discovery phase

**Note:** You can disable automatic discovery by toggling **Auto-Discovery** to OFF before testing.

#### Step 4: Monitor Discovery Progress

The discovery runs through 6 phases:

| Phase | Name | What's Discovered |
|-------|------|-------------------|
| 1 | Configuration Scenarios | Groupings of related integration objects |
| 2 | Integrated Configurations | ICOs (routing and mapping configuration) |
| 3 | Communication Channels | Sender and receiver channel configurations |
| 4 | Agreements | Sender and receiver agreements |
| 5 | Value Mappings | Value mapping tables |
| 6 | ESR Objects | Service interfaces, message mappings, operation mappings |

**Progress Indicators:**
- Overall percentage completion
- Current phase name
- Artifacts found / new / updated counts
- Error and warning counts (if any)

#### Step 5: Review Discovered Artifacts

Once discovery completes:

1. Navigate to **Inventory** view
2. Browse artifacts by type, system, or status
3. Use search and filters to find specific artifacts
4. Click any artifact to view full details including:
   - Raw XML definition
   - Dependencies
   - Migration assessment (if available)

### 1.3 Configuration Options

#### Auto-Discovery Toggle

| Setting | Description |
|---------|-------------|
| **Enabled (default)** | Discovery starts automatically after successful connection test |
| **Disabled** | Manual trigger required via "Refresh Discovery" button |

#### Discovery Options

When manually triggering discovery:

| Option | Description | Default |
|--------|-------------|---------|
| **Include Inactive** | Discover artifacts with inactive status in PI/PO | OFF |
| **Include History** | Discover version history (where available) | OFF |
| **Artifact Types** | Select specific types to discover | All types |

### 1.4 Examples

#### Example 1: First-Time Setup

```
1. Add new PI/PO system "PO_DEV"
2. Enter connection details for development PI/PO
3. Click Save → Destinations created
4. Click Test Connection → Success ✅
5. Discovery starts automatically
6. Wait 2-5 minutes for completion
7. View 150 discovered artifacts in Inventory
```

#### Example 2: Refreshing After PI/PO Changes

```
1. Navigate to PI/PO Systems → PO_DEV
2. Click "Refresh Discovery"
3. Select "Full Discovery" (or Incremental for faster update)
4. Confirm
5. Discovery runs and identifies:
   - 5 new artifacts
   - 12 updated artifacts
   - 150 unchanged artifacts
```

#### Example 3: Cancelling a Running Discovery

```
1. Discovery is running (60% complete)
2. Click "Cancel Discovery"
3. Confirm cancellation
4. Discovery stops after current phase
5. Partial results (60%) are preserved
6. Can re-run discovery later
```

### 1.5 Troubleshooting

#### Common Issues

| Issue | Possible Cause | Solution |
|-------|---------------|----------|
| "Cloud Connector location not found" | Location ID mismatch | Verify Cloud Connector is running and location ID matches exactly |
| "Virtual host not reachable" | Cloud Connector mapping missing | Add virtual host mapping in Cloud Connector admin |
| "Invalid credentials" | Wrong username or password | Verify PI/PO technical user credentials |
| "Insufficient permissions" | User lacks PI/PO authorization | Grant S_XI_* authorizations to technical user |
| "Request timeout" | Network latency or PI/PO load | Retry; if persistent, check network and PI/PO performance |
| "Discovery already running" | Duplicate trigger | Wait for current discovery to complete |

#### Required PI/PO Authorizations

The technical user needs these SAP authorizations:

| Authorization Object | Description |
|---------------------|-------------|
| `S_XI_ADMIN` | Access to Integration Directory |
| `S_XI_READ` | Read access to configuration objects |
| `S_XI_PCKADD` | Access to ESR packages (optional) |

---

## 2. API Documentation

### 2.1 Base URL

All API endpoints are available at:

```
https://<your-application-host>/odata/v4/discovery
```

### 2.2 Authentication

All endpoints require authentication via SAP XSUAA JWT token:

```http
Authorization: Bearer <jwt_token>
```

### 2.3 Endpoints

#### 2.3.1 Start Discovery

Initiates a discovery job for a PI/PO system.

**Endpoint:** `POST /startDiscovery`

**Request Body:**
```json
{
  "systemId": "uuid",
  "includeInactive": false,
  "includeHistory": false,
  "artifactTypes": "[\"IntegratedConfiguration\", \"CommunicationChannel\"]"
}
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `systemId` | UUID | Yes | PI/PO system ID |
| `includeInactive` | Boolean | No | Include inactive artifacts (default: false) |
| `includeHistory` | Boolean | No | Include version history (default: false) |
| `artifactTypes` | String (JSON) | No | JSON array of types, or null for all |

**Response (201 Created):**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "estimatedTime": 120,
  "message": "Discovery started for \"PO_DEV\". Monitor progress via getDiscoveryProgress or SSE."
}
```

**Response (409 Conflict):**
```json
{
  "jobId": "existing-job-id",
  "status": "already_running",
  "estimatedTime": 60,
  "message": "Discovery is already running for system \"PO_DEV\". Job ID: existing-job-id"
}
```

**Error Codes:**

| Code | Description |
|------|-------------|
| 400 | `systemId` is required |
| 404 | PI/PO system not found |
| 409 | Discovery already running for this system |
| 500 | Internal server error |

---

#### 2.3.2 Get Discovery Progress

Retrieves current progress of a discovery job.

**Endpoint:** `GET /getDiscoveryProgress(jobId='{jobId}')`

**Response (200 OK):**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "running",
  "phase": 3,
  "phaseName": "Communication Channels",
  "progressPercent": 45,
  "artifactsFound": 156,
  "currentItem": "CC_SOAP_SENDER_001",
  "errors": "[]",
  "estimatedRemaining": 75
}
```

**Status Values:**

| Status | Description |
|--------|-------------|
| `pending` | Job queued, not yet started |
| `running` | Discovery in progress |
| `completed` | Successfully completed |
| `failed` | Failed after max retries |
| `cancelled` | Cancelled by user |

**Error Codes:**

| Code | Description |
|------|-------------|
| 400 | `jobId` is required |
| 404 | Discovery job not found |

---

#### 2.3.3 Cancel Discovery

Cancels a running discovery job.

**Endpoint:** `POST /cancelDiscovery`

**Request Body:**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Discovery cancelled"
}
```

**Response (400 Bad Request):**
```json
{
  "success": false,
  "message": "Cannot cancel job in status: completed"
}
```

**Error Codes:**

| Code | Description |
|------|-------------|
| 400 | `jobId` is required or job not in cancellable state |
| 404 | Discovery job not found |

---

#### 2.3.4 Get Discovery Summary

Retrieves summary statistics for a PI/PO system's discovered artifacts.

**Endpoint:** `GET /getDiscoverySummary(systemId='{systemId}')`

**Response (200 OK):**
```json
{
  "systemName": "PO_DEV",
  "totalArtifacts": 523,
  "byType": "{\"IntegratedConfiguration\":87,\"CommunicationChannel\":164,\"MessageMapping\":112}",
  "byTier": "{\"simple\":312,\"medium\":156,\"complex\":55}",
  "byStatus": "{\"discovered\":400,\"assessed\":100,\"approved\":23}",
  "estimatedTotalHours": 1250.5,
  "lastDiscoveryAt": "2025-01-15T10:42:15Z"
}
```

---

#### 2.3.5 Assess Artifact

Triggers AI-powered migration assessment for an artifact.

**Endpoint:** `POST /assessArtifact`

**Request Body:**
```json
{
  "artifactId": "artifact-uuid",
  "async": true
}
```

**Response (Async - 202 Accepted):**
```json
{
  "artifactId": "artifact-uuid",
  "status": "queued",
  "message": "Assessment queued for async processing. Monitor via SSE or polling."
}
```

**Response (Sync - 200 OK):**
```json
{
  "artifactId": "artifact-uuid",
  "status": "complete",
  "tier": "medium",
  "complexityScore": 65,
  "recommendedTool": "iFlow_SemiAuto",
  "estimatedHours": 8.5,
  "rationale": "Standard SOAP-to-REST pattern with value mapping...",
  "scenarioPattern": "P2P_SYNC",
  "sapMigrationStatus": "Ready to migrate",
  "matchedTemplate": "SAP_Standard_SOAP_Proxy",
  "message": "Assessment complete"
}
```

---

#### 2.3.6 Approve Artifact

Approves an artifact for migration.

**Endpoint:** `POST /approveArtifact`

**Request Body:**
```json
{
  "artifactId": "artifact-uuid",
  "wave": 1,
  "notes": "Approved for Wave 1 - low risk, standard pattern"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Artifact \"Orders_Outbound_ICO\" approved for wave 1"
}
```

---

### 2.4 OData Entity Endpoints

#### PISystems

**Read all systems for tenant:**
```
GET /PISystems
```

**Read single system:**
```
GET /PISystems('{systemId}')
```

**With expanded jobs:**
```
GET /PISystems?$expand=jobs,artifacts
```

---

#### DiscoveryJobs

**Read all jobs for tenant:**
```
GET /DiscoveryJobs
```

**Filter by system:**
```
GET /DiscoveryJobs?$filter=system_ID eq '{systemId}'
```

**Filter by status:**
```
GET /DiscoveryJobs?$filter=status eq 'running'
```

---

#### Artifacts

**Read all artifacts:**
```
GET /Artifacts
```

**Filter by system and type:**
```
GET /Artifacts?$filter=system_ID eq '{systemId}' and artifactType eq 'IntegratedConfiguration'
```

**Search by name:**
```
GET /Artifacts?$filter=contains(name, 'Order')
```

**Get artifact with full details:**
```
GET /ArtifactDetails('{artifactId}')
```

---

### 2.5 Server-Sent Events (SSE)

#### Event: DiscoveryProgress

Real-time progress updates during discovery.

**Event Format:**
```json
{
  "tenantId": "tenant-subdomain",
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "type": "phase_complete",
  "phase": 3,
  "phaseName": "Communication Channels",
  "progressPercent": 50,
  "artifactsFound": 164,
  "newArtifacts": 150,
  "updatedArtifacts": 14,
  "errorsCount": 0,
  "timestamp": "2025-01-15T10:35:00Z"
}
```

**Event Types:**

| Type | Description |
|------|-------------|
| `phase_start` | A new discovery phase has started |
| `phase_complete` | A discovery phase has completed |
| `artifact_found` | Individual artifact discovered (high-frequency) |
| `error` | An error occurred during discovery |
| `discovery_complete` | Full discovery has completed |

---

### 2.6 Error Codes Reference

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `PIPO-001` | 502 | Cloud Connector location not found |
| `PIPO-002` | 502 | Virtual host not reachable |
| `PIPO-003` | 401 | Invalid PI/PO credentials |
| `PIPO-004` | 403 | Insufficient PI/PO permissions |
| `PIPO-005` | 504 | SOAP request timeout |
| `PIPO-006` | 502 | Invalid SOAP response format |
| `PIPO-007` | 413 | Artifact limit exceeded |
| `PIPO-008` | 503 | BTP Destination creation failed |
| `PIPO-009` | 500 | Internal processing error |

---

## 3. Developer Documentation

### 3.1 Architecture Overview

The Auto-Discovery feature follows a multi-layer architecture:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           UI LAYER                                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │ System Config   │  │ Discovery       │  │ Inventory       │         │
│  │ Controller      │  │ Progress View   │  │ View            │         │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘         │
└───────────┼─────────────────────┼─────────────────────┼─────────────────┘
            │                     │ SSE                 │
┌───────────┼─────────────────────┼─────────────────────┼─────────────────┐
│           ▼                     ▼                     ▼   SERVICE LAYER │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │ TenantService   │  │ DiscoveryService│  │ BrainService    │         │
│  │ (tenant-svc.js) │  │ (discovery-svc) │  │ (AI Assessment) │         │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘         │
└───────────┼─────────────────────┼─────────────────────┼─────────────────┘
            │                     │                     │
┌───────────┼─────────────────────┼─────────────────────┼─────────────────┐
│           ▼                     ▼                     ▼  WORKER LAYER   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │DestinationSvc   │  │ DiscoveryWorker │  │ AssessmentWorker│         │
│  │(BTP Dest API)   │  │ (Async Job)     │  │ (Async AI)      │         │
│  └────────┬────────┘  └────────┬────────┘  └─────────────────┘         │
└───────────┼─────────────────────┼───────────────────────────────────────┘
            │                     │
┌───────────┼─────────────────────┼───────────────────────────────────────┐
│           ▼                     ▼                    ADAPTER LAYER      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │ BTP Destination │  │ PIPoSoapClient  │  │ ArtifactCache   │         │
│  │ REST API        │  │ (Directory/ESR) │  │ Service         │         │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘         │
└───────────┼─────────────────────┼─────────────────────┼─────────────────┘
            │                     │                     │
            ▼                     ▼                     ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐
│ BTP Destination │  │ Cloud Connector │  │ Tenant HDI Container        │
│ Service         │  │ → PI/PO System  │  │ (HANA Cloud)                │
└─────────────────┘  └─────────────────┘  └─────────────────────────────┘
```

### 3.2 Key Components

#### 3.2.1 DiscoveryWorker (srv/workers/discoveryWorker.js)

The core async worker that processes discovery jobs.

**Responsibilities:**
- Phase-level progress tracking with SSE emission
- Retry logic with exponential backoff (1s, 4s, 16s)
- Cancellation support (checks status between phases)
- Idempotent artifact upsert
- Batch processing for large result sets

**Key Methods:**

```javascript
class DiscoveryWorker {
  constructor(options) {
    this.tenantId = options.tenantId;
    this.jobId = options.jobId;
    this.system = options.system;
  }

  async run() {
    // Main discovery loop
    for (const phase of DISCOVERY_PHASES) {
      if (await this._isCancelled()) break;
      await this._processPhase(phase);
    }
  }

  async _processPhase(phase) {
    // Emit phase start
    await this._emitProgress({ type: 'phase_start', ... });
    
    // Process each artifact type with retry
    for (const artifactType of phase.types) {
      await this._processArtifactType(artifactType, phase);
    }
    
    // Emit phase complete
    await this._emitProgress({ type: 'phase_complete', ... });
  }

  async _processArtifactType(artifactType, phase) {
    // Retry loop with exponential backoff
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const artifacts = await this._queryArtifacts(artifactType);
        await this._processArtifactBatch(artifacts, artifactType);
        return;
      } catch (error) {
        if (attempt === MAX_RETRIES) throw error;
        await this._sleep(RETRY_DELAYS[attempt - 1]);
      }
    }
  }
}
```

#### 3.2.2 PIPoSoapClient (srv/utils/pipoSoapClient.js)

SOAP client for PI/PO Directory and ESR APIs.

**Key Features:**
- SAP NetWeaver 7.50 optimized (supports IntegratedConfiguration750InService)
- Full channel module chain extraction
- Security configuration discovery
- Dynamic WSDL through Cloud Connector

**SOAP Services Used:**

| Service | Path | Purpose |
|---------|------|---------|
| IntegratedConfigurationInService | `/IntegratedConfigurationInService/IntegratedConfigurationInImplBean` | ICO discovery |
| IntegratedConfiguration750InService | `/IntegratedConfiguration750InService/IntegratedConfiguration750InImplBean` | PI 7.50 ICOs |
| CommunicationChannelInService | `/CommunicationChannelInService/CommunicationChannelInImplBean` | Channel discovery |
| SenderAgreementInService | `/SenderAgreementInService/SenderAgreementInImplBean` | Sender agreements |
| ReceiverAgreementInService | `/ReceiverAgreementInService/ReceiverAgreementInImplBean` | Receiver agreements |
| ValueMappingInService | `/ValueMappingInService/ValueMappingInImplBean` | Value mappings |
| ConfigurationScenarioInService | `/ConfigurationScenarioInService/ConfigurationScenarioInImplBean` | Scenarios |

**ESR Endpoints:**

| Endpoint | Purpose |
|----------|---------|
| `/rep/support/SimpleQuery` | Simple object queries |
| `/rep/query/ext/1` | Extended queries |
| `/rep/read/ext/1` | Object detail reads |

#### 3.2.3 DestinationService (srv/utils/destinationService.js)

BTP Destination management for PI/PO connectivity.

**Key Functions:**

```javascript
// Create both DIR and ESR destinations for a PI/PO system
async function createPISystemDestinations(config) {
  const dirDestination = {
    Name: `PO_${systemName}_${tenantId}_DIR`,
    Type: 'HTTP',
    URL: baseUrl,
    ProxyType: 'OnPremise',
    Authentication: 'BasicAuthentication',
    CloudConnectorLocationId: locationId,
    // ...
  };
  
  await createDestination(dirDestination);
  await createDestination(esrDestination);
}

// Test destination connectivity
async function testDestinationConnectivity(destinationName) {
  const response = await executeHttpRequest(
    { destinationName },
    { method: 'GET', url: '/dir/hmi', timeout: 10000 }
  );
  return { success: true, statusCode: response.status };
}
```

### 3.3 How to Extend

#### Adding a New Artifact Type

1. **Update Discovery Phases** (discoveryWorker.js):
```javascript
const DISCOVERY_PHASES = [
  // ...existing phases...
  {
    order: 7,
    code: 'NewArtifactType',
    name: 'New Artifact Type',
    types: ['NewArtifactType'],
    weight: 5,
    category: 'dir', // or 'esr'
    timeout: 60000,
  },
];
```

2. **Add Query Method** (pipoSoapClient.js):
```javascript
async queryNewArtifactType() {
  const namespace = 'http://sap.com/xi/BASIS';
  const body = await this._soapCall(
    SOAP_SERVICES.NewArtifactType,
    'NewArtifactTypeQueryRequest',
    namespace,
    '',
    DEFAULT_TIMEOUT
  );
  return this._extractQueryResponse(body, 'NewArtifactTypeQueryResponse');
}
```

3. **Update Artifact Processing** (discoveryWorker.js):
```javascript
async _queryArtifacts(client, artifactType) {
  switch (artifactType) {
    // ...existing cases...
    case 'NewArtifactType':
      return await client.queryNewArtifactType();
    default:
      return [];
  }
}
```

4. **Update Mock Data** (for development):
```javascript
_getMockArtifacts(artifactType) {
  const mockData = {
    // ...existing mocks...
    NewArtifactType: [
      { ObjectID: 'NEW_001', Name: 'Sample New Artifact' },
    ],
  };
  return mockData[artifactType] || [];
}
```

#### Adding a Custom Discovery Hook

To add custom processing during discovery:

```javascript
// srv/hooks/discoveryHooks.js
module.exports = {
  // Called before each phase starts
  onPhaseStart: async (phase, context) => {
    console.log(`Starting phase: ${phase.name}`);
  },
  
  // Called after each artifact is processed
  onArtifactProcessed: async (artifact, context) => {
    // Custom logic, e.g., send to external system
  },
  
  // Called when discovery completes
  onDiscoveryComplete: async (summary, context) => {
    // Send notification, trigger downstream workflow, etc.
  },
};
```

Register hooks in the worker:

```javascript
// discoveryWorker.js
const hooks = require('../hooks/discoveryHooks');

async _processPhase(phase) {
  await hooks.onPhaseStart?.(phase, this._getContext());
  // ...process phase...
}

async _processArtifact(artifact, artifactType) {
  const result = await this._upsertArtifact(artifact, artifactType);
  await hooks.onArtifactProcessed?.(result, this._getContext());
  return result;
}
```

### 3.4 Troubleshooting Guide

#### Issue: Discovery Hangs at Phase 2

**Symptoms:**
- Progress stuck at "Integrated Configurations" phase
- No errors in logs

**Diagnosis:**
1. Check PI/PO system load - ICO queries can be heavy
2. Review Cloud Connector connection count
3. Check for locked ICOs in PI/PO

**Resolution:**
```javascript
// Increase timeout for ICO phase in discoveryWorker.js
{
  code: 'IntegratedConfiguration',
  timeout: 300000, // Increase to 5 minutes
}
```

#### Issue: "Destination Not Found" Error

**Symptoms:**
- Connection test fails immediately
- Error: "Could not find destination 'PO_XXX_DIR'"

**Diagnosis:**
1. Check destination status in BTP Cockpit
2. Verify destination service binding exists
3. Check tenant context in logs

**Resolution:**
```bash
# Re-create destinations
cf service-key <app-service> <key-name>

# Verify in application logs
cf logs <app-name> --recent | grep destination
```

#### Issue: Partial Discovery Results

**Symptoms:**
- Discovery completes but some artifact types have 0 count
- No errors reported

**Diagnosis:**
1. Check PI/PO user authorizations
2. Verify ESR vs Directory endpoint configuration
3. Review phase-specific logs

**Resolution:**
```javascript
// Enable debug logging for specific phase
process.env.LOG_LEVEL = 'debug';
// Or in CAP configuration
cds.env.log.levels = { 'pipo-soap-client': 'debug' };
```

#### Issue: SSE Connection Drops

**Symptoms:**
- UI progress stops updating
- Discovery continues in backend

**Diagnosis:**
1. Check network proxy timeouts
2. Review browser console for connection errors
3. Check if heartbeat is being sent

**Resolution:**
```javascript
// Frontend: Implement reconnection logic
const eventSource = new EventSource(progressUrl);
eventSource.onerror = () => {
  setTimeout(() => {
    // Reconnect after 5 seconds
    setupEventSource();
  }, 5000);
};
```

#### Issue: Memory Exhaustion During Large Discovery

**Symptoms:**
- Node.js crashes with OOM error
- Discovery fails for tenants with 10,000+ artifacts

**Diagnosis:**
1. Check Node.js heap usage
2. Review batch size configuration
3. Check for memory leaks in XML parsing

**Resolution:**
```javascript
// Reduce batch size
const ARTIFACT_BATCH_SIZE = 50; // Reduce from 100

// Enable garbage collection hints
global.gc && global.gc();

// Use streaming parser for large XML
const saxParser = require('sax').createStream(true);
```

### 3.5 Performance Tuning

#### Recommended Configuration

| Setting | Development | Production |
|---------|-------------|------------|
| `ARTIFACT_BATCH_SIZE` | 100 | 50-100 |
| `MAX_RETRY_ATTEMPTS` | 3 | 3 |
| `SOAP_TIMEOUT` | 60000 | 120000 |
| `SSE_HEARTBEAT_INTERVAL` | 30000 | 15000 |
| `MAX_CONCURRENT_JOBS` | 3 | 10 |

#### Database Indexes

Ensure these indexes exist for optimal query performance:

```sql
CREATE INDEX idx_artifact_tenant_system_type 
  ON Artifact(tenantId, system_ID, artifactType);

CREATE INDEX idx_discoveryjob_tenant_status 
  ON DiscoveryJob(tenantId, status);

CREATE INDEX idx_pisystem_tenant_status 
  ON PISystem(tenantId, status);
```

#### Monitoring Queries

```sql
-- Active discovery jobs
SELECT * FROM DiscoveryJob 
WHERE status = 'running' 
ORDER BY startedAt DESC;

-- Artifact count by system
SELECT system_ID, artifactType, COUNT(*) as count
FROM Artifact
WHERE tenantId = ?
GROUP BY system_ID, artifactType;

-- Discovery job duration statistics
SELECT 
  AVG(durationMs) as avg_duration,
  MAX(durationMs) as max_duration,
  COUNT(*) as total_jobs
FROM DiscoveryJob
WHERE status = 'completed' 
  AND startedAt > DATEADD(DAY, -30, CURRENT_DATE);
```

---

## Appendix A: Discovery Phase Configuration

```javascript
const DISCOVERY_PHASES = [
  {
    order: 1,
    code: 'ConfigurationScenario',
    name: 'Configuration Scenarios',
    types: ['ConfigurationScenario'],
    weight: 5,
    category: 'dir',
    timeout: 60000,
  },
  {
    order: 2,
    code: 'IntegratedConfiguration',
    name: 'Integrated Configurations',
    types: ['IntegratedConfiguration', 'IntegratedConfiguration750'],
    weight: 20,
    category: 'dir',
    timeout: 180000,
  },
  {
    order: 3,
    code: 'CommunicationChannel',
    name: 'Communication Channels',
    types: ['CommunicationChannel'],
    weight: 15,
    category: 'dir',
    timeout: 180000,
  },
  {
    order: 4,
    code: 'Agreement',
    name: 'Agreements',
    types: ['SenderAgreement', 'ReceiverAgreement'],
    weight: 15,
    category: 'dir',
    timeout: 60000,
  },
  {
    order: 5,
    code: 'ValueMapping',
    name: 'Value Mappings',
    types: ['ValueMappingGroup'],
    weight: 10,
    category: 'dir',
    timeout: 60000,
  },
  {
    order: 6,
    code: 'ESRObjects',
    name: 'ESR Objects',
    types: ['SoftwareComponentVersion', 'MessageMapping', 'OperationMapping', 'ServiceInterface'],
    weight: 35,
    category: 'esr',
    timeout: 300000,
  },
];
```

---

## Appendix B: Sample API Calls

### cURL Examples

**Start Discovery:**
```bash
curl -X POST \
  'https://app.cfapps.us10.hana.ondemand.com/odata/v4/discovery/startDiscovery' \
  -H 'Authorization: Bearer <jwt>' \
  -H 'Content-Type: application/json' \
  -d '{"systemId": "550e8400-e29b-41d4-a716-446655440000"}'
```

**Get Progress:**
```bash
curl -X GET \
  "https://app.cfapps.us10.hana.ondemand.com/odata/v4/discovery/getDiscoveryProgress(jobId='550e8400-e29b-41d4-a716-446655440000')" \
  -H 'Authorization: Bearer <jwt>'
```

**Cancel Discovery:**
```bash
curl -X POST \
  'https://app.cfapps.us10.hana.ondemand.com/odata/v4/discovery/cancelDiscovery' \
  -H 'Authorization: Bearer <jwt>' \
  -H 'Content-Type: application/json' \
  -d '{"jobId": "550e8400-e29b-41d4-a716-446655440000"}'
```

---

*Document End*
