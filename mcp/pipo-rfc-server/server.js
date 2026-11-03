'use strict';

/**
 * SDAINTAI PI/PO & S/4HANA RFC bridge, exposed as a remote MCP server.
 *
 * Scope, enforced in code, not just documentation: this server only talks to
 * named "systems" explicitly configured via environment variables. SDAINTAI
 * is the only one wired up today; SDADATAAI is reserved as a named slot for
 * a later session and is rejected with a clear error until its own
 * SDADATAAI_SAP_* env vars are set. There is no way to call an arbitrary
 * SAP host through this server — the caller can only pick among the
 * allowlisted system names below.
 */

const express = require('express');
const basicAuth = require('basic-auth');
const { RFCClient } = require('@sap-rfc/node-rfc-library');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

// --- Allowlisted systems -----------------------------------------------
// Each entry's connection params come entirely from env vars. A system that
// has no ASHOST configured is treated as "not yet set up" and calls to it
// are rejected, rather than silently falling back to any default.

function systemFromEnv(prefix) {
  const ashost = process.env[`${prefix}_SAP_ASHOST`];
  if (!ashost) return null; // not configured yet — e.g. SDADATAAI today
  return {
    ashost,
    sysnr: process.env[`${prefix}_SAP_SYSNR`] || '00',
    client: process.env[`${prefix}_SAP_CLIENT`],
    user: process.env[`${prefix}_SAP_USER`],
    passwd: process.env[`${prefix}_SAP_PASSWD`]
  };
}

const SYSTEMS = {
  SDAINTAI: systemFromEnv('SDAINTAI'),
  SDADATAAI: systemFromEnv('SDADATAAI') // reserved for later, null until configured
};

function getSystemConnectionParams(systemName) {
  if (!(systemName in SYSTEMS)) {
    throw new Error(
      `Unknown system "${systemName}". This server only serves: ${Object.keys(SYSTEMS).join(', ')}.`
    );
  }
  const params = SYSTEMS[systemName];
  if (!params) {
    throw new Error(
      `System "${systemName}" is a reserved name but has no connection configured yet ` +
      `(set ${systemName}_SAP_ASHOST etc. as CF env vars to enable it).`
    );
  }
  return params;
}

// --- Basic Auth, two fixed users ----------------------------------------
// Credentials come from env vars (CF: cf set-env), with the two usernames
// requested as the default so the server is usable immediately on deploy.
// NOTE: identical username/password per user is weak by design, per explicit
// request — rotate these via `cf set-env` + restage before relying on this
// for anything beyond initial wiring. See MCP on CF SDA.md for the flagged
// security caveat.

const MCP_USERS = {
  [process.env.MCP_USER_1 || 'AYMANK']: process.env.MCP_PASS_1 || 'AYMANK',
  [process.env.MCP_USER_2 || 'SAIREDDY']: process.env.MCP_PASS_2 || 'SAIREDDY'
};

function requireBasicAuth(req, res, next) {
  const credentials = basicAuth(req);
  if (!credentials || MCP_USERS[credentials.name] !== credentials.pass) {
    res.set('WWW-Authenticate', 'Basic realm="SDAINTAI PI/PO RFC MCP"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

// --- RFC execution helpers -----------------------------------------------

async function withRfcConnection(systemName, fn) {
  const connectionParams = getSystemConnectionParams(systemName);
  const client = new RFCClient();
  const connection = await client.open(connectionParams);
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

// --- MCP server + tools ----------------------------------------------------

function buildMcpServer() {
  const server = new McpServer({
    name: 'sdaintai-pipo-rfc-bridge',
    version: '0.1.0'
  });

  server.tool(
    'call_rfc',
    'Executes a named RFC/BAPI on an allowlisted SAP system (currently only "SDAINTAI") ' +
    'and returns the result, including nested structures/tables, directly as tool output.',
    {
      system: z.enum(['SDAINTAI', 'SDADATAAI']).describe(
        'Which allowlisted system to call. Only SDAINTAI is configured today; ' +
        'SDADATAAI is reserved for a later session.'
      ),
      rfc_name: z.string().describe('The RFC/BAPI name to execute, e.g. BAPI_PO_GETITEMS.'),
      import_parameters: z.record(z.any()).optional().default({})
        .describe('Import parameters for the RFC.'),
      changing_parameters: z.record(z.any()).optional().default({})
        .describe('Changing parameters for the RFC, if any.'),
      table_parameters: z.record(z.array(z.any())).optional().default({})
        .describe('Table parameters for the RFC. Mandatory output tables must still be passed as empty arrays.')
    },
    async ({ system, rfc_name, import_parameters, changing_parameters, table_parameters }) => {
      try {
        const result = await withRfcConnection(system, (connection) =>
          connection.execute(rfc_name, {
            import: import_parameters,
            changing: changing_parameters,
            table: table_parameters
          })
        );
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `RFC call failed: ${err.message || String(err)}` }]
        };
      }
    }
  );

  server.tool(
    'get_rfc_metadata',
    'Looks up the expected import/changing/table parameters for a named RFC/BAPI on an ' +
    'allowlisted system, before calling it — use this to avoid guessing a call signature.',
    {
      system: z.enum(['SDAINTAI', 'SDADATAAI']),
      rfc_name: z.string()
    },
    async ({ system, rfc_name }) => {
      try {
        const metadata = await withRfcConnection(system, (connection) =>
          connection.getMetadata(rfc_name)
        );
        return { content: [{ type: 'text', text: JSON.stringify(metadata) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Metadata lookup failed: ${err.message || String(err)}` }]
        };
      }
    }
  );

  return server;
}

// --- HTTP wiring (Streamable HTTP transport, CF-friendly) ------------------

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.status(200).send('ok')); // unauthenticated, for CF health checks

app.use('/mcp', requireBasicAuth);

app.post('/mcp', async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`SDAINTAI PI/PO RFC MCP server listening on ${port}`);
  console.log(`Configured systems: ${Object.entries(SYSTEMS).map(([k, v]) => `${k}=${v ? 'configured' : 'NOT configured'}`).join(', ')}`);
});
