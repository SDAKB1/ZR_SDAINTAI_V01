'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const {
    CacheError, MAX_PARAMETERS_BYTES, MAX_PAYLOAD_BYTES, canonicalize, parseParameters,
    configuredTtl, resolveTtl, createCacheKey, createReadThroughCache, createCdsStore, isCacheableResponse
} = require('./pipoDiscoveryCache');

const tool = 'fetch_pi8_repository_simple_query';
const endpoint = { tool, path: '/rep/support/SimpleQuery', category: 'Repository' };
const source = { url: 'https://mcp.example.test/mcp', identity: 'mcp-reader', version: '' };
const context = { tenant: 'tenant-a', user: { id: 'alice' } };
const request = overrides => ({ tool, endpoint, parameters: {}, source, context, ...overrides });
const success = { tool, status: 'ok', httpStatus: 200, metadataOnly: false, artifacts: [{ name: 'Interface-A' }] };

function fixture(options = {}) {
    const entries = new Map();
    const counts = { read: 0, check: 0, write: 0, load: 0 };
    let now = Date.parse('2030-01-01T00:00:00Z');
    const store = {
        async read(ID) { counts.read++; return entries.get(ID); },
        async check() { counts.check++; },
        async write(entry) { counts.write++; entries.set(entry.ID, { ...entry }); }
    };
    const cache = createReadThroughCache({
        store,
        clock: () => now,
        maxTtlSeconds: 3600,
        load: async input => { counts.load++; return options.load ? options.load(input) : success; },
        ...options.cache
    });
    return { entries, counts, store, cache, advance: ms => { now += ms; } };
}

test('cacheability fails closed for excessive nesting and cycles without prior canonicalization', () => {
    assert.equal(isCacheableResponse(success), true);
    let nested = { errors: ['must not be missed'] };
    for (let depth = 0; depth < 100; depth++) nested = { child: nested };
    assert.equal(isCacheableResponse({ status: 'ok', nested }), false);
    const cyclic = { status: 'ok' };
    cyclic.self = cyclic;
    assert.equal(isCacheableResponse(cyclic), false);
});

test('canonical parameters sort nested objects, preserve arrays and reject unsafe JSON', () => {
    assert.equal(canonicalize({ z: [{ b: 2, a: 1 }], a: true }), '{"a":true,"z":[{"a":1,"b":2}]}');
    assert.notEqual(canonicalize({ a: [1, 2] }), canonicalize({ a: [2, 1] }));
    const cycle = {}; cycle.self = cycle;
    const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('must not run'); } });
    const invalid = [cycle, getter, new Date(), new Map(), Object.create({ inherited: true }),
        { x: undefined }, { x: () => 0 }, { x: BigInt(1) }, { x: NaN }, { x: Infinity }, { x: Symbol('x') },
        JSON.parse('{"__proto__":{}}'), JSON.parse('{"nested":{"constructor":{}}}'), { x: [, 1] }];
    for (const value of invalid) assert.throws(() => canonicalize(value), CacheError);
    for (const text of ['[]', 'null', '1', '"text"', '{broken']) assert.throws(() => parseParameters(text), CacheError);
    assert.deepEqual(parseParameters('{"b":2,"a":1}'), { b: 2, a: 1 });
    assert.throws(() => parseParameters(JSON.stringify({ text: 'é'.repeat(MAX_PARAMETERS_BYTES) })), { statusCode: 413 });
});

test('TTL defaults, configuration bounds and bad request types are explicit', () => {
    assert.equal(configuredTtl('3600'), 3600);
    assert.equal(configuredTtl('0'), 0);
    assert.equal(configuredTtl('604800'), 604800);
    for (const value of ['', '-1', '1.5', '604801', 'bad']) assert.throws(() => configuredTtl(value), { statusCode: 503 });
    assert.equal(resolveTtl(undefined, 3600), 3600);
    assert.equal(resolveTtl(0, 3600), 0);
    for (const value of ['30', true, -1, 0.1, NaN, 3601]) assert.throws(() => resolveTtl(value, 3600), { statusCode: 400 });
});

