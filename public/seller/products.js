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
  const imagePanel = find('#product-image-panel');
  const imageStatus = find('#product-image-status');
  const galleryPanel = find('#product-gallery-panel');
  const galleryList = find('#product-gallery-list');
  const removeImage = find('#product-remove-image');
  const restoreImage = find('#product-restore-image');
  let originalImageUrl = null;
  let pendingRemove = false;
  let galleryImages = [];
  let categories = [];
  let defaultCurrency = 'MYR';
  let items = [];
  let nextOffset = null;
  let editingId = null;
  let statusKey = '';
  let formErrorKey = '';

  function setStatus(key) { statusKey = key; status.textContent = key ? t(key) : ''; }
  function setError(key) { formErrorKey = key; error.textContent = key ? t(key) : ''; }

  function showImage(state, source = null) {
    imagePanel.hidden = state === 'none';
    preview.hidden = !source;
    if (source) preview.src = source;
    else preview.removeAttribute('src');
    imageStatus.dataset.i18n = { current: 'currentImage', replacement: 'newImage', removed: 'imagePendingRemoval' }[state] || '';
    imageStatus.textContent = imageStatus.dataset.i18n ? t(imageStatus.dataset.i18n) : '';
    removeImage.hidden = state === 'removed' || state === 'none';
    restoreImage.hidden = state !== 'removed' || !originalImageUrl;
  }

  function renderGallery() {
    galleryPanel.hidden = !editingId;
    form.elements.gallery.disabled = !originalImageUrl || pendingRemove || galleryImages.length >= 4;
    galleryList.replaceChildren();
    for (const source of galleryImages) {
      const item = document.createElement('div');
      item.className = 'product-gallery-item';
      const photo = document.createElement('img');
      photo.src = source; photo.alt = '';
      const imageId = /\/gallery\/([0-9a-f-]{36})/.exec(source)?.[1];
      const productId = editingId;
      item.append(photo, button(t('removePhoto'), async () => {
        if (!imageId) return;
        try {
          const result = await api('DELETE', `/api/v1/seller/products/${productId}/gallery/${imageId}`);
          if (editingId !== productId) return;
          galleryImages = result.images.slice(1);
          renderGallery();
          setStatus('productSaved');
        } catch { setError('productError'); }
      }));
      galleryList.append(item);
    }
  }

  function populateCategories(selected = '') {
    const select = form.elements.category;
    select.replaceChildren(new Option(t('chooseCategory'), ''));
    for (const category of categories) {
      if (category.active || category.code === selected) select.add(new Option(category.label, category.code));
    }
    select.value = selected;
  }

  async function loadSettings() {
    try {
      const [categoryResult, settings] = await Promise.all([
        api('GET', '/api/v1/seller/categories'), api('GET', '/api/v1/seller/company-settings'),
      ]);
      if (!root.isConnected) return;
      categories = categoryResult.items;
      defaultCurrency = settings.defaultCurrency;
      populateCategories(form.elements.category.value);
    } catch { if (root.isConnected) setStatus('networkError'); }
  }

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
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrfToken() }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error('request'), { field: data.error?.field, code: data.error?.code });
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
    originalImageUrl = null;
    pendingRemove = false;
    galleryImages = [];
    showImage('none');
    renderGallery();
    setError('');
  }

  async function edit(product) {
    editingId = product.id;
    form.hidden = false;
    form.elements.sku.value = product.sku;
    form.elements.name.value = product.name;
    form.elements.description.value = product.description;
    populateCategories(product.categoryCode);
    form.elements.price.value = (product.priceMinor / 100).toFixed(2);
    form.elements.currency.value = product.currency;
    form.elements.active.checked = product.active;
    form.elements.variantGroup.value = product.variantGroup || '';
    form.elements.variantLabel.value = product.variantLabel || '';
    form.elements.image.value = '';
    originalImageUrl = product.imageUrl;
    pendingRemove = false;
    showImage(product.imageUrl ? 'current' : 'none', product.imageUrl);
    galleryImages = [];
    renderGallery();
    find('#product-form-title').dataset.i18n = 'editProduct';
    find('#product-form-title').textContent = t('editProduct');
    setError('');
    form.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    form.elements.sku.focus();
    try {
      const detail = await api('GET', `/api/v1/seller/products/${product.id}`);
      if (editingId === product.id) { galleryImages = detail.images.slice(1); renderGallery(); }
    } catch { if (editingId === product.id) setError('productError'); }
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
    populateCategories();
    form.elements.currency.value = defaultCurrency;
    find('#product-form-title').dataset.i18n = 'addProduct';
    find('#product-form-title').textContent = t('addProduct');
    form.elements.sku.focus();
  });
  find('#product-cancel').addEventListener('click', resetForm);
  find('#product-search-form').addEventListener('submit', (event) => { event.preventDefault(); load(); });
  more.addEventListener('click', () => load(false));
  removeImage.addEventListener('click', () => {
    form.elements.image.value = '';
    pendingRemove = Boolean(originalImageUrl);
    showImage(pendingRemove ? 'removed' : 'none');
    renderGallery();
  });
  restoreImage.addEventListener('click', () => {
    pendingRemove = false;
    showImage('current', originalImageUrl);
    renderGallery();
  });
  form.elements.image.addEventListener('change', async () => {
    const file = form.elements.image.files[0];
    if (file) {
      try {
        const dataUrl = await readImage(file);
        if (form.elements.image.files[0] !== file) return;
        pendingRemove = false;
        showImage('replacement', dataUrl);
        renderGallery();
      } catch {
        setError('productError');
      }
    } else showImage(originalImageUrl ? 'current' : 'none', originalImageUrl);
  });
  form.elements.gallery.addEventListener('change', async () => {
    const files = [...form.elements.gallery.files];
    if (!files.length) return;
    if (files.length + galleryImages.length > 4) { setError('galleryLimit'); form.elements.gallery.value = ''; return; }
    form.elements.gallery.disabled = true;
    setError('');
    const productId = editingId;
    try {
      for (const file of files) {
        const imageDataUrl = await readImage(file);
        const detail = await api('POST', `/api/v1/seller/products/${productId}/gallery`, { imageDataUrl });
        if (editingId !== productId) break;
        galleryImages = detail.images.slice(1);
        renderGallery();
      }
      setStatus('productSaved');
    } catch { setError('productError'); }
    finally { form.elements.gallery.value = ''; renderGallery(); }
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
        currency: form.elements.currency.value,
        active: form.elements.active.checked,
        variantGroup: form.elements.variantGroup.value,
        variantLabel: form.elements.variantLabel.value,
      };
      const file = form.elements.image.files[0];
      if (file) payload.imageDataUrl = await readImage(file);
      else if (pendingRemove) payload.imageDataUrl = null;
      const saved = await api(editingId ? 'PATCH' : 'POST', editingId ? `/api/v1/seller/products/${editingId}` : '/api/v1/seller/products', payload);
      resetForm();
      if (await load()) setStatus('productSaved');
      await edit(saved);
    } catch (failure) {
      setError(failure.code === 'DUPLICATE_SKU' ? 'duplicateSku' : failure.code === 'DUPLICATE_VARIANT' ? 'duplicateVariant' : 'productError');
      const field = failure.code === 'DUPLICATE_SKU' ? 'sku' : failure.field === 'priceMinor' ? 'price' : failure.field === 'imageDataUrl' ? 'image' : failure.field;
      if (field && form.elements[field]) form.elements[field].focus();
    } finally { save.disabled = false; }
  });

  loadSettings().then(() => load());
  return {
    refreshLocale() {
      translate(root);
      renderList();
      populateCategories(form.elements.category.value);
      status.textContent = statusKey ? t(statusKey) : '';
      error.textContent = formErrorKey ? t(formErrorKey) : '';
    },
  };
}
