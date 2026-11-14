'use strict';

const cds = require('@sap/cds');

const VALID_PERSONAS = Object.freeze(['Admin', 'Approver', 'Viewer']);

const MCP_TOOLS_BY_PERSONA = Object.freeze({
  Viewer: Object.freeze([
    'semantic_search_artifacts',
    'list_discovered_interfaces',
    'inspect_artifact_evidence',
    'analyze_discovery_failures',
    'compare_esr_vs_directory',
    'get_wave_plan_status'
  ]),
  Approver: Object.freeze([
    'semantic_search_artifacts',
    'list_discovered_interfaces',
    'inspect_artifact_evidence',
    'analyze_discovery_failures',
    'compare_esr_vs_directory',
    'get_wave_plan_status',
    'approve_wave_plan',
    'reject_wave_plan'
  ]),
  Admin: Object.freeze([
    'semantic_search_artifacts',
    'list_discovered_interfaces',
    'inspect_artifact_evidence',
    'analyze_discovery_failures',
    'compare_esr_vs_directory',
    'get_wave_plan_status',
    'update_wave_assignment',
    'deploy_approved_wave'
  ])
});

class AuthorizationError extends Error {
  constructor(code, message, statusCode = 403) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isProductionRuntime(env = process.env) {
  if (env.NODE_ENV === 'production') return true;
  const profiles = Array.isArray(cds.env?.profiles) ? cds.env.profiles : [];
  return profiles.includes('production');
}

function resolveTenantId(req, env = process.env) {
  const explicitTenant = typeof req?.tenant === 'string' ? req.tenant.trim() : '';
  if (explicitTenant) return explicitTenant;

  const attrTenant = typeof req?.user?.tenant === 'string' ? req.user.tenant.trim() : '';
  if (attrTenant) return attrTenant;

  // In production or multitenant SaaS mode, missing tenant context MUST fail closed.
  if (isProductionRuntime(env) || cds.env?.requires?.multitenancy === true && env.SDAINTAI_ALLOW_LOCAL_DEFAULT_TENANT !== 'true') {
    if (isProductionRuntime(env)) {
      throw new AuthorizationError('TENANT_CONTEXT_REQUIRED', 'Verified multi-tenant subscription context is required.', 403);
    }
  }

  // Non-production local dev fallback: allow isolated dev tenant header for multi-tenant testing, or 'tenant-dev-local'.
  const devTenant = typeof req?.headers?.['x-sdaintai-dev-tenant'] === 'string'
    ? req.headers['x-sdaintai-dev-tenant'].trim()
    : '';
  if (devTenant && /^[a-zA-Z0-9_-]{1,64}$/.test(devTenant)) return devTenant;
  return 'tenant-dev-local';
}

function hasScope(user, roleName) {
  if (!user || typeof user.is !== 'function') return false;
  if (user.is(roleName) || user.is(roleName.toLowerCase())) return true;
  const roles = Array.isArray(user.roles) ? user.roles : Object.keys(user.roles || {});
  return roles.some((r) => {
    const lower = String(r).toLowerCase();
    return lower === roleName.toLowerCase() || lower.endsWith(`.${roleName.toLowerCase()}`);
  });
}

function resolvePersona(req, env = process.env) {
  const user = req?.user;
  const prod = isProductionRuntime(env);

  if (prod) {
    if (!user || user.id === 'anonymous' || (typeof user.is === 'function' && !user.is('authenticated-user') && !hasScope(user, 'admin') && !hasScope(user, 'approver') && !hasScope(user, 'viewer'))) {
      throw new AuthorizationError('AUTH_REQUIRED', 'Authentication is required.', 401);
    }
    if (hasScope(user, 'admin')) return 'Admin';
    if (hasScope(user, 'approver')) return 'Approver';
    if (hasScope(user, 'viewer')) return 'Viewer';
    throw new AuthorizationError('PERSONA_SCOPE_MISSING', 'No Migration Factory role collection (admin, approver, viewer) is assigned to your user.', 403);
  }

  // Non-production: honor explicit XSUAA/CAP roles first, then validated dev-only header, defaulting to Admin for local dev convenience.
  if (hasScope(user, 'admin')) return 'Admin';
  if (hasScope(user, 'approver')) return 'Approver';
  if (hasScope(user, 'viewer')) return 'Viewer';

  const headerPersona = typeof req?.headers?.['x-sdaintai-dev-persona'] === 'string'
    ? req.headers['x-sdaintai-dev-persona'].trim()
    : '';
  if (VALID_PERSONAS.includes(headerPersona)) return headerPersona;
  if (headerPersona) {
    throw new AuthorizationError('INVALID_DEV_PERSONA', 'Unsupported persona header value.', 400);
  }
  return 'Admin';
}

function resolveAuthContext(req, env = process.env) {
  const tenantId = resolveTenantId(req, env);
  const persona = resolvePersona(req, env);
  const userId = (typeof req?.user?.id === 'string' && req.user.id && req.user.id !== 'anonymous')
    ? req.user.id
    : `dev-${persona.toLowerCase()}`;
  return {
    tenantId,
    persona,
    userId,
    allowedTools: MCP_TOOLS_BY_PERSONA[persona] || MCP_TOOLS_BY_PERSONA.Viewer
  };
}

function requirePersona(req, allowedPersonas, env = process.env) {
  const ctx = resolveAuthContext(req, env);
  if (!allowedPersonas.includes(ctx.persona)) {
    throw new AuthorizationError(
      'PERSONA_FORBIDDEN',
      `Action requires ${allowedPersonas.join(' or ')} persona; current persona is ${ctx.persona}.`,
      403
    );
  }
  return ctx;
}

function assertToolAllowed(persona, toolName) {
  const allowed = MCP_TOOLS_BY_PERSONA[persona] || [];
  if (!allowed.includes(toolName)) {
    throw new AuthorizationError(
      'MCP_TOOL_FORBIDDEN',
      `MCP tool "${toolName}" is not permitted for persona ${persona}.`,
      403
    );
  }
}

module.exports = {
  VALID_PERSONAS,
  MCP_TOOLS_BY_PERSONA,
  AuthorizationError,
  isProductionRuntime,
  resolveTenantId,
  resolvePersona,
  resolveAuthContext,
  requirePersona,
  assertToolAllowed
};