test('invalid TTL, flags and parameters fail before database or upstream access', async () => {
    const f = fixture();
    for (const overrides of [{ ttlSeconds: '10' }, { ttlSeconds: -1 }, { ttlSeconds: 604801 },
        { forceRefresh: 'false' }, { parameters: [] }, { parameters: { x: undefined } }]) {
        await assert.rejects(f.cache.fetchEndpoint(request(overrides)), { statusCode: 400 });
    }
    assert.deepEqual(f.counts, { read: 0, check: 0, write: 0, load: 0 });
});

test('keys isolate tenant, CAP user, MCP identity, source URL, revision, tool and parser', () => {
    const input = request({ parameters: { b: 2, a: { d: 4, c: 3 } } });
    const key = createCacheKey(input);
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(key, createCacheKey({ ...input, parameters: { a: { c: 3, d: 4 }, b: 2 } }));
    const variants = [
        { context: { ...context, tenant: 'tenant-b' } },
        { context: { ...context, user: { id: 'bob' } } },
        { source: { ...source, identity: 'different-mcp-user' } },
        { source: { ...source, url: 'https://other.example.test/mcp' } },
        { source: { ...source, version: 'rotated-destination' } },
        { tool: 'fetch_pi8_cpa_cache' },
        { parameters: { a: 1 } },
        { parserVersion: 'next-parser' }
    ];
    for (const variant of variants) assert.notEqual(key, createCacheKey({ ...input, ...variant }));
    assert.throws(() => createCacheKey({ ...input, context: { user: { id: 'anonymous' } } }), { statusCode: 401 });
});

test('read-through hits reuse durable rows across cache instances and canonical params', async () => {
    const f = fixture();
    const first = await f.cache.fetchEndpoint(request({ parameters: { b: 2, a: 1 } }));
    assert.equal(first.cache.hit, false);
    const secondCache = createReadThroughCache({ store: f.store, maxTtlSeconds: 3600,
        clock: () => Date.parse(first.cache.fetchedAt) + 1, load: () => assert.fail('must hit persistence') });
    const second = await secondCache.fetchEndpoint(request({ parameters: { a: 1, b: 2 } }));
    assert.equal(second.cache.hit, true);
    assert.equal(second.result, first.result);
    assert.equal(f.counts.load, 1);
    assert.equal(f.entries.size, 1);
});

test('expiry is strict; longer requested TTL never extends a stored expiry', async () => {
    const f = fixture();
    const first = await f.cache.fetchEndpoint(request({ ttlSeconds: 10 }));
    f.advance(9999);
    const hit = await f.cache.fetchEndpoint(request({ ttlSeconds: 100 }));
    assert.equal(hit.cache.hit, true);
    assert.equal(hit.cache.expiresAt, first.cache.expiresAt);
    f.advance(1);
    assert.equal((await f.cache.fetchEndpoint(request({ ttlSeconds: 100 }))).cache.hit, false);
    assert.equal(f.counts.load, 2);
    assert.equal(f.entries.size, 1, 'refresh upserts the same key');
});

test('shorter requested TTL expires data even before its stored expiresAt', async () => {
    const f = fixture();
    await f.cache.fetchEndpoint(request({ ttlSeconds: 100 }));
    f.advance(10000);
    assert.equal((await f.cache.fetchEndpoint(request({ ttlSeconds: 10 }))).cache.hit, false);
    assert.equal(f.counts.load, 2);
});

test('TTL zero bypasses reads/writes with finite zero-lifetime metadata; force bypasses reads', async () => {
    const f = fixture();
    const bypass = await f.cache.fetchEndpoint(request({ ttlSeconds: 0 }));
    assert.equal(bypass.cache.hit, false);
    assert.equal(bypass.cache.expiresAt, bypass.cache.fetchedAt);
    assert.equal(bypass.cache.backend, 'none');
    assert.equal(f.counts.read, 0);
    assert.equal(f.counts.check, 1);
    assert.equal(f.entries.size, 0);
    await f.cache.fetchEndpoint(request());
    await f.cache.fetchEndpoint(request({ forceRefresh: true }));
    assert.equal(f.counts.read, 1);
    assert.equal(f.counts.check, 2);
    assert.equal(f.counts.load, 3);
    assert.equal(f.entries.size, 1);
});

