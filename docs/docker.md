# Docker Demo Setup

> **CAP + MTXS + SQLite**, mocked authentication and integrations.
> Best for demonstrating rapid onboarding, tenant isolation and automated provisioning without BTP expenses.

---

## Demo Storyline (~5 minutes)

1. `docker compose up` starts the CAP app + MTX sidecar (SQLite), the mock PI/PO stub, the LangGraph chat service and the UI.

2. `demo.sh` subscribes two synthetic tenants ? **Dollarama** (retail) and **Bombardier** (aerospace) ? and prints what was provisioned for each.

3. Discovery runs automatically per tenant and the terminal shows the mocked PI/PO artifacts found.

4. The UI opens per tenant, showing only that tenant's discovered interfaces, with a chat panel.

5. The presenter chats with LangGraph about the discovered interfaces (e.g. "Which ICOs use IDoc?"), and selecting an interface scopes the chat to it.

> ?? **Synthetic data and mocked authentication only.** This demo runs locally and shows how the flow works. It does not prove BTP SaaS Registry, Service Manager or HANA HDI behaviour.

---

## Tasks

### D1 ? Docker Setup

- [ ] `docker-compose.yml` with services: `cap-app`, `mtx-sidecar`, `pipo-mock` (WireMock), `agent` (LangGraph, Python), `ui` (UI5 via approuter or cds watch).
- [ ] Shared network, healthchecks and `depends_on` ordering; one `.env.example` (LLM provider/key, `LLM_MODE=mock|live`).
- [ ] Volume for per-tenant SQLite files (`db-<tenant>.sqlite`) so isolation is visible on disk.
- [ ] `make demo` / `make reset` targets for a clean rerun in under 2 minutes.

### D2 ? Mocked Authentication and Tenancy

- [ ] CAP mocked auth with users per tenant: `alice@dollarama` (Admin, tenant `t-dollarama`), `bob@bombardier` (Admin, tenant `t-bombardier`), plus one Viewer each.
- [ ] `cds.requires.multitenancy: true` with `@sap/cds-mtxs` in local mode; tenant always taken from `cds.context.tenant`, never from the UI.
- [ ] Negative check: Alice calling Bombardier data returns 403/empty.

### D3 ? Automated Provisioning Script (`demo.sh`)

- [ ] Generic `onboard-tenant.sh <tenantId> <profile.json>`; no customer-specific logic. `demo.sh` calls it for both profiles in `demo/profiles/`.
- [ ] Steps: `cds subscribe` ? deploy model ? submit profile (`sourceMode: MOCK`) ? wait for discovery ? print a summary.
- [ ] Coloured terminal output per tenant: tenant ID, DB file, lifecycle state transitions (`PROVISIONING` ? `TECHNICALLY_READY` ? `PROFILE_PENDING` ? `ACTIVE`), discovery run ID and counts by artifact type.
- [ ] Idempotent: rerunning shows "already subscribed ? updated" with no duplicate data.
- [ ] Final side-by-side table: Dollarama vs Bombardier artifacts provisioned.

### D4 ? Mocked PI/PO Artifacts and Discovery

- [ ] Deterministic synthetic fixtures per tenant:
  - **Dollarama**: EDI 850/856, IDoc ORDERS/DESADV, POS file-to-IDoc, REST inventory
  - **Bombardier**: SOAP supplier quality, IDoc MATMAS/BOMMAT, SFTP engineering files, ccBPM collect pattern
- [ ] Cover ESR (SWCV, namespaces, data/message types, service interfaces, message/operation mappings) and ID (components, channels, ICOs, receiver determinations).
- [ ] WireMock stub exposes the fixtures through the same contract as the live PI/PO connector, so the `LivePiPoAdapter` path can also be shown.
- [ ] Discovery worker triggered from the outbox on profile submit; paginated, idempotent upserts; `provenance = MOCK`; status `COMPLETED` / `PARTIAL`.
- [ ] Live discovery log streamed to the terminal and UI ("Found 12 ICOs, 31 channels?").

### D5 ? UI Wired to Discovered Interfaces

- [ ] Landing page reads `getTenantReadiness()` and routes to provisioning, discovering or ready.
- [ ] Interfaces list (Fiori Elements list report): ICO, sender ? receiver, adapter types, mapping count, complexity, MOCK badge.
- [ ] Object page: channels, mappings, receiver determinations and dependency graph.
- [ ] Discovery progress loads automatically (WebSocket or polling with backoff), with no manual refresh.
- [ ] Tenant switcher in the header that only changes the mocked login user, so the demo shows isolation.
- [ ] Chat side panel; selecting an interface passes its ID as chat context.

### D6 ? LangGraph Chat Over Discovered Interfaces

