import { storageKey } from './storage-scope.js';
import { localPhoneInput, normalizeProfile } from './profile.js';
import { malaysiaStates, stateForPostcode } from './postcodes-my.js';
import { createModal } from '../shared/modal.js';
import { t } from '../shared/i18n.js';

const KEY = 'online-shopping-addresses-v1';
const SELECTION_KEY = 'online-shopping-checkout-address-v1';
const addressFields = ['line1', 'line2', 'city', 'region', 'postcode', 'country'];
const limits = { line1: 160, line2: 160, city: 80, region: 80, postcode: 20, country: 2 };
export const countryForCurrency = currency => currency === 'SGD' ? 'SG' : 'MY';
const codeForCountry = country => country === 'SG' ? '+65' : '+60';

function addressValues(input) {
  const address = {};
  for (const key of addressFields) {
    const value = typeof input[key] === 'string' ? input[key].trim() : '';
    if (value.length > limits[key] || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('addressInvalid');
    address[key] = key === 'country' ? value.toUpperCase() : value;
  }
  if (!/^[A-Z]{2}$/.test(address.country) || !address.line1 || !address.postcode) throw new Error('addressInvalid');
  return address;
}

export function validateAddressEntry(input) {
  const address = addressValues(input);
  if (!['MY', 'SG'].includes(address.country)) throw new Error('addressInvalid');
  const code = codeForCountry(address.country);
  const person = normalizeProfile({ fullName: input.fullName, phone: input.phone, code });
  if (!person.phone) throw new Error('profilePhoneInvalid');
  if (!address.city || !address.region) throw new Error('addressInvalid');
  if (address.country === 'MY') {
    if (!/^\d{5}$/.test(address.postcode)) throw new Error('postcodeInvalid');
    const state = stateForPostcode(address.postcode);
    if (!state) throw new Error('postcodeInvalid');
    if (state !== address.region) throw new Error('postcodeStateMismatch');
  } else if (!/^\d{6}$/.test(address.postcode) || address.region !== 'Singapore') throw new Error('postcodeInvalid');
  return { fullName: person.fullName, phone: person.phone, code, ...address };
}

function readSavedEntry(entry) {
  const address = addressValues(entry);
  const fullName = typeof entry.fullName === 'string' ? entry.fullName.trim() : '';
  const phone = typeof entry.phone === 'string' ? entry.phone.trim() : '';
  if (!fullName || fullName.length > 120 || /[\u0000-\u001f\u007f]/.test(fullName) ||
      !/^\+(?:60[1-9]\d{7,9}|65[3689]\d{7})$/.test(phone)) throw new Error();
  return { fullName, phone, code: phone.startsWith('+65') ? '+65' : '+60', ...address };
}

export function createAddressStore(storage, id = () => crypto.randomUUID()) {
  function read() {
    try {
      if (!storage) throw new Error();
      const raw = storage.getItem(storageKey(KEY));
      if (!raw) return { version: 1, entries: [], defaultId: null };
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || !Array.isArray(saved.entries)) throw new Error();
      const ids = new Set();
      const entries = saved.entries.map(entry => {
        if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) throw new Error();
        ids.add(entry.id);
        return { id: entry.id, ...readSavedEntry(entry) };
      });
      return { version: 1, entries, defaultId: ids.has(saved.defaultId) ? saved.defaultId : entries[0]?.id || null };
    } catch { throw new Error('addressStorageFailed'); }
  }
  function write(next) {
    try { storage.setItem(storageKey(KEY), JSON.stringify(next)); } catch { throw new Error('addressStorageFailed'); }
  }
  return {
    read,
    save(input, entryId = null) {
      const entry = validateAddressEntry(input);
      const data = read();
      if (entryId && !data.entries.some(item => item.id === entryId)) throw new Error('addressMissing');
      const saved = { id: entryId || id(), ...entry };
      if (entryId) data.entries = data.entries.map(item => item.id === entryId ? saved : item);
      else data.entries.push(saved);
      if (!data.defaultId) data.defaultId = saved.id;
      write(data);
      return saved;
    },
    remove(entryId) {
      const data = read();
      data.entries = data.entries.filter(item => item.id !== entryId);
      if (data.defaultId === entryId) data.defaultId = data.entries[0]?.id || null;
      write(data);
    },
    setDefault(entryId) {
      const data = read();
      if (!data.entries.some(item => item.id === entryId)) throw new Error('addressMissing');
      write({ ...data, defaultId: entryId });
    },
  };
}

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}
function button(key, handler, className = 'outline-button') {
  const element = node('button', className, t(key));
  element.type = 'button'; element.addEventListener('click', handler);
  return element;
}
export function addressSummary(entry) {
  return [entry.line1, entry.line2, entry.city, entry.region, entry.postcode, entry.country].filter(Boolean).join(', ');
}
export function mountAddressBook({ onChange, getCountry = () => 'MY' }) {
  let storage; let session;
  try { storage = localStorage; session = sessionStorage; } catch { /* Save reports unavailable storage. */ }
  const store = createAddressStore(storage);
  const modal = createModal();
  let selectedId = null;
  try { selectedId = session?.getItem(storageKey(SELECTION_KEY)) || null; } catch { /* Selection remains in memory. */ }
  let editing = null;
  let checkoutContext = false;
  let mode = 'choose';
  const pageStatus = document.getElementById('addresses-status');
  const currentCountry = () => getCountry() === 'SG' ? 'SG' : 'MY';
  function select(id) {
    selectedId = id;
    try { if (id) session?.setItem(storageKey(SELECTION_KEY), id); else session?.removeItem(storageKey(SELECTION_KEY)); } catch { /* Optional tab persistence. */ }
  }
  function usable(entry) {
    if (entry.country !== currentCountry()) return false;
    try { validateAddressEntry(entry); return true; } catch { return false; }
  }
  function selected() {
    const entry = store.read().entries.find(item => item.id === selectedId);
    return entry && usable(entry) ? entry : null;
  }
  function changed() { render(); onChange(); }
  function cancel() {
    if (mode === 'edit' && checkoutContext && store.read().entries.length) showChooser();
    else modal.close();
  }
  function card(entry, defaultId) {
    const body = node('div', 'address-copy');
    body.append(node('strong', '', entry.fullName), node('span', '', entry.phone), node('p', '', addressSummary(entry)));
    if (entry.id === defaultId) body.append(node('span', 'default-badge', t('defaultAddress')));
    if (!usable(entry)) body.append(node('p', 'checkout-error', t('addressNeedsEdit')));
    return body;
  }
  function addField(fields, name, label, max, entry, required = false) {
    const wrapper = node('label', 'checkout-field');
    wrapper.append(node('span', '', t(label)));
    const input = node('input'); input.name = name; input.maxLength = max; input.required = required;
    input.value = name === 'phone' ? localPhoneInput(entry?.phone, codeForCountry(currentCountry())) : entry?.[name] || '';
    if (name === 'phone') { input.type = 'tel'; input.inputMode = 'tel'; input.autocomplete = 'tel-national'; }
    if (name === 'postcode') { input.inputMode = 'numeric'; input.autocomplete = 'postal-code'; }
    wrapper.append(input); fields.append(wrapper);
    return input;
  }
  function showEditor(entry = null) {
    mode = 'edit'; editing = entry?.id || null;
    modal.setTitle(t(entry ? 'editAddress' : 'addAddress'));
    const form = node('form', 'address-form');
    const fields = node('div', 'checkout-fields');
    const country = currentCountry();
    const code = codeForCountry(country);
    const name = addField(fields, 'fullName', 'recipientName', 120, entry, true);
    const phoneRow = node('div', 'phone-fields');
    const prefix = node('div', 'checkout-field'); prefix.append(node('span', '', t('phoneCode')), node('strong', 'address-phone-prefix', `${country} ${code}`));
    const phoneFields = node('div', 'checkout-fields');
    const phone = addField(phoneFields, 'phone', 'recipientPhone', 32, entry, true);
    phoneRow.append(prefix, phoneFields); fields.append(phoneRow);
    phone.addEventListener('blur', () => { phone.value = localPhoneInput(phone.value, code); });
    addField(fields, 'line1', 'addressLine1', 160, entry, true);
    addField(fields, 'line2', 'addressLine2', 160, entry);
    addField(fields, 'city', 'requiredCity', 80, entry, true);
    if (country === 'MY') {
      const wrapper = node('label', 'checkout-field'); wrapper.append(node('span', '', t('requiredRegion')));
      const selectState = node('select'); selectState.name = 'region'; selectState.required = true;
      selectState.append(new Option(t('chooseState'), ''));
      for (const state of malaysiaStates) selectState.append(new Option(state, state));
      selectState.value = entry?.region || '';
      wrapper.append(selectState); fields.append(wrapper);
    } else {
      const region = node('input'); region.type = 'hidden'; region.name = 'region'; region.value = 'Singapore'; fields.append(region);
    }
    const postcode = addField(fields, 'postcode', 'postcode', country === 'MY' ? 5 : 6, entry, true);
    if (country === 'MY') {
      postcode.addEventListener('blur', () => {
        const state = stateForPostcode(postcode.value.trim());
        const selectState = form.elements.namedItem('region');
        if (state && !selectState.value) selectState.value = state;
      });
      fields.append(node('small', 'shop-note address-postcode-source', t('postcodeSource')));
    }
    const error = node('p', 'checkout-error'); error.setAttribute('role', 'alert');
    const save = node('button', 'primary-button', t('saveAddress')); save.type = 'submit';
    form.prepend(node('p', 'shop-note', t('addressLocalNotice')));
    form.append(fields, error, save); modal.content.replaceChildren(form);
    form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const value = store.save({ ...Object.fromEntries(new FormData(form)), country, code }, editing);
        if (checkoutContext) select(value.id);
        changed(); modal.close();
      } catch (failure) { error.textContent = t(failure.message); }
    });
    form.dataset.baseline = JSON.stringify([...new FormData(form)]);
    if (modal.isOpen) name.focus();
  }
  function showChooser() {
    mode = 'choose'; modal.setTitle(t('chooseAddress'));
    try {
      const data = store.read();
      const form = node('form', 'address-form'); const items = node('div', 'address-choices');
      for (const entry of data.entries) {
        const label = node('label', 'address-choice');
        const radio = node('input'); radio.type = 'radio'; radio.name = 'address'; radio.value = entry.id;
        radio.disabled = !usable(entry); radio.checked = radio.value === selectedId && !radio.disabled;
        label.append(radio, card(entry, data.defaultId)); items.append(label);
      }
      if (!data.entries.length) items.append(node('p', 'shop-note', t('noAddresses')));
      else if (!data.entries.some(entry => entry.id === selectedId && usable(entry))) items.append(node('p', 'shop-note', t('addressRequired')));
      const actions = node('div', 'cart-actions');
      const use = node('button', 'primary-button', t('useAddress')); use.type = 'submit'; use.disabled = !items.querySelector('input:checked');
      actions.append(button('addAddress', () => showEditor()), use);
      form.append(items, actions); modal.content.replaceChildren(form);
      form.addEventListener('change', () => { use.disabled = !form.querySelector('input[name="address"]:checked'); });
      form.addEventListener('submit', event => {
        event.preventDefault(); const id = new FormData(form).get('address');
        try {
          if (!store.read().entries.some(entry => entry.id === id && usable(entry))) { showChooser(); return; }
          select(id); changed(); modal.close();
        } catch (failure) { form.append(node('p', 'checkout-error', t(failure.message))); }
      });
    } catch (failure) { modal.content.replaceChildren(node('p', 'checkout-error', t(failure.message))); }
  }
  function open(choose, entry = null) {
    checkoutContext = choose;
    let hasChoices = false;
    try { hasChoices = choose && store.read().entries.length > 0; }
    catch { showChooser(); modal.open(t('chooseAddress')); return; }
    if (hasChoices) showChooser(); else showEditor(entry);
    modal.open(t(hasChoices ? 'chooseAddress' : entry ? 'editAddress' : 'addAddress'));
  }
  function render() {
    const list = document.getElementById('addresses-list'); list.replaceChildren(); pageStatus.textContent = '';
    try {
      const data = store.read();
      if (!data.entries.length) list.append(node('p', 'address-empty', t('noAddresses')));
      for (const entry of data.entries) {
        const row = node('article', 'address-card');
        const actions = node('div', 'address-actions');
        actions.append(button('editAddress', () => open(false, entry)), button('deleteAddress', () => {
          if (!window.confirm(t('deleteAddressConfirm'))) return;
          try { store.remove(entry.id); changed(); } catch (failure) { pageStatus.textContent = t(failure.message); }
        }));
        const makeDefault = button('setDefaultAddress', () => {
          try { store.setDefault(entry.id); changed(); } catch (failure) { pageStatus.textContent = t(failure.message); }
        }); makeDefault.disabled = entry.id === data.defaultId; actions.append(makeDefault);
        row.append(card(entry, data.defaultId), actions); list.append(row);
      }
    } catch (failure) { pageStatus.textContent = t(failure.message); }
  }
  document.getElementById('add-address').addEventListener('click', () => open(false));
  window.addEventListener('storage', event => { if (event.key === storageKey(KEY) || event.key === null) changed(); });
  window.addEventListener('hashchange', () => { if (modal.isOpen) modal.close(); });
  return {
    isDirty() { const form = modal.content.querySelector('form'); return modal.isOpen && mode === 'edit' && form && form.dataset.baseline !== JSON.stringify([...new FormData(form)]); },
    render, selected,
    defaultId: () => store.read().defaultId,
    ensureSelection() { if (!selectedId) select(store.read().defaultId); },
    choose: () => open(true),
    resetSelection: () => select(null),
    refreshLocale() { render(); if (modal.isOpen) { if (mode === 'choose') showChooser(); else modal.setTitle(t(editing ? 'editAddress' : 'addAddress')); } },
  };
}
