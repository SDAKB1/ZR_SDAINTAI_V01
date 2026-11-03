# SDAINTAI PI/PO RFC MCP Server — Quick Start

If you've cloned/branched this repo, this is how to actually **call**
the deployed MCP server (or run it locally), not how it was built — for
the full design rationale, see
[`docs/MCP on CF SDA.md`](../../docs/MCP%20on%20CF%20SDA.md).

## What this is, in one line

A standalone MCP server that lets Claude (or any MCP client, or
SDAINTAI's own CAP backend) call SAP RFCs/BAPIs by name on the
**SDAINTAI** system (SDADATAAI reserved for later, not yet enabled).

## Option A — Connect to it as a remote MCP server (Claude Desktop / Claude Code)

Once deployed, the server is reachable at a CF route ending in `/mcp`
(confirm the exact URL with `cf app sdaintai-pipo-rfc-mcp` — defaults to
`https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com/mcp`, but CF
may have suffixed it if that route was already taken).

Every request needs **HTTP Basic Auth**. Ask whoever deployed the server
for the current username/password (don't assume the placeholder
defaults in `server.js` are still in use — they're meant to be rotated,
see the security note in `docs/MCP on CF SDA.md`).

Add it to your MCP client config, e.g. `claude_desktop_config.json` /
Claude Code's MCP settings:

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

(Generate the `Authorization` value with
`echo -n 'USERNAME:PASSWORD' | base64`.)

Once connected, two tools are available:
- **`call_rfc`** — `{ system: "SDAINTAI", rfc_name: "...", import_parameters: {...} }`
- **`get_rfc_metadata`** — `{ system: "SDAINTAI", rfc_name: "..." }` — look up an
  RFC's expected parameters before calling it blind.

## Option B — Call it from Node.js/CAP code

Use `srv/utils/pipoMcpClient.js` (already in this repo):

```js
const { callPipoRfc } = require('../../srv/utils/pipoMcpClient');

const result = await callPipoRfc('BAPI_PO_GETITEMS', {
  PURCHASEORDER: '4500001234',
  WITH_PO_HEADERS: 'X'
}, {
  tableParameters: { PO_ITEMS: [], PO_HEADERS: [], RETURN: [] }
});
```

Requires three environment variables on whatever app is calling it:

| Variable | What it is |
|---|---|
| `PIPO_MCP_URL` | the deployed server's `/mcp` URL |
| `PIPO_MCP_USER` | Basic Auth username |
| `PIPO_MCP_PASS` | Basic Auth password |

## Option C — Run the server itself locally (for development)

```bash
cd mcp/pipo-rfc-server
cp .env.example .env   # fill in real values — never commit .env
npm install            # needs SAP_NPM_REGISTRY_TOKEN set first, see below
npm start
curl http://localhost:8080/health   # should return "ok"
```

`npm install` pulls `@sap-rfc/node-rfc-library` from SDA's private npm
feed (configured in `.npmrc`, scoped to `@sap-rfc`) — set
`SAP_NPM_REGISTRY_TOKEN` in your shell before running `npm install`, or
it will 404. Ask whoever manages SDA's private npm feed for the token if
you don't already have it from another SDA project
(`vendor-invoice-management` already uses the same feed).

## Deploying/redeploying to Cloud Foundry

```bash
cf login -a https://api.cf.us10.hana.ondemand.com   # if not already logged in
cd mcp/pipo-rfc-server
cf push
```

The app starts even with `SDAINTAI_SAP_*` connection vars unset — it'll
just return a clear "not configured" error from `call_rfc`/
`get_rfc_metadata` until those are set:

```bash
cf set-env sdaintai-pipo-rfc-mcp SAP_NPM_REGISTRY_TOKEN '<token>'
cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_ASHOST '<host>'
cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_SYSNR '00'
cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_CLIENT '<client>'
cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_USER '<user>'
cf set-env sdaintai-pipo-rfc-mcp SDAINTAI_SAP_PASSWD '<password>'
cf restage sdaintai-pipo-rfc-mcp
```

## What this server will NOT do

It only accepts `system: "SDAINTAI"` or `system: "SDADATAAI"` — never an
arbitrary host. `SDADATAAI` is a reserved name until its own
`SDADATAAI_SAP_*` env vars are set; calling it before then returns an
explicit error rather than silently doing nothing or falling back to
SDAINTAI. There's no way around this allowlist from the client side —
it's enforced in `server.js`, not just this doc.
