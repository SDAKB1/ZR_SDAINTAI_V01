# PI/PO Connection Architecture Summary

## Overview

This document describes the complete connectivity chain from SAP BTP applications to the on-premise PI/PO system for the migration project.

---

## System Landscape

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SAP BTP (Cloud Foundry)                          │
│                         Region: <your-region>                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     Subaccount: <your-subaccount>                     │  │
│  │                                                                       │  │
│  │  ┌─────────────────────┐      ┌─────────────────────────────────┐    │  │
│  │  │  pipo-rfc-mcp       │      │      Service Instances          │    │  │
│  │  │  (MCP Server)       │◄────►│  • destination (lite)           │    │  │
│  │  └─────────────────────┘      │  • connectivity (lite)          │    │  │
│  │           │                   └─────────────────────────────────┘    │  │
│  │           │                              │                            │  │
│  │           │                              ▼                            │  │
│  │           │                   ┌─────────────────────────────────┐    │  │
│  │           │                   │      BTP Destinations           │    │  │
│  │           │                   │  • PO_ESR (HTTP/OnPremise)      │    │  │
│  │           │                   │  • PO_DIR (HTTP/OnPremise)      │    │  │
│  │           │                   └─────────────────────────────────┘    │  │
│  └───────────┼───────────────────────────────┼───────────────────────────┘  │
└──────────────┼───────────────────────────────┼──────────────────────────────┘
               │                               │
               │         Connectivity Proxy    │
               │    (connectivityproxy.internal.cf.<region>.hana.ondemand.com)
               │                               │
               ▼                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SAP Cloud Connector                                │
│                     Location ID: <your-location-id>                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Virtual Host Mapping:                                                │  │
│  │  <virtual-host>:443  ──►  <pipo-internal-host>:50000                 │  │
│  │  (Virtual)                 (Internal - HTTP)                          │  │
│  │                                                                       │  │
│  │  Protocol: HTTP                                                       │  │
│  │  Back-End Type: SAP Process Integration                               │  │
│  │  Check Result: Reachable ✓                                            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
               │
               │  Network (Internal)
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Jump Server: <jump-server-ip>                         │
│                       Internal IP: <internal-ip>                            │
└─────────────────────────────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PI/PO System                                       │
│                                                                             │
│  Host: <your-pipo-host>                                                     │
│  Port: 50000 (HTTP)                                                         │
│  System Name: <system-name>                                                 │
│  Version: SAP NetWeaver 7.50 / AS Java 7.53                                 │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Enterprise Services Repository (ESR)                               │   │
│  │  Integration Directory (DIR)                                        │   │
│  │  Adapter Framework                                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. MCP Server

**Purpose:** Bridge server exposing PI/PO connectivity as MCP tools and REST APIs

**Authentication:** Configure via environment variables (see deployment docs)

**REST API Endpoints:**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/pi8/ping` | GET | Check Cloud Connector tunnel status |
| `/api/pi8/objects` | GET | Fetch ESR objects via SimpleQuery |
| `/health` | GET | Health check for CF |

**Service Bindings:**
- `destination` - Provides access to BTP Destinations
- `connectivity` - Enables Cloud Connector tunnel routing

---

### 2. BTP Destinations

#### PO_ESR (Enterprise Services Repository)

| Property | Value |
|----------|-------|
| Name | `PO_ESR` |
| Type | HTTP |
| URL | `http://<virtual-host>:443` |
| Proxy Type | OnPremise |
| Authentication | BasicAuthentication |
| User | `<service-user>` |
| Password | `<service-password>` |
| Location ID | `<location-id>` |

#### PO_DIR (Integration Directory)

| Property | Value |
|----------|-------|
| Name | `PO_DIR` |
| Type | HTTP |
| URL | `http://<virtual-host>:443` |
| Proxy Type | OnPremise |
| Authentication | BasicAuthentication |
| User | `<service-user>` |
| Password | `<service-password>` |
| Location ID | `<location-id>` |

---

### 3. Cloud Connector Configuration

**Subaccount Connection:**
- Region: `<your-cf-region>`
- Subaccount ID: `<your-subaccount>`
- Location ID: `<your-location-id>`
- Status: Connected ✓

**Virtual Host Mapping:**
| Virtual Host | Virtual Port | Internal Host | Internal Port | Protocol | Back-End Type |
|--------------|--------------|---------------|---------------|----------|---------------|
| `<virtual-host>` | 443 | `<internal-pipo-host>` | 50000 | HTTP | SAP Process Integration |

---

### 4. Exposed Resource Paths (23 Total)

All paths configured with **"Path and All Sub-Paths"** access policy.

