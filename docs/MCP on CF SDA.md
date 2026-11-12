# MCP on CF — SDAINTAI PI/PO & S/4HANA RFC Bridge

Standalone MCP server that lets Claude (and SDAINTAI's own CAP backend)
call SAP PI/PO or S/4HANA RFCs/BAPIs dynamically by name, deployed on
Cloud Foundry (`api.cf.us10.hana.ondemand.com`, org "System Design
Analysis (SDA) inc.", space `lab-sda_Space`). Code lives at
`mcp/pipo-rfc-server/` in both this repo and
[ZR_SDAINTAI_V01](https://github.com/SDAKB1/ZR_SDAINTAI_V01) (the
curated SDAINTAI-solution-only repo).

## Scope — enforced in code, not just here

This server only talks to **named, allowlisted systems**, each wired up
via its own set of environment variables:

- **`SDAINTAI`** — the only system actually configured today.
- **`SDADATAAI`** — a reserved name for a later session. Calling it
  before its `SDADATAAI_SAP_*` env vars are set returns a clear error
  ("reserved name but has no connection configured yet"), not a silent
  fallback to some default system.

There is no way to pass an arbitrary host/connection through this
server — callers pick a `system` name from a fixed `z.enum(['SDAINTAI',
'SDADATAAI'])`, never free-form connection parameters. This was an
explicit requirement: the server must not become a generic bridge to
any SAP system, only SDAINTAI (and SDADATAAI once it's ready).

## Why Node.js, not the originally-suggested Python/`pyrfc`

The user's starting snippet used Python's `mcp` SDK + `pyrfc`. Real
problems with that path, found before writing any code:

1. `from mcp.server.fastapi import FastMCP` is wrong — the actual
   import in the Python MCP SDK is `mcp.server.fastmcp`.
2. `pyrfc` requires the **SAP NW RFC SDK** (a licensed, non-redistributable
   C library) present at both **build time** (to compile the Python
   extension) and runtime. Cloud Foundry's generic `python_buildpack`
   has no path to that SDK — getting it onto CF would need either a
   custom buildpack or a Docker-based deploy with the SDK baked into
   the image, and the SDK itself requires an SAP S-user license to
   download (something that can't be fetched programmatically).

**What changed the plan:** this machine already has a **working,
proven** alternative — `@sap-rfc/node-rfc-library`, a private SAP npm
package already used in two sibling projects
(`vendor-invoice-management`, `vendor-invoice-management-fajvimuomexch`)
on this same machine. It vendors the NW RFC SDK **inside the npm
package itself**, with prebuilt native bindings for `linux-x64` already
present (`dist/sapnoderfcaddons/prebuilds/linux-x64/*.node` +
`dist/sapnoderfcaddons/nwrfcsdk/linux/`). That means a plain
`nodejs_buildpack` `cf push` just works — no custom buildpack, no
Docker, no SDK staging step. Since SDAINTAI's whole backend is already
Node.js/CAP, building this in Node.js instead of Python also avoids
introducing a second runtime into the stack.

The library's `RFCClient.open(connParams)` →
`connection.execute(rfcName, {import, changing, table})` gives the same
dynamic "call any RFC by name" behavior as the original Python
snippet's `conn.call(rfc_name, **import_parameters)` — plus a
`connection.getMetadata(rfcName)` method the Python version didn't
have, used here as a second MCP tool so Claude can look up an RFC's
expected parameters before calling it blind.

**Real, proven usage pattern reused from `vendor-invoice-management`**
(`srv/utils/poDataFetcher.js` there): CAP's `@sap/cds-rfc` plugin wraps
this same library via `cds.connect.to('S4RFC')`, with the destination
name (not raw host/credentials) in source — credentials live in a BTP
Destination, never committed. This MCP server follows the same
never-hardcode-credentials discipline, just via plain env vars instead
of `cds.requires`, since it's a standalone process, not a CAP service.

## Files

```
mcp/pipo-rfc-server/
  package.json      — @sap-rfc/node-rfc-library, @modelcontextprotocol/sdk, express, basic-auth, zod
  .npmrc             — maps @sap-rfc scope to SDA's private npm feed; auth token via env var, not hardcoded
  server.js          — the MCP server itself (see below)
  manifest.yml        — cf push manifest, nodejs_buildpack
  .env.example       — local-dev reference, never commit a real .env
  .gitignore         — excludes .env and node_modules locally
```

`server.js` exposes two MCP tools over Streamable HTTP, mounted at
`POST /mcp` (plus an unauthenticated `GET /health` for CF's health
check):

- **`call_rfc`** — `{ system, rfc_name, import_parameters,
  changing_parameters?, table_parameters? }` → executes the RFC, returns
  the full result (including nested structures/tables) as JSON text.
- **`get_rfc_metadata`** — `{ system, rfc_name }` → returns the RFC's
  expected parameter signature.

Every `/mcp` request is gated by **HTTP Basic Auth**.

## Credentials — as explicitly requested, with a flagged caveat

Two users, both with the username repeated as the password:

| Username | Password |
|---|---|
| `AYMANK` | `AYMANK` |
| `SAIREDDY` | `SAIREDDY` |

**Security note, stated plainly:** a password identical to the username
is trivially guessable. This is fine for initial wiring/testing, but
before this server is handling anything that actually reaches a real
PI/PO or S/4 system, rotate both to real passwords via:
```
cf set-env sdaintai-pipo-rfc-mcp MCP_PASS_1 '<real password>'
cf set-env sdaintai-pipo-rfc-mcp MCP_PASS_2 '<real password>'
cf restage sdaintai-pipo-rfc-mcp
```
`server.js` reads `MCP_USER_1`/`MCP_PASS_1`/`MCP_USER_2`/`MCP_PASS_2`
from env, falling back to the two defaults above only if unset — so
rotating is a `cf set-env` + restage, no code change.

## Deployment — what's done vs. what's still needed

**Done:** code written, CF manifest written, confirmed `cf` CLI is
already authenticated in this environment (`ayman.kabalan@consultsda.com`,
org "System Design Analysis (SDA) inc.", space `lab-sda_Space`,
`api.cf.us10.hana.ondemand.com`).

**Not yet done — needs real values before `cf push` will fully work:**

1. **`SAP_NPM_REGISTRY_TOKEN`** — the private npm feed token for the
   `@sap-rfc` scope. The sibling project `vendor-invoice-management`
   has this already working in its own `.npmrc`; the same token needs
   to be supplied here too (as a CF env var, not committed) before
   `npm install` can fetch `@sap-rfc/node-rfc-library` during staging:
   ```
   cf set-env sdaintai-pipo-rfc-mcp SAP_NPM_REGISTRY_TOKEN '<token>'
   ```
2. **Real SAP connection details for `SDAINTAI`** — `ashost`, `sysnr`,
   `client`, `user`, `passwd`. Deliberately left as empty placeholders
   per explicit instruction ("we can update SAP host connection
   later") — the server starts and logs which systems are configured
   vs. not, so this can be wired up without touching code:
   ```
   cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_ASHOST '<host>'
   cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_SYSNR '00'
   cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_CLIENT '<client>'
   cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_USER '<user>'
   cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_PASSWD '<password>'
   cf restage sdaintai-pipo-rfc-mcp
   ```
3. **First actual `cf push`** — not yet run. Once (1) is set:
   ```
   cd mcp/pipo-rfc-server
   cf push
   ```
   The app will start (health check passes) even with SDAINTAI's SAP
   connection unset — `call_rfc`/`get_rfc_metadata` will just return a
   clear "not configured yet" error for `SDAINTAI` until step 2 is done,
   matching how `SDADATAAI` behaves by design.
4. **SDADATAAI**, later — set its `SDADATAAI_SAP_*` env vars whenever
   that system is ready; no code change needed, it's already a live
   option in the `system` enum, just unconfigured.

## How SDAINTAI's CAP backend calls this

`srv/utils/pipoMcpClient.js` (new, this session) — uses the official
`@modelcontextprotocol/sdk` client (`Client` +
`StreamableHTTPClientTransport`) with the Basic Auth header set, mirroring
the connection-handling discipline already established in
`vendor-invoice-management/srv/utils/poDataFetcher.js` (timeout via
`Promise.race`, distinguishing transient vs. business errors — not yet
ported into this first version, flagged as a follow-up if this needs
production-grade retry behavior).

```js
const { callPipoRfc } = require('./utils/pipoMcpClient');

const result = await callPipoRfc('BAPI_PO_GETITEMS', {
  PURCHASEORDER: '4500001234',
  WITH_PO_HEADERS: 'X'
}, {
  system: 'SDAINTAI', // default; SDADATAAI once configured
  tableParameters: { PO_ITEMS: [], PO_HEADERS: [], RETURN: [] }
});
```

Needs `PIPO_MCP_URL`, `PIPO_MCP_USER`, `PIPO_MCP_PASS` set on the CAP
app's own environment once the MCP server is pushed and has a real
route (`https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com/mcp`
by default, per `manifest.yml`'s app name — confirm the actual assigned
route after first `cf push`, CF may suffix it if the route is taken).

## Open items, not yet resolved

- Real `SAP_NPM_REGISTRY_TOKEN` value needs copying over from wherever
  it's actually held for `vendor-invoice-management` (not duplicated
  into this doc — supply it directly via `cf set-env`).
- Real SDAINTAI SAP connection details.
- First `cf push` + smoke test (`call_rfc` against a known-safe,
  read-only RFC) not yet executed — do this before relying on the
  server for anything real.
- `pipoMcpClient.js`'s timeout/retry behavior is simpler than
  `poDataFetcher.js`'s proven pattern — revisit if this needs to be
  production-hardened later.
