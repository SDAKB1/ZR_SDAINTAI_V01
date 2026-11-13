'use strict';

const { createHash } = require('node:crypto');

const MAX_TTL_SECONDS = 604800;
const MAX_PARAMETERS_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
const PARSER_VERSION = 'pipo-discovery-v1';
const ENTITY = 'pipo.cache.Entries';
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SUCCESS_STATUSES = new Set(['ok', 'success', 'successful', 'available', 'reachable']);

class CacheError extends Error {
    constructor(code, message, statusCode = 400) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}

function invalidParameters() {
    return new CacheError('PIPO_INVALID_PARAMETERS', 'Parameters must be a plain JSON object.');
}

// No toJSON calls, accessors, custom prototypes, sparse arrays or prototype keys.
function canonicalize(value) {
    const ancestors = new Set();
    function visit(item, depth) {
        if (depth > 64) throw invalidParameters();
        if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
        if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
        if (typeof item !== 'object' || ancestors.has(item)) throw invalidParameters();
        const array = Array.isArray(item);
        const proto = Object.getPrototypeOf(item);
        if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw invalidParameters();
        if (Object.getOwnPropertySymbols(item).length) throw invalidParameters();
        const descriptors = Object.getOwnPropertyDescriptors(item);
        ancestors.add(item);
        try {
            if (array) {
                const keys = Object.keys(descriptors).filter(key => key !== 'length');
                if (keys.length !== item.length) throw invalidParameters();
                const values = [];
                for (let index = 0; index < item.length; index++) {
                    const descriptor = descriptors[index];
                    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw invalidParameters();
                    values.push(visit(descriptor.value, depth + 1));
                }
                return `[${values.join(',')}]`;
            }
            return `{${Object.keys(descriptors).sort().map(key => {
                const descriptor = descriptors[key];
                if (FORBIDDEN_KEYS.has(key) || !('value' in descriptor) || !descriptor.enumerable) throw invalidParameters();
                return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
            }).join(',')}}`;
        } finally {
            ancestors.delete(item);
        }
    }
    return visit(value, 0);
}

function parseParameters(value) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'string') throw invalidParameters();
    if (Buffer.byteLength(value, 'utf8') > MAX_PARAMETERS_BYTES) {
        throw new CacheError('PIPO_PARAMETERS_TOO_LARGE', 'Parameters exceed 64 KB.', 413);
    }
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw invalidParameters(); }
    validateParameters(parsed);
    return parsed;
}

function validateParameters(parameters) {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw invalidParameters();
    const serialized = canonicalize(parameters);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PARAMETERS_BYTES) {
        throw new CacheError('PIPO_PARAMETERS_TOO_LARGE', 'Parameters exceed 64 KB.', 413);
    }
    return serialized;
}

function configuredTtl(value = process.env.PIPO_CACHE_TTL_SECONDS) {
    if (value === undefined) return 3600;
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || Number(value) > MAX_TTL_SECONDS) {
        throw new CacheError('PIPO_CACHE_CONFIGURATION', 'Invalid cache TTL configuration.', 503);
    }
    return Number(value);
}

function resolveTtl(requested, maximum) {
    if (!Number.isInteger(maximum) || maximum < 0 || maximum > MAX_TTL_SECONDS) {
        throw new CacheError('PIPO_CACHE_CONFIGURATION', 'Invalid cache TTL configuration.', 503);
    }
    if (requested === undefined || requested === null) return maximum;
    if (!Number.isInteger(requested) || requested < 0 || requested > maximum) {
        throw new CacheError('PIPO_INVALID_TTL', 'TTL must be an integer between zero and the configured maximum.');
    }
    return requested;
}

function sourceUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new CacheError('PIPO_CACHE_CONFIGURATION', 'Invalid MCP source configuration.', 503); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
        url.username || url.password || url.search || url.hash) {
        throw new CacheError('PIPO_CACHE_CONFIGURATION', 'MCP requires HTTPS (HTTP is allowed only on localhost), without URL credentials or query parameters.', 503);
    }
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/mcp') ? path : `${path}/mcp`;
    return url.href;
}

const hash = value => createHash('sha256').update(value).digest('hex');

function createCacheKey({ tool, parameters, source, context, parserVersion = PARSER_VERSION }) {
    const userId = context?.user?.id;
    if (typeof userId !== 'string' || !userId || userId === 'anonymous') {
        throw new CacheError('PIPO_UNAUTHENTICATED', 'Authentication is required.', 401);
    }
    if (typeof source?.identity !== 'string' || !source.identity || typeof source.version !== 'string') {
        throw new CacheError('PIPO_CACHE_CONFIGURATION', 'Invalid MCP source identity.', 503);
    }
    // Only hashes enter persistence; passwords/tokens are never part of the key.
    return hash(canonicalize({
        tenant: hash(context.tenant || ''),
        user: hash(userId),
        source: hash(canonicalize({ url: sourceUrl(source.url), identity: hash(source.identity), version: source.version })),
        tool,
        parameters: hash(validateParameters(parameters)),
        parserVersion
    }));
}

