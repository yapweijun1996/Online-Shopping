import { formatMoney, t, translate } from '../shared/i18n.js';

function inputFailure(field) { return Object.assign(new Error(field), { field }); }

function priceToMinor(value) {
  const match = /^(\d{1,8})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw inputFailure('price');
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  if (minor < 1n || minor > 1_000_000_000n) throw inputFailure('price');
  return Number(minor);
}

function readImage(file) {
  if (!file) return Promise.resolve(undefined);
  if (file.size > 512 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    return Promise.reject(inputFailure('image'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(inputFailure('image'));
    reader.readAsDataURL(file);
  });
}

function button(label, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'secondary-button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

export function mountProducts(root, { csrfToken, onUnauthorized }) {
  root.replaceChildren(document.getElementById('products-template').content.cloneNode(true));
  translate(root);
  const find = (selector) => root.querySelector(selector);
  const form = find('#product-form');
  const status = find('#product-status');
  const error = find('#product-form-error');
  const search = find('#product-search');
  const list = find('#product-list');
  const more = find('#product-more');
  const preview = find('#product-image-preview');
  const removeImageLabel = find('#remove-image-label');
  let items = [];
  let nextOffset = null;
  let editingId = null;
  let statusKey = '';
  let formErrorKey = '';

  function setStatus(key) { statusKey = key; status.textContent = key ? t(key) : ''; }
  function setError(key) { formErrorKey = key; error.textContent = key ? t(key) : ''; }

  function renderList() {
    list.replaceChildren();
    for (const product of items) {
      const card = document.createElement('article');
      card.className = 'product-card';
      if (product.imageUrl) {
        const image = document.createElement('img');
        image.src = product.imageUrl;
        image.alt = product.name;
        card.append(image);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'product-placeholder';
        placeholder.textContent = t('imageMissing');
        card.append(placeholder);
      }
      const main = document.createElement('div');
      main.className = 'product-card-main';
      const title = document.createElement('h3');
      title.textContent = product.name;
      const detail = document.createElement('p');
      detail.textContent = `${product.sku} · ${product.category} · ${formatMoney(product.priceMinor, product.currency)}`;
      const chip = document.createElement('span');
      chip.className = `product-status-chip${product.active ? '' : ' inactive'}`;
      chip.textContent = t(product.active ? 'active' : 'inactive');
      main.append(title, detail, chip);
      const actions = document.createElement('div');
      actions.className = 'product-card-actions';
      actions.append(
        button(t('editProduct'), () => edit(product)),
        button(t(product.active ? 'deactivateProduct' : 'activateProduct'), () => toggle(product)),
      );
      card.append(main, actions);
      list.append(card);
    }
    if (!items.length && !statusKey) setStatus('noProducts');
    more.hidden = nextOffset === null;
  }

  async function api(method, path, body) {
    const response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error('request'), { field: data.error?.field });
    return data;
  }

  async function load(reset = true) {
    setStatus('loading');
    try {
      const params = new URLSearchParams({ limit: '24', offset: String(reset ? 0 : nextOffset), search: search.value.trim() });
      const result = await api('GET', `/api/v1/seller/products?${params}`);
      if (!root.isConnected) return;
      items = reset ? result.items : [...items, ...result.items];
      nextOffset = result.nextOffset;
      setStatus(items.length ? '' : 'noProducts');
      renderList();
      return true;
    } catch {
      if (root.isConnected) setStatus('networkError');
      return false;
    }
  }

  function resetForm() {
    editingId = null;
    form.reset();
    form.hidden = true;
    preview.hidden = true;
    preview.removeAttribute('src');
    removeImageLabel.hidden = true;
    setError('');
  }

  function edit(product) {
    editingId = product.id;
    form.hidden = false;
    form.elements.sku.value = product.sku;
    form.elements.name.value = product.name;
    form.elements.description.value = product.description;
    form.elements.category.value = product.category;
    form.elements.price.value = (product.priceMinor / 100).toFixed(2);
    form.elements.active.checked = product.active;
    form.elements.image.value = '';
    form.elements.removeImage.checked = false;
    removeImageLabel.hidden = !product.imageUrl;
    preview.hidden = !product.imageUrl;
    if (product.imageUrl) preview.src = product.imageUrl;
    find('#product-form-title').dataset.i18n = 'editProduct';
    find('#product-form-title').textContent = t('editProduct');
    setError('');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.elements.sku.focus();
  }

  async function toggle(product) {
    try {
      await api('PATCH', `/api/v1/seller/products/${product.id}`, { active: !product.active });
      if (await load()) setStatus('productSaved');
    } catch { if (root.isConnected) setStatus('productError'); }
  }

  find('#product-new').addEventListener('click', () => {
    resetForm();
    form.hidden = false;
    find('#product-form-title').dataset.i18n = 'addProduct';
    find('#product-form-title').textContent = t('addProduct');
    form.elements.sku.focus();
  });
  find('#product-cancel').addEventListener('click', resetForm);
  find('#product-search-form').addEventListener('submit', (event) => { event.preventDefault(); load(); });
  more.addEventListener('click', () => load(false));
  form.elements.image.addEventListener('change', async () => {
    const file = form.elements.image.files[0];
    preview.hidden = true;
    if (file) {
      try {
        const dataUrl = await readImage(file);
        if (form.elements.image.files[0] !== file) return;
        preview.src = dataUrl;
        preview.hidden = false;
        form.elements.removeImage.checked = false;
      } catch {
        setError('productError');
      }
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const save = find('#product-save');
    save.disabled = true;
    setError('');
    try {
      const payload = {
        sku: form.elements.sku.value,
        name: form.elements.name.value,
        description: form.elements.description.value,
        category: form.elements.category.value,
        priceMinor: priceToMinor(form.elements.price.value),
        currency: 'MYR',
        active: form.elements.active.checked,
      };
      const file = form.elements.image.files[0];
      if (file) payload.imageDataUrl = await readImage(file);
      else if (form.elements.removeImage.checked) payload.imageDataUrl = null;
      await api(editingId ? 'PATCH' : 'POST', editingId ? `/api/v1/seller/products/${editingId}` : '/api/v1/seller/products', payload);
      resetForm();
      if (await load()) setStatus('productSaved');
    } catch (failure) {
      setError('productError');
      const field = failure.field === 'priceMinor' ? 'price' : failure.field === 'imageDataUrl' ? 'image' : failure.field;
      if (field && form.elements[field]) form.elements[field].focus();
    } finally { save.disabled = false; }
  });

  load();
  return {
    refreshLocale() {
      translate(root);
      renderList();
      status.textContent = statusKey ? t(statusKey) : '';
      error.textContent = formErrorKey ? t(formErrorKey) : '';
    },
  };
}
