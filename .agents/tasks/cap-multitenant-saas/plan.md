# Implementation Plan: CAP Multitenant SaaS Architecture

## Overview

Implement production-grade CAP multitenant SaaS architecture for PI/PO migration with:
- Full SaaS multitenancy (MTXS sidecar already configured)
- Durable artifact caching with configurable TTL (indefinite for test systems)
- LangGraph durable checkpoints for fault tolerance
- Idempotency, duplicate handling, and transaction safety
- UI wiring for auto-discovery and chat functionality

The worktree at `.worktrees/cap-multitenant-saas` already has MTXS sidecar configured in mta.yaml with SaaS Registry, Service Manager, and subscription callbacks. The task ports tenant-schema entities from main repo, adds cache/checkpoint schemas, creates service implementations, and wires the UI.

---

## Feature 1: CDS Schema Extensions (FEAT-001)

Foundation layer: data models for caching, checkpoints, and tenant artifacts.

- [ ] 1. Port db/tenant-schema.cds from main repo to worktree containing PISystem, DiscoveryJob, Artifact, AuditLog, ModuleConfiguration, CredentialInventory, Party, ArtifactLimitation, and all reference entities.
      Files: .worktrees/cap-multitenant-saas/db/tenant-schema.cds
      Verify: `npx cds build --production` succeeds

- [ ] 2. Create db/cache-schema.cds with ArtifactCache entity (tenantId, cacheKey, artifactType, payload, metadata, ttlSeconds default -1, expiresAt, hitCount, lastAccessedAt, version, checksum). Include unique constraint.
      Files: .worktrees/cap-multitenant-saas/db/cache-schema.cds
      Verify: `npx cds build --production` succeeds

- [ ] 3. Create db/checkpoint-schema.cds with LangGraphCheckpoint (tenantId, threadId, checkpointId, parentId, state, metadata, createdAt) and LangGraphMessage (tenantId, threadId, messageId, role, content, toolCalls, createdAt).
      Files: .worktrees/cap-multitenant-saas/db/checkpoint-schema.cds
      Verify: `npx cds build --production` succeeds

- [ ] 4. Create db/idempotency-schema.cds with IdempotencyRecord entity (tenantId, idempotencyKey, operation, status, result, expiresAt, createdAt).
      Files: .worktrees/cap-multitenant-saas/db/idempotency-schema.cds
      Verify: `npx cds build --production` succeeds

- [ ] 5. Create db/index.cds that uses all schema files for unified model loading.
      Files: .worktrees/cap-multitenant-saas/db/index.cds
      Verify: `npx cds build --production` produces csn.json with all entities

---

## Feature 2: Cache & Checkpoint Services (FEAT-002)

Core services for durable caching and LangGraph state persistence.

- [ ] 6. Create srv/cache/artifactCacheService.js with get(key), set(key, value, ttl), invalidate(key), invalidateByPattern(pattern), warmCache(systemId). Use cds.context.tenant. TTL=-1 means indefinite (for test systems).
      Files: .worktrees/cap-multitenant-saas/srv/cache/artifactCacheService.js
      Verify: `npx cds build --production` succeeds, file exports expected functions

- [ ] 7. Create srv/ai/capCheckpointSaver.js implementing LangGraph BaseCheckpointSaver: put(config, checkpoint, metadata), get(config), list(config, options), getTuple(config). Tenant-aware via cds.context.tenant.
      Files: .worktrees/cap-multitenant-saas/srv/ai/capCheckpointSaver.js
      Verify: `npx cds build --production` succeeds, exports CapCheckpointSaver class

- [ ] 8. Create srv/utils/idempotencyService.js with checkAndLock(key, operation, ttl), complete(key, result), fail(key, error), cleanExpired(). Default TTL 3600s.
      Files: .worktrees/cap-multitenant-saas/srv/utils/idempotencyService.js
      Verify: `npx cds build --production` succeeds, exports expected functions

