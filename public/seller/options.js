import { languages, t, translate } from '../shared/i18n.js';
import { request } from './settings.js';
import { priceToMinor, stockFromInput } from './product-fields.js';

/*
 * Seller editor for product options. Everything here is tenant-defined: the seller creates option types
 * (colour, size, storage, anything) and their values, then generates one product (SKU) per combination.
 */
const swatchPattern = /^#[0-9a-f]{6}$/i;
const displays = [['button', 'displayButton'], ['swatch', 'displaySwatch'], ['image', 'displayImage'], ['dropdown', 'displayDropdown']];

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function field(labelText, input) {
  const label = el('label'); label.append(el('span', '', labelText), input);
  return label;
}

/** Every combination of the chosen values: [{ type, value }, ...] per row, types in the given order. */
export function combinations(selected) {
  let rows = [[]];
  for (const { type, values } of selected) rows = rows.flatMap((row) => values.map((value) => [...row, { type, value }]));
  return selected.length ? rows : [];
}

export function skuFor(prefix, index) {
  return `${prefix.toUpperCase()}-${String(index + 1).padStart(3, '0')}`;
}

export function mountOptions(root, { csrfToken, onUnauthorized: notifyUnauthorized }) {
  root.innerHTML = `
    <section class="settings-card" aria-labelledby="option-types-heading">
      <h2 id="option-types-heading" data-i18n="optionTypesTitle">Option types</h2>
      <p data-i18n="optionsIntro">Define your own options, such as colour, size or storage, then create product variants from them.</p>
      <form id="option-type-create" class="settings-form">
        <label><span data-i18n="optionTypeName">Option name</span><input name="name" required maxlength="60" autocomplete="off"></label>
        <label><span data-i18n="optionDisplay">Display style</span><select name="display"></select></label>
        <button class="primary-button" type="submit" data-i18n="addOptionType">Add option type</button>
      </form>
      <p class="settings-status" role="status"></p>
      <div id="option-type-list" class="option-type-list"></div>
    </section>
    <section class="settings-card option-generator" aria-labelledby="generator-heading">
      <h2 id="generator-heading" data-i18n="generatorTitle">Create variants</h2>
      <p data-i18n="generatorIntro">Pick values from your option types and create one product (SKU) for every combination.</p>
      <form id="generator-form" class="settings-form">
        <h3 data-i18n="generatorBaseTitle">Shared details</h3>
        <label><span data-i18n="variantGroup">Variant group</span><input name="group" required maxlength="40" autocomplete="off" placeholder="PHONE-X"></label>
        <label><span data-i18n="generatorSkuPrefix">SKU prefix</span><input name="prefix" required maxlength="30" autocomplete="off" placeholder="PX"></label>
        <label><span data-i18n="name">Name</span><input name="name" required maxlength="120"></label>
        <label><span data-i18n="category">Category</span><select name="category" required></select></label>
        <label><span data-i18n="price">Price</span><input name="price" required inputmode="decimal"></label>
        <label><span data-i18n="stockQuantity">Stock quantity</span><input name="stock" inputmode="numeric" autocomplete="off"></label>
        <label class="full"><span data-i18n="description">Description</span><textarea name="description" required maxlength="2000" rows="3"></textarea></label>
        <h3 data-i18n="generatorPickValues">Choose the values to combine</h3>
        <div id="generator-values" class="generator-values"></div>
        <h3 data-i18n="generatorRows">Combinations</h3>
        <div class="generator-table-wrap"><table class="generator-table"><thead><tr>
          <th data-i18n="generatorCombination">Combination</th><th data-i18n="sku">SKU</th><th data-i18n="price">Price</th><th data-i18n="stockQuantity">Stock quantity</th><th data-i18n="generatorInclude">Create</th>
        </tr></thead><tbody></tbody></table></div>
        <p class="generator-note" role="status"></p>
        <button class="primary-button" type="submit" id="generator-submit" disabled data-i18n="generatorSubmit">Create products</button>
      </form>
      <p class="settings-status generator-status" role="status"></p>
    </section>`;
  translate(root);
  const typeForm = root.querySelector('#option-type-create');
  const list = root.querySelector('#option-type-list');
  const statusLine = root.querySelector('.settings-status');
  const generator = root.querySelector('#generator-form');
  const generatorStatus = root.querySelector('.generator-status');
  const note = root.querySelector('.generator-note');
  const submit = root.querySelector('#generator-submit');
  const tbody = root.querySelector('tbody');
  const isCurrent = () => typeForm.isConnected && root.contains(typeForm);
  const onUnauthorized = () => { if (isCurrent()) notifyUnauthorized(); };
  const call = (method, path, body) => request(method, path, body, csrfToken, onUnauthorized);
  let types = [], limits = { combinationsPerGroup: 300 }, currency = 'MYR', busy = 0;
  const openTypes = new Set();
  const rowState = new Map();   // combination key -> edited { sku, price, stock, include }
  const chosen = new Map();     // value id -> checked

  const setStatus = (key, error = false, vars = {}) => {
    statusLine.dataset.statusKey = key || '';
    statusLine.textContent = key ? Object.entries(vars).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key)) : '';
    statusLine.classList.toggle('is-error', error);
  };
  const failureKey = (error) => error.code === 'DUPLICATE_OPTION' ? 'optionDuplicate' : 'optionError';
  async function write(method, path, body, done) {
    busy++;
    try {
      const result = await call(method, path, body);
      if (!isCurrent()) return;
      await load();
      if (isCurrent()) { setStatus('optionSaved'); done?.(result); }
    } catch (error) { if (isCurrent()) setStatus(failureKey(error), true); }
    finally { busy--; }
  }

  const displaySelect = (current) => {
    const select = el('select');
    select.name = 'display';
    for (const [value, key] of displays) { const option = el('option', '', t(key)); option.value = value; option.selected = value === current; select.append(option); }
    return select;
  };
  typeForm.elements.display.replaceWith(displaySelect('button'));

  function translationInputs(existing = {}) {
    const wrap = el('details', 'option-translations');
    wrap.append(el('summary', '', t('optionTranslations')), el('p', 'settings-check-help', t('optionTranslationsHelp')));
    for (const { code, label } of languages.filter((language) => language.code !== 'en')) {
      const input = el('input'); input.dataset.locale = code; input.maxLength = 80; input.value = existing[code] || ''; input.lang = code;
      wrap.append(field(label, input));
    }
    return wrap;
  }
  const readTranslations = (wrap) => Object.fromEntries([...wrap.querySelectorAll('input[data-locale]')]
    .map((input) => [input.dataset.locale, input.value.trim()]).filter(([, text]) => text));

  function valueRow(type, value) {
    const row = el('form', 'option-value-row');
    const label = el('input'); label.value = value.label; label.maxLength = 80; label.required = true; label.setAttribute('aria-label', `${t('optionValueLabel')}: ${value.label}`);
    const color = el('input'); color.type = 'color'; color.value = value.swatchColor || '#1e3a5f'; color.setAttribute('aria-label', t('optionUseColor'));
    const useColor = el('input'); useColor.type = 'checkbox'; useColor.checked = Boolean(value.swatchColor);
    const useLabel = el('label', 'check-row'); useLabel.append(useColor, document.createTextNode(t('optionUseColor')));
    const order = el('input'); order.type = 'number'; order.min = '0'; order.max = '100000'; order.value = String(value.position); order.setAttribute('aria-label', `${t('optionOrder')}: ${value.label}`);
    const active = el('input'); active.type = 'checkbox'; active.checked = value.active;
    const activeLabel = el('label', 'check-row'); activeLabel.append(active, document.createTextNode(t('categoryActive')));
    const translations = translationInputs(value.translations);
    const save = el('button', 'secondary-button', t('saveOptionItem')); save.type = 'submit';
    // The colour controls matter for swatch-style types (or a value that already has a colour).
    const showColor = type.display === 'swatch' || Boolean(value.swatchColor);
    useLabel.hidden = color.hidden = !showColor;
    row.append(label, useLabel, color, order, activeLabel, save, translations);
    row.addEventListener('submit', async (event) => {
      event.preventDefault(); save.disabled = true;
      await write('PATCH', `/api/v1/seller/option-types/${type.id}/values/${value.id}`, {
        label: label.value, swatchColor: useColor.checked ? color.value : null, position: Number(order.value) || 0,
        active: active.checked, translations: readTranslations(translations),
      });
    });
    return row;
  }

  function typeCard(type) {
    const card = el('details', 'option-type-card'); card.open = openTypes.has(type.id);
    card.addEventListener('toggle', () => { if (card.open) openTypes.add(type.id); else openTypes.delete(type.id); });
    const display = t(displays.find(([value]) => value === type.display)?.[1] || 'displayButton');
    const summary = el('summary'); summary.append(el('strong', '', type.name), el('span', 'option-meta', ` · ${display} · ${type.values.length}${type.active ? '' : ' · ✕'}`));
    const form = el('form', 'settings-form option-type-form');
    const name = el('input'); name.value = type.name; name.required = true; name.maxLength = 60; name.name = 'name';
    const select = displaySelect(type.display);
    const active = el('input'); active.type = 'checkbox'; active.checked = type.active;
    const activeLabel = el('label', 'check-row'); activeLabel.append(active, document.createTextNode(t('categoryActive')));
    const translations = translationInputs(type.translations);
    const save = el('button', 'secondary-button', t('saveOptionItem')); save.type = 'submit';
    form.append(field(t('optionTypeName'), name), field(t('optionDisplay'), select), activeLabel, save, translations);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); save.disabled = true;
      await write('PATCH', `/api/v1/seller/option-types/${type.id}`, { name: name.value, display: select.value, active: active.checked, translations: readTranslations(translations) });
    });
    const values = el('div', 'option-values');
    values.append(el('h3', '', t('optionValuesTitle')));
    for (const value of type.values) values.append(valueRow(type, value));
    const add = el('form', 'settings-form option-value-add');
    const newLabel = el('input'); newLabel.required = true; newLabel.maxLength = 80;
    const newColor = el('input'); newColor.type = 'color'; newColor.value = '#1e3a5f'; newColor.setAttribute('aria-label', t('optionUseColor'));
    const newUse = el('input'); newUse.type = 'checkbox';
    const newUseLabel = el('label', 'check-row'); newUseLabel.append(newUse, document.createTextNode(t('optionUseColor')));
    const addButton = el('button', 'primary-button', t('addOptionValue')); addButton.type = 'submit';
    newUseLabel.hidden = newColor.hidden = type.display !== 'swatch';
    add.append(field(t('optionValueLabel'), newLabel), newUseLabel, newColor, addButton);
    add.addEventListener('submit', async (event) => {
      event.preventDefault(); addButton.disabled = true;
      await write('POST', `/api/v1/seller/option-types/${type.id}/values`, { label: newLabel.value, swatchColor: newUse.checked ? newColor.value : null, position: type.values.length + 1 });
    });
    values.append(add);
    card.append(summary, form, values);
    return card;
  }

  function renderTypes() {
    list.replaceChildren();
    if (!types.length) { list.append(el('p', 'settings-check-help', t('optionsEmpty'))); return; }
    for (const type of types) list.append(typeCard(type));
  }

  // ----- variant generator -----
  const usable = () => types.filter((type) => type.active && type.values.some((value) => value.active));
  function renderValueChoices() {
    const box = root.querySelector('#generator-values');
    box.replaceChildren();
    for (const type of usable()) {
      const set = el('fieldset', 'generator-type'); set.append(el('legend', '', type.name));
      for (const value of type.values.filter((item) => item.active)) {
        const check = el('input'); check.type = 'checkbox'; check.checked = chosen.get(value.id) === true;
        check.addEventListener('change', () => { chosen.set(value.id, check.checked); renderRows(); });
        const label = el('label', 'check-row'); label.append(check, document.createTextNode(value.label));
        set.append(label);
      }
      box.append(set);
    }
  }
  const selection = () => usable().map((type) => ({ type, values: type.values.filter((value) => value.active && chosen.get(value.id)) })).filter((entry) => entry.values.length);
  const keyOf = (row) => row.map(({ value }) => value.id).join('|');

  function renderRows() {
    const rows = combinations(selection());
    tbody.replaceChildren();
    note.textContent = '';
    if (rows.length > limits.combinationsPerGroup) {
      note.textContent = t('generatorTooMany').replace('{max}', String(limits.combinationsPerGroup));
      submit.disabled = true; return;
    }
    if (!rows.length) { note.textContent = t('generatorNeedValues'); submit.disabled = true; return; }
    const prefix = generator.elements.prefix.value.trim() || generator.elements.group.value.trim() || 'SKU';
    rows.forEach((row, index) => {
      const key = keyOf(row);
      const state = rowState.get(key) || { sku: '', auto: true, price: generator.elements.price.value, stock: generator.elements.stock.value, include: true };
      // Generated SKUs follow the row order; a SKU the seller typed is kept.
      if (state.auto) state.sku = skuFor(prefix, index);
      rowState.set(key, state);
      const tr = el('tr'); tr.dataset.key = key;
      tr.append(el('th', '', row.map(({ value }) => value.label).join(' / ')));
      const sku = el('input'); sku.value = state.sku; sku.maxLength = 40; sku.setAttribute('aria-label', `${t('sku')}: ${row.map(({ value }) => value.label).join(' / ')}`);
      const price = el('input'); price.value = state.price; price.inputMode = 'decimal'; price.setAttribute('aria-label', `${t('price')}: ${row.map(({ value }) => value.label).join(' / ')}`);
      const stock = el('input'); stock.value = state.stock; stock.inputMode = 'numeric'; stock.setAttribute('aria-label', `${t('stockQuantity')}: ${row.map(({ value }) => value.label).join(' / ')}`);
      const include = el('input'); include.type = 'checkbox'; include.checked = state.include; include.setAttribute('aria-label', `${t('generatorInclude')}: ${row.map(({ value }) => value.label).join(' / ')}`);
      sku.addEventListener('input', () => { state.sku = sku.value; state.auto = false; });
      price.addEventListener('input', () => { state.price = price.value; });
      stock.addEventListener('input', () => { state.stock = stock.value; });
      include.addEventListener('change', () => { state.include = include.checked; syncSubmit(); });
      const includeBox = el('label', 'tap-box'); includeBox.append(include);  // a 44px tap area around the checkbox
      const labels = [t('sku'), t('price'), t('stockQuantity'), t('generatorInclude')];
      [sku, price, stock, includeBox].forEach((control, position) => {
        const cell = el('td'); cell.dataset.label = labels[position];  // shown as a caption when rows stack on a phone
        cell.append(control); tr.append(cell);
      });
      tbody.append(tr);
    });
    syncSubmit();
  }
  const syncSubmit = () => { submit.disabled = !tbody.querySelector('input[type=checkbox]:checked'); };
  // Changing a shared value regenerates the rows with the new defaults.
  for (const name of ['price', 'stock']) generator.elements[name].addEventListener('change', () => { rowState.clear(); renderRows(); });
  generator.elements.prefix.addEventListener('change', () => { rowState.clear(); renderRows(); });

  generator.addEventListener('submit', async (event) => {
    event.preventDefault();
    const rows = combinations(selection());
    const created = [], failed = [];
    submit.disabled = true; generatorStatus.textContent = t('generatorCreating'); generatorStatus.classList.remove('is-error'); busy++;
    try {
      const included = rows.filter((row) => rowState.get(keyOf(row))?.include);
      for (const row of included) {
        const state = rowState.get(keyOf(row));
        try {
          await call('POST', '/api/v1/seller/products', {
            sku: state.sku, name: generator.elements.name.value, description: generator.elements.description.value,
            category: generator.elements.category.value, priceMinor: priceToMinor(state.price), currency, active: true,
            stockQuantity: stockFromInput(state.stock), variantGroup: generator.elements.group.value,
            options: row.map(({ type, value }) => ({ typeId: type.id, valueId: value.id })),
          });
          created.push(state.sku);
        } catch (error) { failed.push(state.sku); if (error.message === 'unauthorized') break; }
      }
      generatorStatus.textContent = t('generatorDone').replace('{created}', String(created.length)).replace('{total}', String(created.length + failed.length))
        + (failed.length ? ` ${t('generatorFailed').replace('{list}', failed.join(', '))}` : '');
      generatorStatus.classList.toggle('is-error', failed.length > 0);
      for (const sku of created) for (const [key, state] of rowState) if (state.sku === sku) rowState.delete(key);
      if (created.length) { for (const id of chosen.keys()) chosen.set(id, false); renderValueChoices(); }
      // A fully successful run leaves nothing unsaved; a partial one keeps the form so the rest can be retried.
      if (!failed.length) { generator.reset(); rowState.clear(); }
      renderRows();
    } finally { busy--; if (isCurrent()) syncSubmit(); }
  });

  typeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = typeForm.querySelector('button'); button.disabled = true;
    await write('POST', '/api/v1/seller/option-types', { name: typeForm.elements.name.value, display: typeForm.elements.display.value }, (created) => { openTypes.add(created.id); typeForm.reset(); });
    if (isCurrent()) { button.disabled = false; renderTypes(); }
  });

  async function load() {
    try {
      const [typeResult, categories, company] = await Promise.all([
        call('GET', '/api/v1/seller/option-types'), call('GET', '/api/v1/seller/categories'), call('GET', '/api/v1/seller/company-settings')]);
      if (!isCurrent()) return;
      types = typeResult.items; limits = typeResult.limits || limits; currency = company.defaultCurrency;
      const select = generator.elements.category, current = select.value;
      select.replaceChildren();
      for (const category of categories.items.filter((item) => item.active)) { const option = el('option', '', category.label); option.value = category.code; select.append(option); }
      if (current) select.value = current;
      renderTypes(); renderValueChoices(); renderRows();
    } catch { if (isCurrent()) setStatus('networkError', true); }
  }
  load();

  return {
    isBusy: () => busy > 0,
    hasUnsavedChanges: () => ['name', 'description', 'group', 'prefix', 'price'].some((name) => generator.elements[name].value.trim()),
    refreshLocale() { translate(root); renderTypes(); renderValueChoices(); renderRows(); setStatus(statusLine.dataset.statusKey, statusLine.classList.contains('is-error')); },
  };
}
