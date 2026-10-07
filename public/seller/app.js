import { formatDate, formatMoney, locale, setupLanguageMenu, t } from '../shared/i18n.js';
import { registerWorker } from '../shared/pwa.js';
import { confirmModal, containDialogFocus } from '../shared/modal.js';
import { draftSignature, mutationsBusy } from '../shared/update-guard.js';
import { APP_VERSION } from './version.js';
import { mountDemoEntry } from '../shared/demo-entry.js';
import { createOrderAlerts } from './alerts.js';
import { snapshotCount } from './studio-copy.js';
import { mountAudit } from './audit.js';
import { mountProducts } from './products.js';
import { mountOrders } from './orders.js';
import { mountCategories, mountCompanySettings } from './settings.js';
import { mountOptions } from './options.js';
import { mountTabIcon } from '../shared/tab-icon.js';

const byId = (id) => document.getElementById(id);
containDialogFocus(byId('profile-dialog'));
const loginView = byId('login-view');
mountDemoEntry(byId('demo-entry'), { onSignedIn: () => sessionHint(true) });
const workspace = byId('workspace');
const sidebar = byId('sidebar');
const accountWrap = byId('account-wrap');
const accountButton = byId('account-button');
const accountMenu = byId('account-menu');
const menuButton = byId('open-menu');
const closeMenuButton = byId('close-menu');
const collapseNavButton = byId('collapse-nav');
const backdrop = byId('drawer-backdrop');
const main = byId('main');
const topbar = document.querySelector('.topbar');
const navTooltip = document.createElement('div');
navTooltip.className = 'sidebar-tooltip';
navTooltip.hidden = true;
document.body.append(navTooltip);
let navTooltipAnchor = null;
let csrfToken = null;
let currentView = 'dashboard';
let currentRoute = 'dashboard';
let username = '';
let role = '';
let productsPage = null;
let ordersPage = null;
let settingsPage = null;
let loginMessageKey = '';
let workspaceMessageKey = '';
let dashboardRequest = 0;
let sessionViewSequence = 0;
let updateState = null;
let updateActions = null;
let updateDismissed = false;
let updateView = null;
let updateIdentity = '';
const sessionHintKey = 'online-shopping-seller-session-hint';
mountTabIcon(window.sellerPalette);
const VALID_VIEWS = new Set(['dashboard', 'products', 'orders', 'confirmations', 'audit', 'categories', 'options', 'company']);
const PRODUCT_ROUTE = /^products\/(?:new|[0-9a-f-]{36})$/;
const ORDER_ROUTE = /^(?:orders|confirmations)\/[0-9a-f-]{36}$/;

function routeFromHash() {
  // `review` was the old address of the queue of orders waiting for a decision, which is now Sales Orders.
  const route = location.hash.slice(1).replace(/^review(?=\/|$)/, 'orders');
  return VALID_VIEWS.has(route) || PRODUCT_ROUTE.test(route) || ORDER_ROUTE.test(route) ? route : 'dashboard';
}

function viewFromRoute(route) { return route.split('/')[0]; }

function applyRoute() {
  currentRoute = routeFromHash();
  currentView = viewFromRoute(currentRoute);
  // Old `#review` links are rewritten to the Sales Orders address.
  if (location.hash.slice(1).startsWith('review')) history.replaceState(history.state, '', `#${currentRoute}`);
  renderView();
}

function activePage() {
  return currentView === 'products' ? productsPage : currentView === 'categories' || currentView === 'options' || currentView === 'company' || currentView === 'audit' ? settingsPage : currentView === 'orders' || currentView === 'confirmations' ? ordersPage : null;
}

function hasUnsavedChanges() { return activePage()?.hasUnsavedChanges?.() === true; }
function confirmLeave() { return !hasUnsavedChanges() || window.confirm(t('unsavedChangesConfirm')); }