- [ ] 9. Add saveOnError wrapper in capCheckpointSaver.js for fault tolerance - persists state before rethrowing.
      Files: .worktrees/cap-multitenant-saas/srv/ai/capCheckpointSaver.js
      Verify: grep for 'saveOnError' function export

---

## Feature 3: Service Layer Integration (FEAT-003)

Port and enhance TenantService, DiscoveryService, integrate cache/checkpoints into BrainService.

- [ ] 10. Create srv/tenant/ directory. Create srv/tenant/tenant-service.cds with TenantProfile, DiscoveryRun entities and actions: savePipoSystem, testConnection, triggerDiscovery.
      Files: .worktrees/cap-multitenant-saas/srv/tenant/tenant-service.cds
      Verify: `npx cds build --production` succeeds

- [ ] 11. Create srv/tenant/tenant-service.js with handlers: savePipoSystem - validate inputs, INSERT PISystem; testConnection - test DIR/ESR; triggerDiscovery - create run, emit event via cds.queued().
      Files: .worktrees/cap-multitenant-saas/srv/tenant/tenant-service.js
      Verify: `npx cds build --production` succeeds

- [ ] 12. Create srv/discovery-service.cds with PISystems, DiscoveryJobs, Artifacts projections and startDiscovery, getDiscoveryProgress, cancelDiscovery actions.
      Files: .worktrees/cap-multitenant-saas/srv/discovery-service.cds
      Verify: `npx cds build --production` succeeds

- [ ] 13. Create srv/discovery-service.js porting from main repo. Integrate artifactCacheService (set after discover), idempotencyService (check before process), SSE emission. Preserve tenant context in async workers.
      Files: .worktrees/cap-multitenant-saas/srv/discovery-service.js
      Verify: `npx cds build --production` succeeds, grep for 'artifactCacheService' import

- [ ] 14. Port srv/utils/pipoSoapClient.js from main repo to worktree for PI/PO SOAP connectivity.
      Files: .worktrees/cap-multitenant-saas/srv/utils/pipoSoapClient.js
      Verify: File exists and exports PIPoSoapClient class

- [ ] 15. Port srv/utils/destinationService.js from main repo for BTP destination management.
      Files: .worktrees/cap-multitenant-saas/srv/utils/destinationService.js
      Verify: File exists

- [ ] 16. Enhance srv/brain-service.js: Import capCheckpointSaver. Add LangGraph tools - get_artifact, search_artifacts, get_dependencies, analyze_migration_path. Use checkpoint saver in graph construction, wrap with saveOnError.
      Files: .worktrees/cap-multitenant-saas/srv/brain-service.js
      Verify: `npx cds build --production` succeeds, grep for 'CapCheckpointSaver' import

- [ ] 17. Create srv/mtx/provisioning.js with MTXS subscription callbacks for tenant lifecycle (optional reference data seeding, cleanup on unsubscribe).
      Files: .worktrees/cap-multitenant-saas/srv/mtx/provisioning.js
      Verify: File exists and exports service extension function

---

## Feature 4: UI Wiring & API Integration (FEAT-004)

Frontend connectivity for settings form, auto-discovery, and chat.

- [ ] 18. Create app/aiconx/webapp/api-client.js with API methods: savePipoSystem, testPipoConnection, triggerDiscovery, subscribeDiscoveryEvents (EventSource), sendChatMessage, getArtifacts.
      Files: .worktrees/cap-multitenant-saas/app/aiconx/webapp/api-client.js
      Verify: File exports expected functions

- [ ] 19. Update btp_cockpit.html: Enhance 'Source System — SAP PI/PO' section with complete connection form (Virtual Host, Port, Protocol, Location ID, credentials). Add 'Save & Auto-Discover' button.
      Files: .worktrees/cap-multitenant-saas/app/aiconx/webapp/btp_cockpit.html
      Verify: grep for 'btn-save-discover-pipo' in file

- [ ] 20. Update btp_cockpit.html: Add chat panel div with chat-messages container, chat-input textarea, send button. Position as fixed right-side panel.
      Files: .worktrees/cap-multitenant-saas/app/aiconx/webapp/btp_cockpit.html
      Verify: grep for 'chat-panel' in file

