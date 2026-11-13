# Running PI/PO discovery tools

This guide is for human operators and AI assistants using `mcp/pipo-rfc-server/fetch-pipo.js`.
It covers catalog discovery, bounded definition reads, local reports and the optional CAP database cache.
**An export is sanitized discovery evidence, not a migration-ready SAP archive.**

## 1. Prepare the local checkout

Use **Node.js 22 (recommended)**. The MCP package declares Node.js 20+, but `--env-file` requires at least 20.6.
From the repository root, install the already-declared dependencies in both locations:

<augment_code_snippet mode="EXCERPT">
````powershell
npm ci
cd mcp/pipo-rfc-server
npm ci
node fetch-pipo.js --help
````
</augment_code_snippet>

The root install supplies `@sap/cds` for the run writer's CAP logger, including in direct MCP mode.
The package install supplies its existing MCP SDK and parser dependencies. No new dependencies are needed.
All remaining CLI commands below run from `mcp/pipo-rfc-server`; relative input/output paths resolve from that working directory.

Use the **existing local, Git-ignored `.env`**, with credentials obtained through the approved secure channel.
For direct MCP access it supplies `PIPO_MCP_URL`, `PIPO_MCP_USER` and `PIPO_MCP_PASS`.
Confirm the intended route rather than relying on the built-in default.
Node loads this file only when `--env-file=.env` is supplied; existing process variables take precedence.
Use HTTPS except for exact localhost testing.

Never inline secrets in commands, URLs, tickets, prompts or committed files. Do not print `.env`, deployment
environment values, authorization headers or credential-bearing manifests to diagnose a problem.
Treat discovery output as sensitive landscape information even after sanitization; keep it out of source control and public uploads.

### Remote MCP prerequisites and redeployment gate

An authorized administrator must confirm the destination service binding, Cloud Connector resource allowlists,
and source destinations `PO_PJ2_DIR` and `PO_PJ2_ESR`. A connectivity allowlist is not authorization for every operation.
Use `node --env-file=.env fetch-pipo.js --tools-only` to inspect the deployed tool names and schemas without calling those tools.
The current package registers 23 fixed read-only discovery tools. If none are registered, catalog mode can use
the legacy status/objects fallback, but this does not provide full export capability. Partial registration leaves missing tools unavailable.

**Do not redeploy until all of these checks are complete:**

- An authorized operator removes any hardcoded credentials from `manifest.yml`, server defaults and other deployment inputs,
  and rotates any credentials exposed or committed previously. Removing a value does not revoke it or remove Git history.
- Credentials are supplied through approved secure runtime configuration, never command-line values.
- The MCP package's `.cfignore` is present and reviewed before push. Exclude `.env` and local environment variants,
  role inventories such as `roles.local.json`, saved catalogs such as `pipo-discovery.json`, discovery run directories,
  local logs/reports, and other credential-bearing or generated local files. Check custom output paths too.
  Do not assume Git ignore rules protect a Cloud Foundry upload.
- The operator verifies the intended Cloud Foundry org/space, route, service bindings and source mappings.

Only after those gates and explicit deployment approval, run **`cf push -f manifest.yml` from
`mcp/pipo-rfc-server`**, not the repository root. This guide does not authorize a deployment or a live source read.
AI assistants must obtain operator approval for those actions rather than treating examples as instructions to execute automatically.

## 2. Choose catalog discovery or definition export

### Fresh catalog only (default)

Run `node --env-file=.env fetch-pipo.js`.

This discovers MCP tool schemas and fetches the 23 fixed discovery endpoints using Query or metadata defaults.
It **does not follow every identifier with a definition Read unless `--export` is present**.
Default queries request at most 1000 records per endpoint. The legacy REST catalog is capped at 150;
neither catalog counts nor reachability prove complete extraction.

### Fresh catalog plus bounded definition reads

Run `node --env-file=.env fetch-pipo.js --export`.

