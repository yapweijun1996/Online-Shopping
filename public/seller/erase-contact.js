import './ops-copy.js';
import { containDialogFocus } from '../shared/modal.js';
import { t } from '../shared/i18n.js';

const node = (tag, className = '', text = '') => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; };

/* Modal that asks the seller to type the order number before the order's buyer contact data is erased for good.
   `send(body)` posts the erase request; it resolves with the updated order or rejects with { status, code }. */
export function openEraseDialog({ order, trigger, send, onErased, onStale }) {
  const dialog = node('dialog', 'decision-dialog erase-dialog');
  const form = node('form', 'erase-form');
  const title = node('h2', '', t('eraseContact')); title.id = 'erase-title';
  dialog.setAttribute('aria-labelledby', 'erase-title');
  const label = node('label'); label.append(node('span', '', t('eraseConfirmLabel')));
  const input = node('input'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 40; input.required = true;
  label.append(input);
  const error = node('p', 'message error'); error.setAttribute('role', 'alert');
  const actions = node('div', 'decision-actions');
  const cancel = node('button', 'secondary-button', t('cancel')); cancel.type = 'button';
  const submit = node('button', 'primary-button erase-confirm', t('eraseConfirmButton')); submit.type = 'submit'; submit.disabled = true;
  actions.append(cancel, submit);
  form.append(title, node('p', '', t('eraseIntro')), node('strong', 'order-number', order.orderNo), label, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  const matches = () => input.value.trim().toLowerCase() === order.orderNo.toLowerCase();
  input.addEventListener('input', () => { submit.disabled = !matches(); error.textContent = ''; });
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  containDialogFocus?.(dialog);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!matches()) { error.textContent = t('eraseMismatch'); return; }
    submit.disabled = true; cancel.disabled = true;
    try {
      const updated = await send({ expectedRevision: order.revision, confirmOrderNo: input.value.trim() });
      dialog.close();
      onErased(updated);
    } catch (failure) {
      if (failure.status === 401) { dialog.close(); return; }
      if (failure.status === 409 && ['STALE_REVISION', 'ALREADY_ERASED'].includes(failure.code)) { dialog.close(); onStale(); return; }
      error.textContent = failure.code === 'ORDER_NOT_FINISHED' ? t('eraseOnlyFinished') : t('eraseFailed');
      submit.disabled = !matches(); cancel.disabled = false;
    }
  });
  dialog.showModal();
  input.focus();
  return dialog;
}
