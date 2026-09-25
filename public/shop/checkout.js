import { locale, t, translate } from '../shared/i18n.js';
import { createContactHistory } from './history.js';

const MAX_DESTINATIONS = 10;

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function field(labelKey, input) {
  const label = element('label', 'checkout-field');
  const caption = element('span', '', t(labelKey));
  caption.dataset.i18n = labelKey;
  label.append(caption, input);
  return label;
}

function input(name, options = {}) {
  const control = element('input');
  control.name = name;
  control.dataset.suffix = name;
  control.required = options.required ?? false;
  control.maxLength = options.maxLength ?? 160;
  if (options.type) control.type = options.type;
  if (options.list) control.setAttribute('list', options.list);
  if (options.autocomplete) control.autocomplete = options.autocomplete;
  if (options.placeholder) control.placeholder = options.placeholder;
  return control;
}

function phoneCode() {
  const select = element('select');
  select.dataset.suffix = 'recipient.code';
  select.setAttribute('aria-label', t('phoneCode'));
  select.append(new Option('MY +60', '+60'), new Option('SG +65', '+65'));
  return select;
}

function internationalPhone(code, value) {
  const raw = value.trim();
  if (/[^+0-9 ()-]/.test(raw)) return raw;
  const digits = raw.replace(/[^0-9]/g, '');
  if (raw.startsWith('+')) return `+${digits}`;
  return `${code}${code === '+60' && digits.startsWith('0') ? digits.slice(1) : digits}`;
}

function syncPhoneCode(code, value) {
  const text = value.trim();
  if (text.startsWith('+60')) code.value = '+60';
  if (text.startsWith('+65')) code.value = '+65';
}

