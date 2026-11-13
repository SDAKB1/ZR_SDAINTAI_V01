'use strict';

// Only version context observed on SimpleQuery's read-only R links is eligible.
// Never retain or follow an upstream URL, host, session parameter or operation.
const ESR_READ_CONTEXT = Object.freeze({
  vc: { query: 'VC', pattern: /^SWC$/ },
  sp: { query: 'SP', pattern: /^(?:-1|[0-9]{1,6})$/ },
  uc: { query: 'UC', pattern: /^(?:true|false)$/ },
  release: { query: 'release', pattern: /^[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?$/ }
});

function readContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const context = {};
  for (const [key, { pattern }] of Object.entries(ESR_READ_CONTEXT)) {
    if (!Object.hasOwn(value, key) || typeof value[key] !== 'string' ||
      /[\x00-\x20\x7f]/.test(value[key]) || !pattern.test(value[key])) return null;
    context[key] = value[key];
  }
  return context;
}

module.exports = { ESR_READ_CONTEXT, readContext };