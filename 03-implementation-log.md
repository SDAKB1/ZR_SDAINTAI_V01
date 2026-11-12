# Implementation Log: Wire UI Controls to Backend Logic

**Project:** ZR_SDAINTAI_V01 — SDAINT-AI Migration Cockpit
**Implementation Date:** 2025-01-13
**Status:** Completed

---

## Summary

This implementation wires the SDAINT-AI Migration Cockpit UI controls to real CAP-based backend services, replacing client-side mocks with actual OData V4 service calls. The implementation maintains backward compatibility with demo mode for trade shows and offline presentations.

---

## Files Created

| File | Path | Purpose |
|------|------|---------|
| `api-client.js` | `app/aiconx/webapp/api-client.js` | Centralized API client module for OData V4 communication with CSRF handling, retry logic, and error handling |
| `ui-wiring.js` | `app/aiconx/webapp/ui-wiring.js` | UI wiring module that connects UI controls to backend services with mock fallbacks for demo mode |

## Files Modified

| File | Path | Changes |
|------|------|---------|
| `btp_cockpit.html` | `app/aiconx/webapp/btp_cockpit.html` | Added script includes for api-client.js and ui-wiring.js; added SDAINTAI_CONFIG for feature flags; version bumped to lumi32 |

## Files Enabled (Renamed from .disabled)

| Original | Enabled | Path |
|----------|---------|------|
| `discovery-service.js.disabled` | `discovery-service.js` | `srv/discovery-service.js` |
| `brain-service.js.disabled` | `brain-service.js` | `srv/brain-service.js` |

---

## Implementation Details

### 1. API Client Module (`api-client.js`)

The API client provides:

- **CSRF Token Management**: Automatic fetching and caching of CSRF tokens per service path with automatic refresh on 403 errors
- **Core HTTP Methods**:
  - `callAction()` - POST requests for OData actions
  - `callFunction()` - GET requests for OData functions
  - `fetchEntities()` - GET requests for entity sets with query options
- **Service-Specific APIs**:
  - `ApiClient.discovery.*` - DiscoveryService endpoints (US-001, US-002, US-003, US-007, US-008, US-009)
  - `ApiClient.brain.*` - BrainService endpoints (US-005, US-006, US-014)
  - `ApiClient.documents.*` - DocumentService endpoints (US-011)
  - `ApiClient.rapDev.*` - RapDevOrchestratorService endpoints (US-012)

### 2. UI Wiring Module (`ui-wiring.js`)

The UI wiring module provides:

- **Feature Flag Support**: `window.SDAINTAI_CONFIG.useBackend` controls backend vs demo mode
- **Connection Testing (US-001)**: `UIWiring.testConnection(systemId)` wires btn-test-connection, btn-admin-test-pipo
- **System Registration (US-002)**: `UIWiring.registerPISystem(params)` wires btn-save-connection
- **Asset Discovery (US-003)**: `UIWiring.startAssetScan(systemId, platform)` wires btn-import-assets-trigger with progress polling
- **Brain Operations (US-005)**: `UIWiring.activateBrain(key)`, `UIWiring.deactivateBrain(key)` wire brain buttons
- **Migration Advisor (US-006)**: `UIWiring.assessArtifact(artifactData)` for AI-powered assessment
- **Approval Workflow (US-007)**: `UIWiring.approveArtifact()`, `UIWiring.batchApprove()` wire approval buttons
- **Wave Planning (US-008)**: `UIWiring.generateWavePlan(systemId)` for wave generation
- **Export Operations (US-009)**: `UIWiring.exportInventory(systemId, format)` for PDF/CSV export
- **Brain Event Capture (US-014)**: `UIWiring.captureBrainEvent()` replaces local array push
- **Mock Fallbacks**: All methods have corresponding `_mock*` fallback methods for demo mode

### 3. Backend Service Handlers

Both `discovery-service.js` and `brain-service.js` were enabled (copied from .disabled variants):

