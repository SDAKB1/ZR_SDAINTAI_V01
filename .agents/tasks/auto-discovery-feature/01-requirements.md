# Requirements: Automatic PI/PO Discovery Feature

**Document Version:** 1.0  
**Date:** 2025-01-XX  
**Status:** Draft

---

## Table of Contents

1. [Overview](#1-overview)
2. [Functional Requirements](#2-functional-requirements)
3. [Non-Functional Requirements](#3-non-functional-requirements)
4. [Constraints and Assumptions](#4-constraints-and-assumptions)
5. [Out of Scope](#5-out-of-scope)

---

## 1. Overview

### 1.1 Purpose

This document defines the requirements for implementing automatic PI/PO discovery triggered when a tenant administrator saves and tests PI/PO system configuration in the UI. The feature enables seamless extraction of integration artifacts from SAP Process Integration/Orchestration systems for migration planning.

### 1.2 Background

The SDAINTAI platform is a CAP-based multi-tenant SaaS application that assists organizations in migrating from SAP PI/PO to SAP Integration Suite. This feature automates the discovery of PI/PO artifacts after successful connection testing, eliminating manual inventory creation.

### 1.3 System Context

```
SaaS Subscription
        ↓
SaaS Registry → MTXS Sidecar → Service Manager
        ↓
Tenant HDI Provisioning + CDS Deployment
        ↓
Tenant Admin Authentication (XSUAA)
        ↓
Admin Profile Submission (PI/PO System Configuration)
        ↓
CAP Tenant-Aware Service
        ↓
Persist Profile + Transactional Outbox
        ↓
Async Discovery Worker
        ↓
Mock / Live Adapter (PI/PO SOAP APIs)
        ↓
Tenant-Aware Upsert (HDI Container)
        ↓
UI Re-fetch / Notification
```

---

## 2. Functional Requirements

### 2.1 User Stories

#### US-001: Tenant Administrator Configures PI/PO System

**As a** tenant administrator  
**I want to** configure my PI/PO system connection details in the UI  
**So that** the platform can connect to my PI/PO system for artifact discovery

**Acceptance Criteria:**
- AC-001.1: Admin can enter PI/PO virtual host, port, and protocol
- AC-001.2: Admin can specify Cloud Connector location ID
- AC-001.3: Admin can provide technical user credentials
- AC-001.4: Admin can select PI/PO version (7.31, 7.40, 7.50)
- AC-001.5: System validates required fields before saving
- AC-001.6: Configuration is persisted to tenant-specific HDI container
- AC-001.7: Audit log entry is created for configuration save

#### US-002: Tenant Administrator Tests Connection

**As a** tenant administrator  
**I want to** test my PI/PO connection before initiating discovery  
**So that** I can verify connectivity and credentials are correct

**Acceptance Criteria:**
- AC-002.1: Admin can click "Test Connection" button
- AC-002.2: System tests connectivity to PI/PO Directory API
- AC-002.3: System tests connectivity to PI/PO ESR API
- AC-002.4: Test results display success/failure for each endpoint
- AC-002.5: On success, PI/PO version is auto-detected and displayed
- AC-002.6: On failure, meaningful error message is displayed
- AC-002.7: Test results are persisted (lastTestedAt, lastTestResult)
- AC-002.8: System status updates to reflect test outcome

#### US-003: Automatic Discovery Trigger

**As a** tenant administrator  
**I want** discovery to start automatically after successful connection test  
**So that** I don't have to manually trigger the discovery process

**Acceptance Criteria:**
- AC-003.1: After successful connection test, discovery job is queued automatically
- AC-003.2: User sees confirmation that discovery has been scheduled
- AC-003.3: Discovery job uses CAP transactional outbox for reliability
- AC-003.4: If discovery is already running for this system, new job is queued
- AC-003.5: User can optionally skip auto-discovery via UI toggle
- AC-003.6: Discovery options (artifact types, include inactive) are configurable

#### US-004: Discovery Progress Monitoring

**As a** tenant administrator  
**I want to** monitor discovery progress in real-time  
**So that** I know how much time remains and can identify issues early

**Acceptance Criteria:**
- AC-004.1: UI displays current discovery phase (1-6)
- AC-004.2: UI displays overall progress percentage
- AC-004.3: UI displays artifacts found/new/updated counts
- AC-004.4: UI displays error and warning counts
- AC-004.5: Progress updates appear within 2 seconds of backend changes
- AC-004.6: User can view detailed progress log
- AC-004.7: User can view error log with actionable details

#### US-005: Discovery Completion Notification

**As a** tenant administrator  
**I want to** be notified when discovery completes  
**So that** I can review results and proceed with migration planning

**Acceptance Criteria:**
- AC-005.1: UI notification appears when discovery completes
- AC-005.2: Notification indicates success/failure status
- AC-005.3: Notification shows summary (artifacts found, duration)
- AC-005.4: Inventory view automatically refreshes with new data
- AC-005.5: Email notification is sent (if configured)
- AC-005.6: Discovery job record shows completion status and duration

#### US-006: Integration Directory Discovery

**As a** system  
**I want to** extract configuration objects from PI/PO Integration Directory  
**So that** the tenant has complete visibility into their integration landscape

**Acceptance Criteria:**
- AC-006.1: System queries IntegratedConfigurationInService for ICOs
- AC-006.2: System queries IntegratedConfiguration750InService for PI 7.5 ICO variants
- AC-006.3: System queries CommunicationChannelInService for channels
- AC-006.4: System queries SenderAgreementInService for sender agreements
- AC-006.5: System queries ReceiverAgreementInService for receiver agreements
- AC-006.6: System queries ValueMappingInService for value mappings
- AC-006.7: System queries ConfigurationScenarioInService for scenarios
- AC-006.8: System queries AlertRuleInService for alert configurations
- AC-006.9: All artifacts include raw XML definition for full fidelity
- AC-006.10: System handles pagination for large result sets

#### US-007: Enterprise Services Repository Discovery

**As a** system  
**I want to** extract design-time objects from PI/PO ESR  
**So that** the tenant has complete mapping and interface definitions

**Acceptance Criteria:**
- AC-007.1: System discovers software components and namespaces
- AC-007.2: System discovers service interfaces (inbound/outbound)
- AC-007.3: System discovers message types
- AC-007.4: System discovers data types (schemas)
- AC-007.5: System discovers message mappings
- AC-007.6: System discovers operation mappings
- AC-007.7: System discovers imported XSDs and WSDLs
- AC-007.8: System identifies Java/XSLT mapping dependencies
- AC-007.9: Custom Java mappings are flagged for manual export if needed
- AC-007.10: All artifacts linked to their SWCV (Software Component Version)

#### US-008: Dependency Resolution

**As a** system  
**I want to** resolve dependencies between discovered artifacts  
**So that** impact analysis and migration sequencing are possible

**Acceptance Criteria:**
- AC-008.1: ICOs linked to their sender/receiver channels
- AC-008.2: ICOs linked to their mappings
- AC-008.3: Mappings linked to their message/data types
- AC-008.4: Channels linked to their adapter modules
- AC-008.5: Artifacts linked to their credential references
- AC-008.6: Dependencies stored in DependencyGraph entity
- AC-008.7: Circular dependencies detected and flagged
- AC-008.8: Missing dependencies logged as warnings

#### US-009: Subscription-Level Destination Provisioning

**As a** system  
**I want to** automatically create BTP destinations for each tenant's PI/PO system  
**So that** connectivity is managed securely per subscription

**Acceptance Criteria:**
- AC-009.1: Destination created at subscription level (not subaccount)
- AC-009.2: PIPO_DIRECTORY destination created for Integration Directory
- AC-009.3: PIPO_ESR destination created for ESR access
- AC-009.4: Destinations use naming convention: `{systemId}_DIRECTORY_{tenantId}`
- AC-009.5: Destinations configured for OnPremise proxy type
- AC-009.6: Credentials stored securely in destination (not in application DB)
- AC-009.7: Destination creation is idempotent (upsert behavior)
- AC-009.8: Destination validation performed after creation
- AC-009.9: Failed destination creation blocks discovery with clear error

#### US-010: Manual Discovery Trigger

**As a** tenant administrator  
**I want to** manually trigger re-discovery at any time  
**So that** I can refresh inventory after PI/PO changes

**Acceptance Criteria:**
- AC-010.1: "Refresh Discovery" button available in UI
- AC-010.2: User can select specific artifact types to re-discover
- AC-010.3: User can choose incremental (changed only) or full discovery
- AC-010.4: Existing artifacts updated (not duplicated) on re-discovery
- AC-010.5: Deleted artifacts in PI/PO flagged but not auto-removed
- AC-010.6: Discovery history maintained for comparison

---

### 2.2 Use Cases

#### UC-001: Configure and Discover PI/PO System

**Primary Actor:** Tenant Administrator  
**Goal:** Configure a new PI/PO system and initiate discovery

**Preconditions:**
- User is authenticated via XSUAA
- User has tenant admin role
- Tenant subscription is active
- Cloud Connector is configured for PI/PO access

**Main Flow:**
1. Admin navigates to PI/PO Systems configuration page
2. Admin clicks "Add System"
3. Admin enters system details (name, host, port, credentials, location ID)
4. Admin clicks "Save"
5. System validates configuration
6. System provisions subscription-level destinations
7. Admin clicks "Test Connection"
8. System tests Directory and ESR connectivity
9. System displays test results
10. On success, system automatically queues discovery job
11. Discovery worker processes job asynchronously
12. UI updates with progress
13. Discovery completes with notification
14. Inventory view shows discovered artifacts

**Postconditions:**
- PISystem record created with status "active"
- Destinations provisioned successfully
- DiscoveryJob completed with status "completed"
- Artifacts persisted to tenant HDI
- AuditLog entries created

**Alternative Flows:**
- 6a. Destination creation fails → Display error, abort save
- 8a. Connection test fails → Display error, allow retry
- 11a. Discovery worker fails → Retry with exponential backoff, max 3 attempts
- 13a. Discovery partially completes → Mark artifacts as partial, log errors

#### UC-002: Re-run Discovery After PI/PO Changes

**Primary Actor:** Tenant Administrator  
**Goal:** Refresh inventory after changes in PI/PO system

**Preconditions:**
- PI/PO system already configured and active
- Previous discovery completed

**Main Flow:**
1. Admin navigates to PI/PO system detail page
2. Admin clicks "Refresh Discovery"
3. Admin selects discovery options (full/incremental, artifact types)
4. Admin confirms action
5. System queues discovery job
6. Discovery worker compares new data with existing artifacts
7. New artifacts inserted, changed artifacts updated
8. Discovery completes with delta summary

**Postconditions:**
- DiscoveryJob completed with artifactsNew and artifactsUpdated counts
- Artifact records updated with new versions
- Previous artifact versions retained in history (if versioning enabled)

#### UC-003: Cancel Running Discovery

**Primary Actor:** Tenant Administrator  
**Goal:** Stop a running discovery job

**Preconditions:**
- Discovery job is in "running" status

**Main Flow:**
1. Admin views running discovery job
2. Admin clicks "Cancel"
3. System sets job status to "cancelled"
4. Worker receives cancellation signal
5. Worker completes current phase and stops
6. Partial results are preserved
7. UI shows cancellation confirmation

**Postconditions:**
- DiscoveryJob status is "cancelled"
- Artifacts discovered before cancellation are preserved
- System remains in consistent state

---

### 2.3 Business Rules

#### BR-001: Tenant Isolation
All PI/PO system configurations, destinations, and discovered artifacts must be strictly isolated per tenant. No cross-tenant data access is permitted.

#### BR-002: Destination Naming Convention
Destinations must follow the pattern `{SYSTEMNAME}_{TYPE}_{TENANTID}` where:
- SYSTEMNAME: User-defined system name (uppercase, max 20 chars)
- TYPE: DIRECTORY or ESR
- TENANTID: CAP tenant subdomain (max 30 chars)

#### BR-003: Discovery Job Concurrency
Only one discovery job per PI/PO system may be in "running" status at any time. Additional requests are queued.

#### BR-004: Artifact Versioning
When an artifact is re-discovered with changes, the previous version is preserved with a version number. Maximum 10 versions retained per artifact.

#### BR-005: Credential Security
PI/PO credentials must never be stored in application database tables. Credentials are stored only in BTP Destination service and referenced by destination name.

#### BR-006: Discovery Retry Policy
Failed discovery phases are retried up to 3 times with exponential backoff (1s, 4s, 16s). After max retries, job fails with detailed error.

#### BR-007: Audit Trail
All configuration changes, connection tests, and discovery jobs must be logged to AuditLog entity with user identity, timestamp, and action details.

#### BR-008: PI/PO Version Compatibility
System must support PI/PO versions 7.31, 7.40, and 7.50. Version-specific SOAP services (e.g., IntegratedConfiguration750InService) are used only when applicable.

#### BR-009: Inactive Artifact Handling
Inactive artifacts in PI/PO (piStatus = 'inactive') are discovered but flagged. They are excluded from migration scope by default.

#### BR-010: Discovery Timeout
Individual SOAP API calls timeout after 60 seconds. Overall discovery job timeout is 30 minutes for full discovery, 10 minutes for incremental.

---

### 2.4 Input/Output Specifications

#### INP-001: PI/PO System Configuration Input

| Field | Type | Required | Validation | Description |
|-------|------|----------|------------|-------------|
| systemName | String(50) | Yes | Alphanumeric, no spaces | User-friendly system identifier |
| description | String(200) | No | - | Optional description |
| virtualHost | String(200) | Yes | Valid hostname | Cloud Connector virtual host |
| virtualPort | Integer | No | 1-65535, default 443 | Port number |
| protocol | String(10) | No | http\|https, default http | Connection protocol |
| locationId | String(50) | Yes | Alphanumeric with underscore | Cloud Connector location ID |
| techUser | String(50) | Yes | - | PI/PO technical user name |
| techPassword | String(200) | Yes | Min 8 chars | PI/PO technical user password |
| piVersion | String(20) | No | 7.31\|7.40\|7.50, default 7.50 | PI/PO version |

#### OUT-001: Connection Test Result Output

```json
{
  "success": true,
  "timestamp": "2025-01-15T10:30:00Z",
  "directoryTest": {
    "success": true,
    "endpoint": "https://host:443/IntegratedConfigurationInService",
    "responseTimeMs": 245,
    "version": "7.50"
  },
  "esrTest": {
    "success": true,
    "endpoint": "https://host:443/rep/read/ext",
    "responseTimeMs": 312,
    "softwareComponents": 15
  },
  "errors": []
}
```

#### OUT-002: Discovery Progress Output

```json
{
  "jobId": "uuid-xxx",
  "status": "running",
  "startedAt": "2025-01-15T10:30:00Z",
  "currentPhase": 3,
  "currentPhaseName": "Discovering Communication Channels",
  "totalPhases": 6,
  "progressPercent": 45,
  "artifactsFound": 156,
  "artifactsNew": 142,
  "artifactsUpdated": 14,
  "errorsCount": 2,
  "warningsCount": 5,
  "estimatedCompletionAt": "2025-01-15T10:45:00Z"
}
```

#### OUT-003: Discovery Completion Summary

```json
{
  "jobId": "uuid-xxx",
  "status": "completed",
  "startedAt": "2025-01-15T10:30:00Z",
  "completedAt": "2025-01-15T10:42:15Z",
  "durationMs": 735000,
  "summary": {
    "totalArtifacts": 523,
    "byType": {
      "IntegratedConfiguration": 87,
      "CommunicationChannel": 164,
      "MessageMapping": 112,
      "OperationMapping": 45,
      "ServiceInterface": 68,
      "ValueMapping": 23,
      "SenderAgreement": 12,
      "ReceiverAgreement": 12
    },
    "byComplexity": {
      "simple": 312,
      "medium": 156,
      "complex": 55
    },
    "errorsCount": 3,
    "warningsCount": 12
  },
  "nextSteps": [
    "Review discovered artifacts in Inventory",
    "Assess migration complexity",
    "Define migration waves"
  ]
}
```

---

## 3. Non-Functional Requirements

### 3.1 Performance Requirements

#### PERF-001: Discovery Throughput
- System shall discover minimum 100 ICOs per minute
- System shall discover minimum 200 communication channels per minute
- System shall process SOAP responses up to 10MB in size

#### PERF-002: Response Times
- Connection test shall complete within 10 seconds
- Discovery job shall start within 5 seconds of trigger
- Progress updates shall reach UI within 2 seconds
- Inventory UI shall load 1000 artifacts within 3 seconds

#### PERF-003: Concurrent Discovery
- System shall support 10 concurrent discovery jobs across all tenants
- System shall support 3 concurrent discovery jobs per tenant

#### PERF-004: Database Performance
- Bulk artifact upsert shall handle 500 records per transaction
- Artifact queries shall use tenant-aware indexes
- Progress updates shall not exceed 10 DB writes per second per job

### 3.2 Security Requirements

#### SEC-001: Authentication
- All API endpoints require valid XSUAA JWT token
- Tenant context must be derived from token, not request parameters
- Token refresh handled automatically by CAP framework

#### SEC-002: Authorization
- System configuration requires "TenantAdmin" scope
- Discovery trigger requires "TenantAdmin" scope
- Artifact read requires minimum "TenantViewer" scope
- Audit log read requires "TenantAuditor" scope

#### SEC-003: Credential Protection
- PI/PO passwords shall never be logged
- PI/PO passwords shall never be stored in application database
- PI/PO passwords shall be transmitted only to Destination service via secure channel
- Destination service credentials shall use BasicAuthentication type

#### SEC-004: Transport Security
- All PI/PO communication shall use TLS 1.2 or higher
- Cloud Connector shall enforce encrypted tunnel
- Certificate validation shall be enabled (no self-signed in production)

#### SEC-005: Data Isolation
- Tenant HDI containers provide database-level isolation
- HANA row-level security enforced via CDS annotations
- API responses filtered by tenant context

#### SEC-006: Audit Logging
- All security-relevant actions logged with timestamp and user identity
- Audit logs immutable (no update or delete operations)
- Audit log retention minimum 365 days

#### SEC-007: Sensitive Data Handling
- Keystore references discovered without exporting private keys
- Certificate subject/issuer DN captured for inventory
- Credential aliases captured for migration planning (not actual credentials)

### 3.3 Scalability Requirements

#### SCALE-001: Tenant Scalability
- System shall support minimum 100 active tenant subscriptions
- Each tenant may configure up to 10 PI/PO systems

#### SCALE-002: Artifact Scalability
- System shall support up to 50,000 artifacts per tenant
- System shall support up to 500,000 total artifacts across platform

#### SCALE-003: Discovery Job Scalability
- System shall queue up to 100 pending discovery jobs
- Worker pool shall auto-scale based on queue depth

#### SCALE-004: Storage Scalability
- Artifact raw XML stored with compression
- PIPOCache TTL manages storage growth
- Archive policy removes discovery jobs older than 90 days (data retained)

### 3.4 Reliability Requirements

#### REL-001: Availability
- Discovery service availability target: 99.5%
- Connection test availability target: 99.9%
- Planned maintenance windows excluded from SLA

#### REL-002: Data Durability
- All persisted data protected by HANA backup/recovery
- Transactional outbox ensures at-least-once delivery
- No data loss on worker crash during discovery

#### REL-003: Error Recovery
- Failed discovery phases automatically retried (max 3 attempts)
- Network timeouts trigger retry with exponential backoff
- Partial discovery results preserved on job failure

#### REL-004: Idempotency
- Destination creation is idempotent (can be safely retried)
- Artifact upsert uses natural keys (no duplicates on retry)
- Discovery job creation uses deduplication key

#### REL-005: Circuit Breaker
- Circuit breaker activates after 5 consecutive PI/PO API failures
- Circuit breaker reset after 5 minutes
- Health check endpoint validates PI/PO connectivity

### 3.5 Maintainability Requirements

#### MAINT-001: Logging
- Structured JSON logging for all services
- Correlation ID propagated across async boundaries
- Log levels: ERROR, WARN, INFO, DEBUG (configurable)

#### MAINT-002: Monitoring
- Discovery job metrics exposed via /metrics endpoint
- Key metrics: job_duration, artifacts_discovered, error_rate
- Alerting thresholds configurable per environment

#### MAINT-003: Configuration
- Environment-specific settings via environment variables
- Feature flags for gradual rollout
- SOAP endpoint paths configurable (for PI/PO version differences)

#### MAINT-004: Mock Adapter
- Development environment uses mock adapter returning static responses
- Mock adapter mimics production latency and error conditions
- Mock data includes representative artifact samples

### 3.6 Usability Requirements

#### USE-001: Progress Visibility
- Discovery progress shown as percentage with phase description
- Estimated completion time displayed after phase 2
- Error/warning counts visible without opening logs

#### USE-002: Error Messages
- Error messages include actionable remediation steps
- Technical details available in expandable section
- Common errors linked to documentation

#### USE-003: Accessibility
- UI controls meet WCAG 2.1 AA compliance
- Progress updates announced to screen readers
- Keyboard navigation supported

---

## 4. Constraints and Assumptions

### 4.1 Technical Constraints

#### TC-001: CAP Framework
Implementation must use SAP CAP Node.js framework with:
- cds-mtx for multitenancy
- Built-in transactional outbox for async processing
- Native HANA database bindings

#### TC-002: BTP Services
Solution depends on:
- XSUAA for authentication
- Destination Service for credential management
- Cloud Connector for on-premise connectivity
- Service Manager for tenant provisioning

#### TC-003: PI/PO SOAP APIs
Discovery relies on PI/PO's documented SOAP APIs:
- Integration Directory services at standard paths
- ESR services may vary by PI/PO version
- No direct database access to PI/PO

#### TC-004: Network Requirements
- Cloud Connector must be pre-configured by customer
- Virtual host mapping must exist in Cloud Connector
- Firewall rules must allow Cloud Connector to PI/PO host

#### TC-005: HANA Cloud
- Tenant databases provisioned as HDI containers in HANA Cloud
- Large text fields limited by HANA LOB handling
- Full-text search requires SAP HANA Cloud, not HANA Service

### 4.2 Business Constraints

#### BC-001: Licensing
- Solution is tenant-metered SaaS
- Discovery operations do not incur per-call charges
- Artifact storage counts toward tenant quota

#### BC-002: Support Boundaries
- Only SAP PI/PO versions 7.31+ are supported
- Third-party middleware (Tibco, MuleSoft) not in scope
- BPM processes have limited discovery support

#### BC-003: Customer Responsibility
- Customer provides valid PI/PO credentials
- Customer configures Cloud Connector
- Customer grants appropriate PI/PO permissions to tech user

### 4.3 Assumptions

#### A-001: PI/PO API Availability
Assumed PI/PO system exposes standard SOAP APIs at documented paths. Custom deployments may require path configuration.

#### A-002: PI/PO Permissions
Assumed technical user has read access to:
- Integration Directory (all configuration objects)
- Enterprise Services Repository (all design objects)
- Adapter Framework (module configurations)

#### A-003: Cloud Connector Setup
Assumed Cloud Connector is already installed and connected to BTP subaccount. This feature does not automate Cloud Connector configuration.

#### A-004: Network Latency
Assumed network latency between BTP and on-premise PI/PO is under 200ms. Higher latency may affect discovery performance.

#### A-005: Artifact Volume
Assumed typical customer has 100-1000 ICOs. Customers with 10,000+ ICOs may require batched discovery approach.

#### A-006: ESR API Consistency
Assumed ESR APIs provide consistent behavior across PI/PO versions. Version-specific handling may be required based on testing.

---

## 5. Out of Scope

### 5.1 Explicitly Excluded Features

#### OOS-001: Cloud Connector Configuration
This feature does not automate Cloud Connector setup, configuration, or troubleshooting. Customers must pre-configure Cloud Connector with:
- Location ID
- Virtual host mappings
- Access control lists

#### OOS-002: PI/PO User Management
This feature does not create or manage PI/PO user accounts. Customers must provide:
- Technical user with appropriate authorizations
- Password management and rotation

#### OOS-003: Certificate Export
Discovery captures certificate metadata (subject, issuer, expiry) but does NOT export:
- Private keys
- Certificate files
- Keystore contents

#### OOS-004: BPM Process Discovery
Business Process Management (BPM) workflows in PI/PO have limited discovery:
- Process metadata captured
- BPEL definitions NOT extracted
- ccBPM patterns flagged but not fully parsed

#### OOS-005: Java Mapping Source Code
Custom Java mappings are identified but:
- Java source code NOT extracted
- JAR files NOT exported
- Only class names and dependencies captured

#### OOS-006: Runtime Message Content
Discovery does NOT access:
- Message payloads from runtime logs
- Adapter Engine message archives
- MPL (Message Processing Log) content

#### OOS-007: PI/PO System Administration
This feature does NOT provide:
- PI/PO system monitoring
- PI/PO cache invalidation
- PI/PO configuration changes

#### OOS-008: Real-time Synchronization
Discovery is triggered on-demand, not continuously synced:
- No push notifications from PI/PO
- No webhook subscriptions
- Manual refresh required after PI/PO changes

#### OOS-009: Migration Execution
This feature covers discovery only, NOT:
- Artifact conversion to iFlow
- Deployment to Integration Suite
- Post-migration testing

#### OOS-010: Third-Party Middleware
Discovery is specific to SAP PI/PO:
- No support for MuleSoft
- No support for Tibco
- No support for Dell Boomi
- No support for Apache Camel

#### OOS-011: Multi-Region Destinations
Initial implementation creates destinations in provider region only:
- Cross-region destination replication not supported
- Geo-redundant discovery not supported

#### OOS-012: Offline Discovery
Discovery requires live connectivity to PI/PO:
- No import from exported archives
- No analysis of static configuration files
- No Excel/CSV upload

---

## Appendix A: Discovery Phase Details

| Phase | Name | SOAP Service | Artifacts |
|-------|------|--------------|-----------|
| 1 | Configuration Scenarios | ConfigurationScenarioInService | ConfigurationScenario |
| 2 | Integrated Configurations | IntegratedConfigurationInService, IntegratedConfiguration750InService | ICO, ICO750 |
| 3 | Communication Channels | CommunicationChannelInService | Channel (Sender, Receiver) |
| 4 | Agreements | SenderAgreementInService, ReceiverAgreementInService | SenderAgreement, ReceiverAgreement |
| 5 | Value Mappings | ValueMappingInService | ValueMapping |
| 6 | ESR Objects | ESR Read API | ServiceInterface, MessageMapping, OperationMapping, MessageType, DataType |

---

## Appendix B: Destination Configuration Template

```json
{
  "Name": "PO_DEV_DIRECTORY_tenant123",
  "Type": "HTTP",
  "URL": "http://pipo-virtual:443",
  "ProxyType": "OnPremise",
  "CloudConnectorLocationId": "SDA_LAB",
  "Authentication": "BasicAuthentication",
  "User": "<tech-user>",
  "Password": "<secure-from-vault>",
  "sap-client": "000",
  "Description": "PI/PO DEV Integration Directory - Tenant tenant123"
}
```

---

## Appendix C: Error Code Reference

| Code | Category | Description | User Action |
|------|----------|-------------|-------------|
| PIPO-001 | Connection | Cloud Connector location not found | Verify Cloud Connector is running and location ID matches |
| PIPO-002 | Connection | Virtual host not reachable | Check Cloud Connector virtual host mapping |
| PIPO-003 | Authentication | Invalid credentials | Verify technical user and password |
| PIPO-004 | Authorization | Insufficient permissions | Grant required PI/PO authorizations to tech user |
| PIPO-005 | Timeout | SOAP request timeout | Check network latency, retry with smaller batch |
| PIPO-006 | Parse | Invalid SOAP response | Check PI/PO version compatibility |
| PIPO-007 | Discovery | Artifact limit exceeded | Use incremental discovery with filters |
| PIPO-008 | Storage | Destination creation failed | Check Destination service quota and permissions |
| PIPO-009 | System | Internal processing error | Contact support with job ID |

---

## Appendix D: LangGraph Integration Points

The discovery feature integrates with the existing Brain AI system for intelligent processing:

| Integration Point | Purpose | Trigger |
|-------------------|---------|---------|
| Complexity Assessment | Auto-assign complexity scores to discovered artifacts | Post-discovery batch job |
| Pattern Recognition | Identify scenario patterns (P2P, Multicast, BPM) | During artifact normalization |
| Dependency Analysis | Build and analyze dependency graph | After dependency resolution phase |
| Migration Recommendations | Suggest target tools and approaches | On-demand via UI action |

---

*Document End*
