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

function statusKey(status) {
  return { SUBMITTED: 'statusSubmitted', CONFIRMED: 'statusConfirmed', REJECTED: 'statusRejected' }[status] || 'orderStatus';
}

export function mountOrders(root, { mode, csrfToken, onUnauthorized }) {
  root.replaceChildren(document.getElementById('orders-template').content.cloneNode(true));
  translate(root);
  const find = (selector) => root.querySelector(selector);
  const shell = find('.order-layout');
  const list = find('#order-list');
  const listStatus = find('#order-list-status');
  const message = find('#order-message');
  const detailContent = find('#order-detail-content');
  const more = find('#order-more');
  const back = find('#order-back');
  const search = find('#order-search');
  const status = find('#order-status');
  const dialog = find('#decision-dialog');
  const reason = find('#decision-reason');
  const reasonLabel = find('#decision-reason-label');
  const dialogError = find('#decision-error');
  const decisionSubmit = find('#decision-submit');
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
  let detailRequest = 0;
  let deciding = false;

  if (mode === 'review') {
    find('#order-status-label').hidden = true;
    status.disabled = true;
  }

  function isCurrent() { return active && shell.isConnected; }
  function setMessage(key) {
    messageKey = key;
    message.textContent = key ? t(key) : '';
    message.classList.toggle('is-error', ['copyFailure', 'orderChanged', 'decisionUnknown', 'decisionFailed', 'offlineMessage'].includes(key));
  }
  function setListStatus(key) { listStatusKey = key; listStatus.textContent = key ? t(key) : ''; }
  function setDialogError(key) { dialogErrorKey = key; dialogError.textContent = key ? t(key) : ''; }
  function showDetailStatus(key) {
    detailStatusKey = key;
    detailContent.replaceChildren();
    detailContent.textContent = t(key);
  }

  async function request(method, path, body) {
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
      button.addEventListener('click', () => openOrder(order.id));
      list.append(button);
    }
    more.hidden = nextOffset === null;
  }

  async function loadQueue(reset = true) {
    if (!isCurrent()) return;
    const requestNumber = ++listRequest;
    const offset = reset ? 0 : nextOffset;
    if (offset === null) return;
    if (reset) { items = []; nextOffset = null; renderQueue(); }
    more.disabled = true;
    setListStatus('loading');
    try {
      const params = new URLSearchParams({
        limit: '20', offset: String(offset), search: search.value.trim(),
      });
      const filter = mode === 'review' ? 'SUBMITTED' : status.value;
      if (filter) params.set('status', filter);
      const result = await request('GET', `/api/v1/seller/orders?${params}`);
      if (!isCurrent() || requestNumber !== listRequest) return;
      items = reset ? result.items : [...items, ...result.items];
      nextOffset = result.nextOffset;
      renderQueue();
      setListStatus(items.length ? '' : mode === 'review' ? 'noPendingOrders' : 'noOrders');
    } catch (error) {
      if (isCurrent() && requestNumber === listRequest && error.status !== 401) setListStatus('networkError');
    } finally {
      if (isCurrent() && requestNumber === listRequest) more.disabled = false;
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

  function renderDetail() {
    if (!selectedOrder) { showDetailStatus(detailStatusKey); return; }
    const order = selectedOrder;
    const fragment = document.createDocumentFragment();
    const head = node('div', 'order-detail-head');
    head.append(node('strong', 'order-number', order.orderNo), node('span', `order-chip ${order.status.toLowerCase()}`, t(statusKey(order.status))));
    fragment.append(head);
    fragment.append(detailGroup('orderSummary', [
      detailField('orderTotal', formatMoney(order.totalMinor, order.currency), false),
      detailField('submittedAt', formatDate(order.submittedAt), false),
      detailField('updatedAt', formatDate(order.updatedAt), false),
      detailField('orderRevision', String(order.revision), false),
    ]));

    const buyer = detailGroup('buyerDetails', [
      detailField('fullName', order.buyer.fullName),
      detailField('buyerWhatsApp', order.buyer.whatsappPhone),
      detailField('emailLabel', order.buyer.email),
    ]);
    const consent = node('p', 'order-consent', t(order.buyer.whatsappOrderContactOptIn ? 'contactOptedIn' : 'contactNotOptedIn'));
    buyer.append(consent);
    if (order.buyer.whatsappOrderContactOptIn && /^\+(?:60|65)[1-9]\d{6,11}$/.test(order.buyer.whatsappPhone)) {
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
        detailField('recipientName', delivery.recipient.fullName),
        detailField('recipientPhone', delivery.recipient.phone),
        detailField('addressLine1', delivery.address.line1),
        detailField('addressLine2Label', delivery.address.line2),
        detailField('cityLabel', delivery.address.city),
        detailField('regionLabel', delivery.address.region),
        detailField('postcode', delivery.address.postcode),
        detailField('countryCode', delivery.address.country),
      ]) if (field) fields.append(field);
      section.append(fields);
      const lines = node('ul', 'order-items');
      for (const item of delivery.items) {
        const line = node('li');
        line.append(
          node('strong', '', item.name),
          node('span', '', `${item.sku} · ${t('quantity')} ${item.quantity}`),
          node('span', '', `${formatMoney(item.priceMinor, item.currency)} × ${item.quantity} = ${formatMoney(item.lineTotalMinor, item.currency)}`),
        );
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

    if (mode === 'review' && order.status === 'SUBMITTED') {
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
    detailStatusKey = '';
    detailContent.replaceChildren(fragment);
  }

  async function openOrder(id) {
    if (!isCurrent()) return;
    const requestNumber = ++detailRequest;
    selectedId = id;
    selectedOrder = null;
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
    if (!selectedOrder || selectedOrder.status !== 'SUBMITTED' || deciding) return;
    if (!navigator.onLine) { setMessage('offlineMessage'); return; }
    dialogAction = action;
    dialogTrigger = trigger;
    reason.value = '';
    setDialogError('');
    reasonLabel.hidden = action !== 'reject';
    reason.required = action === 'reject';
    find('#decision-title').textContent = t(action === 'confirm' ? 'confirmOrder' : 'rejectOrder');
    find('#decision-intro').textContent = t(action === 'confirm' ? 'confirmQuestion' : 'rejectQuestion');
    decisionSubmit.textContent = t(action === 'confirm' ? 'confirmOrder' : 'rejectOrder');
    dialog.showModal();
    if (action === 'reject') reason.focus();
    else decisionSubmit.focus();
  }

  find('#order-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    selectedId = null;
    selectedOrder = null;
    root.classList.remove('order-show-detail');
    showDetailStatus('selectOrder');
    setMessage('');
    loadQueue();
  });
  more.addEventListener('click', () => loadQueue(false));
  back.addEventListener('click', () => {
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
  find('#decision-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (deciding || !selectedOrder || !dialogAction) return;
    const action = dialogAction;
    const id = selectedOrder.id;
    const expectedRevision = selectedOrder.revision;
    const body = { expectedRevision };
    if (action === 'reject') {
      const trimmed = reason.value.trim();
      if (!trimmed) { setDialogError('reasonRequired'); reason.focus(); return; }
      body.reason = trimmed;
    }
    deciding = true;
    decisionSubmit.disabled = true;
    setDialogError('');
    try {
      const updated = await request('POST', `/api/v1/seller/orders/${encodeURIComponent(id)}/${action}`, body);
      if (!isCurrent()) return;
      dialog.close();
      selectedOrder = updated;
      renderDetail();
      setMessage(action === 'confirm' ? 'orderConfirmed' : 'orderRejected');
      await loadQueue();
    } catch (error) {
      if (!isCurrent() || error.status === 401) return;
      if (error.status === 409 && error.code === 'STALE_REVISION') {
        dialog.close();
        await Promise.all([loadQueue(), openOrder(id)]);
        setMessage('orderChanged');
      } else if (!error.status) {
        dialog.close();
        await Promise.all([loadQueue(), openOrder(id)]);
        setMessage('decisionUnknown');
      } else {
        setDialogError(error.field === 'reason' ? 'reasonRequired' : 'decisionFailed');
      }
    } finally {
      deciding = false;
      if (isCurrent()) decisionSubmit.disabled = false;
    }
  });

  loadQueue();
  return {
    mode,
    dispose() {
      active = false;
      root.classList.remove('order-show-detail');
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      if (dialog.open) dialog.close();
    },
    refreshLocale() {
      if (!isCurrent()) return;
      translate(root);
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
