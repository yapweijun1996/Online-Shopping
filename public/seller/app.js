import { locale, setupLanguageMenu, t } from '../shared/i18n.js';
import { registerWorker } from '../shared/pwa.js';
import { mountProducts } from './products.js';
import { mountOrders } from './orders.js';
import { mountCategories, mountCompanySettings } from './settings.js';

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
let role = '';
let productsPage = null;
let ordersPage = null;
let settingsPage = null;
let loginMessageKey = '';
let workspaceMessageKey = '';
let dashboardRequest = 0;
let updateState = null;
let updateActions = null;
let updateDismissed = false;
let updateView = null;
let updateIdentity = '';
const sessionHintKey = 'online-shopping-seller-session-hint';
const VALID_VIEWS = new Set(['dashboard', 'products', 'orders', 'review', 'categories', 'company']);

function viewFromHash() {
  const view = location.hash.slice(1);
  return VALID_VIEWS.has(view) ? view : 'dashboard';
}

function applyRoute() {
  currentView = viewFromHash();
  renderView();
}

function activePage() {
  return currentView === 'products' ? productsPage : currentView === 'categories' || currentView === 'company' ? settingsPage : null;
}

function hasUnsavedChanges() { return activePage()?.hasUnsavedChanges?.() === true; }
function confirmLeave() { return !hasUnsavedChanges() || window.confirm(t('unsavedChangesConfirm')); }

function navigate(view) {
  if (view === currentView) { focusRouteChange(); return true; }
  if (!confirmLeave()) return false;
  currentView = view;
  location.hash = view;
  renderView();
  focusRouteChange();
  return true;
}

function sessionHint(value) {
  try {
    if (value === undefined) return localStorage.getItem(sessionHintKey) === '1';
    if (value) localStorage.setItem(sessionHintKey, '1');
    else localStorage.removeItem(sessionHintKey);
  } catch { return false; }
}

setupLanguageMenu(byId('language'));
document.title = `${t('sellerPortal')} · Online Shopping`;
registerWorker('/seller/sw.js', '/seller/', {
  onState(state, actions) {
    const identity = state.ready ? state.available || 'ready' : '';
    if (identity && identity !== updateIdentity) updateDismissed = false;
    updateIdentity = identity;
    updateState = state;
    updateActions = actions;
    renderUpdateUI();
  },
}).catch(() => {
  updateState = { statusKey: 'updateFailed' };
  renderUpdateUI();
});

function renderUpdateUI() {
  const check = byId('check-updates-button');
  const notice = byId('seller-update-notice');
  const applying = updateState?.applying === true;
  check.disabled = !updateActions || updateState?.checking === true || applying;
  byId('check-updates-status').textContent = updateState?.statusKey ? t(updateState.statusKey) : '';
  notice.hidden = !updateState?.ready || updateDismissed;
  byId('seller-update-detail').textContent = t(applying ? 'appUpdating' : 'updateReadyDetail');
  byId('install-update-button').disabled = applying;
  byId('later-update-button').disabled = applying;
}

function setLoginMessage(key) {
  loginMessageKey = key;
  byId('login-message').textContent = key ? t(key) : '';
}

function setWorkspaceMessage(key) {
  workspaceMessageKey = key;
  byId('workspace-message').textContent = key ? t(key) : '';
}

function setPasswordVisible(visible) {
  byId('password').type = visible ? 'text' : 'password';
  const toggle = byId('password-toggle');
  toggle.classList.toggle('is-visible', visible);
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.dataset.i18nAria = visible ? 'hidePassword' : 'showPassword';
  toggle.setAttribute('aria-label', t(toggle.dataset.i18nAria));
}

function showLogin(messageKey = '', clearHint = true) {
  const leavingWorkspace = !workspace.hidden;
  if (clearHint) sessionHint(false);
  csrfToken = null;
  username = '';
  role = '';
  productsPage = null;
  settingsPage = null;
  ordersPage?.dispose();
  ordersPage = null;
  byId('workspace-content').replaceChildren();
  loginView.hidden = false;
  workspace.hidden = true;
  sidebar.hidden = true;
  menuButton.hidden = true;
  accountWrap.hidden = true;
  document.body.classList.remove('seller-signed-in');
  setPasswordVisible(false);
  setLoginMessage(messageKey);
  closeDrawer(false);
  if (leavingWorkspace) byId('username').focus();
}

