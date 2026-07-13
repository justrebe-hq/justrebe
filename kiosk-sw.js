// ReBe Genre Kiosk - Service Worker
// Caches the kiosk page and icons on first visit so it works fully offline.
//
// Scope is intentionally limited to /rebe-genre-kiosk to avoid interfering
// with the rest of justrebe.com. Any request outside that path falls through
// to normal network behavior.

const CACHE_NAME = 'rebe-kiosk-v1';
const KIOSK_ASSETS = [
  '/rebe-genre-kiosk',
  '/rebe-genre-kiosk.html',
  '/kiosk-manifest.json',
  '/kiosk-icon-180.png',
  '/kiosk-icon-192.png',
  '/kiosk-icon-512.png',
];

// Install: pre-cache the kiosk HTML + icons so first-load-then-offline works.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Try to cache every asset; if any single one fails (e.g. redirect
      // resolves to different URL), keep going — the browser will retry
      // via the fetch handler on the next request.
      return Promise.allSettled(
        KIOSK_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })))
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up any old caches from previous versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: for kiosk paths, serve from cache first (fast + offline).
// For everything else, do nothing — let the browser handle normally.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  const path = url.pathname;
  const isKioskAsset =
    path === '/rebe-genre-kiosk' ||
    path === '/rebe-genre-kiosk.html' ||
    path === '/kiosk-manifest.json' ||
    path.startsWith('/kiosk-icon-');

  if (!isKioskAsset) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Serve from cache immediately, then refresh cache in background
        // so the next visit gets any updates.
        fetch(event.request).then((fresh) => {
          if (fresh && fresh.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, fresh));
          }
        }).catch(() => { /* offline — ignore */ });
        return cached;
      }
      // Not cached — fetch from network and cache for next time.
      return fetch(event.request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
