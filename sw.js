// Elite AI service worker: makes the app installable and opens it offline.
// Same-origin files are network-first (testers always get the latest build when online).
// AI API calls are never cached or touched.
const CACHE = 'elite-ai-v5';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/providers.js', 'js/orchestrator.js', 'js/markdown.js', 'js/store.js', 'js/audit.js', 'js/code-runner.js', 'js/learning.js', 'js/net.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
  );
});