function navigate(route) {
  if (route === currentRoute) { focusRouteChange(); return true; }
  if (!confirmLeave()) return false;
  currentRoute = route;
  currentView = viewFromRoute(route);
  location.hash = route;
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
const baseTitle = () => `${t('sellerPortal')} · Online Shopping`;
const orderAlerts = createOrderAlerts({ badge: byId('pending-badge'), button: byId('alerts-button'), baseTitle, onUnauthorized: () => showLogin('authError') });
document.title = baseTitle();
document.addEventListener('ordersdecided', () => orderAlerts.poll());
registerWorker('/seller/sw.js', '/seller/', {
  currentVersion: APP_VERSION, autoUpdate: true,
  guard: () => ({ dirty: hasUnsavedChanges(), busy: mutationsBusy() || activePage()?.isBusy?.() === true, signature: JSON.stringify([currentRoute, draftSignature(), activePage()?.draftSignature?.()]) }),
  confirmUpdate: confirmModal,
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
  const busy = mutationsBusy() || activePage()?.isBusy?.() === true;
  byId('seller-current-version').textContent = `${t('appVersion')}: Seller ${APP_VERSION}`;
  check.disabled = !updateActions || updateState?.checking === true || applying;
  byId('check-updates-status').textContent = updateState?.statusKey ? t(updateState.statusKey) : '';
  notice.hidden = !updateState?.ready || updateDismissed;
  byId('seller-update-detail').textContent = `${t('appVersion')}: Seller ${APP_VERSION} · ${t(applying ? 'appUpdating' : 'updateReadyDetail')}`;
  byId('install-update-button').textContent = `${t('installUpdate')}${updateState?.available ? ` · ${updateState.available}` : ''}`;
  byId('install-update-button').disabled = applying || busy;
  byId('later-update-button').disabled = applying;
  byId('login-version').textContent = `${t('appVersion')}: Seller ${APP_VERSION}`;
  byId('login-check-updates').disabled = check.disabled;
  byId('login-update-status').textContent = byId('check-updates-status').textContent;
  const loginInstall = byId('login-install-update');
  loginInstall.hidden = !updateState?.ready;
  loginInstall.textContent = `${t('installUpdate')}${updateState?.available ? ` · ${updateState.available}` : ''}`;
  loginInstall.disabled = applying;
}
document.addEventListener('updateguardchange', renderUpdateUI);

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
  sessionViewSequence++;
  const leavingWorkspace = !workspace.hidden;
  if (clearHint) sessionHint(false);
  csrfToken = null;
  username = '';
  role = '';
  productsPage = null;
  settingsPage = null;
  ordersPage?.dispose();
  ordersPage = null;
  orderAlerts.stop();
  byId('workspace-content').replaceChildren();
  loginView.hidden = false;
  workspace.hidden = true;
  sidebar.hidden = true;
  menuButton.hidden = true;
  accountWrap.hidden = true;
  byId('shop-context').hidden = true;
  document.body.classList.remove('seller-signed-in');
  setPasswordVisible(false);
  setLoginMessage(messageKey);
  closeDrawer(false);
  if (leavingWorkspace) byId('username').focus();
}

function showWorkspace(session) {
  sessionViewSequence++;
  sessionHint(true);
  csrfToken = session.csrfToken;
  username = session.username;
  role = session.role;
  accountButton.querySelector('.avatar').textContent = Array.from(username.trim())[0]?.toLocaleUpperCase(locale()) || '•';
  setLoginMessage('');
  setWorkspaceMessage('');
  loginView.hidden = true;
  workspace.hidden = false;
  orderAlerts.start();
  sidebar.hidden = false;
  menuButton.hidden = false;
  accountWrap.hidden = false;
  document.body.classList.add('seller-signed-in');
  const sessionToken = csrfToken;
  fetch('/api/v1/seller/setup', { cache: 'no-store' }).then(async response => {
    if (!response.ok) return;
    const setup = await response.json();
    if (workspace.hidden || csrfToken !== sessionToken) return;
    byId('shop-context').textContent = setup.shopName || t('sellerPortal');
    byId('shop-context').hidden = false;
  }).catch(() => {});
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
  const titleKey = currentView === 'products' && currentRoute !== 'products'
    ? currentRoute === 'products/new' ? 'addProduct' : 'editProduct'
    : { dashboard: 'dashboard', products: 'products', orders: 'salesOrders', confirmations: 'orderReview', audit: 'auditLog', categories: 'categoryCodes', options: 'optionsNav', company: 'companySettings' }[currentView];
  byId('page-title').dataset.i18n = titleKey;
  byId('page-title').textContent = t(titleKey);
  const content = byId('workspace-content');
  if (currentView === 'orders' || currentView === 'confirmations') {
    productsPage = null;
    settingsPage = null;
    const orderId = currentRoute.split('/')[1] || null;
    if (ordersPage?.mode !== currentView) {
      ordersPage?.dispose();
      ordersPage = mountOrders(content, {
        mode: currentView,
        csrfToken: () => csrfToken,
        onUnauthorized: () => showLogin('authError'),
        initialOrderId: orderId,
        // Keep the address in step with the open order so a refresh or a shared link returns to it.
        onSelect(id) {
          const route = id ? `${currentView}/${id}` : currentView;
          if (route === currentRoute) return;
          currentRoute = route;
          history.replaceState(history.state, '', `#${route}`);
        },
      });
    } else ordersPage.showOrder(orderId);
    return;
  }
  ordersPage?.dispose();
  ordersPage = null;
  if (currentView === 'products') {
    settingsPage = null;
    if (!productsPage) productsPage = mountProducts(content, {
      csrfToken: () => csrfToken,
      onUnauthorized: () => showLogin('authError'),
      onNavigate: navigate,
      onSaved(id) {
        currentRoute = `products/${id}`;
        history.replaceState(history.state, '', `#${currentRoute}`);
        byId('page-title').dataset.i18n = 'editProduct';
        byId('page-title').textContent = t('editProduct');
      },
    });
    productsPage.showRoute(currentRoute);
    return;
  }
  productsPage = null;
  if (currentView === 'audit') {
    settingsPage = mountAudit(content, { onUnauthorized: () => showLogin('authError') });
    return;
  }
  if (currentView === 'categories') {
    settingsPage = mountCategories(content, { csrfToken: () => csrfToken, onUnauthorized: () => showLogin('authError') });
    return;
  }
  if (currentView === 'options') {
    settingsPage = mountOptions(content, { csrfToken: () => csrfToken, onUnauthorized: () => showLogin('authError') });
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
  const node = (tag, className, value) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value) element.textContent = value;
    return element;
  };
  const isCurrent = () => request === dashboardRequest && currentView === 'dashboard' && !workspace.hidden;
  const action = (key, view, className = 'secondary-button') => {
    const button = node('button', className, t(key));
    button.type = 'button';
    button.addEventListener('click', () => navigate(view));
    return button;
  };
  const shell = node('div', 'dashboard-home');
  const loading = node('p', 'dashboard-loading', t('loading'));
  loading.setAttribute('role', 'status');
  shell.append(loading);
  content.replaceChildren(shell);
  try {
    const response = await fetch('/api/v1/seller/setup', { cache: 'no-store' });
    if (response.status === 401) { if (isCurrent()) showLogin('authError'); return; }
    if (!response.ok) throw new Error('setup failed');
    const setup = await response.json();
    if (!isCurrent()) return;
    if (!setup.mode) {
      const card = node('section', 'settings-card dashboard-card');
      card.append(node('h2', '', t('shopSetup')), node('p', '', t('setupIntro')), action('shopSetup', 'company', 'primary-button'));
      shell.replaceChildren(card);
      return;
    }

    const identity = node('section', 'dashboard-identity');
    const welcome = node('div', 'dashboard-welcome');
    welcome.append(node('div', 'dashboard-shop-name', setup.shopName || t('shop')), node('p', '', t('studioOverview')));
    identity.append(welcome,
      node('span', `dashboard-mode ${setup.mode === 'demo' ? 'is-demo' : ''}`, t(setup.mode === 'demo' ? 'dashboardSimulated' : 'dashboardProduction')));
    byId('shop-context').textContent = setup.shopName || t('sellerPortal');
    const stats = node('div', 'dashboard-stats');
    const stat = (label, value) => {
      const card = node('section', 'dashboard-stat');
      const number = node('strong', '', value);
      number.setAttribute('aria-live', 'polite');
      card.append(node('p', '', t(label)), number);
      stats.append(card);
      return number;
    };
    const orderCount = stat('dashboardSubmittedOrders', t('loading'));
    const productCount = stat('products', t('loading'));
    const currency = stat('currency', t('loading'));
    stat('shopSetup', t(setup.mode === 'demo' ? 'dashboardSimulated' : 'dashboardProduction'));
    fetch('/api/v1/seller/company-settings', { cache: 'no-store' }).then(async response => {
      if (response.status === 401) { if (isCurrent()) showLogin('authError'); return; }
      if (!response.ok) throw new Error('settings failed');
      const settings = await response.json();
      if (isCurrent()) currency.textContent = settings.defaultCurrency;
    }).catch(() => { if (isCurrent()) currency.textContent = t('networkError'); });
    const grid = node('div', 'dashboard-grid');
    shell.replaceChildren(identity, stats, node('p', 'dashboard-count-help', t('snapshotCountHelp')), grid);

    const panels = [
      {
        title: 'dashboardSubmittedOrders', intro: 'dashboardOrdersIntro',
        path: '/api/v1/seller/orders?status=SUBMITTED&limit=100', count: orderCount,
        action: 'dashboardReviewOrders', view: 'orders', empty: 'dashboardNoSubmittedOrders',
        render(item) {
          const row = node('li', 'dashboard-order-row');
          const link = node('a', 'dashboard-order-link');
          link.href = `#orders/${item.id}`;
          const thumb = node('span', 'dashboard-order-thumb');
          if (item.preview?.imageUrl) {
            const image = node('img'); image.src = item.preview.imageUrl; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
            image.addEventListener('error', () => image.remove());
            thumb.append(image);
          }
          const text = node('span', 'dashboard-order-text');
          const line = node('span', 'dashboard-row-line');
          line.append(node('strong', '', item.orderNo), node('span', 'dashboard-status', t('sellerStatusSubmitted')));
          const what = item.preview ? `${item.buyerName} · ${item.preview.name}${item.preview.itemCount > 1 ? ` +${item.preview.itemCount - 1}` : ''}` : item.buyerName;
          text.append(line, node('span', 'dashboard-row-buyer', what),
            node('span', 'dashboard-row-meta', `${formatMoney(item.totalMinor, item.currency)} · ${formatDate(item.submittedAt)}`));
          link.append(thumb, text);
          row.append(link);
          return row;
        },
      },
      {
        title: 'dashboardRecentProducts', intro: 'dashboardProductsIntro',
        path: '/api/v1/seller/products?limit=100', count: productCount,
        action: 'dashboardViewProducts', view: 'products', empty: 'noProducts',
        render(item) {
          const row = node('li', 'dashboard-product-row');
          // The row opens the product's edit page, like an order row opens its order.
          const link = node('a', 'dashboard-order-link');
          link.href = `#products/${item.id}`;
          const thumb = node('span', 'dashboard-order-thumb');
          if (item.imageUrl) {
            const image = node('img'); image.src = item.imageUrl; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
            image.addEventListener('error', () => image.remove());
            thumb.append(image);
          }
          const text = node('span', 'dashboard-order-text');
          text.append(node('strong', '', item.name), node('span', 'dashboard-row-meta', item.sku));
          link.append(thumb, text);
          row.append(link);
          return row;
        },
      },
    ];
    for (const [index, panel] of panels.entries()) {
      const section = node('section', `dashboard-panel ${index === 0 ? 'dashboard-orders' : 'dashboard-products'}`);
      const header = node('div', 'dashboard-panel-header');
      header.append(node('h2', '', t(panel.title)), node('p', '', t(panel.intro)));
      const body = node('div', 'dashboard-panel-body', t('loading'));
      body.setAttribute('role', 'status');
      body.setAttribute('aria-live', 'polite');
      section.append(header, body, action(panel.action, panel.view, index === 0 ? 'primary-button' : 'secondary-button'));
      if (index === 0 && setup.mode === 'demo') section.append(node('p', 'dashboard-simulation-note', t('dashboardSimulationNote')));
      grid.append(section);
      const load = async () => {
        body.textContent = t('loading');
        try {
          const result = await fetch(panel.path, { cache: 'no-store' });
          if (result.status === 401) { if (isCurrent()) showLogin('authError'); return; }
          if (!result.ok) throw new Error('dashboard preview failed');
          const data = await result.json();
          if (!isCurrent()) return;
          panel.count.textContent = snapshotCount(data);
          if (!Array.isArray(data.items) || !data.items.length) {
            body.replaceChildren(node('p', 'dashboard-empty', t(panel.empty)));
            return;
          }
          const list = node('ul', 'dashboard-preview-list');
          for (const item of data.items.slice(0, 3)) list.append(panel.render(item));
          body.replaceChildren(list);
        } catch {
          if (!isCurrent()) return;
          panel.count.textContent = t('networkError');
          const retry = node('button', 'secondary-button', t('retry'));
          retry.type = 'button';
          retry.addEventListener('click', load);
          body.replaceChildren(node('p', 'dashboard-error', t('networkError')), retry);
        }
      };
      load();
    }
  } catch {
    if (!isCurrent()) return;
    const message = node('p', 'dashboard-error', t('networkError'));
    const retry = node('button', 'secondary-button', t('retry'));
    retry.type = 'button';
    retry.addEventListener('click', () => renderDashboard(content));
    shell.replaceChildren(message, retry);
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
  const mobile = window.matchMedia('(max-width: 900px)').matches;
  const modalOpen = mobile && sidebar.classList.contains('drawer-open');
  sidebar.inert = mobile && !modalOpen;
  main.inert = modalOpen;
  topbar.inert = modalOpen;
  if (modalOpen) {
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    sidebar.setAttribute('aria-label', t('sellerPortal'));
  } else {
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
    sidebar.removeAttribute('aria-label');
  }
}

function showNavTooltip(button) {
  if (window.matchMedia('(max-width: 900px)').matches || !sidebar.classList.contains('collapsed')) return;
  navTooltipAnchor = button;
  navTooltip.textContent = button.getAttribute('aria-label') || '';
  navTooltip.hidden = false;
  const buttonRect = button.getBoundingClientRect();
  const tipRect = navTooltip.getBoundingClientRect();
  navTooltip.style.left = `${Math.min(buttonRect.right + 9, innerWidth - tipRect.width - 8)}px`;
  navTooltip.style.top = `${Math.max(8, Math.min(buttonRect.top + (buttonRect.height - tipRect.height) / 2, innerHeight - tipRect.height - 8))}px`;
}

function hideNavTooltip() { navTooltip.hidden = true; navTooltipAnchor = null; }
sidebar.addEventListener('transitionend', (event) => {
  if (event.propertyName === 'width' && navTooltipAnchor) showNavTooltip(navTooltipAnchor);
});

function closeAccount() {
  accountMenu.hidden = true;
  accountButton.setAttribute('aria-expanded', 'false');
}

menuButton.addEventListener('click', () => {
  closeAccount();
  sidebar.classList.add('drawer-open');
  syncDrawerAccess();
  backdrop.hidden = false;
  menuButton.setAttribute('aria-expanded', 'true');
  closeMenuButton.focus();
});
closeMenuButton.addEventListener('click', () => closeDrawer());
backdrop.addEventListener('click', () => closeDrawer());
window.addEventListener('resize', () => {
  hideNavTooltip();
  if (!window.matchMedia('(max-width: 900px)').matches && sidebar.classList.contains('drawer-open')) {
    closeDrawer(false);
    byId('page-title').focus({ preventScroll: true });
  } else syncDrawerAccess();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && sidebar.classList.contains('drawer-open') && !document.querySelector('dialog[open]')) {
    const focusables = [...sidebar.querySelectorAll('button')].filter((button) => button.getClientRects().length && !button.disabled);
    const first = focusables[0];
    const last = focusables.at(-1);
    if (event.shiftKey && (!sidebar.contains(document.activeElement) || document.activeElement === first)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (!sidebar.contains(document.activeElement) || document.activeElement === last)) {
      event.preventDefault();
      first?.focus();
    }
    return;
  }
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (!accountMenu.hidden) { closeAccount(); accountButton.focus(); return; }
  if (sidebar.classList.contains('drawer-open')) closeDrawer();
});
document.addEventListener('focusin', (event) => {
  if (sidebar.classList.contains('drawer-open') && !sidebar.contains(event.target)) closeMenuButton.focus();
});
collapseNavButton.addEventListener('mouseenter', () => showNavTooltip(collapseNavButton));
collapseNavButton.addEventListener('focus', () => showNavTooltip(collapseNavButton));
collapseNavButton.addEventListener('mouseleave', () => {
  if (document.activeElement !== collapseNavButton) hideNavTooltip();
});
collapseNavButton.addEventListener('blur', hideNavTooltip);
collapseNavButton.addEventListener('click', () => {
  const collapsed = sidebar.classList.toggle('collapsed');
  hideNavTooltip();
  document.body.classList.toggle('seller-nav-collapsed', collapsed);
  collapseNavButton.dataset.i18nAria = collapsed ? 'expand' : 'collapse';
  collapseNavButton.setAttribute('aria-label', t(collapsed ? 'expand' : 'collapse'));
  collapseNavButton.setAttribute('aria-expanded', String(!collapsed));
  if (collapsed && document.activeElement === collapseNavButton) showNavTooltip(collapseNavButton);
});
function focusRouteChange() {
  window.scrollTo(0, 0);
  byId('page-title').focus({ preventScroll: true });
}
window.addEventListener('hashchange', () => {
  if (workspace.hidden) return;
  if (routeFromHash() === currentRoute) return;
  if (!confirmLeave()) {
    history.replaceState(history.state, '', `#${currentRoute}`);
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
document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('mouseenter', () => showNavTooltip(button));
  button.addEventListener('focus', () => showNavTooltip(button));
  button.addEventListener('mouseleave', () => {
    if (document.activeElement !== button) hideNavTooltip();
  });
  button.addEventListener('blur', hideNavTooltip);
  button.addEventListener('click', () => {
    hideNavTooltip();
    if (navigate(button.dataset.view)) {
      const wasOpen = sidebar.classList.contains('drawer-open');
      closeDrawer(false);
      if (wasOpen) focusRouteChange();
    }
  });
});
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
byId('login-check-updates').addEventListener('click', () => byId('check-updates-button').click());
byId('login-install-update').addEventListener('click', () => updateActions?.update());
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
  orderAlerts.refresh();
  setLoginMessage(loginMessageKey);
  setWorkspaceMessage(workspaceMessageKey);
  renderUpdateUI();
  if (byId('profile-dialog').open) byId('profile-role').textContent = role === 'SUPER_ADMIN' ? t('superAdmin') : role;
});

if (sessionHint()) {
  showLogin('loading', false);
  const restoreView = sessionViewSequence;
  const ownsRestore = () => restoreView === sessionViewSequence;
  fetch('/api/v1/seller/session').then(async (response) => {
    if (!ownsRestore()) return;
    if (response.ok) {
      const session = await response.json();
      if (ownsRestore()) showWorkspace(session);
    }
    else showLogin();
  }).catch(() => { if (ownsRestore()) showLogin('networkError'); });
} else {
  showLogin();
}
