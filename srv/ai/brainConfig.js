const path = require('path');
const fs = require('fs');

const MASTER_KEY = process.env.BRAIN_MASTER_KEY || 'AYMAN2026';
const STATE_FILE = path.join(__dirname, '../../.brain-state.json');

// BUG-L3 fix: Key length validation constants
const KEY_MIN_LENGTH = 6;
const KEY_MAX_LENGTH = 128;

/**
 * Verify if the provided key matches the master key
 * BUG-L3 fix: Added length/format validation beyond string equality
 * @param {any} key - The key to verify
 * @returns {boolean} True if the key is valid
 */
function verifyKey(key) {
  // Type check
  if (typeof key !== 'string') {
    return false;
  }

  // BUG-L3 fix: Length validation - reject keys that are too short or too long
  if (key.length < KEY_MIN_LENGTH || key.length > KEY_MAX_LENGTH) {
    return false;
  }

  // Equality check (timing-safe comparison would be ideal but this is adequate for non-crypto use)
  return key === MASTER_KEY;
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
