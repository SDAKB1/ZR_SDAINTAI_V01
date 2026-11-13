# PI/PO Landscape Discovery Guide

This document defines the complete extraction strategy for migrating from SAP PI/PO to SAP Cloud Integration.

---

## System Access

### PJ2 System Details

| Property | Value |
|----------|-------|
| System Name | PJ2 |
| Host | `<your-pipo-host>` |
| HTTP Port | 50000 |
| HTTPS Port | 50001 |
| Version | 7.50.x |
| Installation Number | `<installation-number>` |

### Access URLs

| Tool | URL | Purpose |
|------|-----|---------|
| **ESR** | `http://<your-pipo-host>:50000/rep/start` | Design objects (interfaces, mappings) |
| **Integration Directory** | `http://<your-pipo-host>:50000/dir/start` | Configuration objects (ICOs, channels) |
| **SLD** | `http://<your-pipo-host>:50000/sld` | System landscape |
| **Message Monitoring** | `http://<your-pipo-host>:50000/mdt` | Message tracking |
| **Channel Admin** | `http://<your-pipo-host>:50000/AdapterFramework/ChannelAdminServlet` | Channel status |
| **NWA** | `http://<your-pipo-host>:50000/nwa` | Administration |
| **ESR SimpleQuery** | `http://<your-pipo-host>:50000/rep/support/SimpleQuery` | ESR API queries |
| **Directory SimpleQuery** | `http://<your-pipo-host>:50000/dir/support/SimpleQuery` | Directory API queries |

### Credentials

- **User**: `<service-user>`
- **Password**: `<service-password>`

### Jump Server Access

- Jump Server IP: `<jump-server-ip>`
- PI/PO Internal IP: `<pipo-internal-ip>`
- Use MobaXterm: SSH to jump server, then access PI/PO

---

## SLD Data (System Landscape Directory)

### Technical Systems (3 systems)

| Name | Host | Version | Type |
|------|------|---------|------|
| EXT_SYSTEM_DEV on extsystemdev | `<external-system-host>` | - | Third Party |
| PJ2 on pj2 | `<pipo-host>` | 7.50.x | AS Java |
| SDA on s4 | `<s4-host>` | - | AS ABAP |

### Business Systems (3 systems)

| Name | Technical System | Client |
|------|------------------|--------|
| EXT_SYSTEM_DEV | EXT_SYSTEM_DEV on extsystemdev | - |
| INTEGRATION_ENGINE_JAVA_PJ2 | PJ2 on pj2 | - |
| S4_S4D_300_DEV | SDA on s4 | 300 of SDA |

### Software Catalog

- **Software Component Versions**: 21,230 total
- **Product Versions**: 5,012 total

---

## Object Types to Extract (Alphabetical)

### ESR Objects (`/rep/support/SimpleQuery`)

| Object Type | Priority | Description |
|-------------|----------|-------------|
| Adapter Metadata | 🟡 Nice | Custom adapter configs |
| Communication Channel Template | 🟡 Nice | Reusable channel templates |
| DataType | 🔴 Critical | Data type definitions |
| External Definition | 🔴 Critical | Imported XSD/WSDL |
| External Message | 🟡 Nice | External message defs |
| Fault Message Type | 🟡 Nice | Error message types |
| Function Library | 🔴 Critical | UDFs (Java functions) |
| IDOC | 🔴 Critical | IDoc definitions |
| Imported Archive | 🔴 Critical | JAR files |
| Integration Process | 🔴 Critical | ccBPM processes |
| MAP_HELPER | 🟡 Nice | Mapping helpers |
| Mapping Template | 🟡 Nice | Reusable mapping templates |
| Message Mapping | 🔴 Critical | Graphical/XSLT mappings |
| Message Type | 🔴 Critical | Message structures |
| Namespace Definition | 🟡 Nice | Namespace info |
| Operation Mapping | 🔴 Critical | Interface-to-mapping links |
| Process Component | 🟡 Nice | Process components |
| RFC Message | 🔴 Critical | RFC interfaces |
| Service Interface | 🔴 Critical | Inbound/Outbound interfaces |
| Subprocess | 🔴 Critical | ccBPM subprocesses |

