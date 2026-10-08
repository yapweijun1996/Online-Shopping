import { beginMutation } from '../shared/update-guard.js';
import { containDialogFocus } from '../shared/modal.js';
import { revealImage } from '../shared/image-reveal.js';
import { thumbUrl } from '../shared/image-thumb.js';
import { createOrderDocuments } from './order-documents.js';
import { documentTitleKey } from './order-document-model.js';
import { statusKey } from './order-status-label.js';
import { mountOrderMessages } from './messages.js';
import './trail-copy.js';
import { formatDate, formatMoney, t, translate } from '../shared/i18n.js';

function node(tag, className = '', value = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function actionButton(label, onClick, className = 'secondary-button') {
  const button = node('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}


/* Sales Orders hold orders waiting for a decision (and rejected ones); once confirmed an order moves to
   Sales Order Confirmation, where it is shipped, delivered or voided. */
const SCOPES = {
  orders: { defaultFilter: 'SUBMITTED', filters: ['SUBMITTED', 'REJECTED', 'SUBMITTED,REJECTED'] },
  confirmations: { defaultFilter: 'CONFIRMED', filters: ['CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'CONFIRMED,SHIPPED,DELIVERED,CANCELLED'] },
};

export function mountOrders(root, { mode, csrfToken, onUnauthorized, initialOrderId = null, onSelect = () => {} }) {
  root.replaceChildren(document.getElementById('orders-template').content.cloneNode(true));
  translate(root);
  const find = (selector) => root.querySelector(selector);
  const shell = find('.order-layout');
  const list = find('#order-list');
  const listStatus = find('#order-list-status');
  const clearFilters = find('#order-clear-filters');
  const message = find('#order-message');
  const detailContent = find('#order-detail-content');
  const more = find('#order-more');
  const back = find('#order-back');
  const search = find('#order-search');
  const status = find('#order-status');
  const dialog = find('#decision-dialog');
  containDialogFocus(dialog);
  const reason = find('#decision-reason');
  const reasonLabel = find('#decision-reason-label');
  const shipFields = find('#decision-ship-fields');
  const carrier = find('#decision-carrier');
  const carrierOtherLabel = find('#decision-carrier-other-label');
  const carrierOther = find('#decision-carrier-other');
  const tracking = find('#decision-tracking');
  const dialogError = find('#decision-error');
  const decisionSubmit = find('#decision-submit');
  const documents = createOrderDocuments();
  const retry = find('#order-retry');
  let shopName = '';
  let documentRequest = 0;
  let active = true;
  let items = [];
  let nextOffset = null;
  let selectedOrder = null;
  let selectedId = null;
  let messageKey = '';
  let listStatusKey = '';
  let detailStatusKey = 'selectOrder';
  let dialogAction = null;
  let dialogTrigger = null;
  let dialogErrorKey = '';
  let listRequest = 0;
  let appliedSearch = '';
  const scope = SCOPES[mode];
  let appliedStatus = scope.defaultFilter;
  let detailRequest = 0;
  let whatsappDetail = null;
  let deciding = false;

  function renderStatusOptions() {
    const chosen = status.value || scope.defaultFilter;
    status.replaceChildren(...scope.filters.map((value) => {
      const option = node('option', '', value.includes(',') ? t('allStatuses') : t(statusKey(value)));
      option.value = value;
      return option;
    }));
    status.value = scope.filters.includes(chosen) ? chosen : scope.defaultFilter;
  }
  renderStatusOptions();
  status.addEventListener('change', () => find('#order-filter').requestSubmit());

  function isCurrent() { return active && shell.isConnected; }
  function setMessage(key) {
    messageKey = key;
    message.textContent = key ? t(key) : '';
    message.classList.toggle('is-error', ['documentFailed', 'copyFailure', 'orderChanged', 'decisionUnknown', 'decisionFailed', 'offlineMessage'].includes(key));
  }
  function setListStatus(key) { listStatusKey = key; listStatus.textContent = key ? t(key) : ''; }
  function setDialogError(key) { dialogErrorKey = key; dialogError.textContent = key ? t(key) : ''; }
  function showDetailStatus(key) {
    whatsappDetail?.dispose();
    whatsappDetail = null;
    detailStatusKey = key;
    detailContent.replaceChildren();
    detailContent.textContent = t(key);
    if (key === 'orderLoadError' && selectedId) detailContent.append(actionButton(t('retry'), () => openOrder(selectedId), 'secondary-button order-retry'));
  }

  async function request(method, path, body) {
    const finish = method === 'GET' ? () => {} : beginMutation();
    try {
      const response = await fetch(path, {
        method,
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 401) {
        if (isCurrent()) onUnauthorized();
        throw Object.assign(new Error('unauthorized'), { status: 401 });
      }
      let data;
      try { data = await response.json(); } catch { throw new Error('invalid response'); }
      if (!response.ok) {
        throw Object.assign(new Error(data.error?.code || 'request failed'), {
          status: response.status, code: data.error?.code, field: data.error?.field,
        });
      }
      return data;
    } finally { finish(); }
  }

  function renderQueue() {
    list.replaceChildren();
    for (const order of items) {
      const button = node('button', 'order-card');
      button.type = 'button';
      button.classList.toggle('selected', order.id === selectedId);
      button.setAttribute('aria-label', `${order.orderNo}, ${order.buyerName}, ${t(statusKey(order.status))}`);
      if (order.id === selectedId) button.setAttribute('aria-current', 'true');
      const heading = node('span', 'order-card-heading', order.orderNo);
      const chip = node('span', `order-chip ${order.status.toLowerCase()}`, t(statusKey(order.status)));
      const name = node('span', 'order-card-buyer', order.buyerName);
      const meta = node('span', 'order-card-meta', `${formatMoney(order.totalMinor, order.currency)} · ${formatDate(order.submittedAt)}`);
      button.append(heading, chip, name, meta);
      if (order.preview) {
        const thumb = node('span', 'order-card-thumb');
        if (order.preview.imageUrl) {
          const image = node('img'); revealImage(image); image.src = thumbUrl(order.preview.imageUrl); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
          image.addEventListener('error', () => image.remove());
          thumb.append(image);
        }
        const what = node('span', 'order-card-item', `${order.preview.name}${order.preview.itemCount > 1 ? ` +${order.preview.itemCount - 1}` : ''}`);
        const row = node('span', 'order-card-preview'); row.append(thumb, what);
        button.append(row);
      }
      button.addEventListener('click', () => openOrder(order.id));
      list.append(button);
    }
    more.hidden = nextOffset === null;
  }

  async function loadQueue(reset = true) {
    if (!isCurrent()) return;
    const requestNumber = ++listRequest;
    let succeeded = false;
    const offset = reset ? 0 : nextOffset;
    if (offset === null) return;
    const query = reset ? search.value.trim() : appliedSearch;
    const filter = reset ? status.value : appliedStatus;
    if (reset) {
      appliedSearch = query;
      appliedStatus = filter;
      // Keep the last successful queue visible until its replacement arrives.
      list.setAttribute('aria-busy', 'true');
    }
    more.disabled = true;
    clearFilters.hidden = true;
    retry.hidden = true;
    setListStatus('loading');
    try {
      const params = new URLSearchParams({
        limit: '20', offset: String(offset), search: query,
      });
      if (filter) params.set('status', filter);
      const result = await request('GET', `/api/v1/seller/orders?${params}`);
      if (!isCurrent() || requestNumber !== listRequest) return;
      succeeded = true;
      items = reset ? result.items : [...items, ...result.items];
      nextOffset = result.nextOffset;
      renderQueue();
      const hasCriteria = Boolean(query || filter !== scope.defaultFilter);
      setListStatus(items.length ? '' : hasCriteria ? 'noMatchingOrders' : mode === 'orders' ? 'noPendingOrders' : 'noOrders');
      clearFilters.hidden = Boolean(items.length) || !hasCriteria;
    } catch (error) {
      if (isCurrent() && requestNumber === listRequest && error.status !== 401) { setListStatus('networkError'); retry.hidden = false; }
    } finally {
      if (isCurrent() && requestNumber === listRequest) { more.disabled = !succeeded; list.setAttribute('aria-busy', 'false'); }
    }
  }

  async function copyValue(value, button) {
    try {
      await navigator.clipboard.writeText(value);
      if (isCurrent()) {
        setMessage('copySuccess');
        button.textContent = t('copied');
      }
    } catch {
      if (isCurrent()) {
        setMessage('copyFailure');
        button.textContent = t('copyFailedShort');
      }
    }
  }

  function detailField(labelKey, value, copy = true) {
    if (!value) return null;
    const row = node('div', 'order-field');
    const label = node('dt', '', t(labelKey));
    const content = node('dd', '', value);
    row.append(label, content);
    if (copy) {
      const button = actionButton(t('copyField'), () => copyValue(value, button), 'text-button');
      button.setAttribute('aria-label', `${t('copyField')} ${t(labelKey)}`);
      row.append(button);
    }
    return row;
  }

  function detailGroup(headingKey, fields) {
    const section = node('section', 'order-detail-group');
    section.append(node('h3', '', t(headingKey)));
    const values = node('dl', 'order-fields');
    for (const field of fields) if (field) values.append(field);
    section.append(values);
    return section;
  }

  // Sales Order -> Sales Order Confirmation -> Shipment -> Delivery, each with its number, time and who did it.
  function documentTrailSection(order) {
    const names = { SALES_ORDER: 'salesOrderDocument', SALES_ORDER_CONFIRMATION: 'salesOrderConfirmationDocument', SHIPMENT: 'documentShipment', DELIVERY: 'documentDelivery' };
    const section = node('section', 'order-detail-group');
    section.append(node('h3', '', t('documentsTrail')));
    const list = node('ol', 'document-trail');
    const person = (who) => who?.actorType === 'SELLER' ? who.actorId : t('guestBuyer');
    for (const doc of order.documents || []) {
      const item = node('li', 'document-trail-item');
      const head = node('div', 'document-trail-head');
      head.append(node('strong', '', t(names[doc.type])));
      const number = [doc.carrier, doc.number].filter(Boolean).join(' · ');
      if (number) head.append(node('span', 'document-number', number));
      const ended = doc.state === 'VOID' ? 'sellerStatusCancelled' : doc.state === 'REJECTED' ? 'statusRejected' : '';
      if (ended) head.append(node('span', `order-chip ${doc.state === 'VOID' ? 'cancelled' : 'rejected'}`, t(ended)));
      item.append(head, node('span', 'document-trail-meta', `${t('issuedAt')}: ${formatDate(doc.issuedAt)} · ${person(doc)}`));
      if (ended && doc.endedAt) item.append(node('span', 'document-trail-meta', `${t(ended)}: ${formatDate(doc.endedAt)} · ${person(doc.endedBy)}${doc.reason ? ` · ${doc.reason}` : ''}`));
      list.append(item);
    }
    section.append(list);
    return section;
  }

  function renderDetail() {
    if (!selectedOrder) { showDetailStatus(detailStatusKey); return; }
    const order = selectedOrder;
    const fragment = document.createDocumentFragment();
    const head = node('div', 'order-detail-head');
    head.append(node('strong', 'order-number', order.orderNo), node('span', `order-chip ${order.status.toLowerCase()}`, t(statusKey(order.status))));
    fragment.append(head);
    const documentActions = node('div', 'order-document-actions');
    for (const kind of order.status === 'CONFIRMED' ? ['summary', 'packing'] : ['summary']) {
      const button = actionButton(t(documentTitleKey(kind, order.status)), async () => {
        const requestNumber = ++documentRequest; const id = order.id; button.disabled = true;
        try {
          const fresh = await request('GET', `/api/v1/seller/orders/${encodeURIComponent(id)}`);
          if (!isCurrent() || requestNumber !== documentRequest || selectedId !== id) return;
          documents.open(fresh, kind, shopName, button);
        } catch (error) { if (isCurrent() && error.status !== 401) setMessage('documentFailed'); }
        finally { if (button.isConnected) button.disabled = false; }
      });
      documentActions.append(button);
    }
    fragment.append(documentActions);
    if (order.simulation) fragment.append(node('p', 'order-simulation-notice', t('orderSimulationNotice')));
    fragment.append(detailGroup('orderSummary', [
      detailField('orderTotal', formatMoney(order.totalMinor, order.currency), false),
      detailField('submittedAt', formatDate(order.submittedAt), false),
      detailField('updatedAt', formatDate(order.updatedAt), false),
      ...(order.trackingCarrier ? [detailField('carrier', order.trackingCarrier, false), detailField('trackingNumberLabel', order.trackingNo, true)] : []),
    ]));

    fragment.append(documentTrailSection(order));

    const buyer = detailGroup('buyerDetails', [
      detailField('fullName', order.buyer.fullName, !order.simulation),
      detailField('buyerWhatsApp', order.simulation ? t('demoContactUnavailable') : order.buyer.whatsappPhone, !order.simulation),
      detailField('emailLabel', order.buyer.email, !order.simulation),
    ]);
    if (!order.simulation) buyer.append(node('p', 'order-consent', t(order.buyer.whatsappOrderContactOptIn ? 'contactOptedIn' : 'contactNotOptedIn')));
    if (!order.simulation && order.buyer.whatsappOrderContactOptIn && /^\+(?:60|65)[1-9]\d{6,11}$/.test(order.buyer.whatsappPhone)) {
      const link = node('a', 'secondary-button whatsapp-link', t('openWhatsApp'));
      link.href = `https://wa.me/${order.buyer.whatsappPhone.slice(1)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      buyer.append(link);
    }
    fragment.append(buyer);

    for (const delivery of order.deliveries) {
      const section = node('section', 'order-detail-group order-delivery');
      section.append(node('h3', '', `${t('destination')} ${delivery.position + 1}`));
      const fields = node('dl', 'order-fields');
      for (const field of [
        detailField('recipientName', delivery.recipient.fullName, !order.simulation),
        detailField('recipientPhone', order.simulation ? t('demoContactUnavailable') : delivery.recipient.phone, !order.simulation),
        detailField('addressLine1', delivery.address.line1, !order.simulation),
        detailField('addressLine2Label', delivery.address.line2, !order.simulation),
        detailField('cityLabel', delivery.address.city, !order.simulation),
        detailField('regionLabel', delivery.address.region, !order.simulation),
        detailField('postcode', delivery.address.postcode, !order.simulation),
        detailField('countryCode', delivery.address.country, !order.simulation),
      ]) if (field) fields.append(field);
      section.append(fields);
      const lines = node('ul', 'order-items');
      for (const item of delivery.items) {
        const line = node('li', 'order-item');
        const thumb = node('span', 'order-item-thumb');
        if (item.imageUrl) {
          const image = node('img'); revealImage(image); image.src = thumbUrl(item.imageUrl); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
          image.addEventListener('error', () => image.remove());
          thumb.append(image);
        }
        const title = node('strong', '', item.name);
        if (item.productUrl) {
          // Opens the public product page in a new tab so staff can double-check what was ordered.
          const link = node('a', 'order-item-link', item.name);
          link.href = item.productUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
          link.title = t('openProductPage');
          title.textContent = ''; title.append(link);
        }
        const text = node('span', 'order-item-text');
        text.append(
          title,
          node('span', '', `${item.sku} · ${t('quantity')} ${item.quantity}`),
          node('span', '', `${formatMoney(item.priceMinor, item.currency)} × ${item.quantity} = ${formatMoney(item.lineTotalMinor, item.currency)}`),
        );
        line.append(thumb, text);
        lines.append(line);
      }
      section.append(node('h4', '', t('orderItems')), lines);
      fragment.append(section);
    }

    const history = node('section', 'order-detail-group');
    history.append(node('h3', '', t('orderHistory')));
    const events = node('ol', 'order-events');
    for (const event of order.events) {
      const line = node('li');
      line.append(node('strong', '', t(statusKey(event.status))));
      line.append(node('span', '', `${formatDate(event.occurredAt)} · ${event.actorType === 'SELLER' ? event.actorId : t('guestBuyer')}`));
      if (event.reason) line.append(node('p', '', event.reason));
      events.append(line);
    }
    history.append(events);
    fragment.append(history);

    if (order.status === 'SUBMITTED') {
      const actions = node('div', 'order-review-actions');
      const confirm = actionButton(t('confirmOrder'), (event) => openDecision('confirm', event.currentTarget), 'primary-button');
      const reject = actionButton(t('rejectOrder'), (event) => openDecision('reject', event.currentTarget), 'secondary-button');
      confirm.dataset.action = 'confirm';
      reject.dataset.action = 'reject';
      confirm.disabled = !navigator.onLine;
      reject.disabled = !navigator.onLine;
      if (!navigator.onLine) actions.append(node('p', 'order-offline-hint', t('offlineMessage')));
      actions.append(confirm, reject);
      fragment.append(actions);
    }
    const fulfilment = { CONFIRMED: [['ship', 'shipOrder', 'primary-button'], ['cancel', 'cancelOrder', 'secondary-button']],
      SHIPPED: [['deliver', 'deliverOrder', 'primary-button']] }[order.status];
    if (fulfilment) {
      const actions = node('div', 'order-review-actions');
      if (!navigator.onLine) actions.append(node('p', 'order-offline-hint', t('offlineMessage')));
      for (const [action, label, kind] of fulfilment) {
        const button = actionButton(t(label), (event) => openDecision(action, event.currentTarget), kind);
        button.dataset.action = action;
        button.disabled = !navigator.onLine;
        actions.append(button);
      }
      fragment.append(actions);
    }
    detailStatusKey = '';
    whatsappDetail?.dispose();
    detailContent.replaceChildren(fragment);
    whatsappDetail = mountOrderMessages(detailContent, { orderId: order.id, csrfToken, onUnauthorized });
  }

  async function openOrder(id) {
    if (!isCurrent()) return;
    const requestNumber = ++detailRequest;
    selectedId = id;
    selectedOrder = null;
    onSelect(id);
    root.classList.add('order-show-detail');
    renderQueue();
    showDetailStatus('loading');
    try {
      const detail = await request('GET', `/api/v1/seller/orders/${encodeURIComponent(id)}`);
      if (!isCurrent() || requestNumber !== detailRequest) return;
      selectedOrder = detail;
      renderDetail();
      find('#order-detail-title').setAttribute('tabindex', '-1');
      find('#order-detail-title').focus();
    } catch (error) {
      if (isCurrent() && requestNumber === detailRequest && error.status !== 401) showDetailStatus('orderLoadError');
    }
  }

  function openDecision(action, trigger) {
    const requiredStatus = { confirm: 'SUBMITTED', reject: 'SUBMITTED', ship: 'CONFIRMED', cancel: 'CONFIRMED', deliver: 'SHIPPED' }[action];
    if (!selectedOrder || selectedOrder.status !== requiredStatus || deciding) return;
    if (!navigator.onLine) { setMessage('offlineMessage'); return; }
    dialogAction = action;
    dialogTrigger = trigger;
    reason.value = '';
    setDialogError('');
    const needsReason = action === 'reject' || action === 'cancel';
    reasonLabel.hidden = !needsReason;
    reason.required = needsReason;
    reasonLabel.firstElementChild.textContent = t(action === 'cancel' ? 'cancellationReason' : 'rejectionReason');
    shipFields.hidden = action !== 'ship';
    carrier.selectedIndex = 0; carrierOther.value = ''; tracking.value = ''; carrierOtherLabel.hidden = true;
    const labels = { confirm: ['confirmOrder', 'confirmQuestion'], reject: ['rejectOrder', 'rejectQuestion'],
      ship: ['shipOrder', 'shipQuestion'], deliver: ['deliverOrder', 'deliverQuestion'], cancel: ['cancelOrder', 'cancelQuestion'] }[action];
    find('#decision-title').textContent = t(labels[0]);
    find('#decision-intro').textContent = t(labels[1]);
    decisionSubmit.textContent = t(labels[0]);
    dialog.showModal();
    if (needsReason) reason.focus();
    else if (action === 'ship') carrier.focus();
    else decisionSubmit.focus();
  }

  find('#order-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    ++detailRequest; ++documentRequest;
    selectedId = null;
    selectedOrder = null;
    onSelect(null);
    root.classList.remove('order-show-detail');
    showDetailStatus('selectOrder');
    setMessage('');
    loadQueue();
  });
  clearFilters.addEventListener('click', () => {
    search.value = '';
    status.value = scope.defaultFilter;
    find('#order-filter').requestSubmit();
    search.focus();
  });
  retry.addEventListener('click', () => loadQueue());
  more.addEventListener('click', () => loadQueue(false));
  back.addEventListener('click', () => {
    onSelect(null);
    root.classList.remove('order-show-detail');
    (list.querySelector('.order-card.selected') || search).focus();
  });
  const onOffline = () => {
    if (!isCurrent()) return;
    if (dialog.open) dialog.close();
    if (selectedOrder) renderDetail();
    setMessage('offlineMessage');
  };
  const onOnline = () => {
    if (!isCurrent()) return;
    if (selectedOrder) renderDetail();
    if (messageKey === 'offlineMessage') setMessage('');
  };
  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);
  find('#decision-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (isCurrent()) {
      const trigger = dialogTrigger?.isConnected ? dialogTrigger : find(`.order-review-actions [data-action="${dialogAction}"]`);
      (trigger || find('#order-detail-title')).focus();
    }
    dialogTrigger = null;
    dialogAction = null;
  });
  carrier.addEventListener('change', () => { carrierOtherLabel.hidden = carrier.value !== 'OTHER'; });
  find('#decision-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (deciding || !selectedOrder || !dialogAction) return;
    const action = dialogAction;
    const id = selectedOrder.id;
    const expectedRevision = selectedOrder.revision;
    const body = { expectedRevision };
    if (action === 'reject' || action === 'cancel') {
      const trimmed = reason.value.trim();
      if (!trimmed) { setDialogError('reasonRequired'); reason.focus(); return; }
      body.reason = trimmed;
    }
    if (action === 'ship') {
      const name = carrier.value === 'OTHER' ? carrierOther.value.trim() : carrier.value;
      if (!name) { setDialogError('carrierRequired'); carrierOther.focus(); return; }
      body.carrier = name;
      if (tracking.value.trim()) body.trackingNo = tracking.value.trim();
    }
    deciding = true;
    document.dispatchEvent(new Event('updateguardchange'));
    decisionSubmit.disabled = true;
    setDialogError('');
    try {
      const updated = await request('POST', `/api/v1/seller/orders/${encodeURIComponent(id)}/${action}`, body);
      if (!isCurrent()) return;
      dialog.close();
      if (selectedId === id) { selectedOrder = updated; renderDetail(); }
      document.dispatchEvent(new Event('ordersdecided'));
      setMessage({ confirm: 'orderConfirmed', reject: 'orderRejected', ship: 'orderShipped', deliver: 'orderDelivered', cancel: 'orderCancelled' }[action]);
      await loadQueue();
    } catch (error) {
      if (!isCurrent() || error.status === 401) return;
      if (error.status === 409 && error.code === 'STALE_REVISION') {
        dialog.close();
        await Promise.all([loadQueue(), ...(selectedId === id ? [openOrder(id)] : [])]);
        setMessage('orderChanged');
      } else if (!error.status) {
        dialog.close();
        await Promise.all([loadQueue(), ...(selectedId === id ? [openOrder(id)] : [])]);
        setMessage('decisionUnknown');
      } else {
        setDialogError(error.code === 'INSUFFICIENT_STOCK' ? 'insufficientStock' : error.field === 'reason' ? 'reasonRequired' : 'decisionFailed');
      }
    } finally {
      deciding = false;
      document.dispatchEvent(new Event('updateguardchange'));
      if (isCurrent()) decisionSubmit.disabled = false;
    }
  });

  request('GET', '/api/v1/shop').then(setup => { if (isCurrent()) shopName = setup.shopName || ''; }).catch(() => {});
  loadQueue();
  if (initialOrderId) openOrder(initialOrderId);
  return {
    mode,
    // Called by the router when the address changes: open that order, or return to the list.
    showOrder(id) {
      if (id) { if (id !== selectedId || !root.classList.contains('order-show-detail')) openOrder(id); return; }
      if (!selectedId) return;
      ++detailRequest; ++documentRequest;
      selectedId = null; selectedOrder = null;
      root.classList.remove('order-show-detail');
      showDetailStatus('selectOrder');
      renderQueue();
    },
    isBusy: () => deciding,
    hasUnsavedChanges: () => dialog.open,
    draftSignature: () => JSON.stringify([dialog.open, dialogAction, selectedId]),
    dispose() {
      whatsappDetail?.dispose();
      active = false;
      ++documentRequest; documents.dispose();
      root.classList.remove('order-show-detail');
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      if (dialog.open) dialog.close();
    },
    refreshLocale() {
      if (!isCurrent()) return;
      translate(root);
      renderStatusOptions();
      renderQueue();
      if (selectedOrder) renderDetail();
      else showDetailStatus(detailStatusKey);
      setMessage(messageKey);
      setListStatus(listStatusKey);
      setDialogError(dialogErrorKey);
      if (dialog.open && dialogAction) {
        find('#decision-title').textContent = t(dialogAction === 'confirm' ? 'confirmOrder' : 'rejectOrder');
        find('#decision-intro').textContent = t(dialogAction === 'confirm' ? 'confirmQuestion' : 'rejectQuestion');
        decisionSubmit.textContent = t(dialogAction === 'confirm' ? 'confirmOrder' : 'rejectOrder');
      }
    },
  };
}
