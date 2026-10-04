// Service worker for the installed-app experience (icon on your Dock/Home Screen, standalone window —
// see docs/SPEC.md's install notes). Deliberately minimal: this is a single-operator tool for *live*
// security camera video, where caching anything time-sensitive would be actively wrong, not just
// unhelpful. Its only job is (a) satisfying the browser's installability requirement for a registered
// worker with a fetch handler, and (b) letting the static app shell (this JS/CSS, not any data) launch
// once already installed even if the Mac running the server is briefly asleep or off the network.
//
// Explicitly NOT cached, ever: anything under /api/ (settings, calibration, export, thumbnails — all must
// always be live), the playback/live WebSocket and WebRTC/MSE streams (the browser never routes these
// through a service worker's fetch event in the first place — no special-casing needed), and anything
// cross-origin.
const CACHE_NAME = 'sentinel-eye-shell-v10'; // shared iPhone/iPad PWA chrome; discard the previous shell on activation
const STATIC_RE = /\.(?:js|css|png|svg|json|ico|webmanifest)$/;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  // Sign-in pages always come from the server: a cached one could show a stale form or skip a redirect.
  if (/^\/(login|pair)(\.html)?$|^\/js\/(login|pair)\.js$/.test(url.pathname)) return;
  const isShell = url.pathname === '/' || url.pathname === '/index.html' || STATIC_RE.test(url.pathname);
  if (!isShell) return;
  event.respondWith(networkFirst(req));
});

// Network-first with a short timeout: a running server always gets its current shell to the browser (a
// cache-first worker kept TVs and installed apps one reload behind every fix — the TV's black-screen fix
// didn't reach it). The cache only answers when the server can't: offline, or too slow to wait for (an
// installed app resuming over a sleepy network still comes back quickly).
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const network = fetch(request, { cache: 'no-cache' }).then((response) => {
    // Never cache a followed redirect (e.g. an app-shell request bounced to /login) under the original key.
    if (response && response.ok && !response.redirected) cache.put(request, response.clone());
    return response;
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 2500));
  try {
    const fresh = await Promise.race([network, timeout]);
    if (fresh) return fresh;
  } catch { /* offline: fall through to the cache */ }
  const cached = await cache.match(request);
  if (cached) return cached;
  return network;   // nothing cached either: wait it out (or surface the real network error)
}
