importScripts('../shared/sw-core.js');
const scopePath = new URL(self.registration.scope).pathname;
const code = scopePath.split('/').filter(Boolean).length === 2 ? scopePath.split('/')[1] : '';
const asset = (path) => new URL(path, self.registration.scope).pathname;

self.setupOfflineWorker({
  cachePrefix: code ? `tenant-${code}-shop` : 'os-shop',
  version: 'v144',
  scopePath,
  offlinePage: asset('./offline.html'),
  assets: [
    './', './index.html', './offline.html', './style.css', './tokens.css', './palette.js', './bootstrap.js', './app.js', './version.js', './catalog-presentation.js', './cart.js',
    './mobile-navigation.js', './update-view.js', './profile.js', './addresses.js', './postcodes-my.js', './checkout-payload.js', './cart-selection.js', './checkout.js', './history.js', './local-orders.js', './product-detail.js', './product-media.js', './option-selector.js', './product-share.js', './storage-scope.js', './image-zoom.js', './shop-route.js',
    './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
    '../shared/base-path.js', '../shared/storage-scope.js', '../shared/offline-bootstrap.js', '../shared/base.css', '../shared/demo-entry.js', '../shared/appearance.js', '../shared/appearance.css', '../shared/update-guard.js', '../shared/image-thumb.js', '../shared/i18n.js', '../shared/order-status.js', '../shared/pwa.js', '../shared/modal.js', '../shared/tab-icon.js', '../shared/offline.js', '/favicon.svg',
  ].map(asset),
});
