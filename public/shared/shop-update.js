import { translate, t } from './i18n.js';
import { registerWorker } from './pwa.js';

translate(document);
// This page is deliberately outside /shop/ so older cached shells cannot intercept it.
registerWorker('./shop/sw.js', './shop/', { returnUrl: './shop/', autoUpdate: true }).catch(() => {
  document.getElementById('update-error').textContent = t('updateFailed');
});
