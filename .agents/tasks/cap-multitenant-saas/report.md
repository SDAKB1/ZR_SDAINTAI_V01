# CAP Multitenant SaaS Implementation Report

## Executive Summary

This report documents the implementation plan for a production-grade CAP multitenant SaaS architecture for PI/PO migration in the SDAINTAI platform. The implementation adds durable artifact caching, LangGraph checkpoints, idempotency handling, and UI wiring to the existing MTXS-enabled CAP application.

## Current State Analysis

### What Already Exists

The worktree at `.worktrees/cap-multitenant-saas` has substantial infrastructure already in place:

**Multitenancy Infrastructure (Complete)**
- MTXS sidecar configured in `mta.yaml` (AICONX-mtx module)
- SaaS Registry resource with subscription callbacks pointing to mtx sidecar
- Service Manager (`AICONX-db`) for HDI container provisioning
- `xs-security.json` with mtcallback scope for subscription authority
- `mtx/sidecar/package.json` with `@sap/cds-mtxs` v3, profile `mtx-sidecar`
- `package.json` has `"multitenancy": true` for production profile

**AI/Brain Services (Partial)**
- `srv/brain-service.cds` and `.js` with LangGraph migration advisor
- `srv/ai/vectorStore.js` with HANA-backed and local-file stores
- `srv/ai/brainConfig.js` for brain state management
- Migration knowledge base with complexity scoring

**UI Framework (Partial)**
- `app/aiconx/webapp/btp_cockpit.html` with admin settings panel
- `app/aiconx/webapp/btp_app.js` with client-side state management
- Existing PI/PO system fields in admin section (incomplete)

### What's Missing

**CDS Schema (From Main Repo)**
- `db/tenant-schema.cds` - PISystem, Artifact, DiscoveryJob entities
- Cache, checkpoint, idempotency entities need to be created

**Service Layer**
- `srv/tenant/tenant-service.cds` and `.js` - tenant profile management
- `srv/discovery-service.cds` and `.js` - PI/PO artifact discovery
- Cache service for durable artifact caching
- Checkpoint saver for LangGraph fault tolerance

**UI Integration**
- Complete PI/PO connection form
- Auto-discovery flow with SSE progress
- Chat panel for LangGraph interaction

## Architecture Design

### Data Flow

```
Tenant Admin → Settings Form → TenantService.savePipoSystem()
                                    ↓
                            PISystem record in tenant HDI
                                    ↓
                  TenantService.triggerDiscovery() → DiscoveryRun
                                    ↓
                  cds.queued() → DiscoveryService.processDiscovery()
                                    ↓
                  PIPoSoapClient → Query DIR + ESR
                                    ↓
                  For each artifact:
                    → artifactCacheService.set() (TTL=-1 for test systems)
                    → INSERT Artifact
                    → SSE emit progress
                                    ↓
                  BrainService tools read from cache:
                    → get_artifact() → cache.get()
                    → search_artifacts() → vectorStore.search()
                                    ↓
                  LangGraph checkpoints persisted:
                    → capCheckpointSaver.put() on each step
                    → saveOnError() wraps operations
```

### Tenant Isolation

All entities include `tenantId` column. Services access via `cds.context.tenant`:

```javascript
const tenantId = cds.context.tenant || 'default';
const artifacts = await SELECT.from(Artifact).where({ tenantId });
```

### Caching Strategy

- **TTL=-1** (indefinite): For test systems to avoid repeated PI/PO fetches
- **TTL configurable**: Via CacheConfig entity or environment variable
- **Invalidation**: Manual (on PI/PO changes), version-based (checksum), dependency-aware

### Checkpoint Pattern

LangGraph checkpoints stored in `LangGraphCheckpoint` entity with:
- `threadId` - conversation/session identifier
- `checkpointId` - unique checkpoint within thread
- `state` - serialized LangGraph state
- `parentId` - for checkpoint history/branching

Recovery on restart loads latest checkpoint for thread.

## Feature Decomposition

The implementation is decomposed into 4 features executed sequentially:

### FEAT-001: CDS Schema Extensions (Foundation)
- Port tenant-schema.cds from main repo
- Create cache-schema.cds, checkpoint-schema.cds, idempotency-schema.cds
- Create index.cds aggregator

