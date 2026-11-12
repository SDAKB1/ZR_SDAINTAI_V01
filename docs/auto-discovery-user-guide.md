# Auto-Discovery User Guide

**Version:** 1.0  
**Audience:** Tenant Administrators  
**Last Updated:** 2025-01-XX

---

## Introduction

The Auto-Discovery feature automatically extracts PI/PO integration artifacts when you configure and test a PI/PO system connection. This guide walks you through configuring your PI/PO system, understanding discovery progress, and working with discovered artifacts.

---

## Prerequisites

Before using Auto-Discovery, ensure:

1. **Cloud Connector is configured**
   - Cloud Connector installed and connected to your BTP subaccount
   - Virtual host mapping created for your PI/PO system
   - Location ID configured

2. **PI/PO technical user exists**
   - User created in PI/PO with read access
   - Required authorizations: `S_XI_ADMIN`, `S_XI_READ`

3. **Network connectivity**
   - Cloud Connector can reach PI/PO system
   - Firewall rules allow traffic on configured port

---

## Step-by-Step Guide

### 1. Add a PI/PO System

1. Navigate to **Settings → PI/PO Systems**
2. Click **+ Add System**
3. Fill in the configuration form:

| Field | Description | Example |
|-------|-------------|---------|
| **System Name** | Identifier (alphanumeric, no spaces) | `PO_PRODUCTION` |
| **Description** | Optional description | `Production PI/PO 7.50` |
| **Virtual Host** | Cloud Connector virtual host | `pipo-prod.internal` |
| **Port** | Connection port | `443` |
| **Protocol** | HTTP or HTTPS | `https` |
| **Location ID** | Cloud Connector location | `DC_EAST_1` |
| **Technical User** | PI/PO user with read access | `PIPO_TECH` |
| **Password** | User password | (stored securely) |
| **PI/PO Version** | System version | `7.50` |

4. Click **Save**

The system creates BTP destinations automatically.

---

### 2. Test the Connection

1. After saving, click **Test Connection**
2. Wait for the test to complete (typically 5-10 seconds)
3. Review results:

**Success:**
```
✅ Directory API: Connected
✅ ESR API: Connected
   PI/PO Version: 7.50
   Software Components: 12
```

**Partial Success:**
```
✅ Directory API: Connected
❌ ESR API: Timeout
   Check ESR endpoint configuration
```

**Failed:**
```
❌ Connection Failed
   Error: Invalid credentials (PIPO-003)
   Verify technical user and password
```

---

### 3. Automatic Discovery

When the connection test succeeds:

1. Discovery job is automatically queued
2. You'll see a notification:
   > "Discovery scheduled for PO_PRODUCTION"

3. Progress bar appears showing:
   - Current phase (1-6)
   - Percentage complete
   - Artifacts found

**Discovery Phases:**

| # | Phase | What's Discovered |
|---|-------|-------------------|
| 1 | Configuration Scenarios | Scenario groupings |
| 2 | Integrated Configurations | ICOs (routing rules) |
| 3 | Communication Channels | Sender/receiver channels |
| 4 | Agreements | Sender/receiver agreements |
| 5 | Value Mappings | Value mapping tables |
| 6 | ESR Objects | Interfaces, mappings, types |

**Typical Duration:**
- Small system (< 100 ICOs): 1-2 minutes
- Medium system (100-500 ICOs): 3-5 minutes
- Large system (500+ ICOs): 5-15 minutes

---

### 4. Monitor Progress

During discovery, the UI shows:

```
[========================================] 65%
Phase 4 of 6: Agreements

Artifacts Found: 287
  New: 280  |  Updated: 7  |  Errors: 0

Estimated Time Remaining: ~2 minutes
```

**Understanding Counts:**
- **New**: Artifacts discovered for the first time
- **Updated**: Existing artifacts with changed definitions
- **Errors**: Artifacts that couldn't be processed (see error log)

---

### 5. View Results

When discovery completes:

1. Notification appears:
   > "Discovery completed: 523 artifacts found"

2. Navigate to **Inventory** view
3. Use filters to explore:
   - By Type (ICO, Channel, Mapping, etc.)
   - By Status (Discovered, Assessed, Approved)
   - By Complexity (Simple, Medium, Complex)