### Directory Objects (`/dir/support/SimpleQuery` or SOAP)

| Object Type | Priority | Description |
|-------------|----------|-------------|
| Alert Rule | 🟡 Nice | Alerting configs |
| Business Component | 🟡 Nice | Logical grouping |
| Business System | 🔴 Critical | Endpoints |
| Communication Channel | 🔴 Critical | Adapter configs |
| Configuration Scenario | 🟡 Nice | Grouped configs |
| Integrated Configuration (ICO) | 🔴 Critical | Main routing config |
| Interface Determination | 🔴 Critical | Interface routing |
| Party | 🟡 Nice | Trading partners |
| Receiver Agreement | 🔴 Critical | Receiver settings |
| Receiver Determination | 🔴 Critical | Routing rules |
| Sender Agreement | 🔴 Critical | Sender settings |
| Value Mapping | 🔴 Critical | Code translations |

### SLD Objects (`/sld`)

| Object Type | Priority | Description |
|-------------|----------|-------------|
| Business System | 🔴 Critical | Logical systems |
| Product | 🟡 Nice | Product catalog |
| Software Component | 🟡 Nice | SWCV definitions |
| Technical System | 🟡 Nice | Physical systems |

**Total: 33 object types** (20 Critical + 13 Nice-to-have)

---

## API Endpoints for Programmatic Extraction

### ESR REST API Paths

| Path | Purpose |
|------|---------|
| `/rep/support/SimpleQuery` | Query form (POST with form data) |
| `/rep/query/ext/` | External query API |
| `/rep/read/ext/` | External read API |
| `/rep/query/int/` | Internal query |
| `/rep/read/int/` | Internal read |

### ESR Object-Specific Queries

```
/rep/query/ext/ServiceInterface
/rep/query/ext/MessageMapping
/rep/query/ext/OperationMapping
/rep/query/ext/MessageType
/rep/query/ext/DataType
/rep/query/ext/ExternalDefinition
/rep/query/ext/FunctionLibrary
/rep/query/ext/ImportedArchive
```

### Directory SOAP Services

```
/IntegratedConfigurationInService
/IntegratedConfiguration750InService
/CommunicationChannelInService
/SenderAgreementInService
/ReceiverAgreementInService
/ReceiverDeterminationInService
/InterfaceDeterminationInService
/ValueMappingInService
/ConfigurationScenarioInService
/BusinessComponentInService
/BusinessSystemInService
/PartyInService
/AlertRuleInService
```

### SLD API

```
/sld/cimom          - CIM Object Manager
/sld/ds/*           - Data services
/sld/content/*      - Content services
```

### Monitoring Paths

```
/mdt/*                              - Message Display Tool
/AdapterFramework/ChannelAdminServlet/*  - Channel monitoring
/CPACache/*                         - CPA Cache
```

---

## SimpleQuery Configuration

### Recommended Settings

- **Software Component**: All software components
- **Consider underlying software components**: ✅ Enabled
- **Use sync tables**: ✅ Enabled
- **Object Versions**: Consider only non-deleted
- **Release**: 7.50 (match system version)
- **Show request XML**: ✅ Enable to capture API format
- **Show response XML**: ✅ Enable to capture response format

---

## Message Prioritization Rules

### URL
`http://<your-pipo-host>:50000/mdt` → **Message Prioritization** tab

### Purpose
Prioritization rules define processing order for messages based on sender/receiver/interface combinations. These rules affect runtime behavior and should be documented for migration.

### Current Status
**No prioritization rules defined** (Line 0/0)

### Rule Structure (if any exist)

| Field | Description |
|-------|-------------|
| Description | Rule name/description |
| Priority | Processing priority (higher = processed first) |
| Sender Partner | Sender party filter |
| Sender Component | Sender business system |
| Receiver Partner | Receiver party filter |
| Receiver Component | Receiver business system |
| Interface | Interface name filter |
| Interface Namespace | Namespace filter |

