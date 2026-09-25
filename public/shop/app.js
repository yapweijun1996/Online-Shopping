import { setupLanguageSelect } from '../shared/i18n.js';
import { registerWorker } from '../shared/pwa.js';

setupLanguageSelect(document.getElementById('language'));
registerWorker('/shop/sw.js', '/shop/').catch(() => console.warn('Shop offline shell unavailable.'));
