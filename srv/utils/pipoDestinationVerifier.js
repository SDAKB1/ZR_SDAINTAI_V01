'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getVerifierSecret(env = process.env) {
  return env.PIPO_CONNECTION_TOKEN_SECRET || env.SIGNUP_VERIFY_SECRET || 'SDAINTAI-PIPO-CONN-DEV-SECRET-ROTATE-IN-PROD';
}

function canonicalConnectionFingerprint(form = {}) {
  const normalized = {
    systemName: String(form.systemName || '').trim().toUpperCase(),
    systemVersion: String(form.systemVersion || '').trim(),
    address: String(form.address || '').trim().toLowerCase().replace(/\/+$/, ''),
    userId: String(form.userId || '').trim().toUpperCase(),
    authType: String(form.authType || 'BasicAuthentication').trim(),
    proxyType: String(form.proxyType || 'OnPremise').trim(),
    locationId: String(form.locationId || '').trim(),
    subaccount: String(form.subaccount || 'sda-ai-shared-eu10').trim()
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function issueConnectionToken({ tenantId, projectId = 'default', formFingerprint, now = Date.now(), env = process.env }) {
  const expiresAt = now + TOKEN_TTL_MS;
  const payload = `${tenantId}|${projectId}|${formFingerprint}|${expiresAt}`;
  const sig = crypto.createHmac('sha256', getVerifierSecret(env)).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ tenantId, projectId, fp: formFingerprint, exp: expiresAt, sig }), 'utf8').toString('base64url');
}

function verifyConnectionToken(token, { tenantId, projectId = null, expectedFingerprint = null, now = Date.now(), env = process.env } = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    const err = new Error('Connection must be verified via Test Connection before running discovery.');
    err.code = 'CONNECTION_NOT_VERIFIED';
    err.statusCode = 412;
    throw err;
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    const err = new Error('Invalid connection verification token — re-run Test Connection.');
    err.code = 'CONNECTION_TOKEN_INVALID';
    err.statusCode = 412;
    throw err;
  }
  if (!decoded || decoded.tenantId !== tenantId) {
    const err = new Error('Connection token does not belong to the active tenant.');
    err.code = 'CONNECTION_TENANT_MISMATCH';
    err.statusCode = 403;
    throw err;
  }
  if (projectId && decoded.projectId && decoded.projectId !== projectId && decoded.projectId !== 'default') {
    const err = new Error('Connection token does not match the active project.');
    err.code = 'CONNECTION_PROJECT_MISMATCH';
    err.statusCode = 412;
    throw err;
  }
  if (!Number.isFinite(decoded.exp) || now > decoded.exp) {
    const err = new Error('Connection verification expired — click Test Connection again.');
    err.code = 'CONNECTION_TOKEN_EXPIRED';
    err.statusCode = 412;
    throw err;
  }
  const payload = `${decoded.tenantId}|${decoded.projectId}|${decoded.fp}|${decoded.exp}`;
  const expectedSig = crypto.createHmac('sha256', getVerifierSecret(env)).update(payload).digest('hex');
  const sigBuf = Buffer.from(String(decoded.sig || ''), 'hex');
  const expBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    const err = new Error('Connection verification signature invalid — re-run Test Connection.');
    err.code = 'CONNECTION_TOKEN_INVALID';
    err.statusCode = 412;
    throw err;
  }
  if (expectedFingerprint && decoded.fp !== expectedFingerprint) {
    const err = new Error('Connection parameters changed since last Test Connection — please re-test.');
    err.code = 'CONNECTION_FORM_CHANGED';
    err.statusCode = 412;
    throw err;
  }
  return decoded;
}

function runPipoVerifyScript(formPayload, { scriptPath = path.resolve(__dirname, '../../mcp/pipo-rfc-server/verify-pipo-connection.js'), timeoutMs = 25000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...env };
    delete childEnv.NODE_OPTIONS; // Prevent debugger auto-attach interference
    const child = spawn(process.execPath, [scriptPath, '--stdin'], {
      cwd: path.dirname(scriptPath),
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('PI/PO connection test timed out.'), { code: 'TUNNEL_UNREACHABLE', statusCode: 504 }));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim() || '{}');
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('PI/PO connection verifier returned an unreadable response.'), { code: 'MCP_UNAVAILABLE', statusCode: 502 }));
      }
    });
    // Write payload strictly over stdin so credentials never appear in process argv
    child.stdin.end(JSON.stringify(formPayload));
  });
}

module.exports = {
  canonicalConnectionFingerprint,
  issueConnectionToken,
  verifyConnectionToken,
  runPipoVerifyScript
};