### Migration Consideration
If prioritization rules exist, they need to be replicated in Cloud Integration using:
- Integration Flow priority settings
- Custom routing logic
- JMS queue prioritization

---

## Shell Commands for Bulk Extraction

### Authentication
```bash
# Base credentials
USER="<service-user>"
PASS="<service-password>"
HOST="http://<your-pipo-host>:50000"
```

### ESR SimpleQuery (POST)
```bash
# Query all ServiceInterfaces
curl -X POST "$HOST/rep/support/SimpleQuery" \
  -u "$USER:$PASS" \
  -d "type=ServiceInterface&qc=All+software+components&action=Submit"

# Query MessageMappings
curl -X POST "$HOST/rep/support/SimpleQuery" \
  -u "$USER:$PASS" \
  -d "type=MessageMapping&qc=All+software+components&action=Submit"

# Query all object types in a loop
for TYPE in ServiceInterface MessageMapping OperationMapping MessageType DataType ExternalDefinition FunctionLibrary ImportedArchive IntegrationProcess; do
  curl -X POST "$HOST/rep/support/SimpleQuery" \
    -u "$USER:$PASS" \
    -d "type=$TYPE&qc=All+software+components&action=Submit" \
    -o "esr_${TYPE}.xml"
done
```

### Directory SOAP Services
```bash
# Get all ICOs
curl -X POST "$HOST/IntegratedConfiguration750InService/IntegratedConfiguration750ImplBean" \
  -u "$USER:$PASS" \
  -H "Content-Type: text/xml" \
  -H "SOAPAction: http://sap.com/xi/BASIS/query" \
  -d '<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <query xmlns="http://sap.com/xi/BASIS"/>
  </soap:Body>
</soap:Envelope>'

# Get all Communication Channels
curl -X POST "$HOST/CommunicationChannelInService/CommunicationChannelImplBean" \
  -u "$USER:$PASS" \
  -H "Content-Type: text/xml" \
  -H "SOAPAction: http://sap.com/xi/BASIS/query" \
  -d '<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <query xmlns="http://sap.com/xi/BASIS"/>
  </soap:Body>
</soap:Envelope>'

# Get all Value Mappings
curl -X POST "$HOST/ValueMappingInService/ValueMappingImplBean" \
  -u "$USER:$PASS" \
  -H "Content-Type: text/xml" \
  -H "SOAPAction: http://sap.com/xi/BASIS/query" \
  -d '<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <query xmlns="http://sap.com/xi/BASIS"/>
  </soap:Body>
</soap:Envelope>'
```

### Directory - All Configuration Objects
```bash
# Loop through all directory services
SERVICES="IntegratedConfiguration750InService/IntegratedConfiguration750ImplBean \
  CommunicationChannelInService/CommunicationChannelImplBean \
  SenderAgreementInService/SenderAgreementImplBean \
  ReceiverAgreementInService/ReceiverAgreementImplBean \
  ReceiverDeterminationInService/ReceiverDeterminationImplBean \
  InterfaceDeterminationInService/InterfaceDeterminationImplBean \
  ValueMappingInService/ValueMappingImplBean"

for SVC in $SERVICES; do
  NAME=$(echo $SVC | cut -d'/' -f1)
  curl -X POST "$HOST/$SVC" \
    -u "$USER:$PASS" \
    -H "Content-Type: text/xml" \
    -H "SOAPAction: http://sap.com/xi/BASIS/query" \
    -d '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><query xmlns="http://sap.com/xi/BASIS"/></soap:Body></soap:Envelope>' \
    -o "dir_${NAME}.xml"
done
```

### SLD Data
```bash
# Get Business Systems
curl -X GET "$HOST/sld/cimom?class=SAP_BusinessSystem" \
  -u "$USER:$PASS" \
  -o "sld_business_systems.xml"

# Get Technical Systems
curl -X GET "$HOST/sld/cimom?class=SAP_ApplicationSystem" \
  -u "$USER:$PASS" \
  -o "sld_technical_systems.xml"

# Get Software Components
curl -X GET "$HOST/sld/cimom?class=SAP_SoftwareComponent" \
  -u "$USER:$PASS" \
  -o "sld_software_components.xml"
```

