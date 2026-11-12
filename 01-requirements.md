# Requirements: Wire All UI Controls to Backend Logic

**Project:** ZR_SDAINTAI_V01 — SDAINT-AI Migration Cockpit  
**Version:** 1.0  
**Date:** 2025-01-13  
**Status:** Draft

---

## Executive Summary

This document specifies the requirements to replace all mocked/simulated UI control behaviors in the SDAINT-AI Migration Cockpit with real backend service calls. The cockpit currently runs client-side demonstrations against sandbox/static data; this initiative wires every button, form submission, and interactive control to the existing CAP-based backend services (DiscoveryService, BrainService, AiconxService, DocumentService, RapDevOrchestratorService).

---

## 1. Functional Requirements

### 1.1 User Stories

#### US-001: Connection Testing
**As a** migration administrator  
**I want to** test PI/PO system connectivity via the "Test Connection" button  
**So that** I can verify the Cloud Connector and destination chain are correctly configured before starting discovery

**Acceptance Criteria:**
- AC-001.1: Clicking "Test Connection" (`btn-admin-test-pipo`) calls `DiscoveryService.testConnection(systemId)` instead of the current 1200ms setTimeout mock
- AC-001.2: The UI displays actual connection status (dirStatus, esrStatus, sldStatus) from the backend response
- AC-001.3: On failure, the error message from the backend is shown to the user
- AC-001.4: The PI version and artifact counts (swcvCount, icoCount, channelCount) are displayed on success

#### US-002: PI/PO System Registration
**As a** migration administrator  
**I want to** register a new PI/PO system through the Settings panel  
**So that** the system is persisted in the database and available for discovery operations

**Acceptance Criteria:**
- AC-002.1: The `registerPISystemWithBackend()` function calls `DiscoveryService.addPISystem()` with validated parameters
- AC-002.2: System registration succeeds with proper destination creation (destinationDir, destinationEsr)
- AC-002.3: Duplicate system names are rejected with a meaningful error message
- AC-002.4: The registered system appears in any system selection dropdowns

#### US-003: Asset Discovery (PI/PO Platform)
**As a** migration administrator  
**I want to** trigger artifact discovery via "Scan" / "Import Assets"  
**So that** real PI/PO artifacts (ICOs, channels, mappings) are fetched from the connected system

**Acceptance Criteria:**
- AC-003.1: `startAssetScan()` for PI/PO platform calls `DiscoveryService.startDiscovery()` instead of using static `ASSET_SETS.pipo`
- AC-003.2: Discovery progress is shown using `DiscoveryService.getDiscoveryProgress()` via polling or SSE
- AC-003.3: Discovered artifacts populate the asset table with real data (name, type, tier, dependencies)
- AC-003.4: Artifact complexity scoring uses `DiscoveryService.assessArtifact()` for accurate tier classification
- AC-003.5: Users can cancel ongoing discovery via `DiscoveryService.cancelDiscovery()`

#### US-004: Asset Discovery (MuleSoft/Informatica/Boomi Platforms)
**As a** migration administrator  
**I want to** scan assets from non-PI/PO platforms  
**So that** these platforms also connect to real backend discovery rather than static data

**Acceptance Criteria:**
- AC-004.1: `AiconxService.importBtpAssets(platform, mode)` is called for MuleSoft, Informatica, and Boomi platforms
- AC-004.2: The `generateBulkAssets()` function is replaced with backend-driven asset generation
- AC-004.3: Each platform's specific terms (idLabel, nameLabel, typeLabel) are applied to real data

#### US-005: AI Brain Activation
**As a** migration administrator  
**I want to** activate the SDAINTAI Brain via the "Activate AI Engine" button  
**So that** all subsequent actions are logged and learned for smarter migrations

**Acceptance Criteria:**
- AC-005.1: `btn-activate-brain` click calls `BrainService.toggleBrain(key, true)`
- AC-005.2: `btn-deactivate-brain` click calls `BrainService.toggleBrain(key, false)`
- AC-005.3: Brain status panel displays real values from `BrainService.getBrainStatus(key)`
- AC-005.4: Status shows: enabled state, eventsCount, insightsCount, coherence, vectorCount

#### US-006: Migration Advisor Assessment
**As a** migration administrator  
**I want to** get AI-powered migration recommendations for each artifact  
**So that** I can understand complexity, recommended tools, and estimated effort

