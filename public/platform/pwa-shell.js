import { registerWorker } from './shared/pwa.js';
import { icon } from './shared/icons.js';
import { createTopbarUpdate } from './shared/topbar-update.js';
import { APP_VERSION } from './version.js';
import { APP_STATES, appState, bannerState, initialFlags, reduceWorkerState } from './app-state.js';

export { APP_STATES, appState };
const root = document.documentElement;
const flags = initialFlags(navigator.onLine === false);
let actions = null, statusLine = null, versionLine = null, checkButton = null, updateButton = null, barUpdate = null, menuStatus = null, menuButton = null, menuVersion = null, region = null, loader = null, lastState = '';
const state = () => appState(flags);

const make = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const action = (label, handler, className = 'secondary-button') => { const node = make('button', label, className); node.type = 'button'; node.addEventListener('click', handler); return node; };

function render() {
  const current = state(), shown = bannerState(flags), identity = flags.available || 'ready';
  root.dataset.appState = current;
  if (!region) return;
  const showBanner = shown !== null;
  region.hidden = !showBanner;
  region.dataset.state = shown || current;
  const message = region.querySelector('.app-status-message'), buttons = region.querySelector('.app-status-actions');
  buttons.replaceChildren();
  if (shown === 'OFFLINE') message.textContent = 'You are offline. Shops and changes need a connection; nothing is saved while offline.';
  else if (shown === 'UPDATE_AVAILABLE') {
    message.textContent = `A new version is available${flags.available ? ` (${flags.available})` : ''}.`;
    buttons.append(action('Update now', () => actions?.update(), 'primary-button'), action('Later', () => { flags.dismissed = identity; render(); }));
  } else if (shown === 'UPDATE_FAILED') {
    message.textContent = 'The update could not be installed. You can keep working in this version.';
    buttons.append(action('Try again', () => { flags.failed = false; render(); actions?.check(); }, 'primary-button'), action('Dismiss', () => { flags.failed = false; render(); }));
  } else if (shown === 'ERROR') {
    message.textContent = `Offline mode is unavailable: ${flags.workerError}`;
    buttons.append(action('Dismiss', () => { flags.workerError = ''; render(); }));
  }
  const busy = current === 'UPDATING' || current === 'RELOADING';
  loader.hidden = !busy;
  loader.setAttribute('aria-busy', String(busy));
  loader.querySelector('.app-loader-text').textContent = current === 'RELOADING' ? 'Reloading the updated version…' : 'Installing the latest version…';
  // Nothing behind the loader can be used while the update activates, so a second request cannot be started.
  document.querySelector('#main')?.toggleAttribute('inert', busy);
  document.querySelector('#sidebar')?.toggleAttribute('inert', busy);
  if (versionLine) versionLine.textContent = `App version: ${APP_VERSION}`;
  if (checkButton) checkButton.disabled = busy || flags.checking || !actions;
  if (updateButton) updateButton.hidden = current !== 'UPDATE_AVAILABLE';
  if (barUpdate) {
    const mode = current === 'UPDATE_FAILED' ? 'failed' : busy ? 'busy' : current === 'UPDATE_AVAILABLE' ? 'ready' : 'idle';
    barUpdate.render(mode, mode === 'failed' ? { short: 'Retry', full: 'Update failed, try again' } : busy ? { short: 'Updating…', full: 'Updating' } : { short: 'Update', full: `Update available${flags.available ? ` (${flags.available})` : ''}` });
    // A new update must be seen: bring the (smart) top bar back.
    if (mode === 'ready' && lastState !== current) document.querySelector('.topbar')?.classList.remove('topbar-hidden');
  }
  if (menuButton) {
    // Account menu: version, a one-line result, and one action that checks or, when a version is waiting, updates.
    menuVersion.textContent = `App version ${APP_VERSION}`;
    menuButton.disabled = busy || flags.checking || !actions;
    menuButton.querySelector('.menu-update-label').textContent = current === 'UPDATE_AVAILABLE' ? `Update now${flags.available ? ` (${flags.available})` : ''}` : flags.checking ? 'Checking…' : 'Check for updates';
    menuStatus.textContent = flags.checking ? 'Checking for a new version…' : current === 'UPDATE_AVAILABLE' ? 'A new version is ready.' : current === 'UPDATE_FAILED' ? 'The check failed. Try again.' : flags.checked ? 'This is the latest version.' : '';
  }
  lastState = current;
  if (statusLine) statusLine.textContent = current === 'UPDATE_AVAILABLE' ? 'A new version is ready to install.' : current === 'UPDATE_FAILED' ? 'The update check failed. Try again.' : flags.checked ? 'This is the latest version.' : '';
  document.documentElement.style.setProperty('--app-banner-height', showBanner ? `${region.offsetHeight}px` : '0px');
}

function buildChrome() {
  region = make('div', undefined, 'app-status'); region.setAttribute('role', 'status'); region.setAttribute('aria-live', 'polite'); region.hidden = true;
  region.append(make('p', undefined, 'app-status-message'), make('div', undefined, 'app-status-actions'));
  loader = make('div', undefined, 'app-loader'); loader.setAttribute('role', 'status'); loader.setAttribute('aria-live', 'assertive'); loader.hidden = true;
  const card = make('div', undefined, 'app-loader-card'); card.append(make('span', undefined, 'app-spinner'), make('strong', 'Updating Shop platform'), make('span', undefined, 'app-loader-text'));
  card.firstChild.setAttribute('aria-hidden', 'true'); loader.append(card);
  document.body.append(region, loader);
  const account = document.querySelector('.topbar .account-wrap');
  if (account) {
    barUpdate = createTopbarUpdate({ update: () => actions?.update(), retry: () => { flags.failed = false; render(); actions?.check(); } });
    barUpdate.element.id = 'topbar-update'; account.before(barUpdate.element);
  }
}