### Message Monitoring Data
```bash
# Get message overview (last 24 hours)
curl -X GET "$HOST/mdt/MessageList?status=all&maxResults=1000" \
  -u "$USER:$PASS" \
  -o "messages_overview.xml"

# Get messages by interface
curl -X GET "$HOST/mdt/MessageList?interface=YourInterfaceName&namespace=urn:your:namespace" \
  -u "$USER:$PASS"

# Get specific message payload
curl -X GET "$HOST/mdt/GetMessageBytesJavaServerPage?messageKey=<MESSAGE_KEY>&version=0&archive=false" \
  -u "$USER:$PASS"
```

### Channel Status
```bash
# Get all channel statuses
curl -X GET "$HOST/AdapterFramework/ChannelAdminServlet?action=status" \
  -u "$USER:$PASS" \
  -o "channel_status.xml"
```

### Complete Extraction Script
```bash
#!/bin/bash
# Full PI/PO landscape extraction

USER="<service-user>"
PASS="<service-password>"
HOST="http://<your-pipo-host>:50000"
OUTPUT_DIR="./pipo_extract_$(date +%Y%m%d)"

mkdir -p "$OUTPUT_DIR"/{esr,dir,sld,monitoring}

echo "=== Extracting ESR Objects ==="
for TYPE in ServiceInterface MessageMapping OperationMapping MessageType DataType ExternalDefinition FunctionLibrary ImportedArchive IntegrationProcess Subprocess FaultMessageType RFC_Message IDOC; do
  echo "  Fetching $TYPE..."
  curl -s -X POST "$HOST/rep/support/SimpleQuery" \
    -u "$USER:$PASS" \
    -d "type=$TYPE&qc=All+software+components&action=Submit" \
    -o "$OUTPUT_DIR/esr/${TYPE}.xml"
done

echo "=== Extracting Directory Objects ==="
declare -A DIR_SERVICES=(
  ["ICO"]="IntegratedConfiguration750InService/IntegratedConfiguration750ImplBean"
  ["Channel"]="CommunicationChannelInService/CommunicationChannelImplBean"
  ["SenderAgreement"]="SenderAgreementInService/SenderAgreementImplBean"
  ["ReceiverAgreement"]="ReceiverAgreementInService/ReceiverAgreementImplBean"
  ["ReceiverDetermination"]="ReceiverDeterminationInService/ReceiverDeterminationImplBean"
  ["InterfaceDetermination"]="InterfaceDeterminationInService/InterfaceDeterminationImplBean"
  ["ValueMapping"]="ValueMappingInService/ValueMappingImplBean"
)

for NAME in "${!DIR_SERVICES[@]}"; do
  SVC="${DIR_SERVICES[$NAME]}"
  echo "  Fetching $NAME..."
  curl -s -X POST "$HOST/$SVC" \
    -u "$USER:$PASS" \
    -H "Content-Type: text/xml" \
    -H "SOAPAction: http://sap.com/xi/BASIS/query" \
    -d '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><query xmlns="http://sap.com/xi/BASIS"/></soap:Body></soap:Envelope>' \
    -o "$OUTPUT_DIR/dir/${NAME}.xml"
done

echo "=== Extracting SLD Data ==="
curl -s "$HOST/sld/cimom?class=SAP_BusinessSystem" -u "$USER:$PASS" -o "$OUTPUT_DIR/sld/business_systems.xml"
curl -s "$HOST/sld/cimom?class=SAP_ApplicationSystem" -u "$USER:$PASS" -o "$OUTPUT_DIR/sld/technical_systems.xml"

echo "=== Extracting Monitoring Data ==="
curl -s "$HOST/AdapterFramework/ChannelAdminServlet?action=status" -u "$USER:$PASS" -o "$OUTPUT_DIR/monitoring/channel_status.xml"

echo "=== Extraction Complete ==="
echo "Output: $OUTPUT_DIR"
ls -la "$OUTPUT_DIR"/*
```

---

## Monitoring Data for Validation

### What to Extract from Message Monitoring (`/mdt`)

