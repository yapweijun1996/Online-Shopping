import { t, translate } from '../shared/i18n.js';

async function request(method, path, body, csrfToken, onUnauthorized) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error('request'), { code: data.error?.code, field: data.error?.field });
  return data;
}

function status(root, key, error = false) {
  const line = root.querySelector('.settings-status');
  line.textContent = key ? t(key) : '';
  line.classList.toggle('is-error', error);
  line.dataset.statusKey = key;
}

export function mountCategories(root, { csrfToken, onUnauthorized }) {
  root.innerHTML = `<section class="settings-card" aria-labelledby="category-heading">
    <h2 id="category-heading" data-i18n="categoryCodes">Category codes</h2>
    <p data-i18n="categoryIntro">Manage the categories available in product forms. Codes stay fixed; deactivate unused categories.</p>
    <form id="category-create" class="settings-form">
      <label><span data-i18n="categoryCode">Code</span><input name="code" required maxlength="80" pattern="[A-Z][A-Z0-9_-]*" autocomplete="off" placeholder="HOME_GOODS"></label>
      <label><span data-i18n="categoryLabel">Display name</span><input name="label" required maxlength="80"></label>
      <button class="primary-button" type="submit" data-i18n="addCategory">Add category</button>
    </form>
    <p class="settings-status" role="status"></p><div id="category-list" class="settings-list"></div>
  </section>`;
  translate(root);
  const list = root.querySelector('#category-list');
  const form = root.querySelector('#category-create');
  let categories = [];
  async function load() {
    try {
      const result = await request('GET', '/api/v1/seller/categories', null, csrfToken, onUnauthorized);
      if (!root.isConnected) return;
      categories = result.items;
      render();
    } catch { if (root.isConnected) status(root, 'networkError', true); }
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
      activeLabel.append(active, document.createTextNode(t('categoryActive')));
      const save = document.createElement('button');
      save.type = 'submit'; save.className = 'secondary-button'; save.textContent = t('saveCategory');
      row.append(code, label, activeLabel, save);
      row.addEventListener('submit', async (event) => {
        event.preventDefault(); save.disabled = true;
        try {
          await request('PATCH', `/api/v1/seller/categories/${encodeURIComponent(category.code)}`,
            { label: label.value, active: active.checked }, csrfToken, onUnauthorized);
          await load(); status(root, 'categorySaved');
        } catch (error) { status(root, error.code === 'DUPLICATE_CATEGORY' ? 'duplicateCategory' : 'productError', true); }
        finally { save.disabled = false; }
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
      form.reset(); await load(); status(root, 'categorySaved');
    } catch (error) { status(root, error.code === 'DUPLICATE_CATEGORY' ? 'duplicateCategory' : 'productError', true); }
    finally { button.disabled = false; }
  });
  load();
  return { refreshLocale() {
    translate(root);
    for (const [index, row] of [...list.children].entries()) {
      row.querySelector('input:not([type="checkbox"])').setAttribute('aria-label', `${t('categoryLabel')}: ${categories[index].code}`);
      row.querySelector('.check-row').lastChild.textContent = t('categoryActive');
      row.querySelector('button').textContent = t('saveCategory');
    }
    const line = root.querySelector('.settings-status');
    line.textContent = line.dataset.statusKey ? t(line.dataset.statusKey) : '';
  } };
}

export function mountCompanySettings(root, { csrfToken, onUnauthorized }) {
  root.innerHTML = `<section class="settings-card" aria-labelledby="company-heading">
    <h2 id="company-heading" data-i18n="companySettings">Company settings</h2>
    <p data-i18n="currencyIntro">Choose the default currency for new products. Existing product prices and orders keep their own currency.</p>
    <form id="company-form" class="settings-form">
      <label><span data-i18n="defaultCurrency">Default currency</span><select name="defaultCurrency"><option value="MYR">MYR</option><option value="SGD">SGD</option></select></label>
      <button class="primary-button" type="submit" data-i18n="saveSettings">Save settings</button>
    </form><p class="settings-status" role="status"></p>
  </section>`;
  translate(root);
  const form = root.querySelector('#company-form');
  request('GET', '/api/v1/seller/company-settings', null, csrfToken, onUnauthorized)
    .then((settings) => { if (root.isConnected) form.elements.defaultCurrency.value = settings.defaultCurrency; })
    .catch(() => { if (root.isConnected) status(root, 'networkError', true); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
    try {
      await request('PATCH', '/api/v1/seller/company-settings', { defaultCurrency: form.elements.defaultCurrency.value }, csrfToken, onUnauthorized);
      status(root, 'settingsSaved');
    } catch { status(root, 'productError', true); }
    finally { button.disabled = false; }
  });
  return { refreshLocale() {
    translate(root);
    const line = root.querySelector('.settings-status');
    line.textContent = line.dataset.statusKey ? t(line.dataset.statusKey) : '';
  } };
}