function hasFailure(value, depth = 0) {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => {
        const name = key.toLowerCase().replace(/[^a-z]/g, '');
        const localName = key.split(':').pop();
        // XML is case-sensitive: wsdl:fault/soap:fault are contract declarations,
        // whereas a SOAP envelope contains Fault (capital F).
        if ((localName === 'Fault' || ['soapfault', 'faultcode', 'faultstring'].includes(localName.toLowerCase()) ||
            (depth === 0 && name === 'fault')) && item != null && item !== false) return true;
        if (['error', 'errors'].includes(name)) {
            if (Array.isArray(item) ? item.length : item && (typeof item !== 'object' || Object.keys(item).length)) return true;
        }
        if (['iserror', 'unsupported'].includes(name) && item === true) return true;
        if (['ok', 'success', 'supported'].includes(name) && item === false) return true;
        if (name === 'httpstatus' && (!Number.isInteger(item) || item < 200 || item >= 300)) return true;
        if (name === 'status' && typeof item === 'string' &&
            /^(failed|failure|error|partial|unsupported|unavailable|unauthorized|forbidden|timeout|skipped|not.?found)$/i.test(item)) return true;
        // Sanitized MCP payloads retain secret field names, but never their values.
        if (/(password|passwd|authorization|token|secret|apikey|privatekey|cookie|credentials)/.test(name) &&
            item !== null && item !== '[REDACTED]') return true;
        if (typeof item === 'string' && /<(?:[\w.-]+:)?Fault(?:\s|\/|>)/.test(item)) return true;
        return hasFailure(item, depth + 1);
    });
}

function isCacheableResponse(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result) || hasFailure(result)) return false;
    // The MCP fetcher distinguishes verified metadata from extracted artifacts.
    if (result.status === 'metadata-only') {
        return result.metadataOnly === true && result.httpStatus >= 200 && result.httpStatus < 300 &&
            result.response?.body != null && ['xml', 'json'].includes(result.response.format);
    }
    if (typeof result.status === 'string') return SUCCESS_STATUSES.has(result.status.toLowerCase());
    if (result.status != null) return false;
    return result.ok === true || result.success === true;
}