test('verified metadata-only responses are cached without requiring artifact extraction', async () => {
    const metadata = { status: 'metadata-only', metadataOnly: true, httpStatus: 200,
        response: { format: 'xml', body: { definitions: { name: 'VerifiedWSDL',
            operation: { 'wsdl:fault': { name: 'ContractFault' }, 'soap:fault': { use: 'literal' } } } } }, artifacts: [] };
    const f = fixture({ load: () => metadata });
    await f.cache.fetchEndpoint(request());
    const hit = await f.cache.fetchEndpoint(request());
    assert.equal(hit.cache.hit, true);
    assert.deepEqual(JSON.parse(hit.result), metadata);
});

test('actual sanitized XML diagnostics with a redacted Password survive the CAP client and cache', async () => {
    // Test-only MCP dependency: all HTTP and MCP transport calls remain offline.
    const { createEndpointFetcher } = require('../../mcp/pipo-rfc-server/endpoint-fetcher');
    const { createDiscoveryClient } = require('./pipoDiscoveryClient');
    const { getEndpoint } = require('./pipoEndpoints');
    const diagnostic = getEndpoint('fetch_pi8_channel_admin');
    const fetch = createEndpointFetcher({
        buildPipoAuthHeaders: () => ({}),
        executeHttpRequest: async () => ({ status: 200, headers: { 'content-type': 'text/xml' },
            data: '<Channel><Name>Example</Name><Password>synthetic-channel-password</Password></Channel>' })
    });
    const sanitized = await fetch(diagnostic.tool);
    assert.equal(sanitized.status, 'metadata-only');
    assert.equal(sanitized.response.format, 'xml');
    assert.equal(sanitized.response.body.Channel.Password, '[REDACTED]');
    assert.equal(sanitized.artifacts[0].type, 'DiagnosticSnapshot');
    let calls = 0;
    const client = createDiscoveryClient({ createConnection: () => ({ transport: {}, client: {
        async connect() {},
        async callTool() { calls++; return { structuredContent: sanitized }; },
        async close() {}
    } }) });
    const f = fixture({ load: client.fetchEndpoint });
    const diagnosticRequest = request({ tool: diagnostic.tool, endpoint: diagnostic, context: {
        ...context, connection: { url: source.url, username: source.identity, password: 'synthetic-mcp-password' }
    } });
    const first = await f.cache.fetchEndpoint(diagnosticRequest);
    const hit = await f.cache.fetchEndpoint(diagnosticRequest);
    assert.equal(first.cache.backend, 'cap-db');
    assert.equal(hit.cache.hit, true);
    assert.deepEqual(JSON.parse(hit.result), sanitized);
    assert.doesNotMatch(JSON.stringify([...f.entries.values()]), /synthetic-channel-password|synthetic-mcp-password/);
    assert.equal(f.counts.write, 1);
    assert.equal(calls, 1);
});

test('secret fields allow only null or the exact redaction marker, never unredacted values or containers', async () => {
    const keys = ['Password', 'Passwd', 'a:Token', 'client_secret', 'api-key', 'privateKey', 'Cookie', 'credentials', 'Authorization'];
    for (const value of [null, '[REDACTED]']) {
        const response = { ...success, response: Object.fromEntries(keys.map(key => [key, value])) };
        const f = fixture({ load: () => response });
        await f.cache.fetchEndpoint(request());
        const hit = await f.cache.fetchEndpoint(request());
        assert.equal(hit.cache.hit, true);
        assert.deepEqual(JSON.parse(hit.result), response);
    }
    for (const key of keys) {
        for (const value of ['', '[redacted]', ' [REDACTED]', '[REDACTED] ', 'synthetic-unredacted', false, 0, [], {}, { value: '[REDACTED]' }]) {
            const f = fixture({ load: () => ({ ...success, response: { [key]: value } }) });
            const result = await f.cache.fetchEndpoint(request());
            assert.equal(result.cache.backend, 'none');
            assert.equal(JSON.parse(result.result).status, 'failed');
            assert.equal(f.entries.size, 0);
            assert.doesNotMatch(result.result, /synthetic-unredacted/);
        }
    }
});

