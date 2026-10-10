import { t, translate } from '../shared/i18n.js';
import { mountAppearance } from '../shared/appearance.js';
import { beginMutation } from '../shared/update-guard.js';
import { confirmModal } from '../shared/modal.js';
import { mountIntegrations } from './integrations.js';
import { mountWhatsAppConnection } from './whatsapp-connection.js';

const SHOW_INTEGRATIONS = false;

let pendingWrites = 0;

export async function request(method, path, body, csrfToken, onUnauthorized) {
  const finish = method === 'GET' ? () => {} : beginMutation();
  if (method !== 'GET') { pendingWrites++; document.dispatchEvent(new Event('updateguardchange')); }
  try {
    const response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error('request'), { code: data.error?.code, field: data.error?.field });
    return data;
  } finally { finish(); if (method !== 'GET') { pendingWrites--; document.dispatchEvent(new Event('updateguardchange')); } }
}

function status(root, key, error = false) {
  const line = root.querySelector('.settings-status');
  line.textContent = key ? t(key) : '';
  line.classList.toggle('is-error', error);
  line.dataset.statusKey = key;
}

export function mountCategories(root, { csrfToken, onUnauthorized: notifyUnauthorized }) {
  root.innerHTML = `<section class="settings-card" aria-labelledby="category-heading">
    <h2 id="category-heading" data-i18n="categoryCodes">Category codes</h2>
    <p data-i18n="categoryIntro">Manage the categories available in product forms. Codes stay fixed; deactivate unused categories.</p>
    <form id="category-create" class="settings-form">
      <label><span data-i18n="categoryCode">Code</span><input name="code" required maxlength="80" pattern="[A-Z][A-Z0-9_\\-]*" autocomplete="off" placeholder="HOME_GOODS"></label>
      <label><span data-i18n="categoryLabel">Display name</span><input name="label" required maxlength="80"></label>
      <button class="primary-button" type="submit" data-i18n="addCategory">Add category</button>
    </form>
    <p class="settings-status" role="status"></p><div id="category-list" class="settings-list"></div>
  </section>`;
  translate(root);
  const list = root.querySelector('#category-list');
  const form = root.querySelector('#category-create');
  const isCurrent = () => form.isConnected && root.contains(form);
  const onUnauthorized = () => { if (isCurrent()) notifyUnauthorized(); };
  let categories = [];
  async function load() {
    try {
      const result = await request('GET', '/api/v1/seller/categories', null, csrfToken, onUnauthorized);
      if (!isCurrent()) return;
      categories = result.items;
      render();
    } catch { if (isCurrent()) status(root, 'networkError', true); }
  }
  function render() {
    list.replaceChildren();
    for (const category of categories) {
      const row = document.createElement('form');
      row.className = 'settings-row';
      const code = document.createElement('strong');
      code.textContent = category.code;
      const label = document.createElement('input');
      label.value = category.label;
      label.maxLength = 80;
      label.required = true;
      label.setAttribute('aria-label', `${t('categoryLabel')}: ${category.code}`);
      const activeLabel = document.createElement('label');
      activeLabel.className = 'check-row';
      const active = document.createElement('input');
      active.type = 'checkbox'; active.checked = category.active;
      active.setAttribute('aria-label', `${t('categoryActive')}: ${category.code}`);
      activeLabel.append(active, document.createTextNode(t('categoryActive')));
      const save = document.createElement('button');
      save.type = 'submit'; save.className = 'secondary-button'; save.textContent = t('saveCategory');
      save.setAttribute('aria-label', `${t('saveCategory')}: ${category.code}`);
      row.append(code, label, activeLabel, save);
      row.addEventListener('submit', async (event) => {
        event.preventDefault(); save.disabled = true;
        try {
          await request('PATCH', `/api/v1/seller/categories/${encodeURIComponent(category.code)}`,
            { label: label.value, active: active.checked }, csrfToken, onUnauthorized);
          if (!isCurrent()) return;
          await load(); if (isCurrent()) status(root, 'categorySaved');
        } catch (error) { if (isCurrent()) status(root, error.code === 'DUPLICATE_CATEGORY' ? 'duplicateCategory' : 'productError', true); }
        finally { if (isCurrent()) save.disabled = false; }
      });
      list.append(row);
    }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button'); button.disabled = true;
    try {
      await request('POST', '/api/v1/seller/categories', {
        code: form.elements.code.value, label: form.elements.label.value,
      }, csrfToken, onUnauthorized);
      if (!isCurrent()) return;
      form.reset(); await load(); if (isCurrent()) status(root, 'categorySaved');
    } catch (error) { if (isCurrent()) status(root, error.code === 'DUPLICATE_CATEGORY' ? 'duplicateCategory' : 'productError', true); }
    finally { if (isCurrent()) button.disabled = false; }
  });
  load();
  return {
    isBusy: () => pendingWrites > 0,
    hasUnsavedChanges() {
      if (form.elements.code.value || form.elements.label.value) return true;
      return [...list.children].some((row, index) =>
        row.querySelector('input:not([type="checkbox"])').value !== categories[index].label ||
        row.querySelector('input[type="checkbox"]').checked !== categories[index].active);
    },
    refreshLocale() {
      translate(root);
      for (const [index, row] of [...list.children].entries()) {
        row.querySelector('input:not([type="checkbox"])').setAttribute('aria-label', `${t('categoryLabel')}: ${categories[index].code}`);
        row.querySelector('.check-row').lastChild.textContent = t('categoryActive');
        row.querySelector('.check-row input').setAttribute('aria-label', `${t('categoryActive')}: ${categories[index].code}`);
        row.querySelector('button').textContent = t('saveCategory');
        row.querySelector('button').setAttribute('aria-label', `${t('saveCategory')}: ${categories[index].code}`);
      }
      const line = root.querySelector('.settings-status');
      line.textContent = line.dataset.statusKey ? t(line.dataset.statusKey) : '';
    },
  };
}