// Hide on scroll down, reveal on scroll up (cumulative 8 px threshold), always shown near the top or while the bar is in use.
function initSmartTopBar() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  let last = scrollY, travel = 0;
  const inUse = () => bar.contains(document.activeElement) || document.querySelector('#sidebar.drawer-open, #account-menu:not([hidden]), dialog[open]');
  addEventListener('scroll', () => {
    const y = scrollY, delta = y - last; last = y;
    if (y <= 48 || inUse()) { travel = 0; bar.classList.remove('topbar-hidden'); return; }
    travel = Math.sign(travel) === Math.sign(delta) ? travel + delta : delta;
    if (travel > 8) bar.classList.add('topbar-hidden'); else if (travel < -8) bar.classList.remove('topbar-hidden');
  }, { passive: true });
  addEventListener('focusin', () => { if (bar.contains(document.activeElement)) bar.classList.remove('topbar-hidden'); });
}

// A contextual button that appears only after about one viewport of scrolling.
function initScrollTop() {
  const button = make('button', undefined, 'scroll-top'); button.type = 'button'; button.hidden = true; button.setAttribute('aria-label', 'Back to top'); button.append(icon('up'));
  button.addEventListener('click', () => scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  document.body.append(button);
  const update = () => { button.hidden = scrollY < innerHeight; };
  addEventListener('scroll', update, { passive: true }); addEventListener('resize', update); update();
}

// Registers the worker and wires the visible update lifecycle. `guard` reports unsaved edits or a request in flight; an
// update is never applied without the user choosing "Update now" (no autoUpdate).
export function initPwaShell({ guard, confirmUpdate } = {}) {
  buildChrome(); render();
  addEventListener('online', () => { flags.offline = false; render(); });
  addEventListener('offline', () => { flags.offline = true; render(); });
  initSmartTopBar(); initScrollTop();
  // Phones keep tabs open for days: look for a new version regularly while the page is visible, not only on start.
  setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) actions?.check(); }, 10 * 60_000);
  if (!('serviceWorker' in navigator)) { flags.workerError = 'this browser has no Service Worker support.'; render(); return; }
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (flags.applying) { flags.reloading = true; render(); } });
  registerWorker('./sw.js', './', {
    currentVersion: APP_VERSION, guard, confirmUpdate,
    onState(workerState, controls) {
      actions = controls; Object.assign(flags, reduceWorkerState(flags, workerState)); render();
    },
  }).catch((error) => { flags.workerError = error?.message || 'the Service Worker could not be registered.'; render(); });
}

// First screen rendered (sign-in or the shop list): STARTING becomes READY.
export function markReady() { flags.booted = true; render(); }

// "Check for updates" in the top bar Account menu. The menu stays open so the result can be read where the action was taken.
export function mountMenuUpdate(menu) {
  const box = make('div', undefined, 'menu-update'); box.dataset.keepOpen = 'true';
  menuVersion = make('p', undefined, 'menu-update-version'); menuStatus = make('p', undefined, 'menu-update-status'); menuStatus.setAttribute('role', 'status');
  menuButton = action('Check for updates', async () => { if (appState(flags) === 'UPDATE_AVAILABLE') { actions?.update(); return; } flags.checked = false; render(); await actions?.check(); }, 'menu-update-button');
  menuButton.replaceChildren(icon('download'), make('span', 'Check for updates', 'menu-update-label'));
  box.append(menuVersion, menuButton, menuStatus); menu.append(box); render();
}

// "App version" row for the Account screen: version, status and a manual update check.
export function mountAppSection(parent) {
  const section = make('section', undefined, 'edit-card');
  versionLine = make('p', undefined, 'edit-help'); statusLine = make('p', undefined, 'form-status'); statusLine.setAttribute('role', 'status');
  checkButton = action('Check for updates', async () => { flags.checked = false; render(); await actions?.check(); }, 'secondary-button');
  checkButton.disabled = !actions;
  // Dismissing the banner with "Later" must not lose the option: the update stays available here.
  updateButton = action('Update now', () => actions?.update(), 'primary-button'); updateButton.hidden = true;
  section.append(make('h3', 'App version'), versionLine, checkButton, updateButton, statusLine); parent.append(section); render();
}

// Compact signed-out footer uses the same update state and guarded activation as the Account page.
export function mountSignInUpdate(parent) {
  const footer = make('footer', undefined, 'login-footer');
  versionLine = make('span', undefined, 'login-footer-version');
  statusLine = make('span', undefined, 'login-footer-status'); statusLine.setAttribute('role', 'status');
  const controls = make('span', undefined, 'login-footer-update');
  checkButton = action('Check for updates', async () => { flags.checked = false; render(); await actions?.check(); }, 'login-footer-action');
  updateButton = action('Update now', () => actions?.update(), 'login-footer-action'); updateButton.hidden = true;
  controls.append(statusLine, checkButton, updateButton); footer.append(versionLine, controls); parent.append(footer); render();
}
