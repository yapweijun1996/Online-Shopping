/* A worker may cache only the explicit public shell files supplied by its surface. */
self.setupOfflineWorker = ({ cachePrefix, version, assets, scopePath, offlinePage }) => {
  const cacheName = `${cachePrefix}-${version}`;
  const assetPaths = new Set(assets);

  self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)));
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(`${cachePrefix}-`) && name !== cacheName) await caches.delete(name);
      }
      await self.clients.claim();
    })());
  });

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

    if (request.mode === 'navigate' && url.pathname.startsWith(scopePath)) {
      event.respondWith((async () => {
        const cache = await caches.open(cacheName);
        try {
          const response = await fetch(request);
          if (!response.ok) return response;
          return (await cache.match(scopePath)) || response;
        } catch {
          return cache.match(offlinePage);
        }
      })());
      return;
    }

    if (assetPaths.has(url.pathname)) {
      event.respondWith((async () => {
        const cache = await caches.open(cacheName);
        return (await cache.match(request)) || fetch(request);
      })());
    }
  });
};
