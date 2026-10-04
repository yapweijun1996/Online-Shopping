import { checkoutPayload } from './checkout-payload.js';
import { formatMoney, locale, t, translate } from '../shared/i18n.js';
import { addressSummary } from './addresses.js';

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

export function mountCheckout({ onSuccess, onPriceChanged, getProfile, addressBook }) {
  const form = document.getElementById('checkout-form');
  const assignmentList = document.getElementById('assignment-list');
  let submitting = false;
  let cartItems = [];
  let cartBacked = true;
  let demoMode = false;
  let modeReady = false;
  let itemsReady = false;
  let viewGeneration = 0;
  let pendingIntent = null;
  let confirmedButNotShown = false;
  let statusKey = '';
  let errorKey = '';

  function setStatus(key) {
    statusKey = key;
    document.getElementById('checkout-status').textContent = key ? t(key) : '';
  }

  function setError(key, fieldName) {
    errorKey = key;
    document.getElementById('checkout-error').textContent = key ? t(key) : '';
    form.querySelectorAll('[aria-invalid="true"]').forEach((control) => control.removeAttribute('aria-invalid'));
    if (!fieldName) return;
    const target = [...form.querySelectorAll('[data-field], [name]')].find((control) =>
      control.dataset.field === fieldName || control.name === fieldName) ||
      (fieldName.includes('.items') ? assignmentList.querySelector('select') : null);
    if (target) {
      target.setAttribute('aria-invalid', 'true');
      target.focus();
    }
  }

  function renderAssignments() {
    assignmentList.replaceChildren();
    const total = cartItems.reduce((sum, item) => sum + item.product.priceMinor * item.quantity, 0);
    document.getElementById('checkout-total').textContent = cartItems.length ? formatMoney(total, cartItems[0].product.currency) : '—';
    const headings = element('div', 'checkout-columns');
    for (const key of ['product', 'unitPrice', 'quantity', 'itemSubtotal']) headings.append(element('span', '', t(key)));
    headings.setAttribute('aria-hidden', 'true'); assignmentList.append(headings);
    for (const item of cartItems) {
      const row = element('div', 'assignment-row');
      const name = element('div', 'checkout-item');
      if (item.product.imageUrl) {
        const image = element('img', 'checkout-item-image');
        image.src = item.product.imageUrl; image.alt = ''; name.append(image);
      }
      const summary = element('div');
      summary.append(element('strong', '', item.product.name));
      name.append(summary);
      row.append(name);
      for (const [key, value] of [['unitPrice', formatMoney(item.product.priceMinor, item.product.currency)], ['quantity', String(item.quantity)], ['itemSubtotal', formatMoney(item.product.priceMinor * item.quantity, item.product.currency)]]) {
        const cell = element('div', 'checkout-cell');
        cell.append(element('span', 'checkout-cell-label', t(key)), element('span', '', value));
        row.append(cell);
      }
      assignmentList.append(row);
    }
  }

  function refreshAddress() {
    const summary = document.getElementById('checkout-address');
    summary.replaceChildren();
    let address = null;
    try {
      address = addressBook.selected();
      if (address) {
        const contact = element('div', 'address-contact');
        contact.append(element('strong', '', address.fullName), element('span', '', address.phone));
        summary.append(contact, element('p', '', addressSummary(address)));
        if (address.id === addressBook.defaultId()) summary.append(element('span', 'default-badge', t('defaultAddress')));
      } else summary.append(element('p', 'shop-note', t('addressRequired')));
    } catch { summary.append(element('p', 'checkout-error', t('addressStorageFailed'))); }
    document.getElementById('change-address').textContent = t(address ? 'changeAddress' : 'addAddress');
    document.getElementById('submit-order').disabled = submitting || confirmedButNotShown || !modeReady || !itemsReady || !address || !cartItems.length;
  }

  function renderBuyer() {
    const profile = getProfile();
    const summary = document.getElementById('checkout-buyer');
    summary.replaceChildren();
    if (profile) {
      for (const [key, value] of [['fullName', profile.fullName], ['buyerWhatsApp', profile.phone], ['email', profile.email]]) {
        summary.append(element('dt', '', t(key)), element('dd', '', value || '—'));
      }
    }
    const consent = document.getElementById('whatsapp-opt-in');
    const needsConsent = !demoMode && Boolean(profile?.phone);
    consent.required = needsConsent;
    consent.closest('label').hidden = !needsConsent;
    if (!needsConsent) consent.checked = false;
  }

  function applyDemo() {
    renderBuyer();
    document.getElementById('submit-order').dataset.i18n = demoMode ? 'simulateOrder' : 'placeOrder';
    document.querySelector('#checkout-view > .shop-note').dataset.i18n = 'checkoutReviewIntro';
    translate(document.getElementById('checkout-view'));
  }

  const whatsappConsent = document.getElementById('whatsapp-opt-in');
  whatsappConsent.addEventListener('invalid', () => setError('whatsappRequired', 'whatsappOrderContactOptIn'));
  whatsappConsent.addEventListener('change', () => { if (whatsappConsent.checked) setError(''); });
  document.getElementById('change-address').addEventListener('click', () => addressBook.choose());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    if (!modeReady || !itemsReady) { setError('networkError'); return; }
    if (!getProfile()) { location.hash = '#profile'; return; }
    setError('');
    setStatus('');
    if (confirmedButNotShown) { setError('receiptRenderError'); return; }
    if (!cartItems.length) { setError('emptyCart'); return; }
    let payload;
    try { payload = checkoutPayload({ profile: getProfile(), address: addressBook.selected(), items: cartItems, locale: locale(), consent: whatsappConsent.checked, demo: demoMode }); } catch (error) { setError(error.message); refreshAddress(); return; }
    if (payload.deliveries.some((delivery) => delivery.items.length === 0)) {
      setError('assignEveryDestination', 'deliveries.0.items');
      return;
    }
    const submittedItems = cartItems.map(({ productId, quantity }) => ({ productId, quantity }));
    const orderItems = cartItems.map(({ productId, quantity, product }) => ({
      productId, name: product.name, quantity, unitPriceMinor: product.priceMinor, imageUrl: product.imageUrl,
    }));
    const serialized = JSON.stringify(payload);
    if (!pendingIntent || pendingIntent.serialized !== serialized) {
      pendingIntent = { key: crypto.randomUUID(), serialized };
    }
    const submit = document.getElementById('submit-order');
    const submittedGeneration = viewGeneration;
    const ownsSubmissionView = () => submittedGeneration === viewGeneration && location.hash === '#checkout';
    submitting = true; document.dispatchEvent(new Event('updateguardchange'));
    submit.disabled = true;
    setStatus('submittingOrder');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let serverConfirmed = false;
    try {
      const response = await fetch('/api/v1/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pendingIntent.key },
        body: serialized, signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) {
        if (['IDEMPOTENCY_CONFLICT', 'PRICE_CHANGED'].includes(result.error?.code)) pendingIntent = null;
        if (!ownsSubmissionView()) return;
        setStatus('');
        if (result.error?.code === 'PRICE_CHANGED') {
          onPriceChanged();
          return;
        }
        setError(result.error?.code === 'MIXED_CURRENCY' ? 'mixedCurrencies' :
          result.error?.code === 'PRODUCT_UNAVAILABLE' ? 'cartUnavailable' :
          result.error?.code === 'INVALID_INPUT' ? 'checkoutInvalid' : 'orderError', result.error?.field);
        return;
      }
      serverConfirmed = true;
      setStatus('');
      await onSuccess(result, { orderItems, submittedItems, cartBacked, statusAccessKey: pendingIntent.key });
    } catch {
      if (!serverConfirmed && !ownsSubmissionView()) return;
      setStatus('');
      setError(serverConfirmed ? 'receiptRenderError' : 'orderNetworkError');
      if (serverConfirmed) confirmedButNotShown = true;
    } finally {
      submitting = false; document.dispatchEvent(new Event('updateguardchange'));
      clearTimeout(timeout);
      refreshAddress();
    }
  });

  refreshAddress();
  return {
    isBusy: () => submitting,
    refreshAddress,
    setDemoMode(value) { demoMode = value === true; modeReady = true; applyDemo(); refreshAddress(); },
    invalidate() { viewGeneration++; itemsReady = false; document.getElementById('submit-order').disabled = true; },
    setItems(items, { fromCart = true } = {}) {
      if (submitting) return;
      itemsReady = true;
      cartBacked = fromCart;
      try { addressBook.ensureSelection(); } catch { /* The address summary reports storage errors. */ }
      cartItems = items.map(({ productId, quantity, product }) => ({ productId, quantity, product }));
      renderAssignments();
      renderBuyer();
      refreshAddress();
      setError('');
    },
    refreshLocale() {
      translate(form);
      renderAssignments();
      refreshAddress();
      renderBuyer();
      document.getElementById('checkout-status').textContent = statusKey ? t(statusKey) : '';
      document.getElementById('checkout-error').textContent = errorKey ? t(errorKey) : '';
    },
    reset() {
      form.reset();
      cartItems = [];
      cartBacked = true;
      itemsReady = false;
      pendingIntent = null;
      confirmedButNotShown = false;
      addressBook.resetSelection();
      refreshAddress();
      setStatus('');
      setError('');
    },
  };
}