/* Offered only when the server says this is the public fictional Demo. */
async function mountDemoReset(root, csrfToken, onUnauthorized) {
  try {
    const shop = await (await fetch('/api/v1/shop', { cache: 'no-store' })).json();
    if (shop.demoRolesAvailable !== true || !root.isConnected) return;
  } catch { return; }
  const card = document.createElement('section'); card.className = 'settings-card';
  card.innerHTML = `<h2 data-i18n="resetDemoTitle"></h2><p data-i18n="resetDemoIntro"></p>
    <button class="secondary-button" type="button" data-i18n="resetDemoButton"></button><p class="settings-status" role="status"></p>`;
  const button = card.querySelector('button'), line = card.querySelector('.settings-status');
  button.addEventListener('click', async () => {
    if (!(await confirmModal(t('resetDemoConfirm')))) return;
    button.disabled = true; line.textContent = t('loading');
    try {
      await request('POST', '/api/v1/seller/demo/reset', { confirm: true }, csrfToken, onUnauthorized);
      line.textContent = t('resetDemoDone');
      setTimeout(() => location.reload(), 1200);
    } catch { line.textContent = t('resetDemoFailed'); button.disabled = false; }
  });
  root.append(card); translate(card);
}

export function mountCompanySettings(root, { csrfToken, onUnauthorized: notifyUnauthorized }) {
  root.innerHTML = `<section class="settings-card" aria-labelledby="company-heading">
    <h2 id="company-heading" data-i18n="companySettings">Company settings</h2>
    <p data-i18n="currencyIntro">Choose the default currency for new products. Existing product prices and orders keep their own currency.</p>
    <form id="company-form" class="settings-form">
      <label><span data-i18n="defaultCurrency">Default currency</span><select name="defaultCurrency"><option value="MYR">MYR</option><option value="SGD">SGD</option></select></label>
      <label><span data-i18n="sellerWhatsAppPhone">Seller WhatsApp number</span><input name="sellerWhatsAppPhone" type="tel" inputmode="tel" autocomplete="tel" maxlength="32" placeholder="+60 / +65" aria-describedby="seller-whatsapp-help"></label>
      <p id="seller-whatsapp-help" data-i18n="sellerWhatsAppHelp">The public product page uses this number for Chat. Enter a +60 or +65 number, or leave it blank to turn Chat off.</p>
      <label class="settings-check"><input name="mobileHideBarsOnScroll" type="checkbox"><span data-i18n="mobileHideBarsOnScroll">Hide mobile navigation bars while scrolling down</span></label>
      <p class="settings-check-help" data-i18n="mobileHideBarsHelp">By default, the shop's top search bar and bottom navigation stay visible. Turn this on to hide them when shoppers scroll down and show them when they scroll up.</p>
      <h3 data-i18n="storefrontTextsTitle">Product page information</h3>
      <p id="storefront-texts-help" data-i18n="storefrontTextsHelp">Shown on every product page in the matching section. Leave a box empty to hide that section.</p>
      <label><span data-i18n="stockAndDelivery">Availability &amp; delivery</span><textarea name="availabilityText" rows="3" maxlength="1000" aria-describedby="storefront-texts-help"></textarea></label>
      <label><span data-i18n="shipping">Shipping</span><textarea name="shippingText" rows="3" maxlength="1000" aria-describedby="storefront-texts-help"></textarea></label>
      <label><span data-i18n="returnsAndGuarantees">Returns and guarantees</span><textarea name="returnsText" rows="3" maxlength="1000" aria-describedby="storefront-texts-help"></textarea></label>
      <button class="secondary-button" type="button" id="company-retry" data-i18n="retry" hidden>Retry</button>
      <button class="primary-button" type="submit" data-i18n="saveSettings">Save settings</button>
    </form><p class="settings-status" role="status"></p>
  </section>`;
  const form = root.querySelector('#company-form');
  const isCurrent = () => form.isConnected && root.contains(form);
  const onUnauthorized = () => { if (isCurrent()) notifyUnauthorized(); };
  const setup = document.createElement('section');
  setup.className = 'settings-card';
  setup.innerHTML = `<h2 data-i18n="shopSetup"></h2><p data-i18n="setupIntro"></p>
    <form class="settings-form" id="shop-setup-form">
      <label><span data-i18n="shopMode"></span><select name="mode"><option value="demo" data-i18n="demoMode"></option><option value="production" data-i18n="productionMode"></option></select></label>
      <label><span data-i18n="shopName"></span><input name="shopName" maxlength="80" value="Preview General Store" required></label>
      <button class="primary-button" type="submit" data-i18n="setupShop" disabled></button>
    </form><p class="setup-status" role="status"></p>`;
  root.prepend(setup);
  const appearance = document.createElement('section'); appearance.className = 'settings-card';
  root.append(appearance); mountAppearance(appearance, 'seller');
  // Provider cards stay hidden until a provider can really be connected; an all-"Not configured" list reads as unfinished.
  const integrations = SHOW_INTEGRATIONS ? mountIntegrations(root, { csrfToken, onUnauthorized }) : { refreshLocale() {} };
  const whatsapp = mountWhatsAppConnection(root, { csrfToken, onUnauthorized, request });
  const setupForm = setup.querySelector('form');
  const setupStatus = setup.querySelector('.setup-status');
  const setupButton = setupForm.querySelector('button');
  const syncName = () => {
    setupForm.elements.shopName.disabled = setupForm.elements.mode.value === 'demo';
    if (setupForm.elements.mode.value === 'demo') setupForm.elements.shopName.value = 'Preview General Store';
    else if (setupForm.elements.shopName.value === 'Preview General Store') setupForm.elements.shopName.value = '';
  };
  syncName();
  setupForm.elements.mode.addEventListener('change', syncName);
  let setupState = null;
  function showSetup(value) {
    if (!isCurrent()) return;
    setupState = value;
    setupForm.hidden = Boolean(value.mode);
    setup.querySelector('h2').dataset.i18n = value.mode ? 'shopConfigured' : 'shopSetup';
    setup.querySelector('h2').textContent = t(value.mode ? 'shopConfigured' : 'shopSetup');
    setup.querySelector('[data-i18n="setupIntro"]').hidden = Boolean(value.mode);
    if (value.mode) {
      setupStatus.textContent = `${value.shopName} — ${t(value.mode === 'demo' ? 'demoMode' : 'productionMode')}`;
      root.append(setup);
    } else {
      root.prepend(setup);
    }
    setupButton.disabled = false;
  }
  request('GET', '/api/v1/seller/setup', null, csrfToken, onUnauthorized)
    .then((value) => { if (isCurrent()) showSetup(value); })
    .catch(() => { if (isCurrent()) setupStatus.textContent = t('networkError'); });
  setupForm.addEventListener('submit', async (event) => {
    event.preventDefault(); setupButton.disabled = true;
    setupStatus.textContent = t('loading');
    try {
      const value = await request('POST', '/api/v1/seller/setup', {
        mode: setupForm.elements.mode.value, shopName: setupForm.elements.shopName.value,
      }, csrfToken, onUnauthorized);
      showSetup(value);
    } catch (error) {
      if (isCurrent()) setupStatus.textContent = t(['SHOP_ALREADY_CONFIGURED', 'SHOP_NOT_EMPTY'].includes(error.code) ? 'setupConflict' : 'productError');
    } finally { if (isCurrent()) setupButton.disabled = false; }
  });
  mountDemoReset(root, csrfToken, onUnauthorized);
  translate(root);
  const saveButton = form.querySelector('[type="submit"]');
  const retryButton = form.querySelector('#company-retry');
  saveButton.disabled = true;
  let currencyEdited = false;
  let phoneEdited = false;
  let mobileBarsEdited = false;
  let savedState = null;
  const textFields = ['availabilityText', 'shippingText', 'returnsText'];
  let textsEdited = false;
  const textValues = () => Object.fromEntries(textFields.map(name => [name, form.elements[name].value]));
  const currentState = () => JSON.stringify({
    defaultCurrency: form.elements.defaultCurrency.value,
    sellerWhatsAppPhone: form.elements.sellerWhatsAppPhone.value,
    mobileHideBarsOnScroll: form.elements.mobileHideBarsOnScroll.checked,
    ...textValues(),
  });
  const initialState = currentState();
  const setupBaseline = JSON.stringify([setupForm.elements.mode.value, setupForm.elements.shopName.value]);
  form.elements.defaultCurrency.addEventListener('change', () => { currencyEdited = true; });
  form.elements.sellerWhatsAppPhone.addEventListener('input', () => { phoneEdited = true; });
  form.elements.mobileHideBarsOnScroll.addEventListener('change', () => { mobileBarsEdited = true; });
  for (const name of textFields) form.elements[name].addEventListener('input', () => { textsEdited = true; });
  async function loadSettings() {
    retryButton.disabled = true;
    try {
      const settings = await request('GET', '/api/v1/seller/company-settings', null, csrfToken, onUnauthorized);
      if (!isCurrent()) return;
      if (!currencyEdited) form.elements.defaultCurrency.value = settings.defaultCurrency;
      if (!phoneEdited) form.elements.sellerWhatsAppPhone.value = settings.sellerWhatsAppPhone ? `+${settings.sellerWhatsAppPhone}` : '';
      if (!mobileBarsEdited) form.elements.mobileHideBarsOnScroll.checked = settings.mobileHideBarsOnScroll === true;
      if (!textsEdited) for (const name of textFields) form.elements[name].value = settings[name] || '';
      savedState = JSON.stringify({
        defaultCurrency: settings.defaultCurrency,
        sellerWhatsAppPhone: settings.sellerWhatsAppPhone ? `+${settings.sellerWhatsAppPhone}` : '',
        mobileHideBarsOnScroll: settings.mobileHideBarsOnScroll === true,
        ...Object.fromEntries(textFields.map(name => [name, settings[name] || ''])),
      });
      saveButton.disabled = false;
      retryButton.hidden = true;
      status(root, '');
    } catch {
      if (isCurrent()) { retryButton.hidden = false; status(root, 'networkError', true); }
    } finally { if (isCurrent()) retryButton.disabled = false; }
  }
  retryButton.addEventListener('click', loadSettings);
  loadSettings();
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); saveButton.disabled = true;
    for (const input of form.querySelectorAll('input, select, textarea')) input.disabled = true;
    try {
      const settings = await request('PATCH', '/api/v1/seller/company-settings', {
        defaultCurrency: form.elements.defaultCurrency.value,
        sellerWhatsAppPhone: form.elements.sellerWhatsAppPhone.value.trim(),
        mobileHideBarsOnScroll: form.elements.mobileHideBarsOnScroll.checked,
        ...textValues(),
      }, csrfToken, onUnauthorized);
      if (!isCurrent()) return;
      form.elements.sellerWhatsAppPhone.value = settings.sellerWhatsAppPhone ? `+${settings.sellerWhatsAppPhone}` : '';
      form.elements.mobileHideBarsOnScroll.checked = settings.mobileHideBarsOnScroll;
      for (const name of textFields) form.elements[name].value = settings[name] || '';
      savedState = currentState();
      currencyEdited = phoneEdited = mobileBarsEdited = textsEdited = false;
      status(root, 'settingsSaved');
    } catch (error) { if (isCurrent()) status(root, error.code === 'COMPANY_CURRENCY_CONFLICT' ? 'currencyConflict' : error.field === 'sellerWhatsAppPhone' ? 'sellerWhatsAppInvalid' : 'productError', true); }
    finally {
      if (isCurrent()) {
        for (const input of form.querySelectorAll('input, select, textarea')) input.disabled = false;
        saveButton.disabled = false;
      }
    }
  });
  return {
    isBusy: () => pendingWrites > 0,
    hasUnsavedChanges() {
      return currentState() !== (savedState ?? initialState) ||
        (!setupForm.hidden && JSON.stringify([setupForm.elements.mode.value, setupForm.elements.shopName.value]) !== setupBaseline);
    },
    refreshLocale() {
      translate(root);
      if (setupState?.mode) showSetup(setupState);
      integrations.refreshLocale();
      whatsapp.refreshLocale();
      const line = root.querySelector('.settings-status');
      line.textContent = line.dataset.statusKey ? t(line.dataset.statusKey) : '';
    },
  };
}
