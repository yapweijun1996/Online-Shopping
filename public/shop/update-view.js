import { t } from '../shared/i18n.js';
import { registerWorker } from '../shared/pwa.js';
import { confirmModal } from '../shared/modal.js';
import { APP_VERSION } from './version.js';

export function mountShopUpdates(guard, productBanner) {
  const settings = document.getElementById('settings-view');
  const panel = document.createElement('section'); panel.className = 'checkout-section shop-update-settings';
  const title = document.createElement('h2');
  const version = document.createElement('p');
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const check = document.createElement('button'); check.type = 'button'; check.className = 'outline-button';
  const update = document.createElement('button'); update.type = 'button'; update.className = 'primary-button';
  panel.append(title, version, status, check, update); settings.append(panel);
  function prepareBanner(banner) {
    const notice = document.createElement('span'); notice.setAttribute('role', 'status');
    const button = update.cloneNode();
    banner.append(notice, button);
    button.addEventListener('click', () => actions?.update());
    return { banner, notice, button };
  }
  const catalogBanner = document.createElement('aside'); catalogBanner.className = 'shop-update-banner'; catalogBanner.hidden = true;
  document.getElementById('demo-banner').after(catalogBanner);
  const banners = [prepareBanner(catalogBanner)];
  if (productBanner) banners.push(prepareBanner(productBanner));
  let state = {}, actions;
  function render() {
    const blocked = Boolean(guard().busy);
    title.textContent = t('appUpdate');
    version.textContent = `${t('appVersion')}: Shop ${APP_VERSION}`;
    check.textContent = t('checkUpdates'); check.disabled = state.checking || state.applying || blocked;
    status.textContent = state.statusKey ? t(state.statusKey) : '';
    const updateText = `${t('updateApp')}${state.available ? ` · ${state.available}` : ''}`;
    update.textContent = updateText;
    update.hidden = !state.ready;
    update.disabled = state.applying || blocked;
    for (const { banner, notice, button } of banners) {
      button.textContent = updateText;
      button.disabled = state.applying || blocked;
      banner.hidden = !state.ready || (banner === catalogBanner && document.body.dataset.shopRoute !== 'catalog');
      notice.textContent = `${t('appVersion')}: Shop ${APP_VERSION} · ${t(state.statusKey === 'updateFailed' ? 'updateFailed' : 'updateAvailable')}`;
    }
  }
  check.addEventListener('click', () => actions ? actions.check() : connect());
  update.addEventListener('click', () => actions?.update());
  document.addEventListener('localechange', render);
  document.addEventListener('updateguardchange', render);
  new MutationObserver(render).observe(document.body, { attributes: true, attributeFilter: ['data-shop-route'] });
  render();
  async function connect() {
    state.checking = true; render();
    try {
      return await registerWorker('/shop/sw.js', '/shop/', { currentVersion: APP_VERSION, guard, confirmUpdate: confirmModal, onState(next, commands) { state = next; actions = commands; render(); } });
    } catch { state.statusKey = 'updateFailed'; }
    finally { state.checking = false; render(); }
  }
  return connect();
}