**Artifact List View:**
```
| Name                    | Type        | Adapter | Complexity | Status     |
|------------------------|-------------|---------|------------|------------|
| Orders_Outbound_ICO    | ICO         | SOAP    | Medium     | Assessed   |
| Vendor_Inbound_ICO     | ICO         | IDoc    | Simple     | Discovered |
| CC_SOAP_SENDER_001     | Channel     | SOAP    | Simple     | Discovered |
| MM_Orders_Transform    | Mapping     | -       | Medium     | Discovered |
```

**Artifact Detail View:**
- Full configuration details
- Dependencies graph
- Migration assessment (if available)
- Raw XML definition

---

### 6. Refresh Discovery

To update your inventory after PI/PO changes:

1. Go to **PI/PO Systems → [Your System]**
2. Click **Refresh Discovery**
3. Choose options:
   - **Full Discovery**: Re-scan all artifacts
   - **Incremental**: Only detect changes (faster)
4. Click **Start**

Discovery compares new data with existing records:
- New artifacts are added
- Changed artifacts are updated
- Deleted artifacts are flagged (not removed)

---

## Configuration Options

### Auto-Discovery Toggle

Control automatic discovery behavior:

| Setting | Behavior |
|---------|----------|
| **ON** (default) | Discovery starts after successful test |
| **OFF** | Manual trigger via Refresh Discovery |

To change: **Settings → PI/PO Systems → Edit → Auto-Discovery**

---

### Discovery Options

When manually triggering discovery:

| Option | Description |
|--------|-------------|
| **Include Inactive** | Discover artifacts with inactive status in PI/PO |
| **Include History** | Discover previous versions (if available) |
| **Artifact Types** | Select specific types to discover |

---

## Troubleshooting

### Connection Test Failed

| Error | Cause | Solution |
|-------|-------|----------|
| "Location not found" | Cloud Connector location ID mismatch | Verify Location ID in Cloud Connector admin |
| "Host not reachable" | Virtual host mapping missing | Add mapping in Cloud Connector |
| "Invalid credentials" | Wrong username/password | Check PI/PO user credentials |
| "Access denied" | Missing authorizations | Add S_XI_ADMIN, S_XI_READ to user |
| "Timeout" | Network issues or PI/PO overloaded | Check connectivity, try again later |

### Discovery Stuck

If discovery stops progressing:

1. Check error log for details
2. Verify PI/PO system is responsive
3. Try cancelling and restarting
4. If persistent, check Cloud Connector connectivity

### Partial Results

If some artifact types show 0 count:

1. Check technical user has access to all areas
2. Verify ESR endpoint is correctly configured
3. Review phase-specific errors in job log

### Missing Artifacts

If expected artifacts aren't discovered:

1. Verify artifacts exist and are active in PI/PO
2. Check namespace/SWCV filters (if applied)
3. Enable "Include Inactive" option
4. Review discovery error log

---

## Best Practices

### Initial Setup

1. Start with a test/development PI/PO system
2. Verify connectivity and permissions
3. Run discovery and review results
4. Move to production systems

### Regular Refresh

- Schedule periodic refresh (weekly/monthly)
- Use incremental discovery for routine updates
- Run full discovery after major PI/PO changes

### Large Systems

For systems with 1000+ artifacts:

- Run discovery during off-peak hours
- Use artifact type filters for targeted updates
- Monitor memory usage in large inventories

### Security

- Use dedicated technical user for discovery
- Grant minimum required authorizations
- Rotate credentials periodically
- Review audit logs for access patterns

---

## FAQ

**Q: How long does discovery take?**
A: Typically 1-5 minutes for most systems. Large systems (500+ ICOs) may take 10-15 minutes.

**Q: Does discovery modify anything in PI/PO?**
A: No. Discovery is read-only and doesn't change PI/PO configuration.

**Q: Can I run discovery for multiple systems simultaneously?**
A: Yes, up to 3 concurrent discoveries per tenant.

**Q: What happens if I cancel discovery?**
A: Partial results are preserved. You can re-run discovery later.

**Q: Are credentials stored securely?**
A: Yes. Credentials are stored only in BTP Destination service, never in the application database.

**Q: How do I know if artifacts changed since last discovery?**
A: Re-run discovery—the system compares and reports new/updated/unchanged counts.

**Q: What if discovery fails repeatedly?**
A: Check the error log, verify connectivity, and ensure PI/PO is responsive. Contact support if issues persist.

---

## Getting Help

- **Error Codes**: See [Error Reference](#troubleshooting)
- **API Documentation**: See [Auto-Discovery API Reference](./auto-discovery-api.md)
- **Support**: Contact your administrator

---

*Document End*
