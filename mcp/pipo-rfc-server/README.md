# SDAINTAI PI/PO MCP Server — PI8 (PJ2) Quick Start

This server's proven, working path is **PI8** — reachability + real object
enumeration against the SAP PI/PO system **PJ2**, over HTTP through a Cloud
Connector, not RFC. It started as a proof of concept inside the SDADATAAI BW
cockpit's `bw-rfc-server` (`sdadataai-bw-rfc-mcp`, in the `ZR_SDADATAAI_V0`
repo) and has now been migrated here so it's native to SDAINTAI — PI8 is
being removed from the BW cockpit side now that this works.

It also carries a second, independent, generic RFC/BAPI bridge
(`call_rfc`/`get_rfc_metadata`) for a named SAP system reachable by direct
RFC — that path has never actually been pointed at a real system yet; don't
assume it's live the way PI8 is.

## What this is, in one line

A standalone MCP server + plain HTTP API that proves — and lets any MCP
client or the `btp_cockpit.html` browser page query — PI8/PJ2's real ESR
(Enterprise Services Repository) object catalog, no mock data required.

## How PI8 connectivity actually works

```
Browser (btp_cockpit.html)              MCP client (Claude Desktop/Code)
   │  fetch(PIPO_MCP_API_BASE               │  call_rfc / get_pi8_status /
   │        + '/api/pi8/ping'               │  list_pi8_esr_objects via
   │        or '/api/pi8/objects')          │  Basic Auth over /mcp
   ▼                                         ▼
          sdaintai-pipo-rfc-mcp  (this server, Cloud Foundry, Node.js)
                       │
                       │  @sap-cloud-sdk/http-client, destinationName lookup
                       ▼
          Destination service instance (AICONX-destination, bound to this app)
                       │
                       │  Cloud Connector destinations PO_PJ2_ESR / PO_PJ2_DIR
                       │  (ProxyType OnPremise)
                       ▼
          Cloud Connector  →  SAP PI/PO system PJ2 (nwjava.consultsda.com:443)
```

**Nothing here is an environment variable.** PI8 reachability doesn't go
through `cf set-env` — it goes through two things that must already exist in
your BTP subaccount:

1. A Cloud Connector mapping the virtual destinations `PO_PJ2_ESR` and
   `PO_PJ2_DIR` to the real PJ2 host (`nwjava.consultsda.com:443`),
   ProxyType `OnPremise`.
2. A destination-service instance that exposes those two destinations,
   bound to this app. `manifest.yml` binds the existing
   `AICONX-destination` instance by name (already shared with
   `AICONX`/`AICONX-srv`/`AICONX-mtx`) — confirm it still exists in your
   space with `cf services`. If you're deploying into a different BTP
   subaccount, you'll need to recreate the Cloud Connector mapping and a
   destination instance there first; there's no way around that from code.

A non-2xx HTTP response from PJ2 still counts as "reachable" in
`/api/pi8/ping` — only a connection-level failure (Cloud Connector/
destination chain broken) counts as unreachable.

## The real ESR object enumeration

The Cloud Connector's Resources ACL for `nwjava.consultsda.com:443`
allowlists `/rep/support/SimpleQuery` — the classic ESR "SimpleQuery"
servlet. `/api/pi8/objects` POSTs it directly with a fixed set of object
types (Service Interface, Operation Mapping, Message Mapping, Communication
Channel Template, Integration Process) and parses the real HTML results
table via each row's encoded `TYPE`/`KEY`/`SWCGUID` link params — confirmed
live against PJ2: **243 real objects**, including genuine custom content
under this org's own software component versions (not just SAP demo
objects). The response is capped at **150** returned items (`totalCount`
still reports the real total), custom objects sorted first.

## Option A — Connect to it as a remote MCP server (Claude Desktop / Claude Code)

Once deployed, the server is reachable at a CF route ending in `/mcp`
(confirm the exact URL with `cf app sdaintai-pipo-rfc-mcp` — defaults to
`https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com/mcp`).

Every `/mcp` request needs **HTTP Basic Auth** (ask whoever deployed the
server for the current username/password — don't assume the placeholder
defaults in `server.js` are still in use).

```json
{
  "mcpServers": {
    "sdaintai-pipo-rfc": {
      "url": "https://<your-route>.cfapps.us10.hana.ondemand.com/mcp",
      "headers": {
        "Authorization": "Basic <base64 of username:password>"
      }
    }
  }
}
```

