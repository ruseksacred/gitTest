// Bump on each app release so installed clients also see the update prompt.
const CACHE = 'race-focus-offline-v9';
const OFFLINE_ASSETS = ['/offline.html', '/pwa.css', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(OFFLINE_ASSETS)));
  // Updates wait for the player's explicit action; never interrupt a match.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('race-focus-offline-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'APPLY_UPDATE') event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // No API responses, accounts, results, game scripts or authenticated pages
  // enter the cache. A reconnect must always use current server state.
  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html', { cacheName: CACHE })));
  } else if (OFFLINE_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname, { cacheName: CACHE }).then(cached => cached || fetch(request)));
  }
});
