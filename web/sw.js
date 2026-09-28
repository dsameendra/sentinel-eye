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
const CACHE_NAME = 'sentinel-eye-shell-v3';
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
  event.respondWith(staleWhileRevalidate(event, req));
});

// Stale-while-revalidate, not network-first: answer from cache immediately (when there is one) so an
// installed app resumes instantly — an iOS home-screen app that got fully evicted from memory while
// backgrounded has to reload this shell from scratch to come back at all, and waiting on a real network
// round-trip for that (network-first's old behaviour) is exactly the kind of pause that reads as "the app
// went black". The network request still always goes out and updates the cache for next time, so this
// keeps network-first's actual goal (never stuck on a stale shell once a real update ships) without paying
// for it on every single resume — just once, in the background, after the page already painted.
async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  if (cached) { event.waitUntil(network); return cached; }
  const fresh = await network;
  if (fresh) return fresh;
  throw new Error('offline and nothing cached yet');
}
