import { locale, setupLanguageSelect, t } from '../shared/i18n.js';
import { registerWorker } from '../shared/pwa.js';

const byId = (id) => document.getElementById(id);
const loginView = byId('login-view');
const workspace = byId('workspace');
const sidebar = byId('sidebar');
const accountWrap = byId('account-wrap');
const accountButton = byId('account-button');
const accountMenu = byId('account-menu');
const menuButton = byId('open-menu');
const backdrop = byId('drawer-backdrop');
let csrfToken = null;
let currentView = 'dashboard';
let username = '';
const sessionHintKey = 'online-shopping-seller-session-hint';

function sessionHint(value) {
  try {
    if (value === undefined) return localStorage.getItem(sessionHintKey) === '1';
    if (value) localStorage.setItem(sessionHintKey, '1');
    else localStorage.removeItem(sessionHintKey);
  } catch { return false; }
}

setupLanguageSelect(byId('language'));
registerWorker('/seller/sw.js', '/seller/').catch(() => console.warn('Seller offline shell unavailable.'));

function showLogin(message = '', clearHint = true) {
  if (clearHint) sessionHint(false);
  csrfToken = null;
  username = '';
  loginView.hidden = false;
  workspace.hidden = true;
  sidebar.hidden = true;
  menuButton.hidden = true;
  accountWrap.hidden = true;
  byId('login-message').textContent = message;
  closeDrawer();
}

function showWorkspace(session) {
  sessionHint(true);
  csrfToken = session.csrfToken;
  username = session.username;
  loginView.hidden = true;
  workspace.hidden = false;
  sidebar.hidden = false;
  menuButton.hidden = false;
  accountWrap.hidden = false;
  byId('password').value = '';
  syncDrawerAccess();
  renderView();
}

function renderView() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    const active = button.dataset.view === currentView;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const titleKey = { dashboard: 'dashboard', products: 'products', orders: 'salesOrders', review: 'orderReview' }[currentView];
  byId('page-title').dataset.i18n = titleKey;
  byId('page-title').textContent = t(titleKey);
  const content = byId('workspace-content');
  content.replaceChildren();
  const p = document.createElement('p');
  p.dataset.i18n = currentView === 'products' ? 'noProducts' : currentView === 'orders' || currentView === 'review' ? 'noOrders' : 'notReady';
  p.textContent = t(p.dataset.i18n);
  content.append(p);
}

function closeDrawer() {
  const wasOpen = sidebar.classList.contains('drawer-open');
  sidebar.classList.remove('drawer-open');
  backdrop.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
  syncDrawerAccess();
  if (wasOpen) menuButton.focus();
}

function syncDrawerAccess() {
  sidebar.inert = window.matchMedia('(max-width: 760px)').matches && !sidebar.classList.contains('drawer-open');
}

function closeAccount() {
  accountMenu.hidden = true;
  accountButton.setAttribute('aria-expanded', 'false');
}

menuButton.addEventListener('click', () => {
  sidebar.classList.add('drawer-open');
  syncDrawerAccess();
  backdrop.hidden = false;
  menuButton.setAttribute('aria-expanded', 'true');
  byId('close-menu').focus();
});
byId('close-menu').addEventListener('click', closeDrawer);
backdrop.addEventListener('click', closeDrawer);
window.addEventListener('resize', syncDrawerAccess);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeDrawer(); closeAccount(); }
});
byId('collapse-nav').addEventListener('click', () => {
  const collapsed = sidebar.classList.toggle('collapsed');
  byId('collapse-nav').dataset.i18nAria = collapsed ? 'expand' : 'collapse';
  byId('collapse-nav').setAttribute('aria-label', t(collapsed ? 'expand' : 'collapse'));
});
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => {
  currentView = button.dataset.view;
  renderView();
  closeDrawer();
}));
accountButton.addEventListener('click', () => {
  accountMenu.hidden = !accountMenu.hidden;
  accountButton.setAttribute('aria-expanded', String(!accountMenu.hidden));
});
document.addEventListener('click', (event) => {
  if (!byId('account-wrap').contains(event.target)) closeAccount();
});
byId('profile-button').addEventListener('click', () => {
  closeAccount();
  byId('workspace-message').textContent = `${t('username')}: ${username} · SUPER_ADMIN`;
});
byId('sign-out-button').addEventListener('click', async () => {
  closeAccount();
  try {
    const response = await fetch('/api/v1/seller/session', { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } });
    if (!response.ok) throw new Error('sign out failed');
    showLogin(t('signedOut'));
  } catch {
    byId('workspace-message').textContent = t('networkError');
  }
});

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = byId('login-submit');
  submit.disabled = true;
  byId('login-message').textContent = '';
  try {
    const response = await fetch('/api/v1/seller/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: byId('username').value, password: byId('password').value }),
    });
    if (!response.ok) {
      byId('login-message').textContent = t('authError');
      return;
    }
    showWorkspace(await response.json());
  } catch {
    byId('login-message').textContent = t('networkError');
  } finally {
    submit.disabled = false;
  }
});

document.addEventListener('localechange', () => {
  renderView();
  document.documentElement.lang = locale();
});

if (sessionHint()) {
  showLogin(t('loading'), false);
  fetch('/api/v1/seller/session').then(async (response) => {
    if (response.ok) showWorkspace(await response.json());
    else showLogin();
  }).catch(() => showLogin(t('networkError')));
} else {
  showLogin();
}
