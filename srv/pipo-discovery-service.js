'use strict';

const cds = require('@sap/cds');
const { CacheError, parseParameters, createReadThroughCache, createCdsStore } = require('./utils/pipoDiscoveryCache');
const { createDiscoveryClient, readMcpConfig } = require('./utils/pipoDiscoveryClient');

module.exports = cds.service.impl(function () {
    const client = createDiscoveryClient();
    const cache = createReadThroughCache({ store: createCdsStore({ cds }), load: client.fetchEndpoint });

    this.on('fetchEndpoint', async req => {
        if (!req.user?.is('authenticated-user')) return req.reject(401, 'Authentication is required.');
        try {
            const endpoint = client.resolveEndpoint(req.data.tool);
            const parameters = parseParameters(req.data.parameters);
            const connection = readMcpConfig();
            return await cache.fetchEndpoint({
                tool: req.data.tool,
                endpoint,
                parameters,
                ttlSeconds: req.data.ttlSeconds,
                forceRefresh: req.data.forceRefresh,
                source: connection.source,
                context: { tenant: req.tenant, user: req.user, connection }
            });
        } catch (error) {
            // Only our fixed messages cross the API boundary; never propagate raw SDK/DB errors.
            if (error instanceof CacheError) return req.reject(error.statusCode, error.message);
            return req.reject(503, 'Discovery cache service is unavailable.');
        }
    });
});