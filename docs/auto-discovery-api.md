# Auto-Discovery API Reference

**Version:** 1.0  
**Base URL:** `/odata/v4/discovery`  
**Authentication:** SAP XSUAA JWT

---

## Overview

The Auto-Discovery API provides endpoints for discovering and managing PI/PO artifacts. The discovery process automatically extracts Integrated Configurations (ICOs), Communication Channels, Mappings, Agreements, and other integration objects from connected SAP PI/PO systems.

---

## Authentication

All endpoints require a valid XSUAA JWT token in the Authorization header:

```http
Authorization: Bearer <jwt_token>
```

Required scopes:
- `TenantAdmin` - For write operations (start, cancel, approve)
- `TenantViewer` - For read operations (progress, summary, artifacts)

---

## Endpoints

### Discovery Operations

#### Start Discovery

Initiates an asynchronous discovery job for a PI/PO system.

```http
POST /odata/v4/discovery/startDiscovery
```

**Request Body:**
```json
{
  "systemId": "550e8400-e29b-41d4-a716-446655440000",
  "includeInactive": false,
  "includeHistory": false,
  "artifactTypes": null
}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `systemId` | UUID | Yes | - | ID of the PI/PO system to discover |
| `includeInactive` | Boolean | No | `false` | Include inactive artifacts |
| `includeHistory` | Boolean | No | `false` | Include version history |
| `artifactTypes` | String | No | `null` | JSON array of types, or null for all |

**Responses:**

`201 Created` - Discovery started:
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "estimatedTime": 120,
  "message": "Discovery started for \"PO_DEV\". Monitor progress via getDiscoveryProgress or SSE."
}
```

`409 Conflict` - Discovery already running:
```json
{
  "jobId": "existing-job-uuid",
  "status": "already_running",
  "estimatedTime": 60,
  "message": "Discovery is already running for system \"PO_DEV\"."
}
```

---

#### Get Discovery Progress

Retrieves the current progress of a discovery job.

```http
GET /odata/v4/discovery/getDiscoveryProgress(jobId='{jobId}')
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `jobId` | UUID | Yes | Discovery job ID |

**Response:**

`200 OK`:
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
| `pending` | Job queued, waiting to start |
| `running` | Discovery in progress |
| `completed` | Discovery finished successfully |
| `failed` | Discovery failed after retries |
| `cancelled` | Discovery cancelled by user |

---

#### Cancel Discovery

Cancels a running discovery job.

```http
POST /odata/v4/discovery/cancelDiscovery
```

**Request Body:**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Responses:**

`200 OK` - Cancellation successful:
```json
{
  "success": true,
  "message": "Discovery cancelled"
}
```

`400 Bad Request` - Job not cancellable:
```json
{
  "success": false,
  "message": "Cannot cancel job in status: completed"
}
```

---

#### Get Discovery Summary

Returns statistics for discovered artifacts of a PI/PO system.

```http
GET /odata/v4/discovery/getDiscoverySummary(systemId='{systemId}')
```

**Response:**

`200 OK`:
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

### Assessment Operations

#### Assess Artifact

Triggers AI-powered migration complexity assessment.

```http
POST /odata/v4/discovery/assessArtifact
```

**Request Body:**
```json
{
  "artifactId": "artifact-uuid",
  "async": true
}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `artifactId` | UUID | Yes | - | Artifact to assess |
| `async` | Boolean | No | `true` | Queue for async processing |

**Responses:**

`202 Accepted` (async=true):
```json
{
  "artifactId": "artifact-uuid",
  "status": "queued",
  "message": "Assessment queued for async processing."
}
```

`200 OK` (async=false):
```json
{
  "artifactId": "artifact-uuid",
  "status": "complete",
  "tier": "medium",
  "complexityScore": 65,
  "recommendedTool": "iFlow_SemiAuto",
  "estimatedHours": 8.5,
  "rationale": "Standard SOAP-to-REST pattern...",
  "scenarioPattern": "P2P_SYNC",
  "sapMigrationStatus": "Ready to migrate",
  "matchedTemplate": "SAP_Standard_SOAP_Proxy"
}
```

---

#### Approve Artifact

Marks an artifact as approved for migration.

```http
POST /odata/v4/discovery/approveArtifact
```