function showWorkspace(session) {
  sessionHint(true);
  csrfToken = session.csrfToken;
  username = session.username;
  role = session.role;
  setLoginMessage('');
  setWorkspaceMessage('');
  loginView.hidden = true;
  workspace.hidden = false;
  sidebar.hidden = false;
  menuButton.hidden = false;
  accountWrap.hidden = false;
  document.body.classList.add('seller-signed-in');
  byId('password').value = '';
  syncDrawerAccess();
  applyRoute();
}

function renderView() {
  if (updateView !== currentView) {
    updateView = currentView;
    updateDismissed = false;
    renderUpdateUI();
  }
  document.querySelectorAll('.nav-item').forEach((button) => {
    const active = button.dataset.view === currentView;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const titleKey = { dashboard: 'dashboard', products: 'products', orders: 'salesOrders', review: 'orderReview', categories: 'categoryCodes', company: 'companySettings' }[currentView];
  byId('page-title').dataset.i18n = titleKey;
  byId('page-title').textContent = t(titleKey);
  const content = byId('workspace-content');
  if (currentView === 'orders' || currentView === 'review') {
    productsPage = null;
    settingsPage = null;
    if (ordersPage?.mode !== currentView) {
      ordersPage?.dispose();
      ordersPage = mountOrders(content, {
        mode: currentView,
        csrfToken: () => csrfToken,
        onUnauthorized: () => showLogin('authError'),
      });
    }
    return;
  }
  ordersPage?.dispose();
  ordersPage = null;
  if (currentView === 'products') {
    settingsPage = null;
    if (!productsPage) productsPage = mountProducts(content, { csrfToken: () => csrfToken, onUnauthorized: () => showLogin('authError') });
    return;
  }
  productsPage = null;
  if (currentView === 'categories') {
    settingsPage = mountCategories(content, { csrfToken: () => csrfToken, onUnauthorized: () => showLogin('authError') });
    return;
  }
  if (currentView === 'company') {
    settingsPage = mountCompanySettings(content, { csrfToken: () => csrfToken, onUnauthorized: () => showLogin('authError') });
    return;
  }
  renderDashboard(content);
}

async function renderDashboard(content) {
  const request = ++dashboardRequest;
  const card = document.createElement('section');
  card.className = 'settings-card dashboard-card';
  card.textContent = t('loading');
  content.replaceChildren(card);
  try {
    const response = await fetch('/api/v1/seller/setup');
    if (response.status === 401) { showLogin('authError'); return; }
    if (!response.ok) throw new Error('setup failed');
    const setup = await response.json();
    if (request !== dashboardRequest || currentView !== 'dashboard' || workspace.hidden) return;
    card.replaceChildren();
    const heading = document.createElement('h2');
    const description = document.createElement('p');
    const actions = document.createElement('div');
    actions.className = 'dashboard-actions';
    if (setup.mode) {
      heading.textContent = setup.shopName;
      description.dataset.i18n = setup.mode === 'demo' ? 'demoMode' : 'productionMode';
      description.textContent = t(description.dataset.i18n);
      for (const [view, key] of [['products', 'products'], ['orders', 'salesOrders'], ['company', 'companySettings']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = view === 'orders' ? 'primary-button' : 'secondary-button';
        button.dataset.i18n = key;
        button.textContent = t(key);
        button.addEventListener('click', () => navigate(view));
        actions.append(button);
      }
    } else {
      heading.dataset.i18n = 'shopSetup';
      heading.textContent = t('shopSetup');
      description.dataset.i18n = 'setupIntro';
      description.textContent = t('setupIntro');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'primary-button';
      button.dataset.i18n = 'shopSetup';
      button.textContent = t('shopSetup');
      button.addEventListener('click', () => navigate('company'));
      actions.append(button);
    }
    card.append(heading, description, actions);
  } catch {
    if (request !== dashboardRequest || currentView !== 'dashboard' || workspace.hidden) return;
    const message = document.createElement('p');
    message.textContent = t('networkError');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'secondary-button';
    retry.textContent = t('retry');
    retry.addEventListener('click', () => renderDashboard(content));
    card.replaceChildren(message, retry);
  }
}

function closeDrawer(restoreFocus = true) {
  const wasOpen = sidebar.classList.contains('drawer-open');
  sidebar.classList.remove('drawer-open');
  backdrop.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
  syncDrawerAccess();
  if (wasOpen && restoreFocus) menuButton.focus();
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
byId('close-menu').addEventListener('click', () => closeDrawer());
backdrop.addEventListener('click', () => closeDrawer());
window.addEventListener('resize', syncDrawerAccess);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (!accountMenu.hidden) { closeAccount(); accountButton.focus(); return; }
  if (sidebar.classList.contains('drawer-open')) closeDrawer();
});
byId('collapse-nav').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 760px)').matches) { closeDrawer(); return; }
  const collapsed = sidebar.classList.toggle('collapsed');
  document.body.classList.toggle('seller-nav-collapsed', collapsed);
  byId('collapse-nav').dataset.i18nAria = collapsed ? 'expand' : 'collapse';
  byId('collapse-nav').setAttribute('aria-label', t(collapsed ? 'expand' : 'collapse'));
  byId('collapse-nav').setAttribute('aria-expanded', String(!collapsed));
});
function focusRouteChange() {
  window.scrollTo(0, 0);
  byId('page-title').focus({ preventScroll: true });
}
window.addEventListener('hashchange', () => {
  if (workspace.hidden) return;
  if (viewFromHash() === currentView) return;
  if (!confirmLeave()) {
    history.replaceState(history.state, '', `#${currentView}`);
    return;
  }
  applyRoute();
  focusRouteChange();
});
window.addEventListener('beforeunload', (event) => {
  if (!hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = '';
});
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => {
  if (navigate(button.dataset.view)) closeDrawer(false);
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
  byId('profile-username').textContent = username;
  byId('profile-role').textContent = role === 'SUPER_ADMIN' ? t('superAdmin') : role;
  byId('profile-dialog').showModal();
});
byId('check-updates-button').addEventListener('click', () => {
  updateDismissed = false;
  renderUpdateUI();
  updateActions?.check();
});
byId('install-update-button').addEventListener('click', () => updateActions?.update());
byId('later-update-button').addEventListener('click', () => {
  updateDismissed = true;
  renderUpdateUI();
  byId('page-title').focus({ preventScroll: true });
});
byId('close-profile').addEventListener('click', () => byId('profile-dialog').close());
byId('profile-dialog').addEventListener('close', () => accountButton.focus());
byId('sign-out-button').addEventListener('click', async () => {
  if (!confirmLeave()) return;
  closeAccount();
  try {
    const response = await fetch('/api/v1/seller/session', { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } });
    if (!response.ok) throw new Error('sign out failed');
    showLogin('signedOut');
  } catch {
    setWorkspaceMessage('networkError');
  }
});

