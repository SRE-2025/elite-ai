// Every network request Elite AI makes passes through here. In Sealed mode the app may only talk to
// the AIs the user connected (or a private gateway / this computer) — nothing else on the internet:
// no web search, no other sites, no lookups. Each request is logged (host and path only, never
// keys or content) so the user, or a company's security team, can see exactly where data went.

const log = [];
let policy = () => ({ sealed: false, hosts: new Set() });

export function installNetworkGuard(getPolicy) {
  policy = getPolicy;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const { sealed, hosts } = policy();
    const internal = url.origin === location.origin;
    const allowed = internal || !sealed || hosts.has(url.host);
    log.unshift({ at: Date.now(), host: url.host, path: url.pathname, method: (init.method || 'GET').toUpperCase(), allowed, internal });
    if (log.length > 300) log.length = 300;
    if (!allowed) {
      throw new Error(`Sealed mode blocked a request to ${url.host} — it isn't one of your connected AIs.`);
    }
    return realFetch(input, init);
  };
}

export const networkLog = () => log;

// A short summary for Settings: which outside hosts were contacted this session, and how often.
export function networkSummary() {
  const out = {};
  for (const e of log) {
    if (e.internal) continue;
    const k = e.host;
    out[k] ||= { host: k, count: 0, blocked: 0 };
    out[k].count++;
    if (!e.allowed) out[k].blocked++;
  }
  return Object.values(out).sort((a, b) => b.count - a.count);
}