test('HTTP errors, SOAP faults, unsupported responses and exceptions are sanitized and never cached', async () => {
    const outcomes = [
        { status: 'failed', errors: ['private-body'] },
        { status: 'ok', httpStatus: 401, response: { body: 'private-body' } },
        { status: 'ok', httpStatus: 200, response: '<soap:Fault>private-body</soap:Fault>' },
        { status: 'ok', response: { 'soap:Fault': { faultstring: 'private-body' } } },
        { status: 'ok', response: { 'env:Fault': {} } },
        { status: 'ok', response: '<env:Fault/>' },
        { status: 'unsupported' }, { status: 'needs_parameters' }, { unknown: true },
        { status: 'metadata-only', metadataOnly: true, response: { format: 'omitted', body: null } },
        { status: 'ok', password: 'private-body' },
        { status: 'ok', data: 'x'.repeat(MAX_PAYLOAD_BYTES) },
        () => { throw new Error('private-body'); }
    ];
    for (const outcome of outcomes) {
        const f = fixture({ load: typeof outcome === 'function' ? outcome : () => outcome });
        const first = await f.cache.fetchEndpoint(request());
        await f.cache.fetchEndpoint(request());
        assert.equal(first.cache.backend, 'none');
        assert.equal(first.cache.hit, false);
        assert.equal(f.entries.size, 0);
        assert.equal(f.counts.load, 2);
        assert.equal(JSON.parse(first.result).path, endpoint.path);
        assert.doesNotMatch(first.result, /private-body/);
    }
});

test('a refresh failure never falls back to an expired cached payload', async () => {
    let failed = false;
    const f = fixture({ load: () => failed ? Promise.reject(new Error('private upstream error')) : success });
    await f.cache.fetchEndpoint(request({ ttlSeconds: 1 }));
    failed = true;
    f.advance(1000);
    const result = await f.cache.fetchEndpoint(request());
    assert.equal(result.cache.hit, false);
    assert.equal(JSON.parse(result.result).status, 'failed');
    assert.doesNotMatch(result.result, /Interface-A|private upstream/);
    assert.equal(f.counts.write, 1);
});

test('DB failures stop SAP calls, including force and TTL zero; write failures reject', async () => {
    for (const policy of [{}, { ttlSeconds: 0 }, { forceRefresh: true }]) {
        let loads = 0;
        const fail = async () => { throw new Error('private database details'); };
        const cache = createReadThroughCache({ store: { read: fail, check: fail }, maxTtlSeconds: 3600,
            load: () => { loads++; return success; } });
        await assert.rejects(cache.fetchEndpoint(request(policy)), error => {
            assert.equal(error.statusCode, 503);
            assert.doesNotMatch(error.message, /private database/);
            return true;
        });
        assert.equal(loads, 0);
    }
    const cache = createReadThroughCache({ maxTtlSeconds: 3600, store: {
        read: async () => undefined, write: async () => { throw new Error('commit failed'); }
    }, load: async () => success });
    await assert.rejects(cache.fetchEndpoint(request()), { code: 'PIPO_CACHE_DATABASE' });
});

test('corrupt live cache payloads fail closed instead of refetching', async () => {
    const f = fixture();
    await f.cache.fetchEndpoint(request());
    const entry = [...f.entries.values()][0];
    entry.payload = 'not-json';
    await assert.rejects(f.cache.fetchEndpoint(request()), { statusCode: 503 });
    assert.equal(f.counts.load, 1);
});

