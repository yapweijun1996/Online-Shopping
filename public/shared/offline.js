import { setupLanguageSelect } from './i18n.js';

setupLanguageSelect(document.getElementById('language'));
document.getElementById('retry').addEventListener('click', () => location.reload());