**Acceptance Criteria:**
- AC-006.1: Artifact assessment calls `BrainService.migrationAdvisor()` with real artifact metadata
- AC-006.2: Assessment results display: tier, complexityScore, recommendedTool, estimatedHours, riskLevel
- AC-006.3: Wave assignment recommendations are calculated by the backend, not client-side
- AC-006.4: Assessment rationale and prerequisite steps are shown to users

#### US-007: Artifact Approval Workflow
**As a** migration approver  
**I want to** approve or skip artifacts for migration  
**So that** only validated artifacts proceed to the conversion phase

**Acceptance Criteria:**
- AC-007.1: "Approve" action calls `DiscoveryService.approveArtifact(artifactId, wave, notes)`
- AC-007.2: "Skip" action calls `DiscoveryService.skipArtifact(artifactId, reason)`
- AC-007.3: Batch approval uses `DiscoveryService.batchApprove()` for multiple selections
- AC-007.4: Approval status persists across page refreshes

#### US-008: Wave Planning
**As a** migration administrator  
**I want to** generate and manage migration waves  
**So that** artifacts are organized into logical deployment groups

**Acceptance Criteria:**
- AC-008.1: "Generate Wave Plan" calls `DiscoveryService.generateWavePlan(systemId)`
- AC-008.2: Wave assignments from backend replace client-side `moveAssetToWave()`
- AC-008.3: Team assignments per wave are persisted to backend
- AC-008.4: Wave summary statistics come from `DiscoveryService.getDiscoverySummary()`

#### US-009: Integration Package Export
**As a** migration administrator  
**I want to** export the migration inventory to various formats  
**So that** I can share migration plans with stakeholders

**Acceptance Criteria:**
- AC-009.1: "Export PDF" (`btn-export-pdf`) calls `DiscoveryService.exportInventory()` with format='pdf'
- AC-009.2: CSV export calls the same endpoint with format='csv'
- AC-009.3: ZIP package download uses backend-generated content, not client-side JSZip
- AC-009.4: Export respects applied filters (types, tiers, statuses)

#### US-010: Integration Suite Deployment
**As a** migration administrator  
**I want to** push converted iFlows to SAP Integration Suite  
**So that** migrations are deployed to the target system

**Acceptance Criteria:**
- AC-010.1: "Push to BTP Integration Suite" (`btn-is-import-artifact`) calls real Integration Suite API
- AC-010.2: Package creation uses `pipoClient.createIntegrationPackage()`
- AC-010.3: iFlow deployment uses `pipoClient.deployIntegrationFlow()`
- AC-010.4: Deployment status polling uses `pipoClient.getDeploymentStatus()`
- AC-010.5: Undeploy functionality uses `pipoClient.undeployArtifact()`

#### US-011: Document Parsing
**As a** migration administrator  
**I want to** upload and parse migration-related documents  
**So that** document content is extracted and posted to the Brain for learning

**Acceptance Criteria:**
- AC-011.1: Document upload triggers `DocumentService.parseDocument()` instead of client-side parsing
- AC-011.2: Parsed fields are retrieved and displayed from backend response
- AC-011.3: Documents are registered in the Brain vector store
- AC-011.4: Supported formats (PDF, PNG, JPEG, WEBP, GIF) are validated server-side

#### US-012: RAP Development Orchestration
**As a** developer using the cockpit  
**I want to** trigger ABAP RAP development operations  
**So that** behavior implementations are generated and validated

**Acceptance Criteria:**
- AC-012.1: Behavior generation calls `RapDevOrchestratorService.generateBehaviorImpl()`
- AC-012.2: Consistency review calls `RapDevOrchestratorService.reviewConsistency()`
- AC-012.3: ATC check calls `RapDevOrchestratorService.runAtcCheck()`
- AC-012.4: Run status polling uses `RapDevOrchestratorService.getRunStatus()`

#### US-013: User Authentication
**As a** migration user  
**I want to** log in with real credentials  
**So that** my session is authenticated against the backend

**Acceptance Criteria:**
- AC-013.1: Login form submits to backend authentication endpoint (XSUAA)
- AC-013.2: Session token is stored and used for subsequent API calls
- AC-013.3: The "mock email verification" flow is replaced with real email verification or removed
- AC-013.4: Persona switching (Admin/Approver/Viewer) enforces backend role checks

