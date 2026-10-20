// Everything Elite AI remembers lives in this browser only (localStorage).
// Reads and writes never throw: private windows and full storage just fall back to defaults.

const PREFIX = 'eliteai.v1.';

export const store = {
  read(name, fallback) {
    try {
      const v = localStorage.getItem(PREFIX + name);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  write(name, value) {
    try {
      localStorage.setItem(PREFIX + name, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(name) {
    try { localStorage.removeItem(PREFIX + name); } catch { /* storage unavailable */ }
  },
};
