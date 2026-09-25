importScripts('/shared/sw-core.js');

self.setupOfflineWorker({
  cachePrefix: 'os-shop',
  version: 'v30',
  scopePath: '/shop/',
  offlinePage: '/shop/offline.html',
  assets: [
    '/shop/', '/shop/index.html', '/shop/offline.html', '/shop/style.css', '/shop/app.js', '/shop/cart.js',
    '/shop/checkout.js', '/shop/history.js',
    '/shop/manifest.webmanifest', '/shop/icons/icon-192.png', '/shop/icons/icon-512.png',
    '/shared/base.css', '/shared/i18n.js', '/shared/pwa.js', '/shared/offline.js', '/favicon.svg',
  ],
});