#### ESR (Enterprise Services Repository) Paths
| Path | Purpose |
|------|---------|
| `/rep/support/SimpleQuery` | ESR object catalog query (HTML form) |
| `/rep/query/ext` | ESR external query API |
| `/rep/query/int` | ESR internal query API |
| `/rep/read/ext` | ESR read API (download objects) |

#### Directory (DIR) SOAP Services
| Path | Purpose |
|------|---------|
| `/IntegratedConfiguration750InService` | ICO configuration (PI 7.50) |
| `/IntegratedConfigurationInService` | ICO configuration (legacy) |
| `/CommunicationChannelInService` | Communication channels |
| `/SenderAgreementInService` | Sender agreements |
| `/ReceiverAgreementInService` | Receiver agreements |
| `/ReceiverDeterminationInService` | Receiver determinations |
| `/InterfaceDeterminationInService` | Interface determinations |
| `/ReceiverRuleInService` | Receiver rules |
| `/ConfigurationScenarioInService` | Configuration scenarios |
| `/ValueMappingInService` | Value mappings |
| `/AlertRuleInService` | Alert rules |
| `/BusinessComponentInService` | Business components |
| `/BPMFacadeBeanImplService` | ccBPM processes |
| `/IntegrationProcessInService` | Integration processes |

#### Directory Query/Read Paths
| Path | Purpose |
|------|---------|
| `/dir/query/ext` | Directory external query |
| `/dir/read/ext` | Directory read API |

#### Monitoring & Runtime
| Path | Purpose |
|------|---------|
| `/mdt` | Message monitoring |
| `/AdapterFramework/ChannelAdminServlet` | Channel monitoring |
| `/CPACache` | CPA cache |

---

### 5. PI/PO System Credentials

**Technical User for API Access:**
| Property | Value |
|----------|-------|
| User ID | `<service-user>` |
| Password | `<service-password>` |
| Required Roles | `SAP_XI_API_DISPLAY_J2EE`, `SAP_XI_API_DEVELOP_J2EE`, `SAP_XI_MONITOR_J2EE` |

---

## Current Status

### MCP Server Endpoints

| Endpoint | Status | Response |
|----------|--------|----------|
| `/api/pi8/ping` | ✓ Working | Destinations reachable (may show 403 on root `/` - expected) |
| `/api/pi8/objects` | ✓ Working | Returns ESR objects when auth is correct |

### What the MCP Server Fetches

The MCP server queries **5 ESR object types** via SimpleQuery:

| Type | Label |
|------|-------|
| `ifmmessif` | Service Interface |
| `MAPPING` | Operation Mapping |
| `XI_TRAFO` | Message Mapping |
| `ChannelTemplate` | Communication Channel Template |
| `RepBProcess` | Integration Process |

---

## Troubleshooting History

### Issue: 503 / 502 Errors from MCP Server

**Root Cause:** Jump server down, breaking the Cloud Connector tunnel.

**Resolution:** Jump server restored; destinations credentials verified.

### Issue: 403 Forbidden on Ping

**Explanation:** The 403 on ping is **expected** - there's no service at the root `/` path on PI/PO. The ping proves the tunnel is working (the system answered).

### Issue: 0 Items Returned

**Possible Causes:**
1. Destination password mismatch - re-enter password in BTP Destination
2. Need to restage MCP app: `cf restage <app-name>`
3. Service user permissions changed on PI/PO

---

## Testing Commands

### From Jump Server (Direct to PI/PO)
```bash
curl -s -u "<service-user>:<service-password>" \
  "http://<pipo-host>:50000/rep/support/SimpleQuery" \
  -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  -d "qc=All+software+components&types=MAPPING&action=Start+query"
```

### Via MCP Server (Through Cloud Connector)
```bash
curl https://<mcp-server-url>/api/pi8/ping
curl https://<mcp-server-url>/api/pi8/objects
```

---

## Data Flow Summary

```
1. User/Agent calls MCP Server
   └─► https://<mcp-server-url>/api/pi8/objects

2. MCP Server reads destination config
   └─► destination service → PO_ESR destination

3. Request routed through Connectivity Service
   └─► connectivity → connectivityproxy.internal.cf.<region>.hana.ondemand.com

4. Cloud Connector receives request
   └─► Matches virtual host
   └─► Routes to internal PI/PO host
   └─► Adds Basic Auth header

5. PI/PO processes SimpleQuery
   └─► Returns HTML with ESR object table

6. MCP Server parses response
   └─► Extracts object names, namespaces, SWCVs
   └─► Returns JSON to caller
```

---

## References

- [SAP Cloud Connector Documentation](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/cloud-connector)
- [SAP Migration Assessment](https://developers.sap.com/tutorials/migration-assessment/)
- [BTP Destination Configuration](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/http-destinations)