- **DiscoveryService**: Handles PI/PO system management, discovery jobs, artifact operations, approvals
- **BrainService**: Handles brain activation, event capture, migration advisor AI pipeline

---

## User Story Coverage

| User Story | Status | Implementation |
|------------|--------|----------------|
| US-001: Connection Testing | ✅ Complete | `UIWiring.testConnection()` → `DiscoveryService.testConnection()` |
| US-002: PI/PO System Registration | ✅ Complete | `UIWiring.registerPISystem()` → `DiscoveryService.addPISystem()` |
| US-003: Asset Discovery (PI/PO) | ✅ Complete | `UIWiring.startAssetScan()` → `DiscoveryService.startDiscovery()` with progress polling |
| US-004: Asset Discovery (Other) | ⚠️ Demo Only | Non-PI/PO platforms continue using mock data (backend services not implemented) |
| US-005: Brain Activation | ✅ Complete | `UIWiring.activateBrain()` → `BrainService.toggleBrain()` |
| US-006: Migration Advisor | ✅ Complete | `UIWiring.assessArtifact()` → `BrainService.migrationAdvisor()` |
| US-007: Approval Workflow | ✅ Complete | `UIWiring.approveArtifact()`, `batchApprove()` → `DiscoveryService.approveArtifact()` |
| US-008: Wave Planning | ✅ Complete | `UIWiring.generateWavePlan()` → `DiscoveryService.generateWavePlan()` |
| US-009: Export Operations | ✅ Complete | `UIWiring.exportInventory()` → `DiscoveryService.exportInventory()` |
| US-010: IS Deployment | ⚠️ Existing | Uses existing `pipoClient` implementation |
| US-011: Document Parsing | ✅ Complete | `UIWiring.parseDocument()` → `DocumentService.parseDocument()` |
| US-012: RAP Dev Orchestration | ✅ Complete | `ApiClient.rapDev.*` methods ready |
| US-013: User Authentication | ⚠️ Existing | Uses existing XSUAA integration |
| US-014: Brain Event Capture | ✅ Complete | `UIWiring.captureBrainEvent()` → `BrainService.captureEvent()` |
| US-015: Execution Monitoring | ⚠️ Future | Requires additional backend implementation |

---

## Configuration

The implementation supports a feature flag for demo mode:

```html
<script>
  window.SDAINTAI_CONFIG = {
    useBackend: true,  // Set to false for pure demo mode
    mockDelay: 1200    // Simulated latency for mock calls
  };
</script>
```

---

## Verification

- ✅ Syntax validation passed for all JavaScript files (`node --check`)
- ✅ Module exports verified (ApiClient, UIWiring exposed globally)
- ✅ HTML includes updated with proper versioning
- ✅ Demo mode fallbacks tested via mock methods

---

## Notes

1. **Backward Compatibility**: The implementation preserves all existing demo functionality. Setting `useBackend: false` in the config reverts to mock behavior.

2. **Progressive Enhancement**: PI/PO is the only platform with complete backend services. Other platforms (MuleSoft, Informatica, Boomi) continue using static `ASSET_SETS` data.

3. **Error Handling**: All API calls include proper error handling with toast notifications and brain event logging.

4. **CSRF Protection**: The API client handles CSRF tokens automatically with refresh on expiration.

5. **Progress Polling**: Discovery operations use 2-second polling intervals per PERF-003 requirements.


---

## SAP Migration Course Gap Implementation (2026-11-11)

**Status:** Completed

