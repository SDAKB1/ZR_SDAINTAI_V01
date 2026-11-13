'use strict';

const cds = require('@sap/cds');
const { CacheError, parseParameters, createReadThroughCache, createCdsStore } = require('./utils/pipoDiscoveryCache');
const { createDiscoveryClient, readMcpConfig } = require('./utils/pipoDiscoveryClient');
const LOG = cds.log('pipo-discovery-cache');

module.exports = cds.service.impl(function () {
    const client = createDiscoveryClient();
    const cache = createReadThroughCache({ store: createCdsStore({ cds }), load: client.fetchEndpoint });

    this.on('fetchEndpoint', async req => {
        if (!req.user?.is('authenticated-user')) return req.reject(401, 'Authentication is required.');
        const started = Date.now();
        try {
            const endpoint = client.resolveEndpoint(req.data.tool);
            const parameters = parseParameters(req.data.parameters);
            const connection = readMcpConfig();
            const response = await cache.fetchEndpoint({
                tool: req.data.tool,
                endpoint,
                parameters,
                ttlSeconds: req.data.ttlSeconds,
                forceRefresh: req.data.forceRefresh,
                source: connection.source,
                context: { tenant: req.tenant, user: req.user, connection }
            });
            LOG.info({ event: 'endpoint-cache-result', tool: endpoint.tool, cacheHit: response.cache.hit,
                backend: response.cache.backend, durationMs: Date.now() - started });
            return response;
        } catch (error) {
            // Only our fixed messages cross the API boundary; never propagate raw SDK/DB errors.
            LOG.warn({ event: 'endpoint-cache-failed', httpStatus: error instanceof CacheError ? error.statusCode : 503,
                durationMs: Date.now() - started });
            if (error instanceof CacheError) return req.reject(error.statusCode, error.message);
            return req.reject(503, 'Discovery cache service is unavailable.');
        }
    });
});