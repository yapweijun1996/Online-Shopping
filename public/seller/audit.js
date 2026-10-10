import { formatDate, t, translate } from '../shared/i18n.js';
import { statusKey } from './order-status-label.js';
import './trail-copy.js';
import './ops-copy.js';

const STATUSES = ['SUBMITTED', 'CONFIRMED', 'REJECTED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const node = (tag, className = '', text = '') => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; };
// A date input holds a local calendar day; the API takes exact UTC instants.
const startOfDay = (value) => value ? new Date(`${value}T00:00:00`).toISOString() : '';
const startOfNextDay = (value) => { if (!value) return ''; const day = new Date(`${value}T00:00:00`); day.setDate(day.getDate() + 1); return day.toISOString(); };

/* Read-only list of every order event (who did what to which order, when and why), newest first. */
export function mountAudit(root, { onUnauthorized }) {
  let active = true, items = [], nextOffset = null, requestNumber = 0, errorKey = '';
  root.replaceChildren();
  const section = node('section', 'settings-card audit-log');
  section.append(node('p', 'audit-intro', t('auditIntro')));
  const form = node('form', 'audit-filter');
  const field = (labelKey, control) => { const label = node('label'); label.append(node('span', '', t(labelKey)), control); return label; };
  const search = node('input'); search.type = 'search'; search.maxLength = 40; search.autocomplete = 'off';
  const status = node('select'), actor = node('select');
  const from = node('input'), to = node('input'); from.type = to.type = 'date';
  const submit = node('button', 'secondary-button', t('applySearch')); submit.type = 'submit';
  form.append(field('searchOrderNo', search), field('orderStatus', status), field('auditActor', actor), field('auditFrom', from), field('auditTo', to), submit);
  const message = node('p', 'message'); message.setAttribute('role', 'status');
  const list = node('ul', 'audit-list');
  const more = node('button', 'secondary-button', t('loadMore')); more.type = 'button'; more.hidden = true;
  section.append(form, message, list, more);
  root.append(section);

  function fillOptions() {
    const keep = [status.value, actor.value];
    status.replaceChildren(...[['', t('auditAnyStatus')], ...STATUSES.map((value) => [value, t(statusKey(value))])].map(([value, label]) => { const option = node('option', '', label); option.value = value; return option; }));
    actor.replaceChildren(...[['', t('auditAnyActor')], ['SELLER', t('auditActorSeller')], ['GUEST', t('auditActorBuyer')]].map(([value, label]) => { const option = node('option', '', label); option.value = value; return option; }));
    status.value = keep[0] || ''; actor.value = keep[1] || '';
  }
  fillOptions();

  const who = (event) => event.actorType === 'SELLER' ? event.actorId : t('guestBuyer');
  function render() {
    list.replaceChildren(...items.map((event) => {
      const li = node('li', 'audit-row');
      const time = node('time', 'audit-time', formatDate(event.occurredAt)); time.dateTime = event.occurredAt;
      const order = node('a', 'audit-order', event.orderNo);
      order.href = `#${['SUBMITTED', 'REJECTED'].includes(event.orderStatus) ? 'orders' : 'confirmations'}/${event.orderId}`;
      const what = node('span', 'audit-event');
      if (event.type === 'CONTACT_ERASED') what.append(node('span', 'order-chip rejected', t('contactErasedChip')));
      else what.append(node('span', `order-chip ${event.status.toLowerCase()}`, t(statusKey(event.status))));
      if (event.previousStatus) what.append(node('span', 'audit-from', `← ${t(statusKey(event.previousStatus))}`));
      li.append(time, order, what, node('span', 'audit-by', who(event)));
      if (event.reason) li.append(node('span', 'audit-reason', `${t('auditReason')}: ${event.reason}`));
      return li;
    }));
    more.hidden = nextOffset === null;
    message.textContent = errorKey ? t(errorKey) : items.length ? '' : t('auditEmpty');
  }

  async function load(reset) {
    const mine = ++requestNumber;
    const offset = reset ? 0 : nextOffset;
    const params = new URLSearchParams({ limit: '30', offset: String(offset), search: search.value.trim() });
    if (status.value) params.set('status', status.value);
    if (actor.value) params.set('actor', actor.value);
    if (from.value) params.set('from', startOfDay(from.value));
    if (to.value) params.set('to', startOfNextDay(to.value));
    more.disabled = true; errorKey = '';
    try {
      const response = await fetch(`/api/v1/seller/audit-log?${params}`, { cache: 'no-store' });
      if (response.status === 401) { if (active) onUnauthorized(); return; }
      if (!response.ok) throw new Error('audit failed');
      const page = await response.json();
      if (!active || mine !== requestNumber) return;
      items = reset ? page.items : [...items, ...page.items];
      nextOffset = page.nextOffset;
    } catch { if (active && mine === requestNumber) errorKey = 'auditLoadError'; }
    if (active && mine === requestNumber) { more.disabled = false; render(); }
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); load(true); });
  for (const control of [status, actor, from, to]) control.addEventListener('change', () => load(true));
  more.addEventListener('click', () => load(false));
  load(true);
  return {
    hasUnsavedChanges: () => false,
    isBusy: () => false,
    dispose() { active = false; },
    refreshLocale() { translate(root); section.firstChild.textContent = t('auditIntro'); fillOptions(); more.textContent = t('loadMore'); render(); },
  };
}