#### US-014: Brain Event Capture
**As a** migration administrator  
**I want to** all user actions to be captured by the Brain  
**So that** the system learns from each migration

**Acceptance Criteria:**
- AC-014.1: `logBrainEvent()` calls `BrainService.captureEvent()` instead of local array push
- AC-014.2: Chat messages are captured via the same mechanism
- AC-014.3: Setting changes are logged to the Brain
- AC-014.4: Conversion outcomes are logged for learning

#### US-015: Execution Monitoring
**As a** migration administrator  
**I want to** monitor migration execution in real-time  
**So that** I can track progress and respond to issues

**Acceptance Criteria:**
- AC-015.1: Execution status is fetched from backend, not simulated with `setInterval`
- AC-015.2: Error logs are retrieved from `pipoClient.getErrorLogs()`
- AC-015.3: Message processing logs use `pipoClient.getMessageProcessingLogs()`
- AC-015.4: Wave completion events trigger real backend updates

---

### 1.2 Use Cases

#### UC-001: Complete Migration Discovery Flow

**Name:** Discover PI/PO Artifacts  
**Actor:** Migration Administrator  
**Preconditions:**
- User is authenticated with Admin role
- PI/PO system is registered in DiscoveryService
- Cloud Connector is configured and running

**Main Flow:**
1. User navigates to "Import Assets" screen
2. User clicks "Scan" button
3. System calls `DiscoveryService.startDiscovery()` with system configuration
4. System displays real-time progress from `getDiscoveryProgress()`
5. Upon completion, artifacts are displayed in the asset table
6. Each artifact shows complexity assessment from `assessArtifact()`

**Postconditions:**
- All discovered artifacts are persisted in the database
- Artifacts appear in the cockpit table with accurate metadata
- Discovery job is recorded in audit log

**Alternative Flows:**
- 4a: User cancels discovery → `cancelDiscovery()` is called
- 5a: Discovery fails → Error message from backend is displayed

#### UC-002: Approve Migration Wave

**Name:** Approve Artifacts for Migration  
**Actor:** Migration Approver  
**Preconditions:**
- Artifacts have been discovered and assessed
- User has Approver or Admin role

**Main Flow:**
1. User reviews artifacts on the Approval screen
2. User selects artifacts to approve
3. User assigns artifacts to a wave
4. User clicks "Approve"
5. System calls `DiscoveryService.batchApprove(artifactIds, wave, notes)`
6. System updates artifact status to "Approved"

**Postconditions:**
- Artifact status is persisted as "Approved"
- Artifacts are assigned to specified wave
- Approval is recorded in audit log

---

### 1.3 Business Rules

| Rule ID | Rule Description | Enforcement Point |
|---------|------------------|-------------------|
| BR-001 | Only Admin role can register PI/PO systems | `addPISystem` action |
| BR-002 | Only Admin role can start discovery jobs | `startDiscovery` action |
| BR-003 | Admin and Approver roles can approve artifacts | `approveArtifact`, `batchApprove` |
| BR-004 | Viewer role has read-only access to all entities | All entity projections |
| BR-005 | Brain activation requires valid master key | `toggleBrain`, all Brain actions |
| BR-006 | Artifacts must be assessed before approval | `approveArtifact` precondition |
| BR-007 | System connections must be tested before discovery | `startDiscovery` precondition |
| BR-008 | Wave 1 artifacts must complete before Wave 2 starts | Execution sequencing |
| BR-009 | All artifacts in a wave must be approved for production push | `pushAndImportToIS` gate |
| BR-010 | Document parsing requires ANTHROPIC_API_KEY | `parseDocument` action |

---

### 1.4 Input/Output Specifications

#### API Call: DiscoveryService.startDiscovery

**Input:**
```json
{
  "systemId": "UUID - registered PI system ID",
  "includeInactive": "boolean - include inactive ICOs",
  "includeHistory": "boolean - include versioned objects",
  "artifactTypes": "JSON array - ['ICO', 'Channel', 'Mapping'] or null for all"
}
```

**Output:**
```json
{
  "jobId": "UUID - discovery job identifier",
  "status": "string - STARTED | QUEUED",
  "estimatedTime": "integer - seconds",
  "message": "string - human-readable status"
}
```

