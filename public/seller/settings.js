import './sender-copy.js';
import { mountCompanyTabs } from './company-tabs.js';
import { mountAiSettings } from './ai-settings.js';
import { senderInputLimits } from '../shared/sender-fields.js';
import { mountSenderFields } from './sender-form.js';
const senderInputs = senderInputLimits;
import { apiUrl } from '../shared/base-path.js';
import { t, translate } from '../shared/i18n.js';
import { mountAppearance } from '../shared/appearance.js';
import { beginMutation } from '../shared/update-guard.js';
import { confirmModal } from '../shared/modal.js';
import { mountIntegrations } from './integrations.js';
import { mountWhatsAppConnection } from './whatsapp-connection.js';
import { mountWhatsAppQr } from './whatsapp-qr.js';

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
      const result = await request('GET', apiUrl('v1/seller/categories'), null, csrfToken, onUnauthorized);
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
          await request('PATCH', apiUrl(`v1/seller/categories/${encodeURIComponent(category.code)}`),
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
      await request('POST', apiUrl('v1/seller/categories'), {
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
    const shop = await (await fetch(apiUrl('v1/shop'), { cache: 'no-store' })).json();
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
      await request('POST', apiUrl('v1/seller/demo/reset'), { confirm: true }, csrfToken, onUnauthorized);
      line.textContent = t('resetDemoDone');
      setTimeout(() => location.reload(), 1200);
    } catch { line.textContent = t('resetDemoFailed'); button.disabled = false; }
  });
  root.append(card); translate(card);
}

