# CAP Multitenant SaaS Implementation

Comprehensive implementation of CAP multitenancy patterns for a PI/PO migration platform. The change adds tenant-isolated CDS schemas for caching, checkpoints, and idempotency, alongside service layer components that maintain tenant context throughout async operations. UI wiring connects form inputs to backend services with SSE-based progress updates. The architecture follows CAP's MTXS provisioning model with HDI container-per-tenant isolation.

**Watch for:** Hardcoded master key in brain service (confirmed, security concern but excluded per user request). Mock endpoints in server.js bypass OData services and may create behavior divergence in production (confirmed). Discovery service's idempotency check uses wrong property name causing duplicate-prevention to fail silently (confirmed).

**Verdict**: NEEDS_CHANGES

## High-level view

The CDS schema design correctly models tenant isolation with tenantId on all entities, and the db/index.cds properly imports all four new schemas. The checkpoint and cache schemas support the indefinite-TTL requirement (ttlSeconds=-1) needed for test system durability.

The cache service implements a complete lifecycle with get/set/invalidate/warmCache and proper TTL handling including the indefinite option. Cache entries auto-clean on expired reads, and the warmCache function pre-populates from discovered artifacts.

The checkpoint saver follows the LangGraph BaseCheckpointSaver interface with put/get/list/getTuple methods and includes a saveOnError wrapper for automatic checkpoint creation on failures. Thread-based checkpoint history enables workflow recovery.

The idempotency service provides exactly-once semantics through checkAndLock/complete/fail, though the discovery service's integration has a bug where it checks for `idempotencyCheck.exists` which doesn't exist in the returned object — the service returns `locked` and `alreadyProcessed` flags instead.

Tenant isolation flows correctly through all services via `cds.context?.tenant` fallback chains, and the MTXS provisioning callbacks seed reference data on subscription while cleaning up cache and idempotency records on unsubscription.

The UI wiring provides api-client.js methods for all required operations, and btp_cockpit.html includes the PI/PO settings form with Save & Auto-Discover functionality. Server.js adds both SSE endpoints for discovery progress and a chat endpoint for brain service integration.

<details>
<summary>Issues (4)</summary>

1. **Idempotency check property mismatch** — discovery-service.js line ~85 checks `idempotencyCheck.exists` but idempotencyService returns `locked`, `alreadyProcessed`, `inProgress`. Change to check `!idempotencyCheck.locked && (idempotencyCheck.alreadyProcessed || idempotencyCheck.inProgress)`.

2. **Mock endpoints bypass OData** — server.js provides `/api/tenant/pipo-systems` and `/api/tenant/test-connection` that return mock data instead of calling TenantService. Either remove these or wire them to the actual CAP service.

3. **Hardcoded authentication key** — brain-service.js and btp_cockpit.html contain hardcoded key 'AYMAN2026'. Flagged but excluded from blocking per user request.

4. **Missing error propagation in destination creation** — tenant-service.js `_createDestinationsAsync` catches errors silently, so failed destination creation never surfaces to the user even though the system record shows as configured.

</details>

<details>
<summary>Details</summary>

## Idempotency service integration gap

The idempotencyService.checkAndLock returns this shape:

```javascript
return {
  locked: true,           // Whether we acquired the lock
  alreadyProcessed: false,
  alreadyFailed: false,
  inProgress: false,
  status: STATUS.PROCESSING
};
```

But discovery-service.js checks:

```javascript
if (idempotencyCheck.exists && idempotencyCheck.status === 'processing') {
```

The `exists` property is never set. The correct check should be:

```javascript
if (!idempotencyCheck.locked && idempotencyCheck.inProgress) {
```

This means concurrent discovery requests for the same system will both proceed instead of one being rejected, defeating the duplicate prevention. The fix is a one-line change in the conditional.

## Server.js mock endpoints vs OData services

The implementation includes two parallel paths:

1. OData services (TenantService at `/api/tenant`, DiscoveryService at `/odata/v4/discovery`) with full CAP entity handling, tenant isolation, and event queuing.

2. Express endpoints in server.js (`/api/tenant/pipo-systems`, `/api/tenant/test-connection`, `/api/pipo/systems/:systemId/discover`) that return mock/simulated data.

The UI's api-client.js calls the Express endpoints, not the OData services. This means:

- `savePipoSystem` hits `/api/tenant/pipo-systems` → mock response, no database write
- `testPipoConnection` hits `/api/tenant/test-connection` → mock response, no real test
- `triggerDiscovery` hits `/api/pipo/systems/:systemId/discover` → `simulateDiscoveryProcess()` with fake artifacts

For production, either:
- Wire api-client.js to call the OData action endpoints (`/api/tenant/savePipoSystem`, `/odata/v4/discovery/startDiscovery`)
- Or remove the mock endpoints and point api-client.js to the real services

The mock endpoints are useful for local development demos, but the disconnect means the UI doesn't exercise the actual service implementations.

## Destination creation failure handling

In tenant-service.js:

```javascript
async _createDestinationsAsync(tenantId, config, destinationDir, destinationEsr) {
  try {
    const destinationService = require('../utils/destinationService');
    await destinationService.createPISystemDestinations({...});
    LOG.info('BTP destinations created', {...});
  } catch (error) {
    LOG.warn('BTP destination creation failed (manual creation required)', {...});
    // Error swallowed — user never learns destinations failed
  }
}
```

