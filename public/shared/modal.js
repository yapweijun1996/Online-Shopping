import { t } from './i18n.js';

export function createModal(variant = '') {
  const dialog = document.createElement('dialog');
  dialog.className = 'app-modal';
  if (variant) dialog.classList.add(`app-modal-${variant}`);
  const header = document.createElement('header');
  const title = document.createElement('h2');
  const closeButton = document.createElement('button');
  closeButton.type = 'button'; closeButton.className = 'modal-close';
  closeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  const content = document.createElement('div'); content.className = 'modal-content';
  header.append(title, closeButton); dialog.append(header, content); document.body.append(dialog);
  let opener, onClose, closing = false;
  function close() {
    if (!dialog.open || closing) return;
    closing = true; dialog.classList.add('closing');
    const finish = () => {
      dialog.close(); dialog.classList.remove('closing'); closing = false;
      opener?.focus({ preventScroll: true }); onClose?.();
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else setTimeout(finish, 180);
  }
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  function setTitle(label) {
    title.textContent = label; dialog.setAttribute('aria-label', label);
    closeButton.setAttribute('aria-label', t('close'));
  }
  return { content, close, setTitle, get isOpen() { return dialog.open; }, open(label, afterClose) {
    if (dialog.open) return;
    opener = document.activeElement; onClose = afterClose;
    setTitle(label);
    dialog.showModal(); content.scrollTop = 0;
    (content.querySelector('[aria-pressed="true"]') || content.querySelector('button, input') || closeButton).focus();
  } };
}

export function confirmModal(message) {
  const modal = createModal('confirm');
  return new Promise(resolve => {
    let accepted = false;
    const text = document.createElement('p'); text.textContent = message;
    const actions = document.createElement('div'); actions.className = 'modal-confirm-actions';
    const cancel = document.createElement('button'); cancel.textContent = t('cancel'); cancel.type = 'button'; cancel.className = 'modal-secondary-button';
    const update = document.createElement('button'); update.textContent = t('updateApp'); update.type = 'button'; update.className = 'primary-button';
    cancel.addEventListener('click', modal.close);
    update.addEventListener('click', () => { accepted = true; modal.close(); });
    actions.append(cancel, update);
    modal.content.append(text, actions);
    modal.open(t('updateApp'), () => { modal.content.parentElement.remove(); resolve(accepted); });
  });
}
