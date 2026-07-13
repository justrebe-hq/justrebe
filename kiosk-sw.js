// ReBe Genre Kiosk - Service Worker (v2, hardened for iOS)
//
// Strategy: cache-first with aggressive precaching, URL-variant fallbacks
// (so /rebe-genre-kiosk and /rebe-genre-kiosk.html both work), and a
// last-ditch cache fallback if the network fails and the exact URL isn't
// cached.

const CACHE_NAME = 'rebe-kiosk-v2';
const KIOSK_URLS = [
  '/rebe-genre-kiosk',
  '/rebe-genre-kiosk.html',
  '/kiosk-manifest.json',
  '/kiosk-icon-180.png',
  '/kiosk-icon-192.png',
  '/kiosk-icon-512.png',
];

// Install: fetch and cache each asset individually. If any single asset
// fails, keep going — better to have a partial cache than no cache.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of KIOSK_URLS) {
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response && response.ok) {
          await cache.put(url, response.clone());
          // Also mirror the HTML under both URL variants so cache lookups
          // succeed whether the browser asks for /rebe-genre-kiosk or
          // /rebe-genre-kiosk.html — Vercel serves the same file at both.
          if (url === '/rebe-genre-kiosk') {
            await cache.put('/rebe-genre-kiosk.html', response.clone());
          } else if (url === '/rebe-genre-kiosk.html') {
            await cache.put('/rebe-genre-kiosk', response.clone());
          }
        }
      } catch (err) {
        console.warn('[kiosk-sw] precache miss:', url, err);
      }
    }
    // Activate this SW immediately, don't wait for old SWs to release control
    await self.skipWaiting();
  })());
});

// Activate: clean up any old caches from previous versions and take
// control of open pages immediately.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Fetch: only intercept kiosk-related requests. Everything else passes
// through to normal network behavior.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const path = url.pathname;
  const isKioskAsset =
    path === '/rebe-genre-kiosk' ||
    path === '/rebe-genre-kiosk.html' ||
    path === '/kiosk-manifest.json' ||
    path.startsWith('/kiosk-icon-');

  if (!isKioskAsset) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // 1) Try direct cache match for the exact URL requested
    let cached = await cache.match(event.request, { ignoreVary: true });

    if (cached) {
      // Return cached immediately, refresh in background for next visit
      fetch(event.request).then((fresh) => {
        if (fresh && fresh.ok) cache.put(event.request, fresh.clone());
      }).catch(() => { /* offline — that's fine, we already served cache */ });
      return cached;
    }

    // 2) Try URL variant (with/without .html) for the kiosk HTML
    if (path === '/rebe-genre-kiosk') {
      cached = await cache.match('/rebe-genre-kiosk.html');
      if (cached) return cached;
    } else if (path === '/rebe-genre-kiosk.html') {
      cached = await cache.match('/rebe-genre-kiosk');
      if (cached) return cached;
    }

    // 3) Nothing cached yet — go to network and cache the response
    try {
      const response = await fetch(event.request);
      if (response && response.ok) {
        cache.put(event.request, response.clone());
      }
      return response;
    } catch (err) {
      // Truly offline with no cache — last resort: serve whatever variant
      // of the kiosk HTML we have (better than showing an error)
      const fallback =
        (await cache.match('/rebe-genre-kiosk')) ||
        (await cache.match('/rebe-genre-kiosk.html'));
      if (fallback) return fallback;
      throw err;
    }
  })());
});