**Request Body:**
```json
{
  "artifactId": "artifact-uuid",
  "wave": 1,
  "notes": "Approved for Wave 1 - low risk"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `artifactId` | UUID | Yes | Artifact to approve |
| `wave` | Integer | No | Migration wave number (default: 1) |
| `notes` | String | No | Approval notes (max 5000 chars) |

**Response:**

`200 OK`:
```json
{
  "success": true,
  "message": "Artifact \"Orders_Outbound_ICO\" approved for wave 1"
}
```

---

### OData Entity Projections

#### PISystems

Read configured PI/PO systems.

```http
GET /odata/v4/discovery/PISystems
GET /odata/v4/discovery/PISystems('{id}')
GET /odata/v4/discovery/PISystems?$expand=jobs,artifacts
```

**Entity Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `ID` | UUID | System identifier |
| `systemName` | String | User-defined name |
| `description` | String | Optional description |
| `virtualHost` | String | Cloud Connector virtual host |
| `virtualPort` | Integer | Port number |
| `status` | String | configured, active, error, disabled |
| `totalArtifacts` | Integer | Count of discovered artifacts |
| `lastDiscoveryAt` | DateTime | Last discovery timestamp |

---

#### DiscoveryJobs

Read discovery job history and status.

```http
GET /odata/v4/discovery/DiscoveryJobs
GET /odata/v4/discovery/DiscoveryJobs?$filter=system_ID eq '{systemId}'
GET /odata/v4/discovery/DiscoveryJobs?$filter=status eq 'running'
```

**Entity Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `ID` | UUID | Job identifier |
| `status` | String | pending, running, completed, failed, cancelled |
| `currentPhase` | Integer | Current phase (1-6) |
| `currentPhaseName` | String | Phase description |
| `progressPercent` | Integer | Overall progress (0-100) |
| `artifactsFound` | Integer | Total artifacts discovered |
| `artifactsNew` | Integer | New artifacts |
| `artifactsUpdated` | Integer | Updated artifacts |
| `errorsCount` | Integer | Error count |
| `startedAt` | DateTime | Job start time |
| `completedAt` | DateTime | Job completion time |
| `durationMs` | Integer | Duration in milliseconds |

---

#### Artifacts

Read discovered PI/PO artifacts.

```http
GET /odata/v4/discovery/Artifacts
GET /odata/v4/discovery/Artifacts?$filter=artifactType eq 'IntegratedConfiguration'
GET /odata/v4/discovery/Artifacts?$filter=contains(name,'Order')
GET /odata/v4/discovery/ArtifactDetails('{id}')
```

**Entity Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `ID` | UUID | Artifact identifier |
| `artifactType` | String | ICO, Channel, Mapping, etc. |
| `name` | String | Artifact name |
| `description` | String | Artifact description |
| `namespace` | String | PI/PO namespace |
| `adapterType` | String | SOAP, REST, IDoc, etc. |
| `migrationTier` | String | simple, medium, complex |
| `complexityScore` | Integer | Complexity score (0-100) |
| `recommendedTool` | String | Recommended migration tool |
| `estimatedHours` | Decimal | Estimated migration effort |
| `migrationStatus` | String | discovered, assessed, approved, migrated |

---

## Events (Server-Sent Events)

### DiscoveryProgress

Real-time progress updates during discovery.

**Event Format:**
```json
{
  "tenantId": "tenant-subdomain",
  "jobId": "job-uuid",
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
| `phase_start` | Discovery phase started |
| `phase_complete` | Discovery phase completed |
| `artifact_found` | Individual artifact discovered |
| `error` | Error during discovery |
| `discovery_complete` | Full discovery completed |

---

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `PIPO-001` | 502 | Cloud Connector location not found |
| `PIPO-002` | 502 | Virtual host not reachable |
| `PIPO-003` | 401 | Invalid PI/PO credentials |
| `PIPO-004` | 403 | Insufficient PI/PO permissions |
| `PIPO-005` | 504 | SOAP request timeout |
| `PIPO-006` | 502 | Invalid SOAP response |
| `PIPO-007` | 413 | Artifact limit exceeded |
| `PIPO-008` | 503 | Destination creation failed |
| `PIPO-009` | 500 | Internal processing error |

---

## Rate Limits

| Operation | Limit |
|-----------|-------|
| Discovery jobs per tenant | 3 concurrent |
| API calls per minute | 60 |
| SSE connections per tenant | 10 |

---

## Examples

### cURL

**Start Discovery:**
```bash
curl -X POST \
  'https://app.cfapps.region.hana.ondemand.com/odata/v4/discovery/startDiscovery' \
  -H 'Authorization: Bearer <jwt>' \
  -H 'Content-Type: application/json' \
  -d '{"systemId":"550e8400-e29b-41d4-a716-446655440000"}'
```

**Get Progress:**
```bash
curl -X GET \
  "https://app.cfapps.region.hana.ondemand.com/odata/v4/discovery/getDiscoveryProgress(jobId='550e8400-e29b-41d4-a716-446655440000')" \
  -H 'Authorization: Bearer <jwt>'
```

### JavaScript

```javascript
// Start discovery
const response = await fetch('/odata/v4/discovery/startDiscovery', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ systemId: systemId })
});
const { jobId } = await response.json();

// Monitor progress via SSE
const eventSource = new EventSource(`/api/discovery/progress/${jobId}/stream`);
eventSource.onmessage = (event) => {
  const progress = JSON.parse(event.data);
  console.log(`Progress: ${progress.progressPercent}%`);
};
```

---

*Document End*
