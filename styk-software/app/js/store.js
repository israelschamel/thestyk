// Everything the app remembers lives on this device, in localStorage.
// Nothing is sent to a server.

const KEY = 'styk.app.v1';
const MAX_HISTORY = 25;

function blank() {
  return { version: 1, tags: [], settings: { notifications: false } };
}

let memoryOnly = false;
let data = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tags)) return blank();
    parsed.settings = parsed.settings || {};
    return parsed;
  } catch {
    memoryOnly = true;
    return blank();
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    memoryOnly = false;
  } catch {
    memoryOnly = true;
  }
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 't' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const store = {
  get tags() { return data.tags; },
  get settings() { return data.settings; },
  get memoryOnly() { return memoryOnly; },

  tag(id) { return data.tags.find((t) => t.id === id) || null; },

  add(tag) {
    data.tags.push({ history: [], lastSeen: null, battery: null, charging: false, leftBehind: true, addedAt: Date.now(), ...tag });
    persist();
    return tag.id;
  },

  update(id, patch) {
    const t = this.tag(id);
    if (!t) return null;
    Object.assign(t, patch);
    persist();
    return t;
  },

  // Record a sighting: when, and where the phone was if location is allowed.
  seen(id, where, how) {
    const t = this.tag(id);
    if (!t) return;
    const entry = { t: Date.now(), how, ...(where || {}) };
    t.lastSeen = entry;
    t.history = [entry, ...(t.history || [])].slice(0, MAX_HISTORY);
    persist();
  },

  remove(id) {
    data.tags = data.tags.filter((t) => t.id !== id);
    persist();
  },

  setting(key, value) {
    data.settings[key] = value;
    persist();
  },

  exportJson() {
    return JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2);
  },

  wipe() {
    data = blank();
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  },
};
