'use strict';

// Node.js 20+. No new dependencies; MCP mode uses this package's existing SDK.
const DEFAULT_URL = 'https://sdaintai-pipo-rfc-mcp.cfapps.us10.hana.ondemand.com/mcp';
const READ_TOOLS = ['get_pi8_status', 'list_pi8_esr_objects'];
const REQUEST_OPTIONS = { timeout: 30000 };

function serverUrl(value) {
  const url = new URL(value || DEFAULT_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Use HTTPS, or HTTP on localhost for development.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('PIPO_MCP_URL must not contain credentials, query parameters or a fragment.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/mcp') ? path : `${path}/mcp`;
  return url;
}

async function fetchPipo({ rest = false, toolsOnly = false, env = process.env } = {}) {
  if (rest && toolsOnly) throw new Error('--tools-only requires MCP mode.');
  const url = serverUrl(env.PIPO_MCP_URL);

  if (rest) {
    const output = { mode: 'rest' };
    for (const [key, path] of [['status', 'ping'], ['objects', 'objects']]) {
      const endpoint = new URL(url);
      endpoint.pathname = endpoint.pathname.replace(/\/mcp$/, `/api/pi8/${path}`);
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) throw new Error(`PI8 ${key} request failed (HTTP ${response.status}).`);
      output[key] = await response.json();
    }
    return output;
  }

  if (!env.PIPO_MCP_USER || !env.PIPO_MCP_PASS) {
    throw new Error('Set PIPO_MCP_USER and PIPO_MCP_PASS, or use --rest without credentials.');
  }
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const authorization = 'Basic ' + Buffer.from(`${env.PIPO_MCP_USER}:${env.PIPO_MCP_PASS}`).toString('base64');
  const client = new Client({ name: 'pipo-fetch', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: authorization }, redirect: 'error' }
  });

  try {
    await client.connect(transport, REQUEST_OPTIONS);
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, REQUEST_OPTIONS);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    const output = { mode: 'mcp', tools };
    if (!toolsOnly) {
      for (const [index, name] of READ_TOOLS.entries()) {
        if (!tools.some((tool) => tool.name === name)) throw new Error(`Required tool ${name} is unavailable.`);
        const result = await client.callTool({ name, arguments: {} }, undefined, REQUEST_OPTIONS);
        if (result.isError) throw new Error(`Tool ${name} failed; check the server's destination configuration.`);
        const text = result.content.find((item) => item.type === 'text');
        if (!text) throw new Error(`Tool ${name} returned no text result.`);
        output[index === 0 ? 'status' : 'objects'] = JSON.parse(text.text);
      }
    }
    return output;
  } finally {
    await client.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node fetch-pipo.js [--rest | --tools-only]\n' +
      'Default: discover MCP tools, then fetch PI8 status and ESR objects.\n' +
      '--tools-only: list live MCP tool descriptions and input schemas without calling tools.\n' +
      '--rest: fetch public PI8 status/objects without credentials or MCP discovery.\n' +
      'Environment: PIPO_MCP_URL (optional), PIPO_MCP_USER, PIPO_MCP_PASS.\n' +
      'Prints JSON to stdout; redirect it to a file if needed.');
    return;
  }
  if (args.some((arg) => !['--rest', '--tools-only'].includes(arg))) {
    throw new Error('Unknown argument. Use --help for usage.');
  }
  const output = await fetchPipo({ rest: args.includes('--rest'), toolsOnly: args.includes('--tools-only') });
  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch(() => {
    // SDK/network errors can include response bodies; never echo them or credentials.
    console.error('PIPO fetch failed. Check arguments (--help), URL, credentials and server connectivity.');
    process.exitCode = 1;
  });
}

module.exports = { fetchPipo };