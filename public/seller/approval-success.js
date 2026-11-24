import { createModal } from '../shared/modal.js';
import { approvalSuccessLanguage } from './approval-success-copy.js';

const operationKeys = new Map([
  ['catalog.preview_create', 'approvalSuccessProductCreate'],
  ['catalog.preview_update', 'approvalSuccessProductUpdate'],
  ['catalog.preview_create_category', 'approvalSuccessCategory'],
  ['company.preview_update', 'approvalSuccessCompany'],
  ['inventory.preview_adjustment', 'approvalSuccessStock'],
  ['orders.preview_decision', 'approvalSuccessOrder'],
  ['media.prepare_upload', 'approvalSuccessPhoto'],
  ['media.preview_layout', 'approvalSuccessLayout'],
]);

export function showApprovalSuccess({ toolName, targetSlot, productName, galleryConfirmation, preference, onClose }) {
  const { lang, t } = approvalSuccessLanguage(preference);
  const key = galleryConfirmation ? 'approvalSuccessGalleryConfirm'
    : toolName === 'media.prepare_upload' && targetSlot === 'GALLERY' ? 'approvalSuccessGalleryAdd'
    : operationKeys.get(toolName) ?? 'approvalSuccessOperation';
  const operation = t(key);
  const modal = createModal('approval-success');
  const dialog = modal.content.parentElement;
  dialog.id = 'approval-success-dialog';
  dialog.lang = lang;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-describedby', 'approval-success-detail');
  dialog.querySelector('.modal-close').hidden = true;

  // The shared checkCircle artwork, split into strokes so the ring draws before the tick.
  dialog.insertAdjacentHTML('afterbegin', `<svg class="approval-success-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path class="approval-success-ring" pathLength="1" d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z"/>
    <path class="approval-success-tick" pathLength="1" d="M8 12l3 3 5-6"/>
  </svg>`);
  const detail = document.createElement('p');
  detail.id = 'approval-success-detail';
  detail.textContent = productName ? t('approvalSuccessWithProduct', { operation, product: productName }) : operation;
  const proceed = document.createElement('button');
  proceed.type = 'button';
  proceed.className = 'primary-button';
  proceed.textContent = t('approvalSuccessContinue');
  proceed.addEventListener('click', modal.close);
  modal.content.append(detail, proceed);
  modal.open(t('approvalSuccessTitle'), () => {
    dialog.remove();
    onClose();
  });
}
