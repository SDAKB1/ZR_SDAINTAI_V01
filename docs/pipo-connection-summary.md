# PI/PO Connection Architecture Summary

## Overview

This document describes the complete connectivity chain from SAP BTP applications to the on-premise PI/PO system (PJ2) for the migration project.

---

## System Landscape

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SAP BTP (Cloud Foundry)                          │
│                         Region: US10 (us10.hana.ondemand.com)               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     Subaccount: LAB-SDA                               │  │
│  │                                                                       │  │
│  │  ┌─────────────────────┐      ┌─────────────────────────────────┐    │  │
│  │  │  sdaintai-pipo-     │      │      Service Instances          │    │  │
│  │  │  rfc-mcp            │◄────►│  • AICONX-destination (lite)    │    │  │
│  │  │  (MCP Server)       │      │  • AICONX-connectivity (lite)   │    │  │
│  │  └─────────────────────┘      └─────────────────────────────────┘    │  │
│  │           │                              │                            │  │
│  │           │                              ▼                            │  │
│  │           │                   ┌─────────────────────────────────┐    │  │
│  │           │                   │      BTP Destinations           │    │  │
│  │           │                   │  • PO_PJ2_ESR (HTTP/OnPremise)  │    │  │
│  │           │                   │  • PO_PJ2_DIR (HTTP/OnPremise)  │    │  │
│  │           │                   └─────────────────────────────────┘    │  │
│  └───────────┼───────────────────────────────┼───────────────────────────┘  │
└──────────────┼───────────────────────────────┼──────────────────────────────┘
               │                               │
               │         Connectivity Proxy    │
               │    (connectivityproxy.internal.cf.us10.hana.ondemand.com)
               │                               │
               ▼                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SAP Cloud Connector                                │
│                     Location ID: SDA_LAB                                    │
│                     Admin: https://localhost:8445                           │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Virtual Host Mapping:                                                │  │
│  │  nwjava.consultsda.com:443  ──►  pj2sda.consultsda.com:50000         │  │
│  │  (Virtual)                       (Internal - HTTP)                    │  │
│  │                                                                       │  │
│  │  Protocol: HTTP                                                       │  │
│  │  Back-End Type: SAP Process Integration                               │  │
│  │  Check Result: Reachable ✓                                            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
               │
               │  Network (Internal: 10.1.1.x)
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Jump Server: 34.63.161.151                            │
│                       Internal IP: 10.1.1.23                                │
│                       (Was down - caused initial connectivity issues)       │
└─────────────────────────────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PI/PO System (PJ2)                                 │
│                                                                             │
│  Host: pj2sda.consultsda.com                                                │
│  Port: 50000 (HTTP)                                                         │
│  System Name: PJ2                                                           │
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

### 1. MCP Server (sdaintai-pipo-rfc-mcp)

**Deployed URL:** `https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com`

**Purpose:** Bridge server exposing PI/PO connectivity as MCP tools and REST APIs

**Authentication (for MCP endpoints):**
| User | Password | Notes |
|------|----------|-------|
| AYMANK | AYMANK | MCP Basic Auth User 1 |
| SAIREDDY | SAIREDDY | MCP Basic Auth User 2 |

**REST API Endpoints (no auth required):**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/pi8/ping` | GET | Check Cloud Connector tunnel status |
| `/api/pi8/objects` | GET | Fetch ESR objects via SimpleQuery |
| `/health` | GET | Health check for CF |

**Service Bindings:**
- `AICONX-destination` - Provides access to BTP Destinations
- `AICONX-connectivity` - Enables Cloud Connector tunnel routing

---

### 2. BTP Destinations

#### PO_PJ2_ESR (Enterprise Services Repository)

| Property | Value |
|----------|-------|
| Name | `PO_PJ2_ESR` |
| Type | HTTP |
| URL | `http://nwjava.consultsda.com:443` |
| Proxy Type | OnPremise |
| Authentication | BasicAuthentication |
| User | `SDAINT` |
| Password | `Password@1` |
| Location ID | `SDA_LAB` |
| Additional Properties | `systemname: PJ2` |

