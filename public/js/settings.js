// Global user settings — time/date format, distance + speed units, sound effects,
// kiosk auto-loop interval, and the selected test server.
// Persisted to localStorage and broadcast via a 'settingschange' window event.

const KEY = 'speedundo.settings';

export const DEFAULTS = {
  time: '12h', // '12h' | '24h'
  date: 'MDY', // 'MDY' | 'DMY' | 'YMD'
  distance: 'mi', // 'mi' | 'km'
  speed: 'mbps', // 'mbps' | 'kbps'
  server: 'auto', // 'auto' | one of engine.js SERVERS ids
  sound: 'on', // 'on' | 'off'
  volume: 0.35, // 0.0 to 1.0
  kioskInterval: 'off', // 'off' | '5m' | '15m' | '30m' | '60m'
};

const VALID = {
  time: ['12h', '24h'],
  date: ['MDY', 'DMY', 'YMD'],
  distance: ['mi', 'km'],
  speed: ['mbps', 'kbps'],
  sound: ['on', 'off'],
  kioskInterval: ['off', '5m', '15m', '30m', '60m'],
};

function hasLS() {
  try { return typeof localStorage !== 'undefined'; } catch (_) { return false; }
}

function load() {
  if (!hasLS()) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { ...DEFAULTS, ...raw };
  } catch (_) { /* corrupt or blocked — fall back to defaults */ }
  return { ...DEFAULTS };
}

let current = load();

function save() {
  if (!hasLS()) return;
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (_) { /* full/blocked */ }
}

function emit() {
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('settingschange', { detail: { ...current } }));
  }
}

export function getSettings() { return { ...current }; }

export function getSetting(key) { return current[key]; }

// Returns true when the value was accepted and changed.
export function setSetting(key, value) {
  if (!(key in DEFAULTS)) return false;
  if (VALID[key] && !VALID[key].includes(value)) return false;
  if (key === 'volume') {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0 || num > 1) return false;
    value = num;
  }
  if (current[key] === value) return false;
  current[key] = value;
  save();
  emit();
  return true;
}