**Dependencies**: None
**Output**: Complete data model for all subsequent features

### FEAT-002: Cache & Checkpoint Services (Core)
- artifactCacheService.js with get/set/invalidate
- capCheckpointSaver.js implementing LangGraph interface
- idempotencyService.js for duplicate handling

**Dependencies**: FEAT-001 (schema entities)
**Output**: Reusable service modules

### FEAT-003: Service Layer Integration (Backend)
- tenant-service.cds/.js with savePipoSystem, testConnection, triggerDiscovery
- discovery-service.cds/.js with cache integration
- brain-service.js enhancements with LangGraph tools

**Dependencies**: FEAT-001 (entities), FEAT-002 (cache/checkpoint services)
**Output**: Complete backend API

### FEAT-004: UI Wiring (Frontend)
- api-client.js for API calls
- btp_cockpit.html enhancements (form + chat panel)
- btp_app.js handlers
- SSE and chat endpoints in server.js

**Dependencies**: FEAT-003 (service APIs)
**Output**: Working end-to-end flow

## Key Implementation Decisions

### 1. TTL=-1 for Test Systems
Rationale: User explicitly requested indefinite durable cache for test systems to avoid repeated PI/PO fetches. The `ttlSeconds` field defaults to -1, and `expiresAt` is null when TTL is indefinite.

### 2. CAP Native Queues Over Custom Outbox
Rationale: Main repo uses `cds.queued()` for async operations. This is CAP's built-in pattern using `cds.outbox.Messages` table. Preserves tenant context automatically.

### 3. Checkpoint Per LangGraph Step
Rationale: Each LangGraph node saves checkpoint before processing. On error, `saveOnError` wrapper persists current state before rethrowing. Recovery resumes from last checkpoint.

### 4. SSE for Discovery Progress
Rationale: UI needs real-time progress. Server-Sent Events (EventSource) provides lightweight push. Endpoint `/api/discovery/events/:jobId` streams job progress.

### 5. Idempotency Via Key+TTL
Rationale: Prevent duplicate discovery runs. `checkAndLock()` returns existing result if key found and not expired. Default 1-hour TTL covers retry scenarios.

## Verification Commands

```bash
# Build verification (all features)
npx cds build --production

# Check generated model
cat gen/srv/csn.json | grep -E '"(ArtifactCache|LangGraphCheckpoint)"'

# Verify tenant isolation pattern
grep -r "cds.context.tenant" srv/

# Verify cache integration
grep -r "artifactCacheService" srv/

# Verify checkpoint integration
grep -r "CapCheckpointSaver" srv/
```

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| MTXS sidecar not running | Already configured in mta.yaml; verify deployment |
| PI/PO connectivity | testConnection validates before discovery |
| Large artifact payloads | LargeString CDS type, batch processing |
| Checkpoint bloat | Consider cleanup job for old checkpoints |
| SSE connection drops | Client reconnects, discovery state preserved |

## Success Criteria

1. ✅ **Multitenancy**: MTXS already configured, provisioning works via callbacks
2. ☐ **Caching**: Artifacts cached with configurable TTL, indefinite works
3. ☐ **Checkpoints**: LangGraph state survives restarts/errors
4. ☐ **Idempotency**: Duplicate discovery requests handled correctly
5. ☐ **Discovery**: Full PI/PO discovery populates cache and HDI
6. ☐ **UI**: Settings form triggers auto-discovery, chat works
7. ☐ **Build**: `cds build` succeeds on all changes
8. ☐ **No Regressions**: Existing brain/aiconx services work

## Files Summary

**Create (16 files)**
- db/tenant-schema.cds, cache-schema.cds, checkpoint-schema.cds, idempotency-schema.cds, index.cds
- srv/cache/artifactCacheService.js
- srv/ai/capCheckpointSaver.js
- srv/utils/idempotencyService.js, pipoSoapClient.js, destinationService.js
- srv/tenant/tenant-service.cds, tenant-service.js
- srv/discovery-service.cds, discovery-service.js
- srv/mtx/provisioning.js
- app/aiconx/webapp/api-client.js

**Modify (5 files)**
- srv/brain-service.js
- srv/server.js
- app/aiconx/webapp/btp_cockpit.html
- app/aiconx/webapp/btp_app.js
- app/aiconx/webapp/btp_style.css