byId('password-toggle').addEventListener('click', () => {
  setPasswordVisible(byId('password').type === 'password');
});

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = byId('login-submit');
  submit.disabled = true;
  setLoginMessage('');
  try {
    const response = await fetch('/api/v1/seller/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: byId('username').value, password: byId('password').value }),
    });
    if (!response.ok) {
      setLoginMessage('authError');
      return;
    }
    showWorkspace(await response.json());
  } catch {
    setLoginMessage('networkError');
  } finally {
    submit.disabled = false;
  }
});

document.addEventListener('localechange', () => {
  if (currentView === 'products' && productsPage) productsPage.refreshLocale();
  else if (ordersPage) ordersPage.refreshLocale();
  else if (settingsPage) settingsPage.refreshLocale();
  else renderView();
  document.documentElement.lang = locale();
  document.title = `${t('sellerPortal')} · Online Shopping`;
  setLoginMessage(loginMessageKey);
  setWorkspaceMessage(workspaceMessageKey);
  renderUpdateUI();
  if (byId('profile-dialog').open) byId('profile-role').textContent = role === 'SUPER_ADMIN' ? t('superAdmin') : role;
});

if (sessionHint()) {
  showLogin('loading', false);
  fetch('/api/v1/seller/session').then(async (response) => {
    if (response.ok) showWorkspace(await response.json());
    else showLogin();
  }).catch(() => showLogin('networkError'));
} else {
  showLogin();
}