#### API Call: BrainService.migrationAdvisor

**Input:**
```json
{
  "key": "string - brain activation key",
  "objectId": "string - artifact identifier",
  "objectDesc": "string - human description",
  "segmentCount": "integer - IDoc segments or steps",
  "hasZFields": "boolean - custom fields present",
  "mappingType": "string - graphical|xslt|java|abap|groovy|none",
  "adapterType": "string - idoc|soap|rest|sftp|as2|jdbc|rfc|jms|custom",
  "volumePerDay": "integer - estimated daily volume",
  "isBpmProcess": "boolean - ccBPM/stateful process",
  "isEdiBased": "boolean - EDI trading partner",
  "sourceSystem": "string - LEGACY_ERP|SAP_PI_PO|SAP_BW|NON_SAP_SAAS"
}
```

**Output:**
```json
{
  "objectId": "string",
  "objectType": "string - classified type",
  "tier": "string - simple|medium|complex",
  "complexityScore": "integer - 0-100",
  "recommendedTool": "string - BAPI|iFlow_SemiAuto|iFlow_Custom|LangChain_Pattern_C",
  "specificTool": "string - specific SAP tool/BAPI",
  "estimatedHours": "integer",
  "riskLevel": "string - low|medium|high",
  "waveAssignment": "integer - wave number",
  "rationale": "string",
  "steps": "JSON array - migration steps",
  "prereqs": "JSON array - prerequisites",
  "message": "string"
}
```

---

## 2. Non-Functional Requirements

### 2.1 Performance Requirements

| NFR ID | Requirement | Target | Measurement |
|--------|-------------|--------|-------------|
| PERF-001 | Connection test response time | < 5 seconds | End-to-end latency |
| PERF-002 | Asset scan initiation | < 2 seconds | Time to receive jobId |
| PERF-003 | Discovery progress update frequency | Every 2 seconds | Polling interval |
| PERF-004 | Large discovery job support | 1000+ artifacts | No timeout/crash |
| PERF-005 | Batch approval performance | 100 items in < 5s | API response time |
| PERF-006 | UI responsiveness during backend calls | No blocking | Async/await pattern |
| PERF-007 | Integration Suite deployment | < 30s per iFlow | Deployment time |
| PERF-008 | Document parsing (PDF) | < 10 seconds | Claude API + persistence |

### 2.2 Security Requirements

| NFR ID | Requirement | Implementation |
|--------|-------------|----------------|
| SEC-001 | All API calls require authentication | XSUAA JWT token validation |
| SEC-002 | Role-based access control | @requires annotations on CDS |
| SEC-003 | Brain activation key protection | Key never logged/exposed |
| SEC-004 | Credential handling | Passwords used only for destination creation |
| SEC-005 | CSRF protection | x-csrf-token header on mutations |
| SEC-006 | Secure credential storage | BTP Destination Service |
| SEC-007 | Audit logging | All mutations logged to AuditLog entity |
| SEC-008 | Input validation | Server-side validation on all actions |

### 2.3 Scalability Requirements

| NFR ID | Requirement | Target |
|--------|-------------|--------|
| SCAL-001 | Concurrent discovery jobs | 10 per tenant |
| SCAL-002 | Artifacts per system | 10,000+ |
| SCAL-003 | Concurrent users | 50 per tenant |
| SCAL-004 | Brain events storage | 1 million+ events |
| SCAL-005 | Vector store entries | 100,000+ embeddings |

### 2.4 Reliability Requirements

| NFR ID | Requirement | Implementation |
|--------|-------------|----------------|
| REL-001 | Retry on transient failures | Exponential backoff (pipoClient-improved.js) |
| REL-002 | Circuit breaker for destinations | Failure threshold: 5, reset: 60s |
| REL-003 | Discovery job resumability | Persist progress, allow restart |
| REL-004 | Graceful degradation | UI functional if Brain offline |
| REL-005 | Data consistency | Transactional writes |
| REL-006 | Error propagation | Meaningful error messages to UI |

---

## 3. Constraints & Assumptions

### 3.1 Technical Constraints