The exporter follows enumerated identifiers through verified Directory SOAP Query/Read contracts and the fixed ESR read tool.
It does not invent identifiers from display names or infer unsupported protocols. Unknown/imported WSDL contracts remain metadata-only.
Directory Reads support local `xsd:string`/`xsd:token` restrictions with enumerations and `maxLength`.
They explicitly send the verified `Active` ReadContext and preserve declared element qualification and field order.
Overlong identifiers and token values that would change under XML whitespace collapsing are rejected rather than rewritten;
unsupported restrictions still prevent a data request. WSDL access alone does not prove that an object Read succeeds.
Additional query pages are fetched only when parsed pagination information supports progress; gaps record incomplete enumeration.
Requests are read-only: no edits, activation, channel start/stop, CPA refresh or BPM execution.

### Reuse an existing PowerShell catalog

Run `node --env-file=.env fetch-pipo.js --export --input-file=pipo-discovery.json`.

This accepts a prior discovery JSON object with a `discovery.endpoints` array, up to 100 MB.
UTF-8 and **UTF-16LE with a byte-order mark**, as produced by Windows PowerShell redirection, are supported.
There is no need to re-fetch or manually re-encode that catalog.
Legacy REST-only JSON without `discovery.endpoints` is not a suitable export seed.

**This is not an offline operation:** the catalog is reused, but definition reads and any needed additional pages
still use the configured MCP server (or CAP with `--cache`). Direct mode still connects and discovers available tools.
The operator must ensure the saved catalog and current destination identity refer to the same intended source/version.

**ESR catalogs created before the Read-context fix must be refreshed.** Their identifiers contain only
`object_type`, `object_key`, `swc_guid`; corrected identifiers also retain validated `vc`, `sp`, `uc`, `release`
from SAP's SimpleQuery `R` links. The exporter counts legacy identifiers but skips their ESR Reads with a gap
instead of guessing version context. After an authorized MCP server update, run a fresh catalog/export without
`--input-file`. A local CLI update alone does not update the deployed MCP parser/tool schema. In cache mode,
force-refresh the catalog or update the configured source version so old cached identifiers are not reused.
The link's API `release` is not inferred from the software component's displayed version.

### Optional controls

Append these options to either export command, using `--name=value` syntax:

| Option | Meaning |
| --- | --- |
| `--output-dir=PATH` | Parent directory for a new unique run folder; default `discovery-runs` relative to the current directory. Quote the whole argument if the path contains spaces. |
| `--max-reads=5000` | Global definition Read request budget; default 5000, accepted range 0–100000. Exhaustion records skipped reads/gaps. |
| `--max-pages=100` | Global budget for **extra Query requests**, not initial/supplied catalog pages; default 100, accepted range 0–1000. This is not a SAP cursor or snapshot. |
| `--roles-file=roles.local.json` | Optional destination-scoped source-role inventory for diagnostic comparisons, not credentials or permission verification. |

Do not combine `--export` with `--rest`, `--tools-only` or a single `--tool`.
`--input-file` requires `--export`. Single-tool investigations can instead use
`--tool=NAME --parameters-file=PATH` with a JSON parameter object matching the live schema.

## 3. Supply role evidence, if available

Ask the source administrator, using **NetWeaver Administrator (NWA)**, to identify the actual SAP user/principal used by
each **source destination**, and obtain that identity's UME (User Management Engine) roles, including applicable inherited assignments.
Do not substitute the MCP Basic Auth user, CAP login, or an administrator's personal roles for that source identity.
Where identity propagation is configured, confirm the effective source principal for the request context.

Store only role names in a protected local `roles.local.json`, for example:

<augment_code_snippet mode="EXCERPT">
````json
{
  "PO_PJ2_DIR": ["SAP_XI_API_DISPLAY_J2EE"],
  "PO_PJ2_ESR": ["SAP_XI_DISPLAY_USER_J2EE"]
}
````
</augment_code_snippet>

These are illustrative assignments, not a claim about your source or an instruction to grant them.
Only `PO_PJ2_DIR` and `PO_PJ2_ESR` keys are accepted; **each is optional** and its value must be an array of strings.
An omitted destination means unknown inventory; an empty array means supplied inventory with no recognized roles.
The JSON object is limited to 64 KB and 1000 role entries in total.
Unknown role names are omitted during validation, not retained in reports; unknown destination keys or non-string entries are rejected.

