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

The original four tools remain available, alongside the 23 read-only discovery
tools listed below:
- **`get_pi8_status`** — reachability proof for PJ2 through the Cloud Connector.
- **`list_pi8_esr_objects`** — the real ESR object catalog described above.
- **`call_rfc`** — `{ system: "SDAINTAI", rfc_name: "...", import_parameters: {...} }`
- **`get_rfc_metadata`** — `{ system: "SDAINTAI", rfc_name: "..." }`

### Small fetch/discovery script (Node.js 20+)

For the end-to-end workflow (Node.js 22 recommended), see [Running discovery tools](../../docs/running-discovery-tools.md): export, saved catalogs, roles, reports, cache and safe redeployment prerequisites.

From `mcp/pipo-rfc-server`, install the existing dependencies with `npm ci`.
Put these client settings in a local, Git-ignored `.env` file:
- `PIPO_MCP_URL`: your route (base URL or `/mcp` URL); defaults to the deployed route above.
- `PIPO_MCP_USER`: the deployed MCP server's current Basic Auth username.
- `PIPO_MCP_PASS`: the deployed MCP server's current Basic Auth password.

The script never assumes the server's placeholder credentials. Use HTTPS except
when testing against localhost. Load `.env` explicitly with Node's `--env-file`
option (Node.js 20.6+); existing process environment variables take precedence.

```bash
node --env-file=.env fetch-pipo.js                 # fetch the 23 read-only discovery endpoints
node --env-file=.env fetch-pipo.js --tools-only    # live tool names, descriptions and input schemas
node --env-file=.env fetch-pipo.js > pipo.json     # save the JSON result locally
node --env-file=.env fetch-pipo.js --rest          # public status + objects; no credentials or npm install needed
node --env-file=.env fetch-pipo.js --cache         # read through the durable CAP database cache
node fetch-pipo.js --help
```

Default output contains `tools`, `discovery.endpoints` and a `summary` with
extracted counts by category/type, service interfaces, full definitions,
metadata documents, diagnostic snapshots, truncation and endpoint coverage.
Count logs go to stderr; stdout remains valid JSON. Each endpoint retains its
parsed, redacted response and artifacts. Repository records are reported as ESR;
Integrated Configuration and Configuration Scenario records as Configuration.
Counts describe extracted records, not a deduplicated landscape inventory:
overlapping endpoints (for example the two ICO services) can return the same ID.

Queries return identifiers, **not full definitions**. Default requests return at
most 1000 records per endpoint. Inspect `truncated`, `actualCount` and `returned`;
use `--tool=NAME --parameters-file=PATH` with `offset`/`maxItems` to fetch further
pages. Pagination is local over a newly fetched response, not a SAP cursor.
The existing legacy REST catalog still caps at 150. If the remote server exposes
none of the new tools, MCP mode falls back to `status`/`objects` and reports the
23 tools unavailable. Redeploy the MCP server to enable them.

`--rest` only calls the existing public endpoints. The script never executes
`call_rfc` or `get_rfc_metadata`. `--cache` needs separate CAP authentication and
never falls back to direct MCP/SAP access; see the [durable cache setup](../../docs/pipo-discovery-cache.md).

An unreachable destination may still return a successful HTTP/MCP response:
inspect `status.reachable` and `status.destinations`. Authentication, HTTP and
legacy MCP tool errors exit nonzero with a generic message. Expanded endpoint
failures are isolated in `discovery.endpoints`; inspect the summary even when the
batch exits successfully. CAP authentication/database HTTP failures abort cache
mode without fallback. Error bodies are omitted. Without `--env-file`, supply the settings
directly through the process environment; `.env` is not loaded automatically.
Run the offline client/report tests with
`node --test fetch-pipo.test.js discovery-report.test.js endpoint-fetcher.test.js cap-cache-client.test.js`.

### The 23 allowlisted discovery tools

All names below are prefixed with `fetch_pi8_`. Only fixed destination/path
descriptors drive requests; callers cannot supply URLs or SOAP operations.

| Path | Tool suffix | Read-only behavior |
| --- | --- | --- |
| `/AdapterFramework/ChannelAdminServlet` | `channel_admin` | GET `action=status`; optional party/service/channel |
| `/AlertRuleInService` | `alert_rule` | WSDL-gated Query/Read |
| `/BPMFacadeBeanImplService` | `bpm_facade` | WSDL metadata only |
| `/BusinessComponentInService` | `business_component` | WSDL-gated Query/Read |
| `/CPACache` | `cpa_cache` | Bare GET snapshot; no refresh |
| `/CommunicationChannelInService` | `communication_channel` | WSDL-gated Query/Read |
| `/ConfigurationScenarioInService` | `configuration_scenario` | WSDL-gated Query/Read |
| `/IntegratedConfiguration750InService` | `integrated_configuration_750` | WSDL-gated IntegratedConfiguration Query/Read |
| `/IntegratedConfigurationInService` | `integrated_configuration` | WSDL-gated Query/Read |
| `/IntegrationProcessInService` | `integration_process` | WSDL-gated Query/Read |
| `/InterfaceDeterminationInService` | `interface_determination` | WSDL-gated Query/Read |
| `/ReceiverAgreementInService` | `receiver_agreement` | WSDL-gated Query/Read |
| `/ReceiverDeterminationInService` | `receiver_determination` | WSDL-gated Query/Read |
| `/ReceiverRuleInService` | `receiver_rule` | WSDL-gated Query/Read |
| `/SenderAgreementInService` | `sender_agreement` | WSDL-gated Query/Read |
| `/ValueMappingInService` | `value_mapping` | WSDL-gated Query/Read |
| `/dir/query/ext` | `directory_query_ext` | GET protocol probe |
| `/dir/read/ext` | `directory_read_ext` | GET protocol probe; no invented ESR protocol |
| `/mdt` | `message_diagnostics` | Bare GET diagnostic probe |
| `/rep/query/ext` | `repository_query_ext` | GET probe; parse recognized SimpleQuery results only |
| `/rep/query/int` | `repository_query_int` | GET probe; parse recognized SimpleQuery results only |
| `/rep/read/ext` | `repository_read_ext` | GET metadata or encoded TYPE/KEY/SWCGUID read |
| `/rep/support/SimpleQuery` | `repository_simple_query` | Fixed read-only query; parse result identifiers |

Whitelisting permits connectivity, not every operation on that URL. Unknown or
imported WSDL contracts remain metadata-only; imports/soap:address are never
followed. Channel start/stop, CPA refresh, edits, deletes and BPM execution are
excluded. SOAP Read requires `mode: "read"` and an `identifier` matching the
verified local WSDL. ESR read needs `object_type`, `object_key`, `swc_guid` from a
query record; its parsed payload is retained but not claimed as a typed full
definition. Unparsed/binary/raw HTML responses are omitted rather than stored.
Requests disable redirects, reject XML DTDs, cap upstream responses at 5 MB and
time out after 20 seconds per SAP request (60 seconds per MCP/client request).

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
