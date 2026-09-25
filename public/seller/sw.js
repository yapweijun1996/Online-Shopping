importScripts('/shared/sw-core.js');

self.setupOfflineWorker({
  cachePrefix: 'os-seller',
  version: 'v7',
  scopePath: '/seller/',
  offlinePage: '/seller/offline.html',
  assets: [
    '/seller/', '/seller/index.html', '/seller/offline.html', '/seller/style.css', '/seller/app.js',
    '/seller/manifest.webmanifest', '/seller/icons/icon-192.png', '/seller/icons/icon-512.png',
    '/shared/base.css', '/shared/i18n.js', '/shared/pwa.js', '/shared/offline.js', '/favicon.svg',
  ],
});
