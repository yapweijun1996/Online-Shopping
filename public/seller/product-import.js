import './ops-copy.js';
import { containDialogFocus } from '../shared/modal.js';
import { t } from '../shared/i18n.js';

const node = (tag, className = '', text = '') => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; };
const field = (name) => { const text = t(`historyField_${name}`); return !text || text === `historyField_${name}` ? name : text; };
const FILL = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key));

function valueText(field, value) {
  if (value === null || value === undefined) return field === 'stockQuantity' ? t('historyUnlimited') : '–';
  if (field === 'active') return t(value ? 'active' : 'inactive');
  if (field === 'priceMinor') return (value / 100).toFixed(2);
  return String(value);
}

/* Import dialog: choose a file, see exactly what would happen, then confirm. `post(body)` returns the server's answer or
   rejects with { status, data }; nothing is written until "Import now" is pressed and the server found no error. */
export function openImportDialog({ post, trigger, onImported, onUnauthorized }) {
  const dialog = node('dialog', 'decision-dialog import-dialog');
  dialog.setAttribute('aria-labelledby', 'import-title');
  const title = node('h2', '', t('importCsv')); title.id = 'import-title';
  const file = node('input'); file.type = 'file'; file.accept = '.csv,text/csv';
  const label = node('label'); label.append(node('span', '', t('importChoose')), file);
  const status = node('p', 'message'); status.setAttribute('role', 'status');
  const result = node('div', 'import-result');
  const actions = node('div', 'decision-actions');
  const close = node('button', 'secondary-button', t('close')); close.type = 'button';
  const confirm = node('button', 'primary-button', t('importConfirm')); confirm.type = 'button'; confirm.hidden = true;
  actions.append(close, confirm);
  dialog.append(title, node('p', '', t('importIntro')), label, status, result, actions);
  document.body.append(dialog);
  containDialogFocus(dialog);
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  let csv = '', busy = false;

  function show(plan) {
    const { create, update, unchanged, errors } = plan.summary;
    const summary = node('p', 'import-summary');
    summary.append(...[['importNew', { count: create }], ['importUpdated', { count: update }], ['importUnchanged', { count: unchanged }], ['importErrors', { count: errors }]]
      .map(([key, values]) => node('span', `import-count${key === 'importErrors' && errors ? ' has-errors' : ''}`, FILL(key, values))));
    const list = node('ul', 'import-rows');
    for (const row of plan.rows) {
      const item = node('li', `import-row is-${row.action}`);
      item.append(node('strong', '', `${FILL('importLine', { line: row.line })} · ${row.sku || '–'} · ${t(`importAction_${row.action}`)}`));
      for (const failure of row.errors) item.append(node('span', 'import-error', `${field(failure.field)}: ${failure.code === 'INVALID' ? failure.message : t(`importErr_${failure.code}`)}`));
      for (const change of row.changes) item.append(node('span', 'import-change', row.action === 'create'
        ? `${field(change.field)}: ${valueText(change.field, change.to)}`
        : `${field(change.field)}: ${valueText(change.field, change.from)} → ${valueText(change.field, change.to)}`));
      list.append(item);
    }
    result.replaceChildren(summary, list, ...(plan.hiddenRows ? [node('p', 'shop-note', FILL('importMore', { count: plan.hiddenRows }))] : []));
    const nothing = !create && !update && !errors;
    status.textContent = nothing ? t('importNothing') : '';
    confirm.hidden = Boolean(errors) || create + update === 0;
  }

  async function run(commit) {
    if (busy) return;
    busy = true; confirm.disabled = true; file.disabled = true;
    try {
      const answer = await post({ csv, commit });
      if (commit) { dialog.close(); onImported(answer.summary); return; }
      status.textContent = ''; show(answer);
    } catch (failure) {
      if (failure.status === 401) { dialog.close(); onUnauthorized(); return; }
      if (failure.data?.rows) { show(failure.data); status.textContent = t('importFailed'); }
      else { result.replaceChildren(); confirm.hidden = true; status.textContent = t(failure.status === 400 ? 'importBadFile' : 'importFailed'); }
    } finally { busy = false; confirm.disabled = false; file.disabled = false; }
  }
  file.addEventListener('change', async () => {
    result.replaceChildren(); confirm.hidden = true; status.textContent = '';
    const chosen = file.files?.[0];
    if (!chosen) return;
    if (chosen.size > 1_500_000) { status.textContent = t('importBadFile'); return; }
    status.textContent = t('importReading');
    csv = await chosen.text();
    await run(false);
  });
  confirm.addEventListener('click', () => run(true));
  dialog.showModal();
  file.focus();
  return dialog;
}