- [ ] `agent` service (FastAPI + LangGraph) with `POST /chat` (streaming via SSE); CAP proxies it as a chat action so tenant and user come from the CAP context.
- [ ] Graph: `router` ? `retrieve` (tools) ? `analyse` ? `answer`, with checkpointer memory per tenant + session.
- [ ] Tools that call tenant-scoped CAP OData only:
  - `list_interfaces(filter)`
  - `get_interface(id)`
  - `get_mappings(id)`
  - `assess_migration(id)` (target iFlow pattern and Integration Suite adapter)
  - `summarize_landscape()`
- [ ] Guardrails: read-only tools, no cross-tenant parameters, answers cite artifact IDs, refuse when data is not found.
- [ ] `LLM_MODE=mock` gives scripted deterministic answers so the demo works offline; `live` uses the configured LLM.
- [ ] Demo prompts:
  - "Summarize my landscape"
  - "Which interfaces use IDoc?"
  - "What is the migration plan for ICO_ORDERS_850?"
  - "Show ccBPM interfaces and their risk"

### D7 ? Verification

- [ ] Smoke test `test.sh`: both tenants are ACTIVE, the artifact counts match the fixtures, and there is no cross-tenant leakage.
- [ ] Agent test: the same question gives different, tenant-correct answers for Dollarama and Bombardier.
- [ ] Rerun `demo.sh`: no duplicates. `make reset` restores a clean state.
- [ ] Short presenter runbook in `README.md` with the script, prompts and fallback if the LLM is unavailable.

---

## Done When

- [ ] `docker compose up && ./demo.sh` provisions both tenants and prints their artifacts with no manual steps.
- [ ] Each tenant's UI shows only its own discovered interfaces, labeled `MOCK`.
- [ ] Chat answers questions about the selected tenant's interfaces using those artifacts, and works offline in mock mode.

---

## What This Demo Proves vs Doesn't

| Proves | Doesn't Prove |
|--------|---------------|
| ? Tenant isolation logic | ? BTP SaaS Registry subscription flow |
| ? Discovery ? UI ? Chat flow | ? HDI container provisioning |
| ? LangGraph agent architecture | ? Real PI/PO API connectivity |
| ? Data model and relationships | ? Cloud Connector / destination service |
| ? Rapid onboarding UX | ? Production auth (XSUAA tokens) |

**This is the right demo for:** technical architecture review, internal stakeholders, early-stage client conversations about the approach.

**You'll still need BTP for:** client POCs where they want to touch real data, final sales demos, anything contractual.

---

## Quick Start

```bash
# Start all services
docker compose up -d

# Run the demo (provisions both tenants)
./demo.sh

# Open the UI
# Dollarama: http://localhost:4004?tenant=t-dollarama
# Bombardier: http://localhost:4004?tenant=t-bombardier

# Reset everything
make reset
```

---

## Architecture

```
???????????????????????????????????????????????????????????????????
?                        Docker Network                            ?
???????????????????????????????????????????????????????????????????
?  cap-app    ? mtx-sidecar ?  pipo-mock  ?   agent     ?   ui    ?
?  (CAP)      ? (cds-mtxs)  ? (WireMock)  ? (LangGraph) ? (UI5)   ?
?  :4004      ?  :4005      ?   :8080     ?   :8000     ?  :5000  ?
???????????????????????????????????????????????????????????????????
        ?              ?              ?              ?
        ??????????????????????????????????????????????
                              ?
                    ?????????????????????
                    ?   SQLite Volume   ?
                    ? db-t-dollarama.db ?
                    ? db-t-bombardier.db?
                    ?????????????????????
```

---

## Environment Variables

Create `.env` from `.env.example`:

```bash
# LLM Configuration
LLM_MODE=mock                    # mock | live
LLM_PROVIDER=anthropic           # anthropic | openai | azure
LLM_API_KEY=sk-...               # Only needed if LLM_MODE=live

# Demo Configuration  
DEMO_TENANTS=t-dollarama,t-bombardier
LOG_LEVEL=info
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Container won't start | Check `docker compose logs <service>` |
| Tenant not found | Run `./demo.sh` to provision tenants |
| Chat not responding | Check `LLM_MODE` in `.env` (use `mock` for offline) |
| Cross-tenant data visible | Clear volumes: `docker compose down -v` |
| Discovery stuck | Check `pipo-mock` logs for WireMock errors |

---

## Files

```
docker/
??? docker-compose.yml      # Main compose file
??? .env.example            # Environment template
??? Dockerfile              # CAP app image
??? Dockerfile.agent        # LangGraph agent image
??? demo.sh                 # Main demo script
??? onboard-tenant.sh       # Generic tenant provisioning
??? test.sh                 # Smoke tests
??? Makefile                # make demo, make reset
??? profiles/
    ??? dollarama.json      # Retail tenant profile
    ??? bombardier.json     # Aerospace tenant profile
```
