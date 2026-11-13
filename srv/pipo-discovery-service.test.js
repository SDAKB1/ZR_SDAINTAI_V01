'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const cds = require('@sap/cds');
const express = require('express');
const cacheModule = require('./utils/pipoDiscoveryCache');
const clientModule = require('./utils/pipoDiscoveryClient');
const { getEndpoint } = require('./utils/pipoEndpoints');

// Run with node --test: require-cache replacements stay in this file's process.
test('PipoDiscoveryService action over HTTP OData', { concurrency: false }, async t => {
    const tool = 'fetch_pi8_repository_simple_query';
    const endpoint = getEndpoint(tool);
    const entries = new Map();
    const loads = [];
    const calls = { read: 0, check: 0, write: 0, load: 0, config: 0 };
    const connection = {
        url: 'https://discovery.example.test/mcp',
        source: { url: 'https://discovery.example.test/mcp', identity: 'test-reader', version: 'test-v1' }
    };
    const restores = [];
    let configError;
    let databaseError;
    let storeCreations = 0;
    let server;

    t.after(async () => {
        try {
            if (server?.listening) await new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        } finally {
            for (const restore of restores.reverse()) restore();
        }
    });

    function replaceModule(filename, exports) {
        const id = require.resolve(filename);
        const previous = require.cache[id];
        require.cache[id] = { id, filename: id, loaded: true, exports };
        restores.push(() => {
            if (previous) require.cache[id] = previous;
            else delete require.cache[id];
        });
    }

    const store = {
        async read(ID) {
            calls.read++;
            if (databaseError) throw databaseError;
            return entries.get(ID);
        },
        async check() {
            calls.check++;
            if (databaseError) throw databaseError;
        },
        async write(entry) {
            calls.write++;
            if (databaseError) throw databaseError;
            entries.set(entry.ID, { ...entry });
        }
    };
    replaceModule('./utils/pipoDiscoveryCache', {
        ...cacheModule,
        createCdsStore(options) {
            assert.equal(options.cds, cds);
            storeCreations++;
            return store;
        }
    });
    replaceModule('./utils/pipoDiscoveryClient', {
        ...clientModule,
        createDiscoveryClient: () => ({
            resolveEndpoint: clientModule.resolveEndpoint,
            async fetchEndpoint(input) {
                calls.load++;
                loads.push(input);
                return {
                    tool, path: endpoint.path, status: 'ok', httpStatus: 200,
                    metadataOnly: false, artifacts: [{ name: `Interface-${input.context.user.id}` }]
                };
            }
        }),
        readMcpConfig() {
            calls.config++;
            if (configError) throw configError;
            return connection;
        }
    });

    const previousTtl = process.env.PIPO_CACHE_TTL_SECONDS;
    process.env.PIPO_CACHE_TTL_SECONDS = '3600';
    restores.push(() => {
        if (previousTtl === undefined) delete process.env.PIPO_CACHE_TTL_SECONDS;
        else process.env.PIPO_CACHE_TTL_SECONDS = previousTtl;
    });

    // Use CAP's request context and error handling, without loading project auth.
    // Only this loopback test server interprets x-test-user as an identity.
    const previousMiddlewares = Object.getOwnPropertyDescriptor(cds, 'middlewares');
    Object.defineProperty(cds, 'middlewares', {
        configurable: true,
        writable: true,
        value: {
            before: [
                require('@sap/cds/lib/srv/middlewares/cds-context')(),
                (req, res, next) => {
                    const fixtureAuth = 'Basic ' + Buffer.from('alice:fixture-only-pass').toString('base64');
                    const id = req.headers['x-test-user'] || (req.headers.authorization === fixtureAuth ? 'alice' : undefined);
                    cds.context.user = id ? new cds.User(id) : new cds.User.Anonymous();
                    cds.context.tenant = 'discovery-test-tenant';
                    next();
                }
            ],
            after: [require('@sap/cds/lib/srv/middlewares/errors')()]
        }
    });
    restores.push(() => {
        if (previousMiddlewares) Object.defineProperty(cds, 'middlewares', previousMiddlewares);
        else delete cds.middlewares;
    });

    const implId = require.resolve('./pipo-discovery-service');
    const previousImpl = require.cache[implId];
    delete require.cache[implId];
    restores.push(() => {
        if (previousImpl) require.cache[implId] = previousImpl;
        else delete require.cache[implId];
    });
    const previousService = cds.services.PipoDiscoveryService;
    const previousProviders = cds.service.providers.slice();
    restores.push(() => {
        if (previousService === undefined) delete cds.services.PipoDiscoveryService;
        else cds.services.PipoDiscoveryService = previousService;
        cds.service.providers.splice(0, cds.service.providers.length, ...previousProviders);
    });

    const model = await cds.load(path.join(__dirname, 'pipo-discovery-service.cds'));
    const app = express();
    const service = await cds.serve('PipoDiscoveryService').from(model)
        .with(require(implId)).to('odata-v4').in(app);
    assert.equal(storeCreations, 1, 'the actual service implementation creates the store');
    assert.equal(service.definition.name, 'PipoDiscoveryService');
    assert.equal(service.path, '/odata/v4/pipo-discovery', 'the CLI and deployed CAP action must use the same route');
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');

    function post(data = {}, user = 'alice') {
        const body = JSON.stringify({ tool, parameters: '{}', ttlSeconds: 60, ...data });
        return new Promise((resolve, reject) => {
            const headers = {
                'content-type': 'application/json', accept: 'application/json',
                'content-length': Buffer.byteLength(body)
            };
            if (user !== null) headers['x-test-user'] = user;
            const request = http.request({
                hostname: '127.0.0.1', port: server.address().port,
                path: `${service.path}/fetchEndpoint`, method: 'POST', headers, agent: false
            }, response => {
                let text = '';
                response.setEncoding('utf8');
                response.on('data', chunk => { text += chunk; });
                response.on('error', reject);
                response.on('end', () => {
                    try {
                        assert.match(response.headers['content-type'], /application\/json/);
                        resolve({ status: response.statusCode, body: JSON.parse(text), text });
                    } catch (error) { reject(error); }
                });
            });
            request.on('error', reject);
            request.setTimeout(5000, () => request.destroy(new Error('Test HTTP request timed out.')));
            request.end(body);
        });
    }

    t.beforeEach(() => {
        entries.clear();
        loads.length = 0;
        for (const key of Object.keys(calls)) calls[key] = 0;
        configError = databaseError = undefined;
    });

    await t.test('authenticated action serializes the result and repeated calls hit the real cache', async () => {
        const first = await post({ parameters: '{"b":2,"a":1}' });
        assert.equal(first.status, 200);
        assert.equal(typeof first.body.result, 'string');
        assert.deepEqual(JSON.parse(first.body.result), {
            tool, path: endpoint.path, status: 'ok', httpStatus: 200,
            metadataOnly: false, artifacts: [{ name: 'Interface-alice' }]
        });
        assert.equal(first.body.cache.hit, false);
        assert.equal(first.body.cache.backend, 'cap-db');
        assert.ok(Number.isFinite(Date.parse(first.body.cache.fetchedAt)));
        assert.equal(Date.parse(first.body.cache.expiresAt) - Date.parse(first.body.cache.fetchedAt), 60000);
        assert.ok(loads[0].context.user instanceof cds.User.class);
        assert.equal(loads[0].context.user.is('authenticated-user'), true);
        assert.equal(loads[0].context.tenant, 'discovery-test-tenant');
        assert.equal(loads[0].context.connection, connection);
        assert.deepEqual(loads[0].parameters, { a: 1, b: 2 });

        const second = await post({ parameters: '{"a":1,"b":2}' });
        assert.equal(second.status, 200);
        assert.equal(second.body.result, first.body.result);
        assert.deepEqual(second.body.cache, { ...first.body.cache, hit: true });
        assert.deepEqual(calls, { read: 2, check: 0, write: 1, load: 1, config: 2 });
        assert.equal(entries.size, 1);
    });

    await t.test('another authenticated user cannot reuse the first user cache entry', async () => {
        const alice = await post();
        const bob = await post({}, 'bob');
        const bobAgain = await post({}, 'bob');
        assert.deepEqual([alice.status, bob.status, bobAgain.status], [200, 200, 200]);
        assert.equal(alice.body.cache.hit, false);
        assert.equal(bob.body.cache.hit, false);
        assert.equal(bobAgain.body.cache.hit, true);
        assert.equal(JSON.parse(bob.body.result).artifacts[0].name, 'Interface-bob');
        assert.notEqual(alice.body.result, bob.body.result);
        assert.equal(calls.load, 2);
        assert.equal(entries.size, 2);
    });

    await t.test('the real CLI cache client reaches the CAP action and reuses the committed response', async () => {
        const { fetchPipo } = require('../mcp/pipo-rfc-server/fetch-pipo');
        const options = { cache: true, tool, env: {
            PIPO_CAP_URL: `http://127.0.0.1:${server.address().port}`,
            PIPO_CAP_USER: 'alice', PIPO_CAP_PASS: 'fixture-only-pass'
        } };
        const first = await fetchPipo(options);
        const second = await fetchPipo(options);
        assert.equal(first.discovery.endpoints[0].cache.hit, false);
        assert.equal(second.discovery.endpoints[0].cache.hit, true);
        assert.equal(second.discovery.endpoints[0].artifacts[0].name, 'Interface-[REDACTED]');
        assert.equal(calls.load, 1, 'the second real HTTP call never reaches the MCP loader');
    });

    await t.test('anonymous action returns 401 before config, database or upstream access', async () => {
        const response = await post({}, null);
        assert.equal(response.status, 401);
        assert.equal(String(response.body.error.code), '401');
        assert.deepEqual(calls, { read: 0, check: 0, write: 0, load: 0, config: 0 });
    });

    await t.test('a syntactically valid but unregistered tool returns 400', async () => {
        const response = await post({ tool: 'fetch_pi8_not_registered' });
        assert.equal(response.status, 400);
        assert.equal(response.body.error.message, 'Unknown discovery endpoint.');
        assert.deepEqual(calls, { read: 0, check: 0, write: 0, load: 0, config: 0 });
    });

    await t.test('invalid JSON and non-object parameters return 400 without downstream access', async () => {
        for (const parameters of ['{broken', '[]', 'null', '{"nested":{"constructor":{}}}']) {
            const response = await post({ parameters });
            assert.equal(response.status, 400);
            assert.equal(response.body.error.message, 'Parameters must be a plain JSON object.');
        }
        assert.deepEqual(calls, { read: 0, check: 0, write: 0, load: 0, config: 0 });
    });

    await t.test('unexpected internal errors become sanitized 503 responses', async () => {
        configError = new Error('synthetic private configuration diagnostic');
        const response = await post();
        assert.equal(response.status, 503);
        assert.doesNotMatch(response.text, /synthetic private|stack|pipo-discovery-service\.js/);
        assert.equal(calls.config, 1);
        assert.equal(calls.load, 0);
        assert.equal(calls.read, 0);
    });

    await t.test('database errors fail closed with sanitized 503 and no upstream call', async () => {
        databaseError = new Error('synthetic private database diagnostic');
        const response = await post();
        assert.equal(response.status, 503);
        assert.doesNotMatch(response.text, /synthetic private|stack|pipoDiscoveryCache\.js/);
        assert.equal(calls.read, 1);
        assert.equal(calls.load, 0);
        assert.equal(calls.write, 0);
        assert.equal(entries.size, 0);
    });
});