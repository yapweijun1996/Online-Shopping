importScripts('./shared/sw-core.js');
const scopePath = new URL(self.registration.scope).pathname;
const asset = (path) => new URL(path, self.registration.scope).pathname;

// Offline contract: only these public, static shell files are cached. Requests under /api/ are never intercepted (sw-core),
// so shop data, sessions and every change go to the network and fail visibly when offline.
self.setupOfflineWorker({
  cachePrefix: 'os-platform',
  version: 'v9',
  scopePath,
  offlinePage: asset('./offline.html'),
  assets: [
    './',
    './app-state.js',
    './app.js',
    './commerce.css',
    './email-template.js',
    './favicon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './index.html',
    './manifest.webmanifest',
    './offline.html',
    './pwa-shell.js',
    './seller/style.css',
    './shared/appearance.css',
    './shared/appearance.js',
    './shared/base.css',
    './shared/i18n.js',
    './shared/icons.js',
    './shared/modal.js',
    './shared/pwa.js',
    './shared/topbar-update.js',
    './shared/update-guard.js',
    './shop/tokens.css',
    './studio-leaf.svg',
    './style.css',
    './table.js',
    './vendor/qrcode.js',
    './version.js',
  ].map(asset),
});