function historyCombobox(control, choices, selectChoice) {
  const list = element('div', 'history-options');
  const listId = `history-options-${crypto.randomUUID()}`;
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  control.parentElement.classList.add('history-combobox');
  control.parentElement.append(list);
  control.setAttribute('role', 'combobox');
  control.setAttribute('aria-autocomplete', 'list');
  control.setAttribute('aria-controls', listId);
  control.setAttribute('aria-expanded', 'false');
  let visible = [];
  let active = -1;

  function close() {
    list.hidden = true;
    list.replaceChildren();
    visible = [];
    control.setAttribute('aria-expanded', 'false');
    control.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function choose(index) {
    const choice = visible[index];
    if (!choice) return;
    control.value = choice.value;
    selectChoice(choice);
    close();
    control.focus();
  }

  function show() {
    const query = control.value.trim().toLowerCase();
    visible = choices().filter((choice) => choice.label.toLowerCase().includes(query));
    list.replaceChildren();
    active = -1;
    visible.forEach((choice, index) => {
      const option = element('div', 'history-option', choice.label);
      option.id = `${listId}-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.addEventListener('pointerdown', (event) => { event.preventDefault(); choose(index); });
      option.addEventListener('click', () => choose(index));
      list.append(option);
    });
    list.hidden = visible.length === 0;
    control.setAttribute('aria-expanded', String(visible.length > 0));
    control.removeAttribute('aria-activedescendant');
  }

  control.addEventListener('focus', show);
  control.addEventListener('input', show);
  control.addEventListener('blur', () => { setTimeout(close, 100); });
  control.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (list.hidden) show();
      if (list.hidden) return;
      event.preventDefault();
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
      [...list.children].forEach((option, index) => option.setAttribute('aria-selected', String(index === active)));
      control.setAttribute('aria-activedescendant', `${listId}-${active}`);
    }
    if (event.key === 'Enter' && !list.hidden && active >= 0) {
      event.preventDefault();
      choose(active);
    }
  });
  return { refresh: () => { if (document.activeElement === control) show(); else close(); } };
}

export function mountCheckout({ onSuccess, onPriceChanged }) {
  const form = document.getElementById('checkout-form');
  const deliveryList = document.getElementById('delivery-list');
  const assignmentList = document.getElementById('assignment-list');
  const history = createContactHistory();
  const suggestionControls = [];
  const assignments = new Map();
  let cartItems = [];
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

  function refreshSuggestions() {
    for (const controller of suggestionControls.filter(({ control }) => control.isConnected)) controller.refresh();
  }

  function deliveryCards() { return [...deliveryList.querySelectorAll('.delivery-card')]; }

  function renderAssignments() {
    const cards = deliveryCards();
    assignmentList.replaceChildren();
    for (const item of cartItems) {
      const row = element('div', 'assignment-row');
      const name = element('span', '', `${item.product.name} × ${item.quantity}`);
      const select = element('select');
      select.setAttribute('aria-label', `${t('destinationFor')} ${item.product.name}`);
      for (const [index, card] of cards.entries()) {
        select.add(new Option(`${t('destination')} ${index + 1}`, card.dataset.deliveryId));
      }
      const current = assignments.get(item.productId);
      select.value = cards.some((card) => card.dataset.deliveryId === current) ? current : cards[0].dataset.deliveryId;
      assignments.set(item.productId, select.value);
      select.addEventListener('change', () => assignments.set(item.productId, select.value));
      row.append(name, select);
      assignmentList.append(row);
    }
  }

  function renumber() {
    const cards = deliveryCards();
    for (const [index, card] of cards.entries()) {
      card.querySelector('legend').textContent = `${t('destination')} ${index + 1}`;
      card.querySelector('.remove-destination').hidden = cards.length === 1;
      for (const control of card.querySelectorAll('[data-suffix]')) {
        control.name = `deliveries.${index}.${control.dataset.suffix}`;
        control.dataset.field = control.name;
      }
    }
    document.getElementById('add-delivery').disabled = cards.length >= MAX_DESTINATIONS;
    renderAssignments();
  }

  function addDestination() {
    if (deliveryCards().length >= MAX_DESTINATIONS) return;
    const card = element('fieldset', 'checkout-section delivery-card');
    card.dataset.deliveryId = crypto.randomUUID();
    card.append(element('legend'));
    const remove = element('button', 'outline-button remove-destination', t('removeDestination'));
    remove.type = 'button'; remove.dataset.i18n = 'removeDestination';
    remove.addEventListener('click', () => {
      if (deliveryCards().length === 1) return;
      const removedId = card.dataset.deliveryId;
      card.remove();
      for (const [productId, deliveryId] of assignments) {
        if (deliveryId === removedId) assignments.set(productId, deliveryCards()[0].dataset.deliveryId);
      }
      renumber();
    });
    card.append(remove);
    const fields = element('div', 'checkout-fields');
    const recipient = input('recipient.fullName', { required: true, maxLength: 120, autocomplete: 'name' });
    fields.append(field('recipientName', recipient));
    const phones = element('div', 'phone-fields');
    const code = phoneCode();
    const number = input('recipient.phone', { required: true, maxLength: 32, type: 'tel', autocomplete: 'off', placeholder: '0123456789' });
    number.inputMode = 'tel';
    number.addEventListener('change', () => syncPhoneCode(code, number.value));
    phones.append(field('phoneCode', code), field('recipientPhone', number));
    suggestionControls.push({ control: number, ...historyCombobox(number,
      () => history.snapshot().recipientPhones.map((value) => ({ value, label: value })),
      (choice) => syncPhoneCode(code, choice.value)) });
    fields.append(phones);
    const address = input('address.line1', { required: true, autocomplete: 'off' });
    fields.append(field('addressLine1', address));
    suggestionControls.push({ control: address, ...historyCombobox(address,
      () => history.snapshot().addresses.map((value) => ({
        value: value.line1,
        label: [value.line1, value.line2, value.city, value.region, value.postcode, value.country].filter(Boolean).join(', '),
        address: value,
      })),
      ({ address: match }) => {
      for (const key of ['line2', 'city', 'region', 'postcode', 'country']) {
        card.querySelector(`[data-suffix="address.${key}"]`).value = match[key];
      }
      setStatus('addressSelected');
    }) });
    fields.append(field('addressLine2', input('address.line2', { autocomplete: 'address-line2' })));
    fields.append(field('city', input('address.city', { maxLength: 80, autocomplete: 'address-level2' })));
    fields.append(field('region', input('address.region', { maxLength: 80, autocomplete: 'address-level1' })));
    fields.append(field('postcode', input('address.postcode', { required: true, maxLength: 20, autocomplete: 'postal-code' })));
    const country = input('address.country', { required: true, maxLength: 2, list: 'country-options', autocomplete: 'country' });
    country.value = 'MY';
    fields.append(field('countryCode', country));
    card.append(fields);
    deliveryList.append(card);
    translate(card);
    renumber();
    return card;
  }

  function collectOrder() {
    const cards = deliveryCards();
    const deliveries = cards.map((card) => {
      const get = (suffix) => card.querySelector(`[data-suffix="${suffix}"]`).value.trim();
      return {
        recipient: { fullName: get('recipient.fullName'), phone: internationalPhone(get('recipient.code'), get('recipient.phone')) },
        address: {
          line1: get('address.line1'), line2: get('address.line2'), city: get('address.city'),
          region: get('address.region'), postcode: get('address.postcode'), country: get('address.country').toUpperCase(),
        },
        items: [],
      };
    });
    for (const item of cartItems) {
      const index = cards.findIndex((card) => card.dataset.deliveryId === assignments.get(item.productId));
      deliveries[index < 0 ? 0 : index].items.push({
        productId: item.productId, quantity: item.quantity,
        expectedPriceMinor: item.product?.priceMinor, expectedCurrency: item.product?.currency,
      });
    }
    return {
      buyer: {
        fullName: document.getElementById('buyer-name').value.trim(),
        whatsappPhone: internationalPhone(document.getElementById('buyer-code').value, document.getElementById('buyer-phone').value),
        email: document.getElementById('buyer-email').value.trim() || null,
      },
      whatsappOrderContactOptIn: document.getElementById('whatsapp-opt-in').checked,
      locale: locale(),
      deliveries,
    };
  }

  const buyerPhone = document.getElementById('buyer-phone');
  const buyerCode = document.getElementById('buyer-code');
  buyerPhone.addEventListener('change', () => syncPhoneCode(buyerCode, buyerPhone.value));
  suggestionControls.push({ control: buyerPhone, ...historyCombobox(buyerPhone,
    () => history.snapshot().buyerPhones.map((value) => ({ value, label: value })),
    (choice) => syncPhoneCode(buyerCode, choice.value)) });
  document.getElementById('add-delivery').addEventListener('click', () => { addDestination()?.querySelector('[data-suffix="recipient.fullName"]').focus(); });
  document.getElementById('clear-history').addEventListener('click', () => {
    history.clear();
    refreshSuggestions();
    setStatus(history.persistent ? 'historyCleared' : 'historyStorageUnavailable');
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError('');
    setStatus('');
    if (confirmedButNotShown) { setError('receiptRenderError'); return; }
    if (!cartItems.length) { setError('emptyCart'); return; }
    const payload = collectOrder();
    if (payload.deliveries.some((delivery) => delivery.items.length === 0)) {
      setError('assignEveryDestination', 'deliveries.0.items');
      return;
    }
    const serialized = JSON.stringify(payload);
    if (!pendingIntent || pendingIntent.serialized !== serialized) {
      pendingIntent = { key: crypto.randomUUID(), serialized };
    }
    const submit = document.getElementById('submit-order');
    submit.disabled = true;
    setStatus('submittingOrder');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let serverConfirmed = false;
    let completed = false;
    try {
      const response = await fetch('/api/v1/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pendingIntent.key },
        body: serialized, signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) {
        if (result.error?.code === 'IDEMPOTENCY_CONFLICT') pendingIntent = null;
        setStatus('');
        if (result.error?.code === 'PRICE_CHANGED') {
          pendingIntent = null;
          onPriceChanged();
          return;
        }
        setError(result.error?.code === 'MIXED_CURRENCY' ? 'mixedCurrencies' :
          result.error?.code === 'PRODUCT_UNAVAILABLE' ? 'cartUnavailable' :
          result.error?.code === 'INVALID_INPUT' ? 'checkoutInvalid' : 'orderError', result.error?.field);
        return;
      }
      serverConfirmed = true;
      let historySaveFailed = false;
      if (document.getElementById('save-history').checked) {
        historySaveFailed = !history.save({
          buyerPhone: payload.buyer.whatsappPhone,
          recipientPhones: payload.deliveries.map((delivery) => delivery.recipient.phone),
          addresses: payload.deliveries.map((delivery) => delivery.address),
        });
        refreshSuggestions();
      }
      document.getElementById('save-history').checked = false;
      setStatus('');
      await onSuccess(result, { historySaveFailed });
      completed = true;
    } catch {
      setStatus('');
      setError(serverConfirmed ? 'receiptRenderError' : 'orderNetworkError');
      if (serverConfirmed) confirmedButNotShown = true;
    } finally {
      clearTimeout(timeout);
      if (!serverConfirmed || completed) submit.disabled = false;
    }
  });

  addDestination();
  refreshSuggestions();
  return {
    setItems(items) {
      cartItems = items.map(({ productId, quantity, product }) => ({ productId, quantity, product }));
      for (const key of assignments.keys()) {
        if (!cartItems.some(({ productId }) => productId === key)) assignments.delete(key);
      }
      renderAssignments();
      setError('');
    },
    refreshLocale() {
      translate(form);
      for (const card of deliveryCards()) {
        card.querySelector('[data-suffix="recipient.code"]').setAttribute('aria-label', t('phoneCode'));
      }
      renumber();
      document.getElementById('checkout-status').textContent = statusKey ? t(statusKey) : '';
      document.getElementById('checkout-error').textContent = errorKey ? t(errorKey) : '';
    },
    reset() {
      form.reset();
      deliveryList.replaceChildren();
      assignments.clear();
      cartItems = [];
      pendingIntent = null;
      confirmedButNotShown = false;
      addDestination();
      setStatus('');
      setError('');
    },
  };
}
