'use strict';

/**
 * SDAINTAI PI/PO & S/4HANA RFC bridge, exposed as a remote MCP server.
 *
 * Two independent connectivity paths live here:
 *
 * 1. Generic RFC/BAPI calls (call_rfc/get_rfc_metadata) against named
 *    "systems" configured entirely via environment variables (SDAINTAI,
 *    SDADATAAI). Uses `open-rfc` (public npm, zero runtime dependencies) --
 *    not `@sap-rfc/node-rfc-library`, which needs a private registry token
 *    and blocks `npm install`/`cf push` for anyone without it.
 *
 * 2. PI8 (PJ2) reachability + real ESR object enumeration -- HTTP, not RFC,
 *    reached only through Cloud Connector destinations bound via the
 *    platform's destination service (see PI8_DESTINATIONS below). This is
 *    the path that's actually been proven live against a real system; (1)
 *    above has never been pointed at a real SAP system yet.
 */

const express = require('express');
const basicAuth = require('basic-auth');
const { Client } = require('open-rfc');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

// --- Allowlisted systems (RFC path) -------------------------------------
// Each entry's connection params come entirely from env vars. A system that
// has no ASHOST configured is treated as "not yet set up" and calls to it
// are rejected, rather than silently falling back to any default.

function systemFromEnv(prefix) {
  const ashost = process.env[`${prefix}_SAP_ASHOST`];
  if (!ashost) return null; // not configured yet
  return {
    ashost,
    sysnr: process.env[`${prefix}_SAP_SYSNR`] || '00',
    client: process.env[`${prefix}_SAP_CLIENT`],
    user: process.env[`${prefix}_SAP_USER`],
    passwd: process.env[`${prefix}_SAP_PASSWD`],
    lang: process.env[`${prefix}_SAP_LANG`] || 'EN'
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
// request -- rotate these via `cf set-env` + restage before relying on this
// for anything beyond initial wiring.

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
  const client = new Client(connectionParams, { timeout: 30 });
  await client.open();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// --- PI8 (PI/PO, non-BW source) reachability proof ------------------------
// HTTP, not RFC -- only reachable through the Cloud Connector virtual host
// configured as destinations in the destination service bound to this app
// (ProxyType OnPremise). The destination names are PO_PJ2_ESR (Enterprise
// Services Repository -- the object catalog) and PO_PJ2_DIR (Integration
// Directory -- runtime config), both pointed at nwjava.consultsda.com:443 /
// PJ2. A non-2xx HTTP response still proves the tunnel/destination chain
// works (the real system answered), so only a connection-level failure (no
// err.response) counts as unreachable. Proven live (originally against the
// SDADATAAI BW cockpit's bw-rfc-server, migrated here) -- see README.md.
const PI8_DESTINATIONS = ['PO_PJ2_ESR', 'PO_PJ2_DIR'];

// Build explicit Basic Auth header for OnPremise destinations -- the
// @sap-cloud-sdk/http-client does not reliably forward credentials for
// OnPremise destinations via Cloud Connector, causing 401 responses.
function buildPipoAuthHeaders() {
  const pipoUser = process.env.PIPO_USER;
  const pipoPass = process.env.PIPO_PASS;
  return pipoUser && pipoPass
    ? { 'Authorization': 'Basic ' + Buffer.from(`${pipoUser}:${pipoPass}`).toString('base64') }
    : {};
}

async function pingPi8() {
  const destinations = {};
  const authHeaders = buildPipoAuthHeaders();
  for (const destinationName of PI8_DESTINATIONS) {
    try {
      const response = await executeHttpRequest(
        { destinationName },
        { method: 'get', url: '/', timeout: 10000, headers: authHeaders }
      );
      destinations[destinationName] = { reachable: true, status: response.status };
    } catch (err) {
      if (err.response) {
        destinations[destinationName] = {
          reachable: true,
          status: err.response.status,
          note: 'Non-2xx response, but the system answered -- tunnel is working.'
        };
      } else {
        destinations[destinationName] = { reachable: false, error: err.message || String(err) };
      }
    }
  }
  const reachable = Object.values(destinations).some((d) => d.reachable);
  return { reachable, system: 'PI8', systemname: 'PJ2', via: 'Cloud Connector (OnPremise)', destinations };
}

// Real ESR object enumeration -- the Cloud Connector's Resources ACL for
// nwjava.consultsda.com:443 allowlists /rep/support/SimpleQuery, the classic
// ESR "SimpleQuery" servlet (an HTML form normally driven from a browser).
// POSTing it directly with a fixed set of object types returns a real HTML
// results table (verified live: 243 real objects, including genuine custom
// content under this org's own software component versions, not just SAP's
// demo objects). Each result row's "R" (raw) link encodes TYPE/KEY/SWCGUID
// as query params -- far more reliable to parse than the free-text label
// column, so that's what gets parsed out.
const PI8_QUERY_TYPES = {
  ifmmessif: 'Service Interface',
  MAPPING: 'Operation Mapping',
  XI_TRAFO: 'Message Mapping',
  ChannelTemplate: 'Communication Channel Template',
  RepBProcess: 'Integration Process'
};

function buildSimpleQueryBody() {
  const params = new URLSearchParams();
  params.append('qc', 'All software components');
  params.append('underL', 'true');
  params.append('changeL', 'true');
  // userL filter removed -- was restricting to SDAINT user artifacts only,
  // causing 0 results while direct curl returned 38 objects
  params.append('syncTabL', 'true');
  params.append('deletedL', 'N');
  params.append('xmlReleaseL', '7.1');
  Object.keys(PI8_QUERY_TYPES).forEach((t) => params.append('types', t));
  params.append('result', 'RA_XILINK');
  params.append('action', 'Start query');
  return params.toString();
}

function parseSimpleQueryResults(html) {
  const rowRe = /<td>\s*([\s\S]*?)<\/td><td>([^<]*)<\/td><td><a target="_blank" href="([^"]+)">R<\/a><\/td>/g;
  const items = [];
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const swcv = m[2].trim();
    const href = m[3].replace(/&amp;/g, '&');
    const qIdx = href.indexOf('?');
    if (qIdx === -1) continue;
    const qs = new URLSearchParams(href.slice(qIdx + 1));
    const type = qs.get('TYPE') || '';
    let key = qs.get('KEY') || '';
    try { key = decodeURIComponent(key); } catch (e) { /* use raw */ }
    const [name, namespace] = key.split('|');
    items.push({
      type,
      typeLabel: PI8_QUERY_TYPES[type] || type,
      name: name || key,
      namespace: namespace || '',
      swcv,
      isCustom: !swcv.includes('SAP BASIS')
    });
  }
  return items;
}

