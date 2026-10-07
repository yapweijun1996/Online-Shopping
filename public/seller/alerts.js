import { t } from '../shared/i18n.js';

const PREFERENCE_KEY = 'online-shopping-seller-order-alerts';
const POLL_MS = 60_000;

function storedPreference() {
  try { return localStorage.getItem(PREFERENCE_KEY) === '1'; } catch { return false; }
}
function storePreference(value) {
  try { if (value) localStorage.setItem(PREFERENCE_KEY, '1'); else localStorage.removeItem(PREFERENCE_KEY); } catch { /* Alerts still work for this visit. */ }
}

/*
 * Shows how many orders wait for a decision: a badge on the Sales Orders menu item, a count in the
 * page title and, if the seller opts in, a browser notification when a newer order arrives.
 * It polls while the portal is open; it is not a background push service.
 */
export function createOrderAlerts({ badge, button, baseTitle, onUnauthorized }) {
  let timer = null;
  let pending = 0;
  let latestSeen = null;
  let enabled = storedPreference() && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  let running = false;

  function renderButton() {
    button.textContent = t(enabled ? 'disableOrderAlerts' : 'enableOrderAlerts');
  }
  function render() {
    badge.hidden = pending === 0;
    badge.textContent = pending > 99 ? '99+' : String(pending);
    badge.setAttribute('aria-label', t('ordersWaiting').replace('{count}', String(pending)));
    document.title = pending ? `(${pending}) ${baseTitle()}` : baseTitle();
    renderButton();
  }
  async function poll() {
    if (!running || document.hidden) return;
    try {
      const response = await fetch('/api/v1/seller/orders/summary', { cache: 'no-store' });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) return;
      const summary = await response.json();
      const isNew = latestSeen !== null && summary.latestSubmittedAt && summary.latestSubmittedAt > latestSeen;
      pending = summary.pending;
      latestSeen = summary.latestSubmittedAt || latestSeen || '';
      render();
      if (isNew && enabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(t('newOrderAlert'), { body: t('ordersWaiting').replace('{count}', String(pending)), tag: 'seller-new-order' });
      }
    } catch { /* A missed poll is retried on the next tick. */ }
  }
  const onVisible = () => { if (!document.hidden) poll(); };
  button.addEventListener('click', async () => {
    if (enabled) { enabled = false; storePreference(false); render(); return; }
    if (typeof Notification === 'undefined') { button.textContent = t('alertsUnsupported'); return; }
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    enabled = permission === 'granted';
    storePreference(enabled);
    if (!enabled) button.textContent = t('alertsBlocked'); else render();
  });
  return {
    start() {
      if (running) return;
      running = true; latestSeen = null; render();
      document.addEventListener('visibilitychange', onVisible);
      timer = setInterval(poll, POLL_MS);
      poll();
    },
    stop() {
      running = false; clearInterval(timer); timer = null; pending = 0; latestSeen = null;
      document.removeEventListener('visibilitychange', onVisible);
      render();
    },
    refresh: render,
    /* Called after the seller decides an order so the count updates without waiting for the next poll. */
    poll,
  };
}