function endpointFailure(tool, endpoint = {}, result) {
    const statuses = ['failed', 'unsupported', 'unavailable', 'needs_parameters'];
    const failure = {
        tool, path: endpoint.path || null, category: endpoint.category || 'Metadata',
        status: statuses.includes(result?.status) ? result.status : 'failed',
        metadataOnly: true, artifacts: [], response: { format: 'omitted', body: null },
        warnings: ['Discovery endpoint failed or returned an unsupported response; sensitive details omitted.'],
        errors: [{ code: 'PIPO_ENDPOINT_FAILED', message: 'Discovery endpoint did not return a cacheable response.' }]
    };
    if (Number.isInteger(result?.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599) failure.httpStatus = result.httpStatus;
    return failure;
}

function safeResponse(result, tool, maxPayloadBytes, endpoint) {
    try {
        const payload = canonicalize(result);
        if (Buffer.byteLength(payload, 'utf8') <= maxPayloadBytes && isCacheableResponse(result)) return { payload, cacheable: true };
    } catch { /* Invalid/non-JSON upstream responses must not escape or be stored. */ }
    return { payload: JSON.stringify(endpointFailure(tool, endpoint, result)), cacheable: false };
}

function createReadThroughCache({ store, load, clock = Date.now, parserVersion = PARSER_VERSION,
    maxTtlSeconds = () => configuredTtl(), maxPayloadBytes = MAX_PAYLOAD_BYTES }) {
    // Process-local deduplication, not a distributed lock. TTL/force policies cannot join each other.
    const inFlight = new Map();
    async function database(operation) {
        try { return await operation(); } catch {
            throw new CacheError('PIPO_CACHE_DATABASE', 'Discovery cache database is unavailable.', 503);
        }
    }
    async function fetchEndpoint(request) {
        const { tool, source, context } = request;
        if (typeof tool !== 'string' || !/^fetch_pi8_[a-z0-9_]+$/.test(tool)) {
            throw new CacheError('PIPO_UNKNOWN_ENDPOINT', 'Unknown discovery endpoint.');
        }
        // Snapshot parameters before any await, so the loaded arguments and key cannot diverge.
        const parameters = JSON.parse(validateParameters(request.parameters ?? {}));
        const ttl = resolveTtl(request.ttlSeconds, typeof maxTtlSeconds === 'function' ? maxTtlSeconds() : maxTtlSeconds);
        const force = request.forceRefresh ?? false;
        if (typeof force !== 'boolean') throw new CacheError('PIPO_INVALID_FORCE', 'forceRefresh must be a boolean.');
        const ID = createCacheKey({ tool, parameters, source, context, parserVersion });
        const flightKey = `${ID}:${ttl}:${force}`;
        if (inFlight.has(flightKey)) return inFlight.get(flightKey);
        const pending = (async () => {
            if (ttl > 0 && !force) {
                const entry = await database(() => store.read(ID, context));
                const now = Number(clock());
                const fetched = Date.parse(entry?.fetchedAt);
                const expires = Date.parse(entry?.expiresAt);
                if (entry && now >= fetched && now < expires && now - fetched < ttl * 1000) {
                    let valid = false;
                    try {
                        if (typeof entry.payload === 'string' && Buffer.byteLength(entry.payload, 'utf8') <= Math.min(maxPayloadBytes, MAX_PAYLOAD_BYTES)) {
                            const parsed = JSON.parse(entry.payload);
                            canonicalize(parsed);
                            valid = isCacheableResponse(parsed);
                        }
                    } catch { /* A corrupt cache is a DB failure, not permission to call SAP. */ }
                    if (!valid) throw new CacheError('PIPO_CACHE_DATABASE', 'Discovery cache data is invalid.', 503);
                    return { result: entry.payload, cache: { hit: true, fetchedAt: entry.fetchedAt, expiresAt: entry.expiresAt, backend: 'cap-db' } };
                }
            } else {
                // Even bypass/force requests fail closed if persistence is unavailable or undeployed.
                await database(() => store.check(context));
            }
            let response;
            try { response = await load({ tool, parameters, context }); } catch { response = endpointFailure(tool, request.endpoint); }
            const { payload, cacheable } = safeResponse(response, tool, Math.min(maxPayloadBytes, MAX_PAYLOAD_BYTES), request.endpoint);
            const fetchedAt = new Date(Number(clock())).toISOString();
            const persist = ttl > 0 && cacheable;
            const expiresAt = new Date(Date.parse(fetchedAt) + (persist ? ttl * 1000 : 0)).toISOString();
            if (persist) await database(() => store.write({ ID, payload, fetchedAt, expiresAt }, context));
            return { result: payload, cache: { hit: false, fetchedAt, expiresAt, backend: persist ? 'cap-db' : 'none' } };
        })();
        inFlight.set(flightKey, pending);
        try { return await pending; } finally { inFlight.delete(flightKey); }
    }
    return { fetchEndpoint };
}

function createCdsStore({ cds, db, getDb = () => cds.connect.to('db') }) {
    async function transaction(context, work) {
        const connection = db || await getDb();
        // A fresh plain context creates an independent, committed root transaction.
        // Never pass the request EventContext here or hold a transaction during MCP I/O.
        return connection.tx({ tenant: context.tenant, user: context.user }, work);
    }
    return {
        read: (ID, context) => transaction(context, tx => tx.run(cds.ql.SELECT.one.from(ENTITY).where({ ID }))),
        check: context => transaction(context, tx => tx.run(cds.ql.SELECT.from(ENTITY).columns('ID').limit(1))),
        write: (entry, context) => transaction(context, async tx => {
            await tx.run(cds.ql.UPSERT.into(ENTITY).entries(entry));
            // Opportunistic, tenant-local cleanup; bound each write's work. Check
            // expiry again on DELETE so a concurrently refreshed row is retained.
            const expired = await tx.run(cds.ql.SELECT.from(ENTITY).columns('ID')
                .where({ expiresAt: { '<=': entry.fetchedAt } }).limit(100));
            if (expired.length) await tx.run(cds.ql.DELETE.from(ENTITY).where({
                ID: { in: expired.map(row => row.ID) }, expiresAt: { '<=': entry.fetchedAt }
            }));
        })
    };
}

module.exports = {
    CacheError, MAX_TTL_SECONDS, MAX_PARAMETERS_BYTES, MAX_PAYLOAD_BYTES, PARSER_VERSION,
    canonicalize, parseParameters, configuredTtl, resolveTtl, sourceUrl, createCacheKey,
    isCacheableResponse, endpointFailure, createReadThroughCache, createCdsStore
};