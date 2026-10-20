// Runs AI-written code against known test cases for the Champion Audit.
// It lives in a Web Worker: no page, no stored keys, network APIs removed, and the app
// terminates it after a few seconds, so a broken or looping answer can't hurt anything.

for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel']) {
  try { self[name] = undefined; } catch { /* not writable — fine */ }
}

const canonGroups = (groups) => JSON.stringify(
  (Array.isArray(groups) ? groups : [])
    .map((g) => (Array.isArray(g) ? [...g] : [g]).sort((a, b) => String(a).toLowerCase().localeCompare(String(b).toLowerCase()) || String(a).localeCompare(String(b))))
    .sort((a, b) => String(a[0]).toLowerCase().localeCompare(String(b[0]).toLowerCase())),
);

const SUITES = {
  parseDuration: {
    fn: 'parseDuration',
    cases: [['1h30m', 5400], ['45m', 2700], ['2h', 7200], ['90s', 90], ['1h2m3s', 3723], ['', null], ['abc', null], ['5x', null], ['1h1h', null]],
    same: (got, want) => got === want,
  },
  groupAnagrams: {
    fn: 'groupAnagrams',
    cases: [
      [['eat', 'Tea', 'tan', 'ate', 'nat', 'bat'], [['ate', 'eat', 'Tea'], ['bat'], ['nat', 'tan']]],
      [[], []],
      [['a'], [['a']]],
      [['abc', 'CBA', 'bca', 'xyz', 'zyx', 'q'], [['abc', 'bca', 'CBA'], ['q'], ['xyz', 'zyx']]],
      [['ab', 'ba', 'ab'], [['ab', 'ab', 'ba']]],
    ],
    same: (got, want) => canonGroups(got) === canonGroups(want),
  },
};

self.onmessage = (e) => {
  const { suite, code } = e.data;
  const s = SUITES[suite];
  let fn;
  try {
    const src = String(code).replace(/^\s*export\s+(default\s+)?/gm, '');
    fn = new Function(`"use strict"; const module = { exports: {} }; const exports = module.exports;\n${src}\n;return typeof ${s.fn} === 'function' ? ${s.fn} : module.exports.${s.fn} || module.exports;`)();
  } catch (err) {
    // If this browser forbids running code at all, say so — the audit then falls back to judges.
    if (err instanceof EvalError || /unsafe-eval|content security/i.test(err.message)) postMessage({ blocked: true });
    else postMessage({ pass: 0, total: s.cases.length, fails: ['Code did not run: ' + err.message] });
    return;
  }
  if (typeof fn !== 'function') {
    postMessage({ pass: 0, total: s.cases.length, fails: [`No function named ${s.fn} was found`] });
    return;
  }
  let pass = 0;
  const fails = [];
  for (const [input, want] of s.cases) {
    try {
      const got = fn(structuredClone(input));
      if (s.same(got, want)) pass++;
      else fails.push(`${JSON.stringify(input)} → ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);
    } catch (err) {
      fails.push(`${JSON.stringify(input)} threw: ${err.message}`);
    }
  }
  postMessage({ pass, total: s.cases.length, fails: fails.slice(0, 3) });
};