test('fetch resolves only after its persistence write has committed', async () => {
    let release;
    const committed = new Promise(resolve => { release = resolve; });
    let writing = false;
    let returned = false;
    const cache = createReadThroughCache({ maxTtlSeconds: 3600, load: async () => success, store: {
        read: async () => undefined,
        write: async () => { writing = true; await committed; }
    } });
    const result = cache.fetchEndpoint(request()).then(value => { returned = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writing, true);
    assert.equal(returned, false);
    release();
    assert.equal((await result).cache.backend, 'cap-db');
});

test('same-context concurrent misses deduplicate; tenant/user/source contexts do not join', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture({ load: async () => { await gate; return success; } });
    const pending = Array.from({ length: 20 }, () => f.cache.fetchEndpoint(request()));
    pending.push(f.cache.fetchEndpoint(request({ context: { ...context, tenant: 'tenant-b' } })));
    pending.push(f.cache.fetchEndpoint(request({ context: { ...context, user: { id: 'bob' } } })));
    pending.push(f.cache.fetchEndpoint(request({ source: { ...source, identity: 'other-reader' } })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.counts.load, 4);
    release();
    await Promise.all(pending);
    assert.equal(f.entries.size, 4);
    await f.cache.fetchEndpoint(request({ forceRefresh: true }));
    assert.equal(f.counts.load, 5, 'completed flights are removed');
});

test('credentials, raw source identity and raw parameters are not serialized in persistence', async () => {
    const f = fixture();
    await f.cache.fetchEndpoint(request({ parameters: { filter: 'private-filter' }, context: {
        ...context, connection: { username: 'mcp-reader', password: 'synthetic-password', token: 'synthetic-token' }
    } }));
    const serialized = JSON.stringify([...f.entries.values()]);
    assert.doesNotMatch(serialized, /synthetic-password|synthetic-token|mcp-reader|alice|tenant-a|mcp\.example|private-filter/);
    assert.deepEqual(Object.keys([...f.entries.values()][0]).sort(), ['ID', 'expiresAt', 'fetchedAt', 'payload']);
});

test('real CAP SQLite commits, survives reopening, isolates tenants and compiles the action', { timeout: 20000 }, async t => {
    const scratch = process.env.TMPDIR || process.env.TMP || process.env.TEMP;
    if (!scratch || !path.isAbsolute(scratch)) return t.skip('A per-session absolute temporary directory is required.');
    const cds = require('@sap/cds');
    const SQLiteService = require('@cap-js/sqlite');
    const root = path.resolve(__dirname, '../..');
    const model = await cds.load([path.join(root, 'db/pipo-cache-schema.cds'), path.join(root, 'srv/pipo-discovery-service.cds')]);
    const edmx = cds.compile.to.edmx(model, { service: 'PipoDiscoveryService' });
    assert.match(edmx, /Action Name="fetchEndpoint"/);
    assert.doesNotMatch(edmx, /EntitySet Name="Entries"/);
    assert.equal(model.definitions.PipoDiscoveryService['@requires'], 'authenticated-user');
    const ddl = cds.compile.to.sql(model, { dialect: 'sqlite' });
    const hanaDdl = cds.compile.to.sql(model, { dialect: 'hana' });
    assert.ok(hanaDdl.length > 0);
    const directory = await mkdtemp(path.join(scratch, 'pipo-cap-cache-test-'));
    const filename = path.join(directory, 'cache.sqlite');
    const user = new cds.User({ id: 'alice' });
    const ctx = { tenant: 'tenant-a', user };
    let db;
    async function open() {
        // DatabaseService.begin selects tenant pools only with this explicit option.
        const connection = new SQLiteService('pipo-cache-test', model, {
            kind: 'sqlite', multiTenant: true, credentials: { url: filename }, pool: { max: 1 }
        });
        for (const tenant of ['tenant-a', 'tenant-b', 'undeployed']) {
            assert.equal(connection.url4(tenant), path.join(directory, `cache-${tenant}.sqlite`));
        }
        await connection.init();
        return connection;
    }
    async function deployScratch(tenant) {
        assert.equal(path.dirname(db.url4(tenant)), directory, 'DDL may only target this unique scratch directory');
        await db.tx({ tenant, user }, async tx => { for (const sql of ddl) await tx.run(sql); });
    }
    t.after(async () => {
        if (db) await db.disconnect();
        // Exact mkdtemp-created test directory only; never the workspace or configured user DB.
        await rm(directory, { recursive: true, force: true });
    });
    db = await open();
    await deployScratch('tenant-a');
    await deployScratch('tenant-b');
    assert.deepEqual(Object.keys(db.pools).sort(), ['tenant-a', 'tenant-b']);
    assert.notEqual(db.pools['tenant-a'], db.pools['tenant-b']);
    const store = createCdsStore({ cds, db });
    let loads = 0;
    const load = async () => {
        loads++;
        // This needs the SQLite connection: proves no read transaction is held during I/O.
        await store.check(ctx);
        return success;
    };
    const cache = createReadThroughCache({ store, load, maxTtlSeconds: 3600 });
    const original = await cache.fetchEndpoint(request({ context: ctx }));
    assert.equal(original.cache.hit, false);
    const ID = createCacheKey(request({ context: ctx }));
    assert.ok(await store.read(ID, ctx));
    assert.equal(await store.read(ID, { tenant: 'tenant-b', user }), undefined,
        'the exact same row ID must not be visible in another tenant database');
    const closed = db;
    await db.disconnect();
    assert.deepEqual(Object.keys(closed.pools), [], 'disconnect drains and closes all tenant pools');
    db = await open();
    assert.notEqual(db, closed);
    const reopenedStore = createCdsStore({ cds, db });
    const reopened = createReadThroughCache({ store: reopenedStore, load: async () => { loads++; return success; }, maxTtlSeconds: 3600 });
    const hit = await reopened.fetchEndpoint(request({ context: ctx }));
    assert.equal(hit.cache.hit, true);
    assert.equal(hit.result, original.result);
    assert.equal(loads, 1, 'committed row survives a real DB close/reopen');
    const variants = [
        { context: { tenant: 'tenant-b', user } },
        { context: { tenant: 'tenant-a', user: new cds.User({ id: 'bob' }) } },
        { source: { ...source, identity: 'rotated-user' } },
        { source: { ...source, url: 'https://other.example.test/mcp' } }
    ];
    for (const variant of variants) assert.equal((await reopened.fetchEndpoint(request({ context: ctx, ...variant }))).cache.hit, false);
    const rowsBefore = await db.tx({ ...ctx }, tx => tx.run(cds.ql.SELECT.from('pipo.cache.Entries')));
    await reopened.fetchEndpoint(request({ context: ctx, forceRefresh: true }));
    const rowsAfter = await db.tx({ ...ctx }, tx => tx.run(cds.ql.SELECT.from('pipo.cache.Entries')));
    assert.equal(rowsBefore.length, rowsAfter.length, 'UPSERT does not append duplicate keys');
    assert.equal(rowsAfter.length, 4);
    const otherRows = await db.tx({ tenant: 'tenant-b', user }, tx => tx.run(cds.ql.SELECT.from('pipo.cache.Entries')));
    assert.equal(otherRows.length, 1, 'tenant-b stores only its own cache row');
    assert.ok(otherRows.every(row => rowsAfter.every(other => row.ID !== other.ID)));
    const expiredRows = Array.from({ length: 101 }, (_, index) => ({
        ID: `expired-${index}`, payload: '{}', fetchedAt: '2000-01-01T00:00:00.000Z', expiresAt: '2000-01-02T00:00:00.000Z'
    }));
    await db.tx({ ...ctx }, tx => tx.run(cds.ql.INSERT.into('pipo.cache.Entries').entries(expiredRows)));
    await db.tx({ tenant: 'tenant-b', user }, tx => tx.run(cds.ql.INSERT.into('pipo.cache.Entries').entries(expiredRows[0])));
    await reopened.fetchEndpoint(request({ context: ctx, forceRefresh: true }));
    const remaining = await db.tx({ ...ctx }, tx => tx.run(cds.ql.SELECT.from('pipo.cache.Entries')));
    assert.equal(remaining.filter(row => row.ID.startsWith('expired-')).length, 1, 'cleanup is bounded to 100 expired rows');
    assert.equal(remaining.filter(row => !row.ID.startsWith('expired-')).length, 4, 'live rows survive cleanup');
    assert.ok(await reopenedStore.read('expired-0', { tenant: 'tenant-b', user }), 'cleanup cannot cross tenant databases');
    const broken = createReadThroughCache({ store: reopenedStore, load: () => assert.fail('must not call SAP before deployment'), maxTtlSeconds: 3600 });
    await assert.rejects(broken.fetchEndpoint(request({ context: { tenant: 'undeployed', user } })), { statusCode: 503 });
});