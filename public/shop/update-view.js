import { t } from '../shared/i18n.js';
import { registerWorker } from '../shared/pwa.js';
import { confirmModal } from '../shared/modal.js';

export function mountShopUpdates(guard) {
  const settings = document.getElementById('settings-view');
  const panel = document.createElement('section'); panel.className = 'checkout-section shop-update-settings';
  const title = document.createElement('h2');
  const version = document.createElement('p');
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const check = document.createElement('button'); check.type = 'button'; check.className = 'outline-button';
  const update = document.createElement('button'); update.type = 'button'; update.className = 'primary-button';
  panel.append(title, version, status, check, update); settings.append(panel);
  const banner = document.createElement('aside'); banner.className = 'shop-update-banner'; banner.hidden = true;
  const notice = document.createElement('span'); notice.setAttribute('role', 'status');
  const bannerUpdate = update.cloneNode(); banner.append(notice, bannerUpdate);
  document.getElementById('demo-banner').after(banner);
  let state = {}, actions;
  function render() {
    const blocked = Boolean(guard().busy);
    title.textContent = t('appUpdate');
    version.textContent = `${t('appVersion')}: ${state.current || '—'}`;
    check.textContent = t('checkUpdates'); check.disabled = state.checking || state.applying || blocked;
    status.textContent = state.statusKey ? t(state.statusKey) : '';
    update.textContent = bannerUpdate.textContent = `${t('updateApp')}${state.available ? ` · ${state.available}` : ''}`;
    update.hidden = !state.ready;
    update.disabled = bannerUpdate.disabled = state.applying || blocked;
    banner.hidden = !state.ready || document.body.dataset.shopRoute !== 'catalog';
    notice.textContent = t(state.statusKey === 'updateFailed' ? 'updateFailed' : 'updateAvailable');
  }
  check.addEventListener('click', () => actions ? actions.check() : connect());
  for (const button of [update, bannerUpdate]) button.addEventListener('click', () => actions?.update());
  document.addEventListener('localechange', render);
  document.addEventListener('updateguardchange', render);
  new MutationObserver(render).observe(document.body, { attributes: true, attributeFilter: ['data-shop-route'] });
  render();
  async function connect() {
    state.checking = true; render();
    try {
      return await registerWorker('/shop/sw.js', '/shop/', { guard, confirmUpdate: confirmModal, onState(next, commands) { state = next; actions = commands; render(); } });
    } catch { state.statusKey = 'updateFailed'; }
    finally { state.checking = false; render(); }
  }
  return connect();
}
