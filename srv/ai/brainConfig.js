const path = require('path');
const fs   = require('fs');

const MASTER_KEY   = process.env.BRAIN_MASTER_KEY || 'AYMAN2026';
const STATE_FILE   = path.join(__dirname, '../../.brain-state.json');

function verifyKey(key) {
  return typeof key === 'string' && key === MASTER_KEY;
}

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return { enabled: false, enabledAt: null };
}

function writeState(enabled) {
  const state = { enabled, enabledAt: enabled ? new Date().toISOString() : null };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

function isBrainEnabled() {
  return readState().enabled === true;
}

module.exports = { verifyKey, readState, writeState, isBrainEnabled };
