// Asset Doctor service worker (hand-rolled, zero-dep). The precache list + VERSION are injected at BUILD
// time by scripts/pwa-plugin.mjs (Vite generateBundle) so the version changes whenever ANY shipped chunk
// changes — that is the whole cache-invalidation safety story. NO user data is ever touched: this caches
// ONLY our own same-origin app shell (JS/CSS/fonts/html), never a user's assets, and there is no network
// path off-device (invariant 1 — offline literally proves it).
//
// Strategy:
//   • navigations (mode:'navigate') → NETWORK-FIRST, fall back to the cached index.html. Online, a fresh
//     deploy's index.html (pointing at new hashed chunks) is always fetched; offline, the shell serves.
//   • same-origin, content-HASHED assets (/assets/…) → CACHE-FIRST (immutable: the hash IS the version;
//     a changed asset is a new URL). Cache-miss populates the versioned cache.
//   • everything else same-origin → network, cache-on-success (stale-while-usable for offline).
//   • cross-origin → passthrough (there are none — invariant 1 — but never cache them if there were).
// activate purges every cache whose name !== the current VERSION, so a new deploy drops all stale chunks.

const VERSION = '__SW_VERSION__';
const PRECACHE = __SW_PRECACHE__; // string[] of scope-relative URLs (the shell)
const CACHE = `asset-doctor-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll is atomic-ish: one 404 rejects the whole install, so keep PRECACHE to the shell only.
      await cache.addAll(PRECACHE);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin (none here) → let the network handle it

  // SPA navigations: network-first so a new deploy's index.html wins online; cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put('index.html', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match('index.html')) || (await cache.match(PRECACHE[0])) || Response.error();
        }
      })(),
    );
    return;
  }

  // Content-hashed build assets are immutable → cache-first (and populate for offline).
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch {
        return hit || Response.error();
      }
    })(),
  );
});
