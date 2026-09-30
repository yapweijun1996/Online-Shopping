importScripts('/shared/sw-core.js');

self.setupOfflineWorker({
  cachePrefix: 'os-shop',
  version: 'v95',
  scopePath: '/shop/',
  offlinePage: '/shop/offline.html',
  assets: [
    '/shop/', '/shop/index.html', '/shop/offline.html', '/shop/style.css', '/shop/tokens.css', '/shop/palette.js', '/shop/app.js', '/shop/cart.js',
    '/shop/mobile-navigation.js', '/shop/update-view.js', '/shop/profile.js', '/shop/addresses.js', '/shop/postcodes-my.js', '/shop/checkout-payload.js', '/shop/cart-selection.js', '/shop/checkout.js', '/shop/history.js', '/shop/local-orders.js', '/shop/product-detail.js', '/shop/image-zoom.js', '/shop/shop-route.js',
    '/shop/manifest.webmanifest', '/shop/icons/icon-192.png', '/shop/icons/icon-512.png',
    '/shared/base.css', '/shared/i18n.js', '/shared/order-status.js', '/shared/pwa.js', '/shared/modal.js', '/shared/offline.js', '/favicon.svg',
  ],
});
