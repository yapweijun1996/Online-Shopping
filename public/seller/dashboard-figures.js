import { apiUrl } from '../shared/base-path.js';
import './ops-copy.js';
import { formatMoney, t } from '../shared/i18n.js';

const node = (tag, className = '', text = '') => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; };

/* Sales figures for the dashboard. Each currency gets its own line: amounts in different currencies are never added. */
export function mountFigures({ isCurrent, onUnauthorized }) {
  const section = node('section', 'dashboard-figures');
  const header = node('div', 'dashboard-panel-header');
  header.append(node('h2', '', t('figuresTitle')), node('p', '', t('figuresIntro')));
  const body = node('div', 'dashboard-figures-body', t('loading'));
  body.setAttribute('role', 'status');
  body.setAttribute('aria-live', 'polite');
  section.append(header, body);

  const card = (labelKey, content) => {
    const element = node('section', 'dashboard-stat');
    element.append(node('p', '', t(labelKey)), content);
    return element;
  };
  const amounts = (rows) => {
    const list = node('ul', 'figure-amounts');
    if (!rows.length) list.append(node('li', 'figure-empty', t('noSales')));
    for (const row of rows) list.append(node('li', '', formatMoney(row.totalMinor, row.currency)));
    return list;
  };
  const number = (value) => node('strong', '', String(value));

  async function load() {
    body.textContent = t('loading');
    try {
      const response = await fetch(apiUrl('v1/seller/dashboard'), { cache: 'no-store' });
      if (response.status === 401) { if (isCurrent()) onUnauthorized(); return; }
      if (!response.ok) throw new Error('figures failed');
      const data = await response.json();
      if (!isCurrent()) return;
      const stats = node('div', 'dashboard-stats');
      stats.append(card('ordersToday', number(data.ordersToday)), card('pendingOrders', number(data.pending)),
        card('salesToday', amounts(data.salesToday)), card('salesLast30', amounts(data.salesWindow)));
      const top = node('div', 'figure-top');
      top.append(node('h3', '', t('topProducts')));
      const list = node('ol', 'figure-top-list');
      if (!data.topProducts.length) list.append(node('li', 'figure-empty', t('noSales')));
      for (const item of data.topProducts) {
        const row = node('li');
        row.append(node('strong', '', item.name), node('span', '', `${item.sku} · ${t('unitsSold').replace('{count}', item.quantity)} · ${formatMoney(item.totalMinor, item.currency)}`));
        list.append(row);
      }
      top.append(list);
      body.replaceChildren(stats, top);
    } catch {
      if (!isCurrent()) return;
      const retry = node('button', 'secondary-button', t('retry'));
      retry.type = 'button';
      retry.addEventListener('click', load);
      body.replaceChildren(node('p', 'dashboard-error', t('figuresLoadError')), retry);
    }
  }
  load();
  return section;
}