The diagnostic allowlist recognizes exactly these three role names:

| Role | Evidence used by diagnostics |
| --- | --- |
| `SAP_XI_API_DISPLAY_J2EE` | **Documented** source-read example for the Integration Directory Programming Interface; candidate for Directory SOAP endpoints, not proof for ESR. |
| `SAP_XI_DISPLAY_USER_J2EE` | **Suggested** candidate for ESR and Directory probes; endpoint-specific effective access is unverified. |
| `SAP_XI_MONITOR_J2EE` | **Suggested** monitoring candidate; not a blanket read-only permission recommendation. SAP documents broader modify/payload actions for this role. |

On a **source-layer 403**, `diagnostic.roleAssessment.candidates[].present` compares a candidate with supplied inventory:
`true` = present, `false` = absent, `null` = unknown inventory. None proves that the role caused or would fix the failure.
`effectivePermissionsVerified` remains `false`. Do not automatically grant elevated roles.
There is **no built-in allowlisted UME endpoint**, and automatic effective-role discovery is **not implemented**.
Role assignment names alone do not establish endpoint policy, release compatibility or effective authorization.

### Official SAP evidence

- [Integration Directory Programming Interface](https://help.sap.com/saphelp_snc700_ehp04/helpdata/en/48/d127e1e1c60783e10000000a42189d/content.htm): SOAP API overview. The API supports writes too; this tool deliberately uses only read-only operations.
- [Migration and Mass Change of Communication Channels](https://help.sap.com/doc/saphelp_em92/9.2/en-US/f1/544ad104f6494c9eb0a8a87a601549/content.htm): explicitly gives `SAP_XI_API_DISPLAY_J2EE` as a release-dependent source-read role example.
- [UME Roles and Actions (AS Java)](https://help.sap.com/doc/saphelp_nw73ehp1/7.31.19/en-US/61/908817bfae4c36a051d95b5a245364/content.htm): official PI UME role list.
- [Monitoring Roles](https://help.sap.com/doc/saphelp_nw73ehp1/7.31.19/en-US/45/951838644f4b12822900e1b127166d/content.htm): display/modify/payload distinctions. These pages are release-specific evidence, not an ESR read-contract guarantee for your system.

## 4. Optional CAP database cache

Run `node --env-file=.env fetch-pipo.js --cache --export` to route catalog queries **and export reads** through
the authenticated CAP `fetchEndpoint` action. The cache uses the existing CAP database with TTL (time-to-live):
development file-backed SQLite, production tenant-aware HANA. **No Redis or object store is used by this cache.**
Successful cache hits avoid MCP/SAP requests; misses can contact the live source.

The CLI needs `PIPO_CAP_URL` and `PIPO_CAP_TOKEN`, or local mocked-auth `PIPO_CAP_USER`/`PIPO_CAP_PASS`,
through its protected environment. CAP separately needs secure MCP settings, the deployed cache schema and database access.
The CLI's `.env` is not automatically loaded by a separately started CAP process.
See [durable cache setup and deployment prerequisites](pipo-discovery-cache.md) before use; no schema deployment is implied by running the CLI.

**Use two separate flags: `--cache --export`, not `--cache--export`.** Joined or incompatible arguments
produce `INVALID_ARGUMENTS` before creating a run. Cache mode does not start or deploy a CAP server.
`PIPO_CAP_URL` must point to your running CAP app, not the MCP route (for local development only, an example is
`http://localhost:4004`). Obtain production CAP authentication through your approved secure channel;
do not reuse MCP credentials or paste tokens into commands or chat.

Startup checks distinguish `CAP_URL_MISSING`, `CAP_URL_INVALID`, `CAP_AUTH_MISSING` and `CAP_AUTH_INVALID`.
These failures make no CAP/MCP/SAP request, retain the CAP layer in the failed HTML report, and print the report location.
Missing URL and authentication settings are checked in that order; fixing the URL can reveal the next missing setting.
Each CLI lifecycle event is logged once. Debugger auto-attach warnings are separate from CAP configuration failures.

- Default server TTL is 3600 seconds; `--ttl-seconds=900` requests a shorter age limit.
- `--force-refresh` bypasses cache reads and replaces successful responses.
- `--ttl-seconds=0` bypasses cache reads/writes but still requires the database availability check.
- Cache configuration/authentication/database failures fail closed; there is no direct MCP/SAP fallback.
- `--cache --export --input-file=pipo-discovery.json` reuses the supplied catalog; it is **not automatically backfilled into the cache**.
  Subsequent requested pages/reads use CAP. Source identity/version consistency remains the administrator's responsibility.
  Update the server's `PIPO_CACHE_SOURCE_VERSION` after destination, source or permission changes as described in the cache guide.

## 5. Inspect the run, not just the exit code

The CLI automatically writes `discovery-runs/<UTC-timestamp>-<UUID>/` (or the chosen output parent).
It prints the run location and count logs to stderr; stdout remains JSON. Redirecting stdout is optional, not needed to obtain run files.
For example, a completed export can contain:

| File/path | Purpose |
| --- | --- |
| `discovery.json` | Sanitized discovery endpoints and export read results, coverage and gaps. |
| `summary.json` | Catalog/type/category counts plus read outcomes, exported definitions, ESR response-body counts and gaps. |
| `artifact-index.json` | Maps source tools and identifiers to generated definition/ESR response files; distinguishes verified definitions from unverified payloads. |
| `manifest.json` | Run ID, timestamps, completion status, gaps, and file sizes/SHA-256 hashes. |
| `events.jsonl` | Structured, sanitized event records; arbitrary upstream text and error bodies are not logged. |
| `report.html` | Local self-contained HTML/SVG charts, diagnostics and relative links; open in a browser. |
| `artifacts/<category>/<type>/<sha256>.json` | Content-addressed sanitized definitions and retained ESR read bodies, when available. Identical saved content shares a file. |

Manifest hashes cover the **exact saved bytes** of generated files, including event logs, HTML and artifact JSON,
not an abstract JSON object. `manifest.json` does **not hash itself**. Editing or re-encoding a saved file changes its hash.
Failed runs may contain only events and a generic failed manifest/report; a filesystem failure can leave incomplete output.

For discovery/export commands, exit code **0 means the CLI completed and wrote the run**, not that every endpoint/read succeeded or that `migrationReady` is true.
Exit code **1 indicates an aborted/failed CLI run**; inspect safe diagnostics and any failed-run files.
`manifest.status: completed` is a writer outcome, not complete extraction.
Check `summary.json` read coverage and gaps, `discovery.json` endpoint diagnostics, and `export.coverage`/`export.gaps`.
Additional query responses are stored in `discovery.pages`, not counted as extra distinct endpoints.
Counts describe extracted records, not cross-endpoint deduplicated inventory; service interfaces, identifiers,
full definitions, metadata documents and diagnostic snapshots are different measures.

Reports and artifacts stay on the **local filesystem**, not in an automatic database run archive.
The CAP cache stores endpoint snapshots only; it is not report retention, an immutable source snapshot or a migration archive.
Preserve run folders through your approved sensitive-data retention process if required.

### Export limitations

`migrationReady` remains **false**. Directory definitions are sanitized; credentials and secrets are excluded,
so these files are not directly importable migration packages. ESR parsed read payloads remain
**metadata-only with an unverified full-definition contract**, even when a response body is retained under `ESR/ReadResponse`.
Opaque adapter `Attributes` blobs are omitted at source and CLI boundaries because their encoded content can
contain credentials. Non-secret surrounding fields remain available; adapter settings are therefore incomplete.
Dependencies, referenced objects, mapping binaries, XSDs/imports, imported archives, complete ESR archives,
and target-platform compatibility remain unverified. Metadata success is not definition or dependency completeness.
Pagination can re-query a changing source; neither an old catalog nor TTL cache makes the run transactionally consistent.

## 6. Troubleshoot safely

First distinguish `diagnostic.layer`: **client**, **MCP**, **CAP**, or **source**.
An MCP/CAP HTTP failure does not prove a SAP source-role problem. Check the matching layer's configuration first.

| Status/symptom | Next check |
| --- | --- |
| 401 | Authentication at the reported layer; credential validity and destination authentication, not a missing-role conclusion. |
| 403 | Source role, endpoint policy, gateway/Cloud Connector connectivity policy, or another access restriction. Compare supplied candidate-role evidence, then ask the owner; the status alone is not proof. |
| 404 | Route/path and service availability for the installed source release/version. |
| 409 with "Method plain for service read does not exist" | Compare against the current SimpleQuery `R` link. Preserve its VC/SP/UC/release context; do not assume an artifact conflict or fix this by editing artifacts. Refresh older catalogs after an authorized MCP update. |
| 429 | Request/rate limit; reduce frequency and follow source retry policy. Not evidence of a missing role. |
| 503 | Service health, connectivity or unavailable CAP database/configuration. Not evidence of a missing role. |
| Metadata-only / unsupported | Verify the local WSDL/read contract and source capabilities; do not invent operations or follow imports/addresses. |
| Missing tools | Verify deployed tool registration and use the redeployment security gate above; do not substitute arbitrary endpoints. |
| Input JSON failure | Confirm a discovery envelope, supported encoding and size. UTF-16LE input needs its BOM; do not remove it blindly. Role/parameter files are UTF-8 JSON objects. |
| `Debugger attached` / waiting for disconnect | Disable editor JavaScript Debug Terminal/Auto Attach and retry in a normal terminal; do not dump `NODE_OPTIONS` or environment contents. |
| Generic failure or output-write error | Check arguments, protected configuration, available disk space and output directory permissions; use sanitized events and trusted source-side diagnostics. |

Raw HTTP bodies, SOAP fault details and SDK exceptions are deliberately omitted because they can contain secrets.
Do not disable sanitization, dump headers/environment values or paste raw error bodies to recover detail.
An HTTP-successful ping can still contain `reachable: false`; reachability alone does not establish API access or exported objects.

## Maintainer layout and nearest offline checks

| Module | Responsibility |
| --- | --- |
| `mcp/pipo-rfc-server/fetch-pipo.js` | CLI options, MCP/CAP routing, saved-catalog decoding, orchestration and output sanitization. |
| `mcp/pipo-rfc-server/pipo-endpoints.js`, `endpoint-fetcher.js` | Fixed endpoint registry and read-only source contract/parser handling. |
| `mcp/pipo-rfc-server/esr-read-context.js` | Allowlisted ESR Read version-context names and validation; no inferred defaults. |
| `mcp/pipo-rfc-server/definition-export.js` | Bounded pagination/identifier reads and explicit coverage gaps. |
| `mcp/pipo-rfc-server/discovery-diagnostics.js` | Layer-aware HTTP diagnostics and allowlisted supplied-role comparisons. |
| `mcp/pipo-rfc-server/discovery-report.js`, `discovery-run.js` | Counts, CAP-safe event logging, unique run files, hashes and HTML/SVG reports. |
| `mcp/pipo-rfc-server/cap-cache-client.js` | Authenticated CLI-to-CAP cache action client. |
| `srv/utils/pipoDiscoveryCache.js`, `pipoDiscoveryClient.js`, `pipoEndpoints.js` | CAP cache persistence, MCP access and server-side allowlist. |
| `srv/pipo-discovery-service.{cds,js}`, `db/pipo-cache-schema.cds` | CAP action and cache schema. |

Nearest tests are adjacent `*.test.js` files. From `mcp/pipo-rfc-server`, run the focused offline suite:

<augment_code_snippet mode="EXCERPT">
````powershell
node --test fetch-pipo.test.js definition-export.test.js discovery-run.test.js discovery-report.test.js discovery-diagnostics.test.js endpoint-fetcher.test.js cap-cache-client.test.js cli-startup.test.js
````
</augment_code_snippet>

For CAP persistence/action changes, also run from the **repository root**:

<augment_code_snippet mode="EXCERPT">
````powershell
node --test srv/utils/pipoDiscoveryCache.test.js srv/utils/pipoDiscoveryClient.test.js srv/pipo-discovery-service.test.js
````
</augment_code_snippet>

These tests use fixtures/loopback services and disposable databases, not live SAP discovery or deployment.
Passing tests do not validate a live destination, HANA/XSUAA configuration, source roles or migration completeness.