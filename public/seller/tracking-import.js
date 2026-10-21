import './ops-copy.js';
import './tracking-copy.js';
import { t } from '../shared/i18n.js';
import { containDialogFocus } from '../shared/modal.js';
import { beginMutation } from '../shared/update-guard.js';
import { apiUrl } from '../shared/base-path.js';
import { statusKey } from './order-status-label.js';

const node = (tag, text = '', className = '') => { const value = document.createElement(tag); value.textContent = text; if (className) value.className = className; return value; };
const fill = (key, count) => t(key).replace('{count}', count);
export function downloadTrackingCsv(csv, filename) {
  const link = node('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
export const trackingTemplate = '\uFEFFOrder number,Carrier,Tracking number,Shipped date\r\n';

export function openTrackingImport({ trigger, csrfToken, onUnauthorized, onImported, onForbidden = () => {} }) {
  const dialog = node('dialog', '', 'decision-dialog import-dialog tracking-import-dialog');
  dialog.setAttribute('aria-labelledby', 'tracking-import-title');
  const title = node('h2', t('trackingImport')); title.id = 'tracking-import-title';
  const file = node('input'); file.type = 'file'; file.accept = '.csv,text/csv';
  const label = node('label'); label.append(node('span', t('importChoose')), file);
  const status = node('p', '', 'message'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const result = node('div', '', 'import-result');
  const actions = node('div', '', 'decision-actions');
  const button = (key, handler) => { const value = node('button', t(key), 'secondary-button'); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const close = button('close', () => dialog.close());
  const preview = button('trackingPreview', () => run(false));
  const commit = button('importConfirm', () => run(true)); commit.className = 'primary-button';
  const report = button('trackingReport', () => downloadTrackingCsv(plan.reportCsv, 'tracking-report.csv'));
  const previous = button('trackingPrevious', () => { page--; show(); });
  const next = button('trackingNext', () => { page++; show(); });
  actions.append(close, preview, report, commit);
  dialog.append(title, node('p', t('trackingIntro')), label, status, result, previous, next, actions);
  document.body.append(dialog); containDialogFocus(dialog);
  let csv = '', plan = null, busy = false, unknownFinish = null, page = 0, generation = 0;
  const notify = () => document.dispatchEvent(new Event('updateguardchange'));
  function controls() {
    const offline = navigator.onLine === false;
    file.disabled = busy || Boolean(unknownFinish); close.disabled = busy || Boolean(unknownFinish);
    preview.disabled = busy || offline || !csv;
    commit.hidden = !plan || Boolean(plan.requiresPreview) || Boolean(plan.applied) || plan.summary.errors > 0 || plan.summary.ship === 0 || Boolean(unknownFinish);
    commit.disabled = busy || offline;
    report.hidden = !plan; report.disabled = busy;
    previous.hidden = !plan || page === 0; next.hidden = !plan || (page + 1) * 50 >= plan.rows.length;
    previous.disabled = next.disabled = busy;
  }
  function show() {
    result.replaceChildren();
    if (plan) {
      const summary = node('p', `${fill('trackingShipCount', plan.summary.ship)} · ${fill('importUnchanged', plan.summary.unchanged)} · ${fill('importErrors', plan.summary.errors)}`, 'import-summary');
      const labels = { orderNo: 'trackingOrder', carrier: 'carrier', trackingNo: 'trackingNumberLabel', shippedDate: 'trackingShippedDate' };
      for (const [field, source] of Object.entries(plan.sourceHeaders ?? {})) result.append(node('p', `${t('trackingSource')}: ${t(labels[field])} ← ${source}`));
      if (plan.ignoredColumns?.length) result.append(node('p', `${t('trackingIgnored')}: ${plan.ignoredColumns.join(', ')}`));
      const table = node('table');
      const head = node('tr'); for (const key of ['importLine', 'trackingOrder', 'trackingImport']) head.append(node('th', key === 'importLine' ? '#' : t(key))); table.append(head);
      for (const row of plan.rows.slice(page * 50, (page + 1) * 50)) {
        const line = node('tr');
        line.append(node('td', String(row.line)), node('td', row.orderNo));
        const info = node('td', `${t(row.action === 'ship' ? 'shipOrder' : `importAction_${row.action}`)} · ${row.carrier} · ${row.trackingNo}`);
        for (const error of row.errors) info.append(node('p', `${error.code}: ${error.message}`, 'import-error'));
        for (const warning of row.warnings) info.append(node('p', warning));
        for (const change of row.changes) {
          const label = { status: 'orderStatus', carrier: 'carrier', trackingNo: 'trackingNumberLabel' }[change.field];
          const value = (text) => text == null ? '–' : change.field === 'status' ? t(statusKey(text)) : text;
          info.append(node('p', `${t(label)}: ${value(change.from)} → ${value(change.to)}`));
        }
        line.append(info); table.append(line);
      }
      result.append(summary, table);
      const firstErrors = plan.rows.filter((row) => row.errors.length).slice(0, 5);
      if (firstErrors.length) result.prepend(node('p', firstErrors.map((row) => `#${row.line} ${row.orderNo}: ${row.errors.map((e) => e.code).join(', ')}`).join(' · '), 'import-error'));
    }
    controls();
  }
  async function run(apply) {
    if (busy || !csv || navigator.onLine === false || (apply && (!plan || plan.requiresPreview || plan.applied || plan.summary.errors || !plan.summary.ship || unknownFinish))) return;
    busy = true; controls(); notify();
    const finish = beginMutation();
    try {
      const response = await fetch(apiUrl('v1/seller/orders/tracking-import'), { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() }, body: JSON.stringify({ csv, commit: apply, ...(apply ? { planHash: plan.planHash, expectedRevisions: plan.expectedRevisions } : {}) }) });
      if (!dialog.open) return;
      if (response.status >= 500) throw new Error('Unknown server outcome');
      if (response.status === 401) { unknownFinish?.(); unknownFinish = null; busy = false; dialog.close(); onUnauthorized(); return; }
      if (response.status === 403) { unknownFinish?.(); unknownFinish = null; busy = false; dialog.close(); onForbidden(); return; }
      const data = await response.json();
      if (!dialog.open) return;
      if (!response.ok) {
        plan = null;
        status.textContent = data.error?.message || t('importFailed');
        // A conflict response is diagnostic, never a replacement authorisation to commit without preview.
        if (data.rows) plan = { ...data, requiresPreview: true };
        show(); return;
      }
      unknownFinish?.(); unknownFinish = null;
      plan = data; page = 0; show();
      status.textContent = apply ? fill('trackingDone', data.applied.shipped) : '';
      if (apply) {
        commit.hidden = true;
        document.dispatchEvent(new Event('ordersdecided'));
        onImported(data);
      }
    } catch {
      if (!dialog.open) return;
      plan = null; show();
      status.textContent = t(apply ? 'trackingUnknown' : 'importFailed');
      if (apply && !unknownFinish) unknownFinish = beginMutation();
    } finally { finish(); busy = false; controls(); notify(); }
  }
  file.addEventListener('change', async () => {
    const current = ++generation; csv = ''; plan = null; page = 0; show(); status.textContent = '';
    const chosen = file.files?.[0]; if (!chosen) return;
    if (chosen.size > 1_500_000) { status.textContent = t('importBadFile'); return; }
    busy = true; controls(); notify();
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(await chosen.arrayBuffer()); if (current !== generation || !dialog.open) return; csv = text; }
    catch { status.textContent = t('importBadFile'); }
    finally { busy = false; controls(); notify(); }
    if (csv) await run(false);
  });
  dialog.addEventListener('cancel', (event) => { if (busy || unknownFinish) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    ++generation; csv = ''; plan = null; file.value = ''; unknownFinish?.(); unknownFinish = null;
    window.removeEventListener('online', controls); window.removeEventListener('offline', controls);
    dialog.remove(); if (trigger?.isConnected) trigger.focus(); notify();
  });
  window.addEventListener('online', controls); window.addEventListener('offline', controls);
  dialog.isBusy = () => busy || Boolean(unknownFinish);
  dialog.dispose = () => { busy = false; dialog.close(); };
  controls(); dialog.showModal(); file.focus(); notify();
  return dialog;
}