Four tools are available:
- **`get_pi8_status`** — reachability proof for PJ2 through the Cloud Connector.
- **`list_pi8_esr_objects`** — the real ESR object catalog described above.
- **`call_rfc`** — `{ system: "SDAINTAI", rfc_name: "...", import_parameters: {...} }`
- **`get_rfc_metadata`** — `{ system: "SDAINTAI", rfc_name: "..." }`

## Option B — Call the plain REST endpoints directly (what btp_cockpit.html does)

These are **unauthenticated and CORS-open** on purpose — read-only,
low-sensitivity metadata (object technical names), never customer data —
so the browser page can call them without embedding Basic Auth credentials
in client-side JS:

```bash
curl https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com/api/pi8/ping
curl https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com/api/pi8/objects
```

`btp_cockpit.html`'s PI/PO migration-source flow calls these directly: when
"SAP PI/PO" is picked as the source platform and you hit **Start Asset
Scan**, it fetches `/api/pi8/objects` live and populates the asset table
from the real ESR catalog, falling back to the existing demo asset set (with
a toast) on any failure — same pattern already proven on the SDADATAAI BW
cockpit's PI8 Objects tab.

## Option C — Call it from Node.js/CAP code

```js
const { callPipoRfc } = require('../../srv/utils/pipoMcpClient');

const result = await callPipoRfc('BAPI_PO_GETITEMS', {
  PURCHASEORDER: '4500001234',
  WITH_PO_HEADERS: 'X'
}, {
  tableParameters: { PO_ITEMS: [], PO_HEADERS: [], RETURN: [] }
});
```

Requires `PIPO_MCP_URL` / `PIPO_MCP_USER` / `PIPO_MCP_PASS` env vars on the
calling app — only relevant to the `call_rfc` path, not PI8.

## Option D — Run the server locally (for development)

```bash
cd mcp/pipo-rfc-server
cp .env.example .env   # fill in real values — never commit .env
npm install            # public npm only, no private token needed
npm start
curl http://localhost:8080/health          # "ok"
curl http://localhost:8080/api/pi8/ping    # reachable:false — no destination service bound locally, expected
```

`npm install` used to require a private SDA npm feed token for
`@sap-rfc/node-rfc-library`; that dependency is gone — `call_rfc`/
`get_rfc_metadata` now run on `open-rfc` (public npm, zero dependencies),
the same library `bw-rfc-server` already proved out, specifically so a
fresh clone works for any developer without asking anyone for a token.

## Deploying/redeploying to Cloud Foundry

```bash
cf login -a https://api.cf.us10.hana.ondemand.com   # if not already logged in
cd mcp/pipo-rfc-server
cf push
```

`manifest.yml` already declares `services: [AICONX-destination]`, so
`cf push` binds the destination service instance automatically — no manual
`cf bind-service` step needed, as long as that instance still exists in
your space (`cf services | grep destination`). If you're setting this up in
a brand-new space/subaccount, create an equivalent destination-service
instance with the `PO_PJ2_ESR`/`PO_PJ2_DIR` destinations configured first,
then update `manifest.yml`'s `services:` entry to match its name.

The app starts even with everything above unset/missing — `/api/pi8/*`
just returns `reachable: false` with a clear error, and `call_rfc`/
`get_rfc_metadata` return a clear "not configured" error, rather than
crashing.

```bash
# only needed for the generic RFC path, not PI8:
cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_ASHOST '<host>'
cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_SYSNR '00'
cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_CLIENT '<client>'
cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_USER '<user>'
cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_PASSWD '<password>'
cf restage sdaintai-pipo-rfc-mcp
```

## What this server will NOT do

- `call_rfc`/`get_rfc_metadata` only accept `system: "SDAINTAI"` or
  `system: "SDADATAAI"` — never an arbitrary host. `SDADATAAI` is a
  reserved name until its own `SDADATAAI_SAP_*` env vars are set.
- PI8 is hardcoded to the `PO_PJ2_ESR`/`PO_PJ2_DIR` destination names and
  the fixed ESR object types in `PI8_QUERY_TYPES` — there's no parameter to
  point it at a different PI/PO system or widen the query from the client
  side; that's a code change, not a config one.
