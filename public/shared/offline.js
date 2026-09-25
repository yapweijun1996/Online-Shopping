import { setupLanguageMenu } from './i18n.js';

setupLanguageMenu(document.getElementById('language'));
document.getElementById('retry').addEventListener('click', () => location.reload());
