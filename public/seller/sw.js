importScripts('../shared/sw-core.js');
const scopePath = new URL(self.registration.scope).pathname;
const code = scopePath.split('/').filter(Boolean).length === 2 ? scopePath.split('/')[1] : '';
const asset = (path) => new URL(path, self.registration.scope).pathname;

self.setupOfflineWorker({
  cachePrefix: code ? `tenant-${code}-seller` : 'os-seller',
  version: 'v135',
  scopePath,
  offlinePage: asset('./offline.html'),
  assets: [
    './', './index.html', './offline.html', './style.css', './palette.js', '../shop/tokens.css', './bootstrap.js', './app.js', './alerts.js', './version.js', './products.js', './orders.js', './order-documents.js', './order-document-model.js', './order-print.css', './vendor/printform.js', './settings.js', './options.js', './product-fields.js', './assets/login-workspace.webp',
    './integrations.js', './whatsapp-connection.js', '../shared/integration-catalog.js',
    './commerce.css', './studio-copy.js', './trail-copy.js', './audit.js', './messages.js', './ops-copy.js', './erase-contact.js', './dashboard-figures.js', './team.js', './order-notes.js', './product-import.js', './password-dialog.js', './order-status-label.js', './assets/studio-leaf.svg',
    './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
    '../shared/base-path.js', '../shared/storage-scope.js', '../shared/offline-bootstrap.js', '../shared/base.css', '../shared/demo-entry.js', '../shared/appearance.js', '../shared/appearance.css', '../shared/update-guard.js', '../shared/image-reveal.js', '../shared/image-thumb.js', '../shared/i18n.js', '../shared/pwa.js', '../shared/modal.js', '../shared/tab-icon.js', '../shared/offline.js', '/favicon.svg',
  ].map(asset),
});