- [ ] 21. Update btp_app.js: Add handler for btn-save-discover-pipo - collect form values, call savePipoSystem, triggerDiscovery, subscribe SSE, show progress, on completion enable chat.
      Files: .worktrees/cap-multitenant-saas/app/aiconx/webapp/btp_app.js
      Verify: grep for 'btn-save-discover-pipo' handler

- [ ] 22. Update btp_app.js: Add chat panel handlers - toggle visibility, send message, display response with tool usage sections.
      Files: .worktrees/cap-multitenant-saas/app/aiconx/webapp/btp_app.js
      Verify: grep for 'chat-panel' or 'sendChatMessage' in file

- [ ] 23. Update btp_style.css: Add styles for .chat-panel (fixed position, slide animation), .chat-messages, .chat-input, .discovery-progress-bar.
      Files: .worktrees/cap-multitenant-saas/app/aiconx/webapp/btp_style.css
      Verify: grep for '.chat-panel' in file

- [ ] 24. Update srv/server.js: Add SSE endpoint /api/discovery/events/:jobId. Add /api/brain/chat endpoint for chat messages.
      Files: .worktrees/cap-multitenant-saas/srv/server.js
      Verify: grep for '/api/discovery/events' and '/api/brain/chat' in file

---

## Digest

### Files to Create

| File | Purpose | Test Coverage |
|------|---------|---------------|
| db/tenant-schema.cds | PISystem, Artifact, DiscoveryJob + ref entities | cds build |
| db/cache-schema.cds | ArtifactCache entity | cds build |
| db/checkpoint-schema.cds | LangGraphCheckpoint, LangGraphMessage | cds build |
| db/idempotency-schema.cds | IdempotencyRecord entity | cds build |
| db/index.cds | Schema aggregator | cds build |
| srv/cache/artifactCacheService.js | Cache service with TTL | cds build |
| srv/ai/capCheckpointSaver.js | LangGraph checkpoint saver | cds build |
| srv/utils/idempotencyService.js | Duplicate handling | cds build |
| srv/tenant/tenant-service.cds | Tenant service CDS | cds build |
| srv/tenant/tenant-service.js | Tenant service handlers | cds build |
| srv/discovery-service.cds | Discovery service CDS | cds build |
| srv/discovery-service.js | Discovery with cache integration | cds build |
| srv/utils/pipoSoapClient.js | PI/PO SOAP client (port from main) | cds build |
| srv/utils/destinationService.js | BTP destinations (port from main) | cds build |
| srv/mtx/provisioning.js | MTXS callbacks | cds build |
| app/aiconx/webapp/api-client.js | API client for UI | Manual/browser test |

### Files to Modify

| File | Changes | Lines/Block |
|------|---------|-------------|
| srv/brain-service.js | Add capCheckpointSaver import, LangGraph tools | After existing imports (~line 5), add tools after buildMigrationGraph |
| srv/server.js | Add SSE /api/discovery/events and /api/brain/chat endpoints | After design-requests endpoints (~line 100) |
| app/aiconx/webapp/btp_cockpit.html | Enhance PI/PO form, add chat panel | screen-admin PI/PO section (~line 300), new chat-panel section |
| app/aiconx/webapp/btp_app.js | Add btn-save-discover-pipo handler, chat handlers | After existing handlers |
| app/aiconx/webapp/btp_style.css | Add .chat-panel, .discovery-progress-bar styles | End of file |

### Verified Today

- `npx cds build --production` works on current worktree (mta.yaml, package.json configured)
- MTXS sidecar already configured in mta.yaml with SaaS Registry, Service Manager
- xs-security.json has mtcallback scope for subscription
- Existing brain-service.js has LangGraph graph builder pattern to follow
- Existing vectorStore.js shows tenant-aware pattern with HANA/local fallback
- btp_cockpit.html has existing PI/PO section in screen-admin to enhance