| ID | Constraint | Impact |
|----|------------|--------|
| TC-001 | SAP Cloud SDK required for destination access | Cannot use direct HTTP for PI/PO |
| TC-002 | Cloud Connector required for on-premise PI/PO | Network topology fixed |
| TC-003 | XSUAA for authentication | No custom auth providers |
| TC-004 | CAP CDS framework | Service definitions in .cds files |
| TC-005 | Anthropic API for document parsing | External dependency |
| TC-006 | No breaking changes to existing service contracts | Backward compatibility |
| TC-007 | SOAP endpoints for some PI/PO operations | XML parsing required |
| TC-008 | SQLite for local development | PostgreSQL/HANA for production |

### 3.2 Business Constraints

| ID | Constraint | Impact |
|----|------------|--------|
| BC-001 | Pre-existing demo mode must remain functional | Feature flag for mock data |
| BC-002 | No changes to UI visual design | Only wiring changes |
| BC-003 | Existing Brain activation workflow preserved | Key-based activation |
| BC-004 | Multi-tenant isolation required | Tenant-scoped data access |
| BC-005 | Backward compatibility with archived projects | Migration path needed |

### 3.3 Assumptions

| ID | Assumption | Risk if Invalid |
|----|------------|-----------------|
| ASM-001 | Backend services are already deployed and accessible | Blocking - services must exist |
| ASM-002 | Cloud Connector destinations are pre-configured | Discovery will fail |
| ASM-003 | Users have appropriate BTP roles assigned | Access denied errors |
| ASM-004 | Anthropic API key is configured for document parsing | Document parsing unavailable |
| ASM-005 | Integration Suite API credentials available | Deployment will fail |
| ASM-006 | Existing service implementations are correct | May need service-side fixes |
| ASM-007 | Network latency is acceptable (< 500ms to PI/PO) | Performance degradation |

---

## 4. Out of Scope

The following items are explicitly **NOT** included in this requirements scope:

### 4.1 Excluded Features

| Item | Reason |
|------|--------|
| New UI components or screens | This is a wiring effort, not UI enhancement |
| Backend service modifications | Services assumed to be complete |
| Database schema changes | Existing schema is sufficient |
| New authentication providers | XSUAA only |
| Mobile-responsive redesign | Desktop-first application |
| Internationalization (i18n) | English only for this phase |
| Offline mode support | Always-connected assumption |
| Third-party integrations beyond existing | Figaf, ALM out of scope |
| Performance optimization of backend | Backend assumed performant |
| Automated testing infrastructure | Separate testing initiative |

### 4.2 Excluded Platforms

| Platform | Current State | Out of Scope Reason |
|----------|---------------|---------------------|
| MuleSoft | Mock data only | No backend discovery service |
| Informatica | Mock data only | No backend discovery service |
| Dell Boomi | Mock data only | No backend discovery service |

**Note:** Only PI/PO platform has complete backend services (`DiscoveryService`, `pipoClient`). Other platforms will continue using mock data until their respective backend services are implemented.

### 4.3 Excluded UI Controls

The following UI controls will remain as client-side only (no backend wiring needed):

| Control | Reason |
|---------|--------|
| Drawer position toggle | UI-only preference |
| Theme switching | Client-side CSS |
| Sidebar accordion expansion | Navigation UX only |
| Lumi avatar animations | Visual feedback only |
| Toast notification dismissal | Ephemeral UI state |
| Modal open/close | UI state management |
| Tab switching | View navigation |
| Drag-and-drop for wave assignment | Uses existing `moveAssetToWave` which needs wiring |

---

## 5. UI Control to Backend Service Mapping

### 5.1 High Priority (Core Functionality)

| UI Control ID | Control Type | Current Behavior | Target Backend Call |
|---------------|--------------|------------------|---------------------|
| `btn-test-connection` | Button | 1200ms setTimeout mock | `DiscoveryService.testConnection()` |
| `btn-admin-test-pipo` | Button | 1200ms setTimeout mock | `DiscoveryService.testConnection()` |
| `btn-admin-test-pi8` | Button | Calls MCP ping (real) | Keep as-is (already real) |
| `btn-import-assets-trigger` | Button | Static ASSET_SETS | `DiscoveryService.startDiscovery()` |
| `btn-activate-brain` | Button | Local state toggle | `BrainService.toggleBrain(key, true)` |
| `btn-deactivate-brain` | Button | Local state toggle | `BrainService.toggleBrain(key, false)` |
| `btn-approve-start` | Button | Local state update | `DiscoveryService.batchApprove()` |
| `btn-is-import-artifact` | Button | Mock deployment | `pipoClient.deployIntegrationFlow()` |
| `btn-start-execution` | Button | setInterval simulation | Backend execution orchestration |