async function listPi8EsrObjects() {
  const authHeaders = buildPipoAuthHeaders();
  const response = await executeHttpRequest(
    { destinationName: 'PO_PJ2_ESR' },
    {
      method: 'post',
      url: '/rep/support/SimpleQuery',
      data: buildSimpleQueryBody(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeaders },
      timeout: 20000
    }
  );
  const html = String(response.data);
  const countMatch = html.match(/Amount of objects:\s*(\d+)/);
  const totalCount = countMatch ? parseInt(countMatch[1], 10) : null;
  const items = parseSimpleQueryResults(html).sort((a, b) => b.isCustom - a.isCustom);
  return { verified: true, totalCount, returned: Math.min(items.length, 150), items: items.slice(0, 150) };
}

// --- MCP server + tools ----------------------------------------------------

function buildMcpServer() {
  const server = new McpServer({
    name: 'sdaintai-pipo-rfc-bridge',
    version: '0.2.0'
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
        // open-rfc's call() takes one flat parameter object keyed by ABAP
        // parameter name (import/changing/table are not separate buckets at
        // the wire level) and returns a flat result object the same way.
        const input = { ...import_parameters, ...changing_parameters, ...table_parameters };
        const result = await withRfcConnection(system, (client) => client.call(rfc_name, input));
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
    'allowlisted system, before calling it -- use this to avoid guessing a call signature.',
    {
      system: z.enum(['SDAINTAI', 'SDADATAAI']),
      rfc_name: z.string()
    },
    async ({ system, rfc_name }) => {
      try {
        const metadata = await withRfcConnection(system, (client) => client.getFunctionInterface(rfc_name));
        return { content: [{ type: 'text', text: JSON.stringify(metadata) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Metadata lookup failed: ${err.message || String(err)}` }]
        };
      }
    }
  );

  server.tool(
    'get_pi8_status',
    'Checks reachability of PI8 (PJ2, PI/PO, non-BW source) through the Cloud Connector ' +
    'destinations PO_PJ2_ESR and PO_PJ2_DIR -- proves the on-premise tunnel is working.',
    {},
    async () => {
      try {
        const status = await pingPi8();
        return { content: [{ type: 'text', text: JSON.stringify(status) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `PI8 ping failed: ${err.message || String(err)}` }] };
      }
    }
  );

  server.tool(
    'list_pi8_esr_objects',
    'Lists real PI8 (PJ2) ESR objects (Service Interfaces, Operation/Message Mappings, ' +
    'Communication Channel Templates, Integration Processes) via the live ESR SimpleQuery ' +
    'servlet -- up to 150 of the total found, custom content sorted first.',
    {},
    async () => {
      try {
        const result = await listPi8EsrObjects();
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `PI8 object enumeration failed: ${err.message || String(err)}` }] };
      }
    }
  );

  return server;
}

// --- HTTP wiring (Streamable HTTP transport, CF-friendly) ------------------

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.status(200).send('ok')); // unauthenticated, for CF health checks

// --- Plain JSON REST endpoints, for the btp_cockpit.html page in the
// browser. Deliberately NOT behind the MCP/Basic-Auth layer below -- a
// browser page calling an MCP server directly would mean embedding Basic
// Auth credentials in client-side JS (visible in page source), which is
// worse than leaving these specific read-only, low-sensitivity endpoints
// (ESR object technical names, no customer data) open. Matches the pattern
// already proven in the SDADATAAI BW cockpit's bw-rfc-server.
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/pi8/ping', async (req, res) => {
  res.json(await pingPi8());
});

app.get('/api/pi8/objects', async (req, res) => {
  try {
    res.json(await listPi8EsrObjects());
  } catch (err) {
    if (err.response) {
      return res.status(502).json({ verified: false, error: 'HTTP ' + err.response.status, items: [] });
    }
    res.status(502).json({ verified: false, error: err.message || String(err), items: [] });
  }
});

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
  console.log(`Configured RFC systems: ${Object.entries(SYSTEMS).map(([k, v]) => `${k}=${v ? 'configured' : 'NOT configured'}`).join(', ')}`);
  console.log('PI8 (PJ2) HTTP path ready at /api/pi8/ping and /api/pi8/objects (needs AICONX-destination bound).');
});
