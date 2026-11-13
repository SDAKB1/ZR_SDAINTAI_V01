'use strict';

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT = 60000;
const CAP_ACTION = '/odata/v4/pipo-discovery/fetchEndpoint';

function checkedUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${label} configuration.`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Use HTTPS, or HTTP on localhost for development.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query parameters or a fragment.`);
  }
  return url;
}

// Bound the bytes before JSON/SSE decoding, including chunked responses with no
// Content-Length. The SDK can still consume a long-lived SSE stream incrementally.
async function boundedFetch(url, init = {}) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT);
  let response;
  try {
    response = await fetch(url, { ...init, redirect: 'error',
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  } catch { throw new Error('Discovery request failed; sensitive details omitted.'); }
  if (Number(response.headers.get('content-length')) > MAX_PAYLOAD_BYTES) {
    await response.body?.cancel();
    throw new Error('Discovery response exceeds 5 MB.');
  }
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_PAYLOAD_BYTES) throw new Error('Discovery response exceeds 5 MB.');
      controller.enqueue(chunk);
    }
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function readJson(response) {
  try { return await response.json(); } catch { throw new Error('Invalid or oversized discovery JSON response.'); }
}

function createCapCacheClient(env) {
  const url = checkedUrl(env.PIPO_CAP_URL, 'PIPO_CAP_URL');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(CAP_ACTION) ? path :
    path.endsWith('/odata/v4/pipo-discovery') ? `${path}/fetchEndpoint` : `${path}${CAP_ACTION}`;
  let authorization;
  if (env.PIPO_CAP_TOKEN) {
    if (!/^[A-Za-z0-9+/_=.~-]+$/.test(env.PIPO_CAP_TOKEN)) throw new Error('Invalid PIPO_CAP_TOKEN configuration.');
    authorization = `Bearer ${env.PIPO_CAP_TOKEN}`;
  } else if (env.PIPO_CAP_USER && env.PIPO_CAP_PASS) {
    authorization = 'Basic ' + Buffer.from(`${env.PIPO_CAP_USER}:${env.PIPO_CAP_PASS}`).toString('base64');
  } else {
    throw new Error('Set PIPO_CAP_TOKEN or PIPO_CAP_USER and PIPO_CAP_PASS for --cache.');
  }
  return async function fetchEndpoint(tool, parameters, { ttlSeconds, forceRefresh = false } = {}) {
    const response = await boundedFetch(url, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ tool, parameters: JSON.stringify(parameters),
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }), forceRefresh })
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`CAP discovery request failed (HTTP ${response.status}); no direct fallback is permitted.`);
    }
    const envelope = await readJson(response);
    const cache = envelope?.cache;
    if (typeof envelope?.result !== 'string' || Buffer.byteLength(envelope.result) > MAX_PAYLOAD_BYTES ||
        typeof cache?.hit !== 'boolean' || !['cap-db', 'none'].includes(cache.backend) ||
        !Number.isFinite(Date.parse(cache.fetchedAt)) || !Number.isFinite(Date.parse(cache.expiresAt))) {
      throw new Error('Invalid CAP discovery response; no direct fallback is permitted.');
    }
    // Project known metadata only; never forward arbitrary envelope fields.
    return { result: envelope.result, cache: { hit: cache.hit, backend: cache.backend,
      fetchedAt: new Date(cache.fetchedAt).toISOString(), expiresAt: new Date(cache.expiresAt).toISOString() } };
  };
}

module.exports = { createCapCacheClient, checkedUrl, boundedFetch, readJson, MAX_PAYLOAD_BYTES, REQUEST_TIMEOUT };