### 5.2 Medium Priority (Plan & Report)

| UI Control ID | Control Type | Current Behavior | Target Backend Call |
|---------------|--------------|------------------|---------------------|
| `btn-goto-wave-from-buckets` | Button | Client-side wave assign | `DiscoveryService.approveArtifact()` |
| `btn-export-pdf` | Button | Client-side jsPDF | `DiscoveryService.exportInventory(format='pdf')` |
| `btn-download-zip` | Button | Client-side JSZip | Backend package generation |
| `btn-download-report-csv` | Button | Client-side CSV | `DiscoveryService.exportInventory(format='csv')` |
| `btn-save-brain` | Button | Local archive | `BrainService.exportBrain()` |
| `btn-refresh-cockpit` | Button | Re-render local state | Fetch latest from backend |

### 5.3 Lower Priority (Settings & Admin)

| UI Control ID | Control Type | Current Behavior | Target Backend Call |
|---------------|--------------|------------------|---------------------|
| `admin-default-*` fields | Input | Local storage | Backend settings persistence |
| `persona-select` | Dropdown | UI filter only | Backend role validation |
| `btn-save-connection` | Button | Local state | Backend connection persistence |
| `lock-form` | Form | Session unlock | XSUAA authentication |
| `signup-form` | Form | Mock verification | Real user registration |

---

## 6. Implementation Notes

### 6.1 Error Handling Pattern

All backend calls should follow this pattern:

```javascript
async function callBackendAction(params) {
  try {
    showLoadingState();
    const response = await fetch('/odata/v4/service/action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': await getCsrfToken()
      },
      body: JSON.stringify(params)
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Backend call failed');
    }
    
    return await response.json();
  } catch (error) {
    showErrorToast(error.message);
    logBrainEvent('error', 'backend', { action: 'actionName', error: error.message });
    throw error;
  } finally {
    hideLoadingState();
  }
}
```

### 6.2 CSRF Token Handling

Use the existing `fetchBrainCsrfToken()` pattern and extend to all services:

```javascript
async function fetchServiceCsrfToken(servicePath) {
  const res = await fetch(`/odata/v4/${servicePath}/$metadata`, {
    method: 'GET',
    headers: { 'x-csrf-token': 'fetch' },
    credentials: 'same-origin'
  });
  return res.headers.get('x-csrf-token');
}
```

### 6.3 Progressive Enhancement

Implement a feature flag to allow fallback to mock mode for demos:

```javascript
const USE_BACKEND = window.SDAINTAI_CONFIG?.useBackend ?? true;

async function startAssetScan() {
  if (USE_BACKEND && S.platform === 'pipo') {
    return startRealDiscovery();
  }
  return startMockDiscovery(); // Existing mock behavior
}
```

---

## Appendix A: Service Endpoint Reference

| Service | Path | Key Actions |
|---------|------|-------------|
| DiscoveryService | `/odata/v4/discovery` | addPISystem, testConnection, startDiscovery, approveArtifact |
| BrainService | `/odata/v4/brain` | toggleBrain, captureEvent, migrationAdvisor, getBrainStatus |
| AiconxService | `/odata/v4/aiconx` | importPipoArtifacts, importBtpAssets |
| DocumentService | `/odata/v4/documents` | parseDocument |
| RapDevOrchestratorService | `/odata/v4/rap-dev` | generateBehaviorImpl, runAtcCheck |

## Appendix B: Related Files

| File | Purpose |
|------|---------|
| `app/aiconx/webapp/btp_app.js` | Main UI application logic (5000+ lines) |
| `app/aiconx/webapp/btp_cockpit.html` | Main HTML template |
| `srv/discovery-service.cds` | Discovery service definition |
| `srv/brain-service.cds` | Brain service definition |
| `srv/utils/pipoClient-improved.js` | PI/PO API client with retry/circuit breaker |
| `srv/utils/pipoDiscovery.js` | Discovery worker utilities |

---

*Document generated for SDAINT-AI Migration Cockpit backend wiring initiative.*