export function mountCompanySettings(root, { csrfToken, onUnauthorized: notifyUnauthorized, role = 'OWNER' }) {
  root.innerHTML = `<section class="settings-card" aria-labelledby="company-heading">
    <form id="company-form" class="settings-form" novalidate>
      <div id="company-group-general">
    <h2 id="company-heading" data-i18n="companySettings">Company settings</h2>
    <p data-i18n="currencyIntro">Choose the default currency for new products. Existing product prices and orders keep their own currency.</p>
      <label><span data-i18n="defaultCurrency">Default currency</span><select name="defaultCurrency"><option value="MYR">MYR</option><option value="SGD">SGD</option></select></label>
      <label><span data-i18n="sellerWhatsAppPhone">Seller WhatsApp number</span><input name="sellerWhatsAppPhone" type="tel" inputmode="tel" autocomplete="tel" maxlength="32" placeholder="+60 / +65" aria-describedby="seller-whatsapp-help"></label>
      <p id="seller-whatsapp-help" data-i18n="sellerWhatsAppHelp">The public product page uses this number for Chat. Enter a +60 or +65 number, or leave it blank to turn Chat off.</p>
      <label class="settings-check"><input name="mobileHideBarsOnScroll" type="checkbox"><span data-i18n="mobileHideBarsOnScroll">Hide mobile navigation bars while scrolling down</span></label>
      <p class="settings-check-help" data-i18n="mobileHideBarsHelp">By default, the shop's top search bar and bottom navigation stay visible. Turn this on to hide them when shoppers scroll down and show them when they scroll up.</p>
      </div>
      <div id="company-group-storefront">
      <h2 data-i18n="storefrontTextsTitle">Product page information</h2>
      <p id="storefront-texts-help" data-i18n="storefrontTextsHelp">Shown on every product page in the matching section. Leave a box empty to hide that section.</p>
      <label><span data-i18n="stockAndDelivery">Availability &amp; delivery</span><textarea name="availabilityText" rows="3" maxlength="1000" aria-describedby="storefront-texts-help"></textarea></label>
      <label><span data-i18n="shipping">Shipping</span><textarea name="shippingText" rows="3" maxlength="1000" aria-describedby="storefront-texts-help"></textarea></label>
      <label><span data-i18n="returnsAndGuarantees">Returns and guarantees</span><textarea name="returnsText" rows="3" maxlength="1000" aria-describedby="storefront-texts-help"></textarea></label>
      </div>
      <div id="company-group-shipping"></div>
      <button class="secondary-button" type="button" id="company-retry" data-i18n="retry" hidden>Retry</button>
      <button class="primary-button" type="submit" data-i18n="saveSettings">Save settings</button>
    </form><p class="settings-status" role="status"></p>
  </section>`;
  const form = root.querySelector('#company-form');
  let disposed = false;
  const identity = csrfToken();
  const isCurrent = () => !disposed && form.isConnected && root.contains(form) && csrfToken() === identity;
  const sender = mountSenderFields(form.querySelector('#company-group-shipping'));
  const onUnauthorized = () => { if (isCurrent()) notifyUnauthorized(); };
  const setup = document.createElement('section');
  setup.className = 'settings-card';
  setup.innerHTML = `<h2 data-i18n="shopSetup"></h2><p data-i18n="setupIntro"></p>
    <form class="settings-form" id="shop-setup-form">
      <label><span data-i18n="shopMode"></span><select name="mode"><option value="demo" data-i18n="demoMode"></option><option value="production" data-i18n="productionMode"></option></select></label>
      <label><span data-i18n="shopName"></span><input name="shopName" maxlength="80" value="Preview General Store" required></label>
      <button class="primary-button" type="submit" data-i18n="setupShop" disabled></button>
    </form><p class="setup-status" role="status"></p>`;
  const formCard = form.closest('.settings-card');
  formCard.before(setup);
  const appearance = document.createElement('section'); appearance.className = 'settings-card';
  const messaging = document.createElement('div'), extras = document.createElement('div');
  extras.className = 'company-extra';
  root.append(extras, messaging, appearance); mountAppearance(appearance, 'seller');
  // Provider cards stay hidden until a provider can really be connected; an all-"Not configured" list reads as unfinished.
  const integrations = SHOW_INTEGRATIONS ? mountIntegrations(messaging, { csrfToken, onUnauthorized }) : { refreshLocale() {} };
  const whatsapp = mountWhatsAppConnection(messaging, { csrfToken, onUnauthorized, request });
  const whatsappQr = mountWhatsAppQr(messaging, { csrfToken, onUnauthorized, role });
  const groups = { general: form.querySelector('#company-group-general'), storefront: form.querySelector('#company-group-storefront'), shipping: form.querySelector('#company-group-shipping') };
  const ai = role === 'OWNER' ? mountAiSettings(root, { csrfToken, onUnauthorized }) : null;
  let activeGroup = 'general';
  const tabs = mountCompanyTabs(root, [
    { id: 'general', label: 'companyTabGeneral', panels: [setup, groups.general, extras] },
    { id: 'storefront', label: 'companyTabStorefront', panels: [groups.storefront] },
    { id: 'shipping', label: 'companyTabShipping', panels: [groups.shipping] },
    { id: 'messaging', label: 'companyTabMessaging', panels: [messaging] },
    { id: 'appearance', label: 'companyTabAppearance', panels: [appearance] },
  ], { onSelect: (id) => { activeGroup = id; formCard.hidden = !['general', 'storefront', 'shipping'].includes(id); syncCompanyControls(); } });
  ai?.ready.then(available => { if (available && isCurrent()) tabs.add({ id: 'ai', label: 'ai_title', panels: [ai.section] }); });
  const tabOfField = (field = '') => field.startsWith('sender') ? 'shipping' : ['availabilityText', 'shippingText', 'returnsText'].includes(field) ? 'storefront' : 'general';
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
    }
    setupButton.disabled = false;
  }
  request('GET', apiUrl('v1/seller/setup'), null, csrfToken, onUnauthorized)
    .then((value) => { if (isCurrent()) showSetup(value); })
    .catch(() => { if (isCurrent()) setupStatus.textContent = t('networkError'); });
  setupForm.addEventListener('submit', async (event) => {
    event.preventDefault(); setupButton.disabled = true;
    setupStatus.textContent = t('loading');
    try {
      const value = await request('POST', apiUrl('v1/seller/setup'), {
        mode: setupForm.elements.mode.value, shopName: setupForm.elements.shopName.value,
      }, csrfToken, onUnauthorized);
      showSetup(value);
    } catch (error) {
      if (isCurrent()) setupStatus.textContent = t(['SHOP_ALREADY_CONFIGURED', 'SHOP_NOT_EMPTY'].includes(error.code) ? 'setupConflict' : 'productError');
    } finally { if (isCurrent()) setupButton.disabled = false; }
  });
  mountDemoReset(extras, csrfToken, onUnauthorized);
  translate(root);
  const saveButton = form.querySelector('[type="submit"]');
  const retryButton = form.querySelector('#company-retry');
  const companyGroups = {
    general: ['defaultCurrency', 'sellerWhatsAppPhone', 'mobileHideBarsOnScroll'],
    storefront: ['availabilityText', 'shippingText', 'returnsText'],
    shipping: Object.keys(senderInputs),
  };
  let loaded = false, loadingSettings = false, loadSequence = 0, pendingGroup = null, forbidden = false;
  const baselines = {}, feedback = {}, errors = new Map();
  const setupBaseline = JSON.stringify([setupForm.elements.mode.value, setupForm.elements.shopName.value]);
  function groupValues(group) {
    return Object.fromEntries(companyGroups[group].map(name => [name, name === 'senderCountry' ? sender.countryValue() : name === 'mobileHideBarsOnScroll' ? form.elements[name].checked : form.elements[name].value]));
  }
  const groupDirty = group => loaded && JSON.stringify(groupValues(group)) !== JSON.stringify(baselines[group]);
  function validSettings(settings) {
    return settings && typeof settings.defaultCurrency === 'string' && typeof settings.mobileHideBarsOnScroll === 'boolean' && Object.values(companyGroups).flat().every(name => Object.hasOwn(settings, name) && (name === 'mobileHideBarsOnScroll' || settings[name] === null || typeof settings[name] === 'string'));
  }
  function canonical(settings, group) {
    return Object.fromEntries(companyGroups[group].map(name => [name, name === 'mobileHideBarsOnScroll' ? settings[name] === true : ['senderPhone', 'sellerWhatsAppPhone'].includes(name) && settings[name] ? `+${settings[name]}` : settings[name] || '']));
  }
  function hydrate(group, values) {
    for (const [name, value] of Object.entries(values)) {
      if (name === 'senderCountry') sender.setCountry(value);
      else if (name === 'mobileHideBarsOnScroll') form.elements[name].checked = value;
      else form.elements[name].value = value;
    }
  }
  function clearFieldError(name) {
    const saved = errors.get(name); if (!saved) return;
    saved.input.removeAttribute('aria-invalid');
    if (saved.describedBy) saved.input.setAttribute('aria-describedby', saved.describedBy); else saved.input.removeAttribute('aria-describedby');
    saved.node.remove(); errors.delete(name);
  }
  function markFieldError(name, key) {
    const input = name.startsWith('sender') ? sender.field(name) : form.elements[name]; if (!input) return;
    clearFieldError(name);
    const node = document.createElement('small'); node.id = `company-error-${name}`; node.className = 'company-field-error'; node.dataset.i18n = key; node.textContent = t(key);
    const describedBy = input.getAttribute('aria-describedby'); input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', [describedBy, node.id].filter(Boolean).join(' ')); input.after(node);
    errors.set(name, { input, node, describedBy });
  }
  function syncCompanyControls() {
    // Company tabs select their initial panel synchronously before this form controller is initialized.
    if (!form.querySelector('[data-company-ready]')) return;
    for (const [group, fields] of Object.entries(companyGroups)) for (const name of fields) form.elements[name].disabled = !loaded || loadingSettings || forbidden || pendingGroup === group;
    form.elements.senderCountryOther.disabled = form.elements.senderCountry.value !== '__other__' || !loaded || loadingSettings || forbidden || pendingGroup === 'shipping';
    saveButton.disabled = !loaded || loadingSettings || forbidden || pendingGroup !== null || !companyGroups[activeGroup] || !groupDirty(activeGroup);
    saveButton.dataset.i18n = pendingGroup === activeGroup ? 'companySaving' : activeGroup === 'shipping' ? 'senderSave' : 'saveSettings'; saveButton.textContent = t(saveButton.dataset.i18n);
    form.setAttribute('aria-busy', String(Boolean(pendingGroup) || loadingSettings));
    const message = feedback[activeGroup];
    status(root, loadingSettings ? 'loading' : message?.key || (companyGroups[activeGroup] && groupDirty(activeGroup) ? 'companyUnsaved' : ''), message?.error === true);
    document.dispatchEvent(new Event('updateguardchange'));
  }
  // A non-secret initialization marker permits the first tab callback to be a harmless no-op.
  saveButton.dataset.companyReady = 'true';
  function onEdit(event) {
    const name = event.target.name === 'senderCountryOther' ? 'senderCountry' : event.target.name;
    const group = Object.keys(companyGroups).find(group => companyGroups[group].includes(name)); if (!group) return;
    clearFieldError(name);
    if (!feedback[group]?.error || feedback[group]?.field === name) delete feedback[group];
    syncCompanyControls();
  }
  form.addEventListener('input', onEdit); form.addEventListener('change', onEdit);
  async function loadSettings() {
    if (!isCurrent() || loadingSettings || pendingGroup !== null) return;
    const ticket = ++loadSequence; loadingSettings = true; retryButton.disabled = true; syncCompanyControls();
    try {
      const settings = await request('GET', apiUrl('v1/seller/company-settings'), null, csrfToken, onUnauthorized);
      if (!isCurrent() || ticket !== loadSequence) return;
      if (!validSettings(settings)) throw new Error('invalid company settings');
      for (const group of Object.keys(companyGroups)) {
        const values = canonical(settings, group); const keepDraft = loaded && groupDirty(group);
        if (!keepDraft) hydrate(group, values);
        baselines[group] = values;
      }
      loaded = true; forbidden = false; retryButton.hidden = true;
      for (const group of Object.keys(companyGroups)) if (feedback[group]?.load) delete feedback[group];
    } catch (error) {
      if (!isCurrent() || ticket !== loadSequence || error.message === 'unauthorized') return;
      forbidden = error.code === 'FORBIDDEN'; retryButton.hidden = false;
      for (const group of Object.keys(companyGroups)) feedback[group] = { key: forbidden ? 'companyForbidden' : 'networkError', error: true, load: true };
    } finally { if (isCurrent() && ticket === loadSequence) { loadingSettings = false; retryButton.disabled = false; syncCompanyControls(); } }
  }
  retryButton.addEventListener('click', loadSettings);
  syncCompanyControls(); loadSettings();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const group = activeGroup;
    if (!isCurrent() || !loaded || loadingSettings || forbidden || pendingGroup !== null || !companyGroups[group] || !groupDirty(group)) return;
    const body = groupValues(group); pendingGroup = group; delete feedback[group];
    for (const name of companyGroups[group]) clearFieldError(name);
    syncCompanyControls();
    let focusField = null;
    try {
      const settings = await request('PATCH', apiUrl('v1/seller/company-settings'), body, csrfToken, onUnauthorized);
      if (!isCurrent()) return;
      if (!validSettings(settings)) throw Object.assign(new Error('invalid company settings response'), { code: 'INVALID_SETTINGS_RESPONSE' });
      const values = canonical(settings, group); hydrate(group, values); baselines[group] = values;
      feedback[group] = { key: group === 'shipping' ? 'senderSaved' : 'settingsSaved', error: false };
    } catch (error) {
      if (!isCurrent() || error.message === 'unauthorized') return;
      const target = error.code === 'COMPANY_CURRENCY_CONFLICT' ? 'general' : error.field ? tabOfField(error.field) : group;
      const key = error.code === 'INVALID_SETTINGS_RESPONSE' ? 'companySaveUnconfirmed' : error.code === 'FORBIDDEN' ? 'companyForbidden' : error.code === 'COMPANY_CURRENCY_CONFLICT' ? 'currencyConflict' : error.field === 'sellerWhatsAppPhone' ? 'sellerWhatsAppInvalid' : error.field?.startsWith('sender') ? 'senderInvalid' : 'companySaveFailed';
      forbidden = error.code === 'FORBIDDEN'; if (forbidden || error.code === 'INVALID_SETTINGS_RESPONSE') retryButton.hidden = false;
      feedback[target] = { key, error: true, field: error.field }; tabs.select(target);
      if (error.field && companyGroups[target]?.includes(error.field)) { markFieldError(error.field, key); focusField = error.field; }
    } finally {
      if (isCurrent()) {
        pendingGroup = null; syncCompanyControls();
        if (focusField) (focusField.startsWith('sender') ? sender.field(focusField) : form.elements[focusField])?.focus();
      }
    }
  });
  return {
    dispose() { disposed = true; loadSequence++; whatsapp.dispose(); whatsappQr.dispose(); },
    isBusy: () => Boolean(pendingGroup) || loadingSettings || pendingWrites > 0 || Boolean(ai?.isBusy()) || whatsapp.isBusy(),
    draftSignature: () => whatsapp.draftSignature(),
    hasUnsavedChanges() {
      return whatsapp.hasUnsavedChanges() || Boolean(ai?.hasUnsavedChanges()) || Object.keys(companyGroups).some(groupDirty) ||
        (!setupForm.hidden && JSON.stringify([setupForm.elements.mode.value, setupForm.elements.shopName.value]) !== setupBaseline);
    },
    refreshLocale() {
      translate(root); tabs.refreshLocale(); sender.refreshLocale(); syncCompanyControls();
      if (setupState?.mode) showSetup(setupState);
      integrations.refreshLocale();
      whatsapp.refreshLocale();
      whatsappQr.refreshLocale();
      ai?.refreshLocale();

    },
  };
}
