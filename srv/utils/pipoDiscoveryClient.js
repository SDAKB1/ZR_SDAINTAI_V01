'use strict';

const { CacheError, sourceUrl, canonicalize, isCacheableResponse, endpointFailure, MAX_PAYLOAD_BYTES } = require('./pipoDiscoveryCache');

function resolveEndpoint(tool, getRegistry = () => require('./pipoEndpoints')) {
    if (typeof tool !== 'string' || !/^fetch_pi8_[a-z0-9_]+$/.test(tool)) {
        throw new CacheError('PIPO_UNKNOWN_ENDPOINT', 'Unknown discovery endpoint.');
    }
    let registry;
    try { registry = getRegistry(); } catch {
        throw new CacheError('PIPO_REGISTRY_UNAVAILABLE', 'Discovery endpoint registry is unavailable.', 503);
    }
    if (!registry || typeof registry.getEndpoint !== 'function' || !registry.ENDPOINTS) {
        throw new CacheError('PIPO_REGISTRY_UNAVAILABLE', 'Discovery endpoint registry is unavailable.', 503);
    }
    const endpoints = Array.isArray(registry.ENDPOINTS) ? registry.ENDPOINTS : Object.values(registry.ENDPOINTS);
    const endpoint = endpoints.find(item => item?.tool === tool);
    if (!endpoint || registry.getEndpoint(tool)?.tool !== tool) {
        throw new CacheError('PIPO_UNKNOWN_ENDPOINT', 'Unknown discovery endpoint.');
    }
    return endpoint;
}

function readMcpConfig(env = process.env) {
    const url = sourceUrl(env.PIPO_MCP_URL);
    if (!env.PIPO_MCP_USER || !env.PIPO_MCP_PASS) {
        throw new CacheError('PIPO_CACHE_CONFIGURATION', 'MCP server credentials are not configured.', 503);
    }
    return {
        url,
        username: env.PIPO_MCP_USER,
        password: env.PIPO_MCP_PASS,
        source: { url, identity: env.PIPO_MCP_USER, version: env.PIPO_CACHE_SOURCE_VERSION || '' }
    };
}

function createDiscoveryClient({ getRegistry, createConnection } = {}) {
    function connectionFor(config) {
        const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
        const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
        const authorization = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
        const client = new Client({ name: 'pipo-cap-discovery', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: { headers: { Authorization: authorization }, redirect: 'error' }
        });
        return { client, transport };
    }
    async function fetchEndpoint({ tool, parameters, context }) {
        const endpoint = resolveEndpoint(tool, getRegistry);
        let connection;
        try {
            const config = context.connection;
            sourceUrl(config.url); // Also guard injected/test connections against unsafe destinations.
            connection = (createConnection || connectionFor)(config);
            const { client, transport } = connection;
            const options = { timeout: 60000 };
            await client.connect(transport, options);
            const envelope = await client.callTool({ name: endpoint.tool, arguments: parameters }, undefined, options);
            if (envelope.isError) return endpointFailure(tool, endpoint);
            let result = envelope.structuredContent;
            if (!result) {
                const content = envelope.content?.filter(item => item.type === 'text');
                if (content?.length !== 1 || Buffer.byteLength(content[0].text, 'utf8') > MAX_PAYLOAD_BYTES) return endpointFailure(tool, endpoint);
                result = JSON.parse(content[0].text);
            }
            const serialized = canonicalize(result);
            const encodedPassword = JSON.stringify(config.password).slice(1, -1);
            if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES || serialized.includes(encodedPassword) ||
                (result.tool && result.tool !== tool) || (result.path && result.path !== endpoint.path)) {
                return endpointFailure(tool, endpoint);
            }
            // Do not return SDK/HTTP/SOAP error bodies to CAP callers or logs.
            return isCacheableResponse(result) ? result : endpointFailure(tool, endpoint, result);
        } catch {
            return endpointFailure(tool, endpoint);
        } finally {
            try { await connection?.client.close(); } catch { /* Never expose SDK close errors. */ }
        }
    }
    return { resolveEndpoint: tool => resolveEndpoint(tool, getRegistry), fetchEndpoint };
}

module.exports = { resolveEndpoint, readMcpConfig, createDiscoveryClient };