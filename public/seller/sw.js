importScripts('/shared/sw-core.js');

self.setupOfflineWorker({
  cachePrefix: 'os-seller',
  version: 'v95',
  scopePath: '/seller/',
  offlinePage: '/seller/offline.html',
  assets: [
    '/seller/', '/seller/index.html', '/seller/offline.html', '/seller/style.css', '/seller/palette.js', '/shop/tokens.css', '/seller/app.js', '/seller/alerts.js', '/seller/version.js', '/seller/products.js', '/seller/orders.js', '/seller/order-documents.js', '/seller/order-document-model.js', '/seller/order-print.css', '/seller/vendor/printform.js', '/seller/settings.js', '/seller/options.js', '/seller/product-fields.js', '/seller/assets/login-workspace.webp',
    '/seller/integrations.js', '/shared/integration-catalog.js',
    '/seller/commerce.css', '/seller/studio-copy.js', '/seller/assets/studio-leaf.svg',
    '/seller/manifest.webmanifest', '/seller/icons/icon-192.png', '/seller/icons/icon-512.png',
    '/shared/base.css', '/shared/demo-entry.js', '/shared/appearance.js', '/shared/appearance.css', '/shared/update-guard.js', '/shared/i18n.js', '/shared/pwa.js', '/shared/modal.js', '/shared/offline.js', '/favicon.svg',
  ],
});
