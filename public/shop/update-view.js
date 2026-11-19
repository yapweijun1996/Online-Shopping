import { t } from '../shared/i18n.js';
import { registerWorker } from '../shared/pwa.js';
import { confirmModal } from '../shared/modal.js';
import { APP_VERSION } from './version.js';
import { createTopbarUpdate, topbarMode } from '../shared/topbar-update.js';

export function mountShopUpdates(guard) {
  const settings = document.getElementById('settings-view');
  const panel = document.createElement('section'); panel.className = 'checkout-section shop-update-settings';
  const title = document.createElement('h2');
  const version = document.createElement('p');
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const check = document.createElement('button'); check.type = 'button'; check.className = 'outline-button';
  const update = document.createElement('button'); update.type = 'button'; update.className = 'primary-button';
  panel.append(title, version, status, check, update); settings.append(panel);
  const notice = document.createElement('p');
  notice.className = 'sr-only shop-update-status';
  notice.setAttribute('role', 'status');
  document.body.append(notice);
  let state = {}, actions;
  const topbarUpdate = createTopbarUpdate({ update: () => actions?.update(), retry: () => actions?.check() });
  topbarUpdate.element.id = 'topbar-update';
  const account = document.querySelector('.shop-topbar .shop-account');
  const productView = document.getElementById('product-view');
  const mobile = matchMedia('(max-width: 760px)');
  function placeUpdate() {
    const navigation = mobile.matches && document.body.dataset.shopRoute === 'product'
      ? productView.querySelector('.product-navigation')
      : null;
    if (topbarUpdate.element.parentElement === (navigation || account.parentElement)) return;
    if (navigation) navigation.insertBefore(topbarUpdate.element, navigation.querySelector('.product-share'));
    else account.before(topbarUpdate.element);
  }
  function render() {
    const mode = topbarMode(state);
    topbarUpdate.render(mode, mode === 'failed' ? { short: t('retry'), full: t('updateFailed') } : mode === 'busy' ? { short: t('appUpdating'), full: t('appUpdating') }
      : { short: t('updateApp'), full: `${t('updateAvailable')}${state.available ? ` · ${state.available}` : ''}` });
    const blocked = Boolean(guard().busy);
    title.textContent = t('appUpdate');
    version.textContent = `${t('appVersion')}: Shop ${APP_VERSION}`;
    check.textContent = t('checkUpdates'); check.disabled = state.checking || state.applying || blocked;
    const statusText = state.statusKey ? t(state.statusKey) : '';
    if (status.textContent !== statusText) status.textContent = statusText;
    if (notice.textContent !== statusText) notice.textContent = statusText;
    const updateText = `${t('updateApp')}${state.available ? ` · ${state.available}` : ''}`;
    update.textContent = updateText;
    update.hidden = !state.ready;
    update.disabled = state.applying || blocked;
  }
  check.addEventListener('click', () => actions ? actions.check() : connect());
  update.addEventListener('click', () => actions?.update());
  document.addEventListener('localechange', render);
  document.addEventListener('updateguardchange', render);
  const placementObserver = new MutationObserver(placeUpdate);
  placementObserver.observe(document.body, { attributes: true, attributeFilter: ['data-shop-route'] });
  placementObserver.observe(productView, { childList: true });
  mobile.addEventListener('change', placeUpdate);
  placeUpdate();
  render();
  async function connect() {
    state.checking = true; render();
    try {
      return await registerWorker('./sw.js', './', { currentVersion: APP_VERSION, guard, confirmUpdate: confirmModal, onState(next, commands) { state = next; actions = commands; render(); } });
    } catch { state.statusKey = 'updateFailed'; }
    finally { state.checking = false; render(); }
  }
  return connect();
}
