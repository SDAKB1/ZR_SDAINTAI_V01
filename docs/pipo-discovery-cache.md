# PI/PO discovery: durable CAP cache

## Storage and request flow

Run `node --env-file=.env fetch-pipo.js --cache` from `mcp/pipo-rfc-server`.
The CLI calls authenticated `POST /odata/v4/pipo-discovery/fetchEndpoint` on the
CAP app, once per fixed discovery tool. CAP checks `pipo.cache.Entries` before
calling MCP. A hit makes **no MCP or SAP call**. Successful misses are committed
before returning. No Redis or object store is used by this cache.

- Development: existing CAP file-backed SQLite database (`db/sdaintai.sqlite`).
- Production: existing tenant-aware HANA persistence. Local file durability is
  only suitable for development, not ephemeral Cloud Foundry instance disks.
- Cached payload: parsed/redacted endpoint response, artifact records and
  warnings. It is not raw HTTP/HTML or an archive of credentials.
- Schema: `db/pipo-cache-schema.cds`; service: `srv/pipo-discovery-service.cds`.
  Cache rows are internal and are not exposed as OData entities.

## Configuration

Set on the **CAP server process** (not only the CLI's `.env`):

| Variable | Meaning |
| --- | --- |
| `PIPO_MCP_URL` | Required MCP route, ending in `/mcp` or its base URL |
| `PIPO_MCP_USER` / `PIPO_MCP_PASS` | Current MCP Basic Auth credentials, supplied through secure configuration |
| `PIPO_CACHE_TTL_SECONDS` | Default and maximum request TTL; default `3600`, allowed `0..604800` |
| `PIPO_CACHE_SOURCE_VERSION` | Optional source revision; change after destination, access-policy or source changes |

For **the CLI** in cache mode, add to its local Git-ignored environment:

| Variable | Meaning |
| --- | --- |
| `PIPO_CAP_URL` | CAP app base URL, e.g. `http://localhost:4004`; service/action URL is also accepted |
| `PIPO_CAP_TOKEN` | Raw access token (no `Bearer ` prefix), for production XSUAA authentication |
| `PIPO_CAP_USER` / `PIPO_CAP_PASS` | Alternative Basic Auth for local CAP mocked authentication only |

Use HTTPS except on exact localhost addresses. Credentials must not be embedded
in URLs or command arguments. The CLI does not need MCP credentials in cache
mode. `.env` is loaded only by Node's `--env-file`; starting CAP separately does
not automatically load the CLI directory's environment file.

## Deployment prerequisites

Deploy the updated MCP package (including its `fast-xml-parser` dependency) to
register all 23 tools. Then deploy the new CDS entity through the project's
normal CAP database deployment process. Existing HANA tenants need an MTX
schema upgrade as well as a CAP app update. For development, inspect/back up the
existing SQLite database before running the normal CDS deployment command.

No database deployment, tenant upgrade, SAP extraction or Cloud Foundry push is
performed by the implementation/tests. An undeployed/unavailable cache returns
503 and does not silently bypass persistence or call SAP.

## Using TTL and refreshing

- `node --env-file=.env fetch-pipo.js --cache`: use the configured server TTL.
- `node --env-file=.env fetch-pipo.js --cache --ttl-seconds=900`: request at most 15-minute-old data.
- `node --env-file=.env fetch-pipo.js --cache --force-refresh`: bypass reads and replace successful responses.
- `node --env-file=.env fetch-pipo.js --cache --ttl-seconds=0`: bypass cache reads/writes; DB availability is still checked.
- Add `--tool=fetch_pi8_business_component --parameters-file=read.json` to run a
  single tool with a JSON parameters object. This also works without `--cache`.

For a SOAP read, `read.json` can contain:

```json
{"mode":"read","identifier":{"PartyID":"","ServiceID":"Example"}}
```

Identifier fields depend on the endpoint's verified WSDL; copy them from query
results, not this example. Paging parameters are `maxItems` (1..1000) and
`offset` (0..1000000). Default discovery queries request up to 1000 identifiers;
they do not automatically issue a Read for every identifier. Unknown contracts
return metadata/probe results instead of fabricated full definitions.

## CAP API contract

POST body, using an existing authenticated session/token:

```json
{"tool":"fetch_pi8_business_component","parameters":"{\"mode\":\"query\"}","ttlSeconds":900,"forceRefresh":false}
```

The response contains `result` (a JSON **string**, parse it once) and `cache`:
`hit`, `fetchedAt`, `expiresAt`, `backend` (`cap-db` or `none`). The CLI parses this
automatically and attaches metadata to each `discovery.endpoints[]` entry.
The report separates cache hits, persisted misses, uncached responses,
identifiers, full definitions, metadata, diagnostics and partial extraction.
Counts are extracted records, not cross-endpoint deduplicated inventory.

## Isolation, failure handling and retention

Keys hash tenant, authenticated CAP user, MCP URL/identity/revision, tool,
canonical parameters and parser version. HANA additionally uses the CAP tenant
database context. No passwords/tokens or raw request parameters are stored as
key metadata. Artifact content can contain identifiers supplied in parameters.
Tenant/user changes cannot reuse another context's entry. Rotate the source
revision when upstream permissions change without changing the MCP identity.

A shorter TTL also restricts an existing entry's age; a longer TTL never extends
its stored expiry. Expired responses are not served after failed refreshes.
Unsupported tools, failed requests, SOAP faults and unsafe/oversized payloads
are returned as sanitized failures and never cached. Verified XML/JSON metadata
may be cached even without catalog records. HTML-only probes are not cached.
Authentication/configuration/database errors fail closed; cache mode never
falls back to direct MCP or SAP. Configuration is validated on each action so
unconfigured discovery does not prevent unrelated CAP services from starting.

Every successful cache write opportunistically deletes **at most 100 expired
rows** in that tenant database, rechecking expiry on deletion. This is not a
scheduled sweep: an idle cache may retain expired rows until a later write.
Upserts replace the same key. Concurrent equal requests are deduplicated only
within one process; separate CAP instances can both fetch a miss.

## Verification

From the repository root:

```bash
node --test mcp/pipo-rfc-server/fetch-pipo.test.js mcp/pipo-rfc-server/cap-cache-client.test.js mcp/pipo-rfc-server/discovery-report.test.js mcp/pipo-rfc-server/endpoint-fetcher.test.js srv/utils/pipoDiscoveryCache.test.js srv/utils/pipoDiscoveryClient.test.js srv/pipo-discovery-service.test.js
```

Tests use loopback MCP/CAP fixtures and disposable SQLite files, including
close/reopen durability, tenant/user separation and bounded expiry cleanup.
The OData action is tested over real local HTTP with test-only authentication.
HANA DDL/EDMX compilation is checked; live HANA/XSUAA/SAP integration still
requires deployment and environment-specific validation.