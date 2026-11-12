// Stub client for the ADT MCP server (see mcp/adt-mcp-server/). This is the
// one place rap-dev-orchestrator-service.js reaches out to ABAP — mirrors how
// Kara HR's CAP orchestrator is the only thing holding the S/4HANA destination.
//
// NOT WIRED TO A REAL SYSTEM YET. Two things need to happen before this is
// real: (1) `npm install @modelcontextprotocol/sdk` and replace the stub calls
// below with an actual MCP client connecting to mcp/adt-mcp-server/index.js
// (stdio transport, per the SDK's Client + StdioClientTransport), and (2) that
// server needs real ADT REST endpoint calls + a service-account destination
// (same "Communication User via BTP Destination service" pattern already
// documented in TDDKARAHR001's security section) instead of its own stubs.
// Kept as a single narrow module so swapping stub→real later touches one file.

const cds = require('@sap/cds');
const LOG = cds.log('adt-mcp-client');

async function callTool(toolName, args) {
  LOG.warn('STUB — would call MCP tool', { toolName, args });

  switch (toolName) {
    case 'getBehaviorDefinition':
      return { found: false, note: 'stub: no live ADT connection configured' };
    case 'runAtcCheck':
      return { findings: [], note: 'stub: no live ADT connection configured' };
    case 'activateObject':
      return { activated: false, note: 'stub: no live ADT connection configured' };
    // ── Generic discovery/invocation pair — the "call all methods and RAP
    // functions" capability. Deliberately generic rather than one hardcoded
    // tool per object: discoverRapService reads whatever the service's own
    // $metadata + behavior definition declare is callable (standard CRUD,
    // every custom action, every function), invokeRapAction then performs
    // the actual bound-action OData call. Neither tool can reach a method
    // that isn't already part of the object's released/activated service —
    // that boundary is enforced by ABAP Cloud itself, not just by this stub.
    case 'discoverRapService':
      return { entities: [], operations: [], note: 'stub: no live ADT connection configured' };
    case 'invokeRapAction':
      return { result: null, note: 'stub: no live ADT connection configured' };
    default:
      throw new Error(`Unknown ADT MCP tool: ${toolName}`);
  }
}

module.exports = { callTool };