| Data Type | Purpose |
|-----------|---------|
| Sample messages (payload + headers) | Test data for validating converted iFlows |
| Message counts per interface | Baseline metrics for before/after comparison |
| Error messages | Edge cases to test in new system |
| Processing timestamps | Activity verification |

### For Each Active Interface, Capture

```
├── 1-2 successful message payloads (input + output)
├── 1-2 error message payloads (if any)
├── Message count (daily/monthly volume)
├── Last processed timestamp
└── Processing time (average)
```

### How Monitoring Data Helps Validation

| Validation Step | Monitoring Data Used |
|-----------------|----------------------|
| Functional testing | Replay captured payloads through CI iFlow |
| Output comparison | Compare PI output vs CI output for same input |
| Volume testing | Know expected throughput to simulate |
| Error handling | Test known error scenarios |
| Completeness check | Ensure all active interfaces were migrated |

**Recommendation**: Extract monitoring data for at least the **top 20 active interfaces** for validation testing.

---

## Cloud Connector Path ACL Requirements

The following paths must be whitelisted in Cloud Connector for BTP access:

### ESR Paths

```
/rep/support/SimpleQuery
/rep/query/ext/*
/rep/read/ext/*
/rep/query/int/*
/rep/read/int/*
```

### Directory SOAP Paths

```
/IntegratedConfigurationInService/*
/IntegratedConfiguration750InService/*
/CommunicationChannelInService/*
/SenderAgreementInService/*
/ReceiverAgreementInService/*
/ReceiverDeterminationInService/*
/InterfaceDeterminationInService/*
/ValueMappingInService/*
/ConfigurationScenarioInService/*
/BusinessComponentInService/*
/BusinessSystemInService/*
/PartyInService/*
/AlertRuleInService/*
```

### Monitoring Paths

```
/mdt/*
/AdapterFramework/ChannelAdminServlet/*
/CPACache/*
```

### SLD Paths

```
/sld/cimom
/sld/ds/*
/sld/content/*
```

---

## Required PI/PO Roles for Discovery

| Role | Authorization | Purpose |
|------|---------------|---------|
| SAP_XI_ADMINISTRATOR | S_XI_ADMIN, S_XI_CONFGDIR, S_XI_CONFGES | ESR + Directory read |
| SAP_XI_MONITOR | S_XI_MONITOR | Message volume data |
| SAP_SLD_READ | S_SLD_READ | Business system resolution |
| SAP_XI_AF_ADMIN | S_XI_AF_ADM | Channel health |
| SAP_XI_API_DISPLAY_USER | - | REST API access (prevents 403) |

**Recommendation**: Create composite role `Z_SDAINTAI_DISCOVERY` with activity 03 (Display) only.

---

## Migration Scope Summary

### In Scope (Critical for Migration)

- ✅ Service Interfaces (inbound/outbound)
- ✅ Message Mappings
- ✅ Operation Mappings
- ✅ Data Types & Message Types
- ✅ External Definitions (XSD/WSDL)
- ✅ Function Libraries (UDFs)
- ✅ Imported Archives (JARs)
- ✅ Integration Processes (ccBPM)
- ✅ Integrated Configurations (ICOs)
- ✅ Communication Channels
- ✅ Sender/Receiver Agreements
- ✅ Receiver/Interface Determinations
- ✅ Value Mappings
- ✅ Business Systems

### Out of Scope (Not Migrated)

- ❌ BPM Workflow objects (Action, Filter, Status Schema)
- ❌ Alert configurations (rebuilt in CI)
- ❌ Archive programs
- ❌ Modeling artifacts (ARIS objects)
- ❌ Reports and queries
- ❌ UI/documentation objects
- ❌ System configuration (NWA settings)

---

## Next Steps

1. **Connect to SLD** - Extract business systems and software components
2. **Query ESR** - Extract all critical object types starting with ServiceInterface
3. **Query Directory** - Extract ICOs, channels, and agreements
4. **Capture Monitoring Data** - Get sample messages for top 20 interfaces
5. **Validate Extraction** - Ensure counts match expected totals