Following a gap analysis comparing SDAINTAI against the official [SAP PO-to-IS Migration Course](https://learning.sap.com/courses/sap-process-orchestration-to-sap-integration-suite-migration), three key gaps were identified and implemented:

### Gap #1: Scenario Pattern Classification

**Problem:** SDAINTAI used internal tier terminology (simple/medium/complex) but didn't classify artifacts by SAP's standard scenario patterns used in the Migration Assessment Tool.

**Solution:** Added scenario pattern classification based on SAP's official taxonomy:
- `P2P_ASYNC` - Point-to-Point Asynchronous (maps to Standard iFlow Async)
- `P2P_SYNC` - Point-to-Point Synchronous (maps to Standard iFlow Sync)
- `MULTICAST` - Multicast/Split 1:N patterns (maps to iFlow with Splitter)
- `BPM` - Simple stateless BPM (maps to iFlow with Orchestration)
- `CCBPM` - Cross-Component BPM (maps to SAP Build Process Automation)
- `CUSTOM` - Non-standard patterns requiring analysis

**Files Modified:**
- `db/tenant-schema.cds` - Added `scenarioPattern` field to Artifact entity
- `db/tenant-schema.cds` - Added `ScenarioPatternRef` reference entity
- `srv/brain-service.js` - Added `SCENARIO_PATTERNS` constant and `classifyScenarioPattern()` helper
- `srv/brain-service.cds` - Added `scenarioPattern` and `scenarioPatternName` to migrationAdvisor return
- `srv/discovery-service.cds` - Added same fields to assessArtifact return

### Gap #2: SAP Migration Assessment Status Alignment

**Problem:** Internal tiers didn't align with SAP Migration Assessment Tool's official status terminology.

**Solution:** Added mapping from internal tiers to SAP's official statuses:
- `simple` → "Ready to migrate" (green in MAT)
- `medium` → "Adjustment required" (yellow in MAT)
- `complex` → "Evaluation required" (red in MAT)

Also added `matchedTemplate` field to reference SAP Business Accelerator Hub packages.

**Files Modified:**
- `db/tenant-schema.cds` - Added `sapMigrationStatus` and `matchedTemplate` fields to Artifact
- `srv/brain-service.js` - Added `SAP_STATUS_MAP` constant and `tierToSapStatus()` helper
- `srv/brain-service.cds` - Added fields to migrationAdvisor return
- `srv/discovery-service.cds` - Added fields to assessArtifact return

### Gap #3: Known Limitations Database

**Problem:** SDAINTAI didn't track known Integration Suite limitations that could block or complicate migration (e.g., NFS adapter not supported, ccBPM stateful processes).

**Solution:** Implemented a limitations tracking system:
- **Reference Data:** Pre-seeded database of 10 known IS limitations from SAP documentation:
  - `NFS_ADAPTER` - NFS Adapter not supported (blocker)
  - `ASMA_HEADER` - ASMA/Dynamic Configuration differences (major)
  - `ACK_HANDLING` - Acknowledgment handling differs (major)
  - `CCBPM_STATEFUL` - ccBPM stateful processes (blocker)
  - `JAVA_MAPPING` - Java mapping programs (major)
  - `ABAP_MAPPING` - ABAP mapping programs (major)
  - `JMS_ADAPTER` - JMS adapter differences (major)
  - `JDBC_STORED_PROC` - JDBC stored procedure differences (minor)
  - `RFC_TRFC` - tRFC/qRFC handling differences (minor)
  - `AS2_MDN` - AS2 MDN configuration differences (minor)

- **Automatic Detection:** `identifyLimitations()` function detects applicable limitations based on adapter type, mapping type, and features.
- **Effort Multiplier:** Each limitation has an effort multiplier (e.g., blocker = 3.0x, major = 1.5-2.0x) that adjusts estimated hours.
- **Instance Tracking:** `ArtifactLimitation` entity tracks detected limitations per artifact with resolution status.

**Files Modified:**
- `db/tenant-schema.cds`:
  - Added `ArtifactLimitation` entity (junction with resolution tracking)
  - Added `MigrationLimitationRef` entity (reference data)
  - Added `limitations` composition to Artifact
- `srv/brain-service.js`:
  - Added `KNOWN_LIMITATIONS` constant with detection rules
  - Added `identifyLimitations()` helper function
  - Updated `ruleMigrationAdvisor()` to return limitation data
  - Added `seedLimitationRef` action to seed reference data
- `srv/brain-service.cds` - Added `limitations`, `limitationCount`, `hasBlockers` to migrationAdvisor return
- `srv/discovery-service.js` - Updated `assessArtifact` to persist ArtifactLimitation records
- `srv/discovery-service.cds`:
  - Updated assessArtifact return type with limitation fields
  - Exposed `MigrationLimitations`, `ScenarioPatterns`, `ArtifactLimitations` entities

### New API Action

**`seedLimitationRef`** - Seeds the MigrationLimitationRef and ScenarioPatternRef tables with reference data from the KNOWN_LIMITATIONS and SCENARIO_PATTERNS constants. Called once during initial setup.

```javascript
// Example call
await brainService.send('seedLimitationRef', { key: 'AYMAN2026' });
// Returns: { seeded: 16, message: 'Seeded 16 reference records (limitations + scenario patterns)' }
```

### Schema Changes Summary

```
Artifact (existing entity)
├── scenarioPattern      : String(30)   // P2P_ASYNC, P2P_SYNC, MULTICAST, BPM, CCBPM, CUSTOM
├── sapMigrationStatus   : String(50)   // "Ready to migrate", "Adjustment required", "Evaluation required"
├── matchedTemplate      : String(200)  // SAP Business Accelerator Hub template
└── limitations          : Composition of ArtifactLimitation

ArtifactLimitation (new entity)
├── artifact            : Association to Artifact
├── limitation          : Association to MigrationLimitationRef
├── detectedAt          : DateTime
├── detectedBy          : String (auto | manual)
├── context             : LargeString (JSON)
├── resolutionStatus    : String (open | workaround_applied | accepted | resolved)
├── resolutionNotes     : LargeString
├── resolvedBy          : String
└── resolvedAt          : DateTime

MigrationLimitationRef (new reference entity)
├── code                : String(50) [key]
├── name                : String(200)
├── category            : String (adapter | runtime | feature | mapping)
├── severity            : String (blocker | major | minor)
├── description         : LargeString
├── detectionRules      : LargeString (JSON)
├── workaroundType      : String (none | manual | script | custom_adapter)
├── workaroundDesc      : LargeString
├── effortMultiplier    : Decimal(3,1)
├── sapNoteId           : String(20)
└── sapDocUrl           : String(500)

ScenarioPatternRef (new reference entity)
├── code                : String(30) [key]
├── name                : String(100)
├── description         : LargeString
├── detectionRules      : LargeString (JSON)
├── isTargetPattern     : String(100)
├── migrationApproach   : LargeString
├── standardTemplates   : LargeString (JSON)
├── baseComplexity      : String (simple | medium | complex)
└── typicalHours        : Decimal(5,1)
```

### Testing

After deployment, run these steps to verify:

1. **Seed reference data:**
   ```bash
   curl -X POST https://<app>/odata/v4/brain/seedLimitationRef \
     -H "Content-Type: application/json" \
     -d '{"key":"AYMAN2026"}'
   ```

2. **Test migrationAdvisor with new fields:**
   ```bash
   curl -X POST https://<app>/odata/v4/brain/migrationAdvisor \
     -H "Content-Type: application/json" \
     -d '{"key":"AYMAN2026","objectId":"TEST_ICO","adapterType":"jms","mappingType":"java","isBpmProcess":false}'
   ```

   Expected response should include:
   - `scenarioPattern: "P2P_ASYNC"`
   - `sapMigrationStatus: "Adjustment required"`
   - `limitations: [...]` with JMS and Java mapping limitations
   - `hasBlockers: false`

3. **Query reference data:**
   ```bash
   curl https://<app>/odata/v4/discovery/MigrationLimitations
   curl https://<app>/odata/v4/discovery/ScenarioPatterns
   ```


---

## SAP Migration Guide Gap Analysis Implementation (2026-11-11)

**Status:** Completed

Following a comprehensive comparison with the SAP `btp-process-orchestration-migration-guide` repository, additional gaps were identified and implemented to align SDAINTAI with SAP's official migration documentation.

### Gap #2: Standard Adapter Migration Matrix

**Problem:** SAP's migration guide has a comprehensive adapter-to-adapter mapping. SDAINTAI lacked this reference data for accurate adapter migration status reporting.

**Solution:** Added `ADAPTER_MIGRATION_MATRIX` constant with 40+ adapter mappings covering:
- Sender adapters: AS2, EDI, File, HTTP, IDoc, JDBC, JMS, Mail, OData, REST, RFC, SFTP, SOAP, etc.
- Receiver adapters: Same adapter types with receiver-specific migration paths
- Migration statuses: `direct`, `alternative`, `partial`, `planned`, `none`
- IS alternatives and limitations for each adapter

**Files Modified:**
- `srv/brain-service.js` - Added `ADAPTER_MIGRATION_MATRIX` constant and `lookupAdapterMigration()` helper
- `db/tenant-schema.cds` - Added `AdapterMigrationRef` entity
- `srv/discovery-service.cds` - Exposed `AdapterMigrations` entity

### Gap #3: Adapter Module Replacement Mapping

**Problem:** PI/PO adapter modules (like PayloadSwapBean, XMLAnonymizerBean) need specific conversion to IS equivalents. This wasn't tracked.

**Solution:** Added `ADAPTER_MODULE_MAPPING` constant with 9 common module types:
- `AF_Modules/MessageTransformBean` → XSLT or Groovy script
- `AF_Modules/PayloadSwapBean` → Mail adapter mapping or Groovy
- `AF_Modules/StrictXml2PlainBean` → XML to CSV/EDI/JSON converters
- `AF_Modules/XMLAnonymizerBean` → XSLT step
- `SAP_XI_IDOC/IDOCXmlToFlatConvertor` → XML to CSV converter
- `SAP_XI_IDOC/IDOCFlatToXmlConvertor` → Custom Groovy script
- `AF_Modules/PayloadZipBean` → Encoder/Decoder steps
- `AF_Modules/DynamicConfigurationBean` → External/runtime parameters
- `localejbs/ArchiverModuleBean` → Data archiving or Splunk

**Files Modified:**
- `srv/brain-service.js` - Added `ADAPTER_MODULE_MAPPING` constant and `identifyAdapterModules()` helper
- `db/tenant-schema.cds` - Added `AdapterModuleMigrationRef` entity
- `srv/discovery-service.cds` - Exposed `AdapterModuleMigrations` entity

### Gap #4: Security Material Migration Planning

**Problem:** SAP's security guide documents 8 types of security material. Our `CredentialInventory` was too basic.

**Solution:** Added enhanced `SecurityMaterialInventory` entity tracking:
- Material types: user_credentials, oauth2_client, oauth2_saml, oauth2_authcode, secure_param, ssh_known_hosts, pgp_public, pgp_secret, x509_cert, x509_keypair
- PI/PO keystore locations: TrustedCAs, ICM_SSL, TicketKeystore, UMEKeystore
- Certificate details: subject/issuer DN, expiry, algorithm, key length
- IS target material mapping and migration status

**Files Modified:**
- `db/tenant-schema.cds` - Added `SecurityMaterialInventory` entity
- `srv/discovery-service.cds` - Exposed entity

### Gap #5: Enterprise Integration Patterns Reference

**Problem:** SAP documents 9 EIP patterns with specific migration paths. This wasn't tracked.

**Solution:** Added `EIPPatternRef` entity for patterns:
- Aggregator, Splitter, Scatter-Gather
- Composed Message Processor
- Content-Based Routing, Recipient List
- Message Filter, Content Filter, Content Enricher

**Files Modified:**
- `db/tenant-schema.cds` - Added `EIPPatternRef` entity
- `srv/discovery-service.cds` - Exposed `EIPPatterns` entity

### Enhanced Migration Advisor

The `ruleMigrationAdvisor()` function now:
1. Looks up adapter migration status from `ADAPTER_MIGRATION_MATRIX`
2. Auto-adds adapter-specific limitations when migration is not `direct`
3. Returns new fields: `adapterMigrationStatus`, `adapterAlternative`

### New Seed Action

**`seedAdapterMigrationRef`** - Seeds the AdapterMigrationRef and AdapterModuleMigrationRef tables with reference data.

```javascript
await brainService.send('seedAdapterMigrationRef', { key: 'AYMAN2026' });
// Returns: { seeded: 50, message: 'Seeded 50 adapter/module migration reference records' }
```

### New Entities Summary

| Entity | Purpose | Records |
|--------|---------|---------|
| `AdapterMigrationRef` | PI/PO adapter → IS adapter mapping | 40+ |
| `AdapterModuleMigrationRef` | PI/PO module → IS step mapping | 9 |
| `SecurityMaterialInventory` | Security credential tracking | Per artifact |
| `EIPPatternRef` | Enterprise Integration Patterns | 9 |

### Data Sources

All reference data is sourced from the official SAP `btp-process-orchestration-migration-guide` repository:
- `docs/30-connectivity/standard-adapter-migration-2622c30.md`
- `docs/30-connectivity/adapter-modules-e402f4a.md`
- `docs/40-security/managing-security-material-in-cloud-integration-09ec016.md`
- `docs/70-interface-migration/integration-patterns-980eace.md`
- `docs/70-interface-migration/directory-api-07096c2.md`

---

## SAP NetWeaver 7.50 Enhancements (2025-01-XX)

### Summary

Enhanced SDAINTAI's PI/PO discovery and migration assessment to fully leverage SAP NetWeaver 7.50 Directory API capabilities. These enhancements close gaps identified from SAP's official `btp-process-orchestration-migration-guide` repository.

### Files Modified

| File | Path | Changes |
|------|------|---------|
| `pipoSoapClient.js` | `srv/utils/pipoSoapClient.js` | Added 7.50-specific APIs, module chain extraction, security config extraction |
| `discovery-service.js` | `srv/discovery-service.js` | Added 7.50 discovery phases, module extraction post-processing, credential inventory population |

### SAP NetWeaver 7.50 Specific Implementations

#### 1. IntegratedConfiguration750InService Support

Added methods to use the 7.50-specific ICO service that includes `ReceiverWildcardIndicator`:

```javascript
// Query ICOs with 7.50 fields
await client.queryIntegratedConfigurations750()

// Read full ICO with 7.50 fields
await client.readIntegratedConfiguration750(icoKey)
```

#### 2. Communication Channel Module Chain Extraction

Extracts full `<ModuleProcess><ProcessStep>` chains from channels:

```javascript
// Read channel with extracted module chain
const channel = await client.readCommunicationChannelWithModules(channelKey)
// channel.moduleChain = [{ sequence, moduleKey, moduleName, moduleType, parameters, isEquivalent }]
```

Module-to-IS mapping based on SAP's `adapter-modules-e402f4a.md`:
- `AF_Modules/PayloadSwapBean` → Content Modifier (swap body/attachment)
- `AF_Modules/StrictXml2PlainBean` → Encoder step (XML to Plain Text)
- `AF_Modules/XMLAnonymizerBean` → Content Modifier + Groovy Script
- `AF_Modules/MessageTransformBean` → Content Modifier
- `AF_Modules/DynamicConfigurationBean` → Content Modifier (header manipulation)
- `AF_Modules/RequestResponseBean` → Request Reply step pattern
- `AF_Modules/PayloadZipBean` → Encoder step (Zip)

#### 3. Configuration Scenario Support

Added support for Configuration Scenarios which group ICOs, channels, and agreements:

```javascript
// Query all scenarios
await client.queryConfigurationScenarios()

// Read scenario with all references
const scenario = await client.readConfigurationScenario(scenarioKey)
// scenario.integratedConfigurations = [...]
// scenario.communicationChannels = [...]
// scenario.senderAgreements = [...]
// scenario.receiverAgreements = [...]
```

#### 4. Sender/Receiver Agreement Read Operations

Full read operations for B2B agreements with security config extraction:

```javascript
await client.readSenderAgreement(key)
await client.readReceiverAgreement(key)
// Includes: headerSecurity, signatureAlgorithm, encryptionAlgorithm, certificateUsed
```

#### 5. Security Configuration Extraction

Extracts security material references from channels/agreements for migration planning:

```javascript
channel.securityConfig = {
  authMethod: 'Basic' | 'Certificate' | 'OAuth',
  credentialAlias: 'alias_name',
  certificates: [{ alias, value }],
  keystoreView: 'TrustedCAs' | 'ICM_SSL' | etc.
}
```

#### 6. Business System and Party Discovery

Added queries for B2B partner and component discovery:

```javascript
await client.queryBusinessSystems()
await client.queryParties()
```

### Discovery Service Enhancements

#### Updated Discovery Phases (9 phases)

```javascript
const DISCOVERY_PHASES = [
  { name: 'Software Components', weight: 5 },
  { name: 'Integrated Configurations (7.50)', weight: 20, use750: true },
  { name: 'Communication Channels', weight: 15 },
  { name: 'Channel Module Extraction', weight: 10, category: 'post' },
  { name: 'Message Mappings', weight: 15 },
  { name: 'Agreements', weight: 15 },
  { name: 'Value Mappings', weight: 10 },
  { name: 'Configuration Scenarios', weight: 5 },
  { name: 'Business Systems & Parties', weight: 5 },
];
```

#### Module Configuration Population

After channel discovery, automatically extracts and stores module chains:

```javascript
// Populates tenant.ModuleConfiguration entity
{
  channelId, moduleKey, moduleName, moduleType,
  parameters, processingSequence, isEquivalent, migrationNotes
}
```

#### Credential Inventory Population

Extracts credential references for security material migration planning:

```javascript
// Populates tenant.CredentialInventory entity
{
  credentialAlias, credentialType, authType,
  referencedBy, migrationStatus
}
```

### Bulk Extraction Methods (Migration Preparation)

Added optimized methods for full inventory extraction:

```javascript
// Extract all channels with module chains
const channels = await client.extractAllChannelsWithModules({
  includeInactive: false,
  maxChannels: 1000
})

// Extract all ICOs with 7.50 fields
const icos = await client.extractAllIcos750({
  use750Service: true,
  maxIcos: 500
})
```

### XML Namespace Constants

Added SAP XI namespace constants for SOAP operations:

```javascript
const XI_NAMESPACES = {
  basis: 'http://sap.com/xi/BASIS',
  basis750: 'http://sap.com/xi/BASIS/750',
  adapter: 'http://sap.com/xi/XI/Adapter',
  system: 'http://sap.com/xi/XI/System',
};
```

### Gap Closure Summary

| Gap | SAP Source | Implementation |
|-----|------------|----------------|
| Adapter Migration Matrix | standard-adapter-migration-2622c30.md | `ADAPTER_MIGRATION_MATRIX` in brain-service.js |
| Adapter Module Mapping | adapter-modules-e402f4a.md | `_identifyIsEquivalent()` in pipoSoapClient.js |
| 7.50-specific ICO Fields | directory-api-07096c2.md | `IntegratedConfiguration750InService` methods |
| Module Chain Extraction | examples-for-directory-api-dc70456.md | `_extractModuleChain()` method |
| Configuration Scenarios | directory-api-07096c2.md | `ConfigurationScenarioInService` methods |
| Security Material Inventory | managing-security-material-in-cloud-integration-09ec016.md | `_extractSecurityConfig()` method |
| Business Systems/Parties | directory-api-07096c2.md | `BusinessSystemInService`, `PartyInService` methods |

---
