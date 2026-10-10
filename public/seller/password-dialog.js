import './ops-copy.js';
import { containDialogFocus } from '../shared/modal.js';
import { t } from '../shared/i18n.js';

const node = (tag, className = '', text = '') => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; };

/* Change-password dialog. `forced` is the temporary-password case: it cannot be dismissed, because nothing else works
   until the password is replaced. Resolves through onDone; a 401 goes to onUnauthorized. */
export function openPasswordDialog({ forced = false, csrfToken, onDone, onUnauthorized, trigger = null }) {
  const dialog = node('dialog', 'decision-dialog password-dialog');
  dialog.setAttribute('aria-labelledby', 'password-title');
  const form = node('form', 'password-form');
  const title = node('h2', '', t('changePassword')); title.id = 'password-title';
  const field = (labelKey, autocomplete) => {
    const label = node('label'); label.append(node('span', '', t(labelKey)));
    const input = node('input'); input.type = 'password'; input.required = true; input.maxLength = 256; input.autocomplete = autocomplete;
    label.append(input);
    return { label, input };
  };
  const current = field('currentPassword', 'current-password'), next = field('newPassword', 'new-password'), repeat = field('confirmNewPassword', 'new-password');
  const error = node('p', 'message error'); error.setAttribute('role', 'alert');
  const actions = node('div', 'decision-actions');
  const submit = node('button', 'primary-button', t('passwordSave')); submit.type = 'submit';
  if (!forced) { const cancel = node('button', 'secondary-button', t('cancel')); cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close()); actions.append(cancel); }
  actions.append(submit);
  form.append(title, node('p', '', t(forced ? 'passwordForcedIntro' : 'passwordChangeIntro')), current.label, next.label, repeat.label, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  containDialogFocus(dialog);
  if (forced) dialog.addEventListener('cancel', (event) => event.preventDefault());   // Escape does not close it
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (next.input.value !== repeat.input.value) { error.textContent = t('passwordsDiffer'); repeat.input.focus(); return; }
    submit.disabled = true; error.textContent = '';
    try {
      const response = await fetch('/api/v1/seller/account/password', { method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() }, body: JSON.stringify({ currentPassword: current.input.value, newPassword: next.input.value }) });
      if (response.status === 401) { dialog.close(); onUnauthorized(); return; }
      if (response.ok) { dialog.close(); onDone(); return; }
      const code = (await response.json().catch(() => ({}))).error?.code;
      error.textContent = t(code === 'WRONG_PASSWORD' ? 'wrongPassword' : code === 'INVALID_INPUT' ? 'passwordRejected' : 'teamSaveError');
      if (code === 'WRONG_PASSWORD') current.input.focus();
    } catch { error.textContent = t('teamSaveError'); }
    submit.disabled = false;
  });
  dialog.showModal();
  current.input.focus();
  return dialog;
}