When this fails, the PI system record shows status='configured' but the destinations don't exist. Subsequent test-connection and discovery will fail with confusing errors about missing destinations. Consider either:
- Returning the error status in the savePipoSystem response
- Setting system status to 'destination_pending' when async creation starts

## Cache service warmCache binding

The warmCache function queries artifacts by `system_ID`:

```javascript
const artifacts = await SELECT.from(Artifact)
  .where({ tenantId: effectiveTenant, system_ID: systemId });
```

But the Artifact entity's association is defined as:
```cds
system : Association to PISystem;
```

In CDS, this creates a foreign key column `system_ID`, so the query is correct. The cache warming integrates properly with the discovery flow, populating cache entries as artifacts are discovered.

## Checkpoint saver tenant context fallback

The CapCheckpointSaver properly handles tenant context:

```javascript
_getEffectiveTenant() {
  const tenant = this.tenantId || cds.context?.tenant;
  if (!tenant) {
    throw new Error('Tenant context required for checkpoint operations');
  }
  return tenant;
}
```

The constructor accepts a tenant ID, and each method falls back to cds.context.tenant. This allows the saver to work both when constructed with an explicit tenant (async workers) and when running within a request context.

## UI form to service flow

The btp_cockpit.html PI/PO settings section includes:
- System name, version, virtual host, port, protocol fields
- Location ID for Cloud Connector
- Tech user credentials with auth type selection
- Test Connection and Save & Auto-Discover buttons

The `btn-save-discover-pipo` button in btp_app.js should wire to:
1. Call `apiClient.savePipoSystem(config)` 
2. On success, call `apiClient.triggerDiscovery(systemId)`
3. Subscribe to SSE via `apiClient.subscribeDiscoveryEvents(jobId, onEvent)`
4. Update progress bar and artifact list from SSE events

The SSE subscription pattern is correctly implemented in api-client.js with automatic close on completion/failure.

## Discovery progress SSE broadcasting

Server.js maintains in-memory maps for SSE clients:

```javascript
const discoveryJobs = new Map();
const discoveryClients = new Map();
```

The broadcastDiscoveryProgress function is exposed via `app.locals` for other modules:

```javascript
app.locals.broadcastDiscoveryProgress = broadcastDiscoveryProgress;
```

However, discovery-service.js has its own `_emitProgress` method that doesn't use this. For the real discovery service to broadcast progress, it would need to either:
- Access Express app.locals (not available in CAP service context)
- Use CAP event mesh to publish events that server.js subscribes to
- Or use a shared message broker

Currently the two don't connect — real discoveries emit to `_emitProgress` which doesn't reach SSE clients, while mock discoveries in server.js use `broadcastDiscoveryProgress` which does.

## MTXS provisioning reference data seeding

The provisioning.js correctly seeds reference data on tenant subscription:

```javascript
const artifactTypes = [...];  // 8 types
const scenarioPatterns = [...];  // 6 patterns
const limitations = [...];  // 5 known limitations
const adapterMigrations = [...];  // 12 adapter mappings
```

Each seed operation checks for existing records before inserting, making the seeding idempotent. The transaction uses tenant context:

```javascript
const tx = cds.transaction({ user: { id: 'system', tenant: tenantId } });
```

Unsubscription cleanup properly invalidates all cache entries and cleans expired idempotency records, though it doesn't explicitly clean checkpoints (which may be intentional for audit retention).

</details>

<details>
<summary>File map (22 files changed)</summary>

| File | Change |
|------|--------|
| db/index.cds | Imports four new multitenant schemas |
| db/tenant-schema.cds | 495-line schema for PI systems, discovery jobs, artifacts, and reference data |
| db/cache-schema.cds | ArtifactCache entity with TTL and checksum support |
| db/checkpoint-schema.cds | LangGraph checkpoint and message storage |
| db/idempotency-schema.cds | IdempotencyRecord for duplicate prevention |
| srv/cache/artifactCacheService.js | Cache CRUD with warmCache, TTL=-1 support |
| srv/ai/capCheckpointSaver.js | LangGraph BaseCheckpointSaver implementation |
| srv/utils/idempotencyService.js | Exactly-once processing helpers |
| srv/tenant/tenant-service.cds | Actions for savePipoSystem, testConnection, triggerDiscovery |
| srv/tenant/tenant-service.js | Service implementation with input validation |
| srv/discovery-service.cds | Discovery API with artifacts, assessments, progress |
| srv/discovery-service.js | 935-line async discovery with cache integration |
| srv/mtx/provisioning.js | MTXS subscription callbacks with reference data seeding |
| srv/brain-service.cds | LangGraph tool actions for artifact operations |
| srv/brain-service.js | Enhanced with artifact tools and migration advisor |
| srv/server.js | SSE endpoints and chat endpoint (mock mode) |
| srv/utils/destinationService.js | BTP destination creation helpers |
| srv/utils/pipoSoapClient.js | PI/PO SOAP API client |
| app/aiconx/webapp/api-client.js | Frontend API methods for all operations |
| app/aiconx/webapp/btp_cockpit.html | PI/PO settings form, discovery progress UI |
| app/aiconx/webapp/btp_app.js | Form handlers and discovery flow logic |
| app/aiconx/webapp/btp_style.css | UI styling additions |

Full diff: `git diff main...HEAD` in the worktree.

</details>
