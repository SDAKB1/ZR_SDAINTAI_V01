'use strict';

const cds = require('@sap/cds');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

let _log;
function getLogger() {
  if (!_log) _log = cds.log('pipo-mcp-client');
  return _log;
}

/**
 * Calls a named RFC/BAPI through the SDAINTAI PI/PO RFC MCP server
 * (mcp/pipo-rfc-server), deployed standalone on Cloud Foundry.
 *
 * @param {string} rfcName - e.g. 'BAPI_PO_GETITEMS'
 * @param {object} importParameters
 * @param {object} [options]
 * @param {'SDAINTAI'|'SDADATAAI'} [options.system='SDAINTAI'] - allowlisted target system
 * @param {object} [options.changingParameters]
 * @param {object} [options.tableParameters]
 * @returns {Promise<object>} the RFC result
 * @throws {Error} on auth failure, connection failure, or an RFC-level error
 */
async function callPipoRfc(rfcName, importParameters, options = {}) {
  const LOG = getLogger();
  const { system = 'SDAINTAI', changingParameters = {}, tableParameters = {} } = options;

  const mcpUrl = process.env.PIPO_MCP_URL; // e.g. https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com/mcp
  const mcpUser = process.env.PIPO_MCP_USER;
  const mcpPass = process.env.PIPO_MCP_PASS;

  if (!mcpUrl || !mcpUser || !mcpPass) {
    throw new Error(
      'PIPO_MCP_URL / PIPO_MCP_USER / PIPO_MCP_PASS must be set (bind as CF env vars or a user-provided service).'
    );
  }

  const authHeader = 'Basic ' + Buffer.from(`${mcpUser}:${mcpPass}`).toString('base64');
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: authHeader } },
  });

  const client = new Client({ name: 'sdaintai-cap-backend', version: '1.0.0' });

  try {
    await client.connect(transport);

    const result = await client.callTool({
      name: 'call_rfc',
      arguments: {
        system,
        rfc_name: rfcName,
        import_parameters: importParameters,
        changing_parameters: changingParameters,
        table_parameters: tableParameters,
      },
    });

    if (result.isError) {
      const message = result.content?.[0]?.text || 'Unknown MCP tool error';
      LOG.error('[PIPO-MCP] RFC call returned an error', { rfcName, system, message });
      throw new Error(message);
    }

    return JSON.parse(result.content[0].text);
  } finally {
    await client.close();
  }
}

module.exports = { callPipoRfc };