#### PO_PJ2_DIR (Integration Directory)

| Property | Value |
|----------|-------|
| Name | `PO_PJ2_DIR` |
| Type | HTTP |
| URL | `http://nwjava.consultsda.com:443` |
| Proxy Type | OnPremise |
| Authentication | BasicAuthentication |
| User | `SDAINT` |
| Password | `Password@1` |
| Location ID | `SDA_LAB` |
| Additional Properties | `systemname: PJ2`, `systemVersion: 7.50` |

---

### 3. Cloud Connector Configuration

**Subaccount Connection:**
- Region: cf-us10
- Subaccount ID: LAB-SDA
- Location ID: SDA_LAB
- Status: Connected ✓

**Virtual Host Mapping:**
| Virtual Host | Virtual Port | Internal Host | Internal Port | Protocol | Back-End Type |
|--------------|--------------|---------------|---------------|----------|---------------|
| nwjava.consultsda.com | 443 | pj2sda.consultsda.com | 50000 | HTTP | SAP Process Integration |

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
| User ID | `SDAINT` |
| Password | `Password@1` |
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

**Last successful fetch:** 243 objects (Nov 11, 2026)

---

## Troubleshooting History

### Issue: 503 / 502 Errors from MCP Server

**Root Cause:** Jump server (34.63.161.151) was down, breaking the Cloud Connector tunnel.

**Resolution:** Jump server restored; destinations credentials verified.

### Issue: 403 Forbidden on Ping

**Explanation:** The 403 on ping is **expected** - there's no service at the root `/` path on PI/PO. The ping proves the tunnel is working (the system answered).

### Issue: 0 Items Returned

**Possible Causes:**
1. Destination password mismatch - re-enter `Password@1` in BTP Destination
2. Need to restage MCP app: `cf restage sdaintai-pipo-rfc-mcp`
3. SDAINT user permissions changed on PI/PO

---

## Testing Commands

### From Jump Server (Direct to PI/PO)
```bash
curl -s -u "SDAINT:Password@1" \
  "http://pj2sda.consultsda.com:50000/rep/support/SimpleQuery" \
  -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  -d "qc=All+software+components&types=MAPPING&action=Start+query"
```

### Via MCP Server (Through Cloud Connector)
```bash
curl https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com/api/pi8/ping
curl https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com/api/pi8/objects
```

---

## Data Flow Summary

```
1. User/Agent calls MCP Server
   └─► https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com/api/pi8/objects

2. MCP Server reads destination config
   └─► AICONX-destination service → PO_PJ2_ESR destination

3. Request routed through Connectivity Service
   └─► AICONX-connectivity → connectivityproxy.internal.cf.us10.hana.ondemand.com:20003

4. Cloud Connector receives request
   └─► Matches virtual host nwjava.consultsda.com:443
   └─► Routes to internal pj2sda.consultsda.com:50000
   └─► Adds Basic Auth header (SDAINT:Password@1)

5. PI/PO processes SimpleQuery
   └─► Returns HTML with ESR object table

6. MCP Server parses response
   └─► Extracts object names, namespaces, SWCVs
   └─► Returns JSON to caller
```

---

## Software Components in PI/PO (PJ2)

| Software Component | Vendor | Description |
|-------------------|--------|-------------|
| SAP BASIS 7.50 | SAP | Standard SAP objects |
| PI_S4_PROCESS | sda | S/4HANA process integration |
| SWC_BPM_PIJ_SFTP | sda | BPM SFTP integration |
| SWC_S4H_FINANCE_DOC_IN | sda | Finance document inbound |
| SWC_S4H_MASTER_DATA_OUT | sda | Master data outbound |
| SWC_S4H_ORDER_2_CASH_IN | sda | Order to cash inbound |
| SWC_S4H_PURCHASE_2_PAY_IN | sda | Purchase to pay inbound |

---

## References

- [SAP Cloud Connector Documentation](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/cloud-connector)
- [SAP Migration Assessment](https://developers.sap.com/tutorials/migration-assessment/)
- [BTP Destination Configuration](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/http-destinations)
