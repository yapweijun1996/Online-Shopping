import { formatMoney, t, translate } from '../shared/i18n.js';
import { beginMutation } from '../shared/update-guard.js';

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

function button(label, onClick, accessibleName = label) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'secondary-button';
  element.textContent = label;
  element.setAttribute('aria-label', accessibleName);
  element.addEventListener('click', onClick);
  return element;
}

export function mountProducts(root, { csrfToken, onUnauthorized, onNavigate, onSaved }) {
  root.replaceChildren(document.getElementById('products-template').content.cloneNode(true));
  translate(root);
  const find = (selector) => root.querySelector(selector);
  const form = find('#product-form');
  const status = find('#product-status');
  const formSuccess = find('#product-form-success');
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
  const imageRemovalHelp = find('#product-image-removal-help');
  const listView = document.createElement('div');
  listView.id = 'product-list-view';
  const editorView = document.createElement('div');
  editorView.id = 'product-editor-view';
  editorView.hidden = true;
  const back = button(t('backToProducts'), () => onNavigate('products'));
  back.id = 'product-back';
  back.className = 'text-button product-back';
  back.dataset.i18n = 'backToProducts';
  const editorStatus = document.createElement('p');
  editorStatus.id = 'product-editor-status';
  editorStatus.className = 'message';
  editorStatus.setAttribute('role', 'status');
  editorStatus.setAttribute('aria-live', 'polite');
  const listRecovery = document.createElement('div');
  listRecovery.className = 'product-list-recovery';
  const clearSearch = button(t('clearSearch'), () => {
    search.value = '';
    load();
  });
  clearSearch.dataset.i18n = 'clearSearch';
  clearSearch.hidden = true;
  const retryList = button(t('retry'), () => loadSettings().then(() => load()));
  retryList.dataset.i18n = 'retry';
  retryList.hidden = true;
  listRecovery.append(clearSearch, retryList);
  const listHeading = document.createElement('div');
  listHeading.className = 'product-list-heading';
  listHeading.setAttribute('aria-hidden', 'true');
  for (const key of ['product', 'sku', 'price', 'orderStatus', 'actions']) {
    const label = document.createElement('span');
    label.dataset.i18n = key;
    label.textContent = t(key);
    listHeading.append(label);
  }
  const formFields = find('.product-fields');
  const group = (key, className) => {
    const fieldset = document.createElement('fieldset');
    fieldset.className = className;
    const legend = document.createElement('legend');
    legend.dataset.i18n = key;
    legend.textContent = t(key);
    fieldset.append(legend);
    return fieldset;
  };
  const details = group('productInformation', 'product-details-card');
  const pricing = group('pricingAvailability', 'product-pricing-card');
  const priceFields = document.createElement('div');
  priceFields.className = 'product-fields';
  priceFields.append(form.elements.price.closest('label'), form.elements.currency.closest('label'), form.elements.active.closest('label'));
  pricing.append(priceFields);
  const imageColumn = group('productImages', 'product-image-column');
  imageColumn.className = 'product-image-column';
  imageColumn.append(form.elements.image.closest('label'), imagePanel, galleryPanel);
  const editorLayout = document.createElement('div');
  editorLayout.className = 'product-editor-layout';
  formFields.before(editorLayout);
  details.append(formFields);
  editorLayout.append(details, pricing, imageColumn);
  const nameLabel = form.elements.name.closest('label');
  nameLabel.classList.add('full');
  formFields.prepend(nameLabel, form.elements.sku.closest('label'), form.elements.category.closest('label'), form.elements.description.closest('label'));
  const editorActions = document.createElement('div');
  editorActions.className = 'product-editor-actions';
  editorActions.append(find('#product-cancel'), find('#product-save'));
  form.append(editorActions);
  find('.product-form-heading').remove();
  listView.append(find('.product-toolbar'), status, listRecovery, listHeading, list, more);
  editorView.append(back, editorStatus, form);
  root.replaceChildren(listView, editorView);
  let originalImageUrl = null;
  let pendingRemove = false;
  let galleryImages = [];
  let galleryLoaded = false;
  let categories = [];
  let defaultCurrency = 'MYR';
  let items = [];
  let nextOffset = null;
  let appliedSearch = '';
  let loadSequence = 0;
  let editingId = null;
  let statusKey = '';
  let statusProductName = '';
  let formErrorKey = '';
  let formSuccessKey = '';
  let formBaseline = null;
  let saving = false;
  let mutations = 0;
  let routeSequence = 0;
  let editorStatusKey = '';
  const undoStates = new Map();
  const pendingChanges = new Set();

  function setStatus(key, productName = '') {
    statusKey = key;
    statusProductName = productName;
    status.classList.toggle('sr-only', ['productActivatedInline', 'productDeactivatedInline', 'productUndoRestored'].includes(key));
    status.textContent = key ? `${productName ? `${productName}: ` : ''}${t(key)}` : '';
  }
  function setError(key) { formErrorKey = key; error.textContent = key ? t(key) : ''; }
  function setFormSuccess(key) { formSuccessKey = key; formSuccess.textContent = key ? t(key) : ''; }
  function setEditorStatus(key) { editorStatusKey = key; editorStatus.textContent = key ? t(key) : ''; }
  function formState() {
    const fields = ['sku', 'name', 'description', 'category', 'price', 'currency', 'variantGroup', 'variantLabel'];
    const image = form.elements.image.files[0];
    return {
      values: Object.fromEntries(fields.map((field) => [field, form.elements[field].value])),
      active: form.elements.active.checked,
      image: image ? [image.name, image.size, image.lastModified] : null,
      pendingRemove,
    };
  }
  function captureBaseline() { formBaseline = JSON.stringify(formState()); }
  function hasUnsavedChanges() { return saving || (!form.hidden && formBaseline !== JSON.stringify(formState())); }
  function confirmDiscard() { return !hasUnsavedChanges() || window.confirm(t('unsavedChangesConfirm')); }

  function showImage(state, source = null) {
    imagePanel.hidden = state === 'none';
    preview.hidden = !source;
    preview.alt = `${form.elements.name.value}: ${t('currentImage')}`;
    if (source) preview.src = source;
    else preview.removeAttribute('src');
    imageStatus.dataset.i18n = { current: 'currentImage', replacement: 'newImage', removed: 'imagePendingRemoval' }[state] || '';
    imageStatus.textContent = imageStatus.dataset.i18n ? t(imageStatus.dataset.i18n) : '';
    removeImage.hidden = state === 'removed' || state === 'none';
    restoreImage.hidden = state !== 'removed' || !originalImageUrl;
  }

  function renderGallery() {
    const storedCount = galleryImages.filter(source => /\/gallery\//.test(source)).length;
    galleryPanel.hidden = !editingId;
    form.elements.gallery.disabled = saving || !originalImageUrl || pendingRemove || storedCount >= 9;
    removeImage.disabled = Boolean(editingId && (!galleryLoaded || storedCount));
    imageRemovalHelp.hidden = !editingId || !originalImageUrl || (galleryLoaded && !storedCount);
    imageRemovalHelp.dataset.i18n = galleryLoaded ? 'removeGalleryFirst' : 'loading';
    imageRemovalHelp.textContent = imageRemovalHelp.hidden ? '' : t(imageRemovalHelp.dataset.i18n);
    galleryList.replaceChildren();
    for (const source of galleryImages) {
      const item = document.createElement('div');
      item.className = 'product-gallery-item';
      const photo = document.createElement('img');
      photo.src = source; photo.alt = `${form.elements.name.value}: ${t('gallery')} ${galleryList.childElementCount + 1}`;
      const imageId = /\/gallery\/([0-9a-f-]{36})/.exec(source)?.[1];
      const productId = editingId;
      const label = document.createElement('p');
      label.textContent = imageId ? t('gallery') : t('demoGalleryPhoto');
      item.append(photo, label);
      if (imageId) item.append(button(t('removePhoto'), async () => {
        try {
          const result = await api('DELETE', `/api/v1/seller/products/${productId}/gallery/${imageId}`);
          if (editingId !== productId) return;
          galleryImages = result.images.slice(1);
          renderGallery();
          setError('');
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
    } catch {
      if (root.isConnected) {
        setStatus('networkError');
        retryList.hidden = false;
        if (!editorView.hidden) setEditorStatus('networkError');
      }
    }
  }

  function renderList() {
    list.replaceChildren();
    for (const product of items) {
      const card = document.createElement('article');
      card.className = 'product-card';
      card.dataset.productId = product.id;
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
      detail.className = 'product-card-identity';
      detail.textContent = `${product.sku} · ${product.category}`;
      const identity = document.createElement('div');
      identity.className = 'product-row-identity';
      detail.textContent = product.category;
      identity.append(title, detail);
      const sku = document.createElement('p');
      sku.className = 'product-row-sku';
      sku.textContent = product.sku;
      const price = document.createElement('p');
      price.className = 'product-card-price';
      price.textContent = formatMoney(product.priceMinor, product.currency);
      const chip = document.createElement('span');
      chip.className = `product-status-chip${product.active ? '' : ' inactive'}`;
      chip.textContent = t(product.active ? 'active' : 'inactive');
      main.append(identity, sku, price, chip);
      const actions = document.createElement('div');
      actions.className = 'product-card-actions';
      const toggleButton = button(t(product.active ? 'deactivateProduct' : 'activateProduct'),
        (event) => toggle(product, event.currentTarget),
        `${t(product.active ? 'deactivateProduct' : 'activateProduct')}: ${product.name} (${product.sku})`);
      toggleButton.dataset.action = 'toggle';
      toggleButton.disabled = pendingChanges.has(product.id);
      actions.append(button(t('editProduct'), () => onNavigate(`products/${product.id}`), `${t('editProduct')}: ${product.name} (${product.sku})`), toggleButton);
      card.append(main, actions);
      const undo = undoStates.get(product.id);
      if (undo && undo.appliedActive === product.active) {
        const line = document.createElement('div');
        line.className = 'product-undo';
        const label = document.createElement('span');
        label.textContent = t(product.active ? 'productActivatedInline' : 'productDeactivatedInline');
        const undoButton = button(t('undoChange'), (event) => undoToggle(product, event.currentTarget),
          `${t('undoChange')} ${t(product.active ? 'productActivatedInline' : 'productDeactivatedInline')}: ${product.name} (${product.sku})`);
        undoButton.dataset.action = 'undo';
        undoButton.disabled = pendingChanges.has(product.id);
        line.append(label, undoButton);
        card.append(line);
      }
      list.append(card);
    }
    more.hidden = nextOffset === null;
  }

  async function api(method, path, body) {
    const finish = method === 'GET' ? () => {} : beginMutation();
    if (method !== 'GET') { mutations++; document.dispatchEvent(new Event('updateguardchange')); }
    try {
      const response = await fetch(path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrfToken() }) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error('request'), { status: response.status, field: data.error?.field, code: data.error?.code });
      return data;
    } finally { finish(); if (method !== 'GET') { mutations--; document.dispatchEvent(new Event('updateguardchange')); } }
  }

  async function load(reset = true) {
    if (!reset && nextOffset === null) return false;
    const sequence = ++loadSequence;
    const query = reset ? search.value.trim() : appliedSearch;
    const offset = reset ? 0 : nextOffset;
    more.disabled = true;
    retryList.hidden = true;
    clearSearch.hidden = true;
    setStatus('loading');
    try {
      const params = new URLSearchParams({ limit: '24', offset: String(offset), search: query });
      const result = await api('GET', `/api/v1/seller/products?${params}`);
      if (sequence !== loadSequence || !root.isConnected) return false;
      items = reset ? result.items : [...items, ...result.items];
      if (reset) appliedSearch = query;
      nextOffset = result.nextOffset;
      setStatus(items.length ? '' : appliedSearch ? 'noMatchingProducts' : 'noProducts');
      clearSearch.hidden = Boolean(items.length) || !appliedSearch;
      renderList();
      return true;
    } catch {
      if (sequence === loadSequence && root.isConnected) {
        setStatus('networkError');
        retryList.hidden = false;
      }
      return false;
    } finally {
      if (sequence === loadSequence && root.isConnected) more.disabled = false;
    }
  }

  function resetForm() {
    editingId = null;
    form.reset();
    form.hidden = true;
    formBaseline = null;
    originalImageUrl = null;
    pendingRemove = false;
    galleryImages = [];
    galleryLoaded = false;
    showImage('none');
    renderGallery();
    setError('');
    setFormSuccess('');
  }

  async function edit(product, { skipGuard = false, detailLoaded = false } = {}) {
    if (!skipGuard && !confirmDiscard()) return;
    editingId = product.id;
    form.hidden = false;
    form.elements.sku.value = product.sku;
    form.elements.name.value = product.name;
    form.elements.description.value = product.description;
    populateCategories(product.categoryCode);
    form.elements.price.value = (product.priceMinor / 100).toFixed(2);
    form.elements.currency.value = product.currency;
    const currencyHelp = find('#product-currency-help');
    currencyHelp.dataset.i18n = product.currency === defaultCurrency ? 'currencyInherited' : 'currencyHistoryNote';
    currencyHelp.textContent = t(currencyHelp.dataset.i18n);
    form.elements.active.checked = product.active;
    form.elements.variantGroup.value = product.variantGroup || '';
    form.elements.variantLabel.value = product.variantLabel || '';
    form.elements.image.value = '';
    originalImageUrl = product.imageUrl;
    pendingRemove = false;
    showImage(product.imageUrl ? 'current' : 'none', product.imageUrl);
    galleryImages = [];
    galleryLoaded = false;
    renderGallery();
    setError('');
    setFormSuccess('');
    captureBaseline();
    if (!detailLoaded) {
      form.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      form.elements.sku.focus();
    }
    if (detailLoaded) {
      galleryImages = product.images.slice(1);
      galleryLoaded = true;
      renderGallery();
      return;
    }
    try {
      const detail = await api('GET', `/api/v1/seller/products/${product.id}`);
      if (editingId === product.id) { galleryImages = detail.images.slice(1); galleryLoaded = true; renderGallery(); }
    } catch { if (editingId === product.id) setError('productError'); }
  }

  async function showRoute(route) {
    const sequence = ++routeSequence;
    if (route === 'products') {
      resetForm();
      editorView.hidden = true;
      listView.hidden = false;
      setEditorStatus('');
      return;
    }
    listView.hidden = true;
    editorView.hidden = false;
    resetForm();
    setEditorStatus(route === 'products/new' ? '' : 'loading');
    if (route === 'products/new') {
      await settingsPromise;
      if (sequence !== routeSequence || !root.isConnected) return;
      form.hidden = false;
      populateCategories();
      form.elements.currency.value = defaultCurrency;
      const currencyHelp = find('#product-currency-help');
      currencyHelp.dataset.i18n = 'currencyInherited';
      currencyHelp.textContent = t('currencyInherited');
      captureBaseline();
      return;
    }
    const id = route.slice('products/'.length);
    try {
      const detail = await api('GET', `/api/v1/seller/products/${id}`);
      await settingsPromise;
      if (sequence !== routeSequence || !root.isConnected) return;
      await edit(detail, { skipGuard: true, detailLoaded: true });
      setEditorStatus('');
    } catch (failure) {
      if (sequence !== routeSequence || !root.isConnected || failure.status === 401) return;
      setEditorStatus(failure.status === 404 ? 'productNotFound' : 'networkError');
      if (failure.status !== 404) {
        const retry = button(t('retry'), () => showRoute(route));
        retry.dataset.i18n = 'retry';
        editorStatus.append(' ', retry);
      }
    }
  }

  function syncOpenFormAvailability(product) {
    if (editingId !== product.id || !formBaseline) return;
    const baseline = JSON.parse(formBaseline);
    const activeChangedInForm = form.elements.active.checked !== baseline.active;
    baseline.active = product.active;
    formBaseline = JSON.stringify(baseline);
    if (!activeChangedInForm) form.elements.active.checked = product.active;
  }

  function replaceProduct(product) {
    items = items.map((item) => item.id === product.id ? product : item);
    syncOpenFormAvailability(product);
    renderList();
  }

  function focusProductAction(productId, action) {
    [...list.children].find((card) => card.dataset.productId === productId)
      ?.querySelector(`[data-action="${action}"]`)?.focus({ preventScroll: true });
  }

  async function toggle(product, control) {
    if (pendingChanges.has(product.id)) return;
    pendingChanges.add(product.id);
    control.disabled = true;
    try {
      const updated = await api('PATCH', `/api/v1/seller/products/${product.id}`, { active: !product.active });
      undoStates.set(product.id, { previousActive: product.active, appliedActive: updated.active });
      pendingChanges.delete(product.id);
      replaceProduct(updated);
      setStatus(updated.active ? 'productActivatedInline' : 'productDeactivatedInline', product.name);
      focusProductAction(product.id, 'toggle');
    } catch {
      pendingChanges.delete(product.id);
      control.disabled = false;
      if (root.isConnected) setStatus('productError', product.name);
    }
  }

  async function undoToggle(product, control) {
    const undo = undoStates.get(product.id);
    if (!undo || pendingChanges.has(product.id)) return;
    pendingChanges.add(product.id);
    control.disabled = true;
    try {
      const latest = await api('GET', `/api/v1/seller/products/${product.id}`);
      if (latest.active !== undo.appliedActive) {
        undoStates.delete(product.id);
        pendingChanges.delete(product.id);
        replaceProduct(latest);
        setStatus('productUndoUnavailable', product.name);
      } else {
        const restored = await api('PATCH', `/api/v1/seller/products/${product.id}`, { active: undo.previousActive });
        undoStates.delete(product.id);
        pendingChanges.delete(product.id);
        replaceProduct(restored);
        setStatus('productUndoRestored', product.name);
      }
      focusProductAction(product.id, 'toggle');
    } catch {
      pendingChanges.delete(product.id);
      control.disabled = false;
      if (root.isConnected) setStatus('productError', product.name);
    }
  }

  find('#product-new').addEventListener('click', () => onNavigate('products/new'));
  find('#product-cancel').addEventListener('click', () => onNavigate('products'));
  form.addEventListener('input', () => { if (formSuccessKey) setFormSuccess(''); });
  form.addEventListener('change', () => { if (formSuccessKey) setFormSuccess(''); });
  find('#product-search-form').addEventListener('submit', (event) => { event.preventDefault(); load(); });
  more.addEventListener('click', () => load(false));
  removeImage.addEventListener('click', () => {
    if (!galleryLoaded || galleryImages.some(source => /\/gallery\//.test(source))) return;
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
    if (files.length + galleryImages.filter(source => /\/gallery\//.test(source)).length > 9) { setError('galleryLimit'); form.elements.gallery.value = ''; return; }
    form.elements.gallery.disabled = true;
    setError('');
    const productId = editingId;
    saving = true;
    const finish = beginMutation();
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
    finally { saving = false; finish(); form.elements.gallery.value = ''; renderGallery(); document.dispatchEvent(new Event('updateguardchange')); }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const save = find('#product-save');
    const productId = editingId;
    saving = true;
    const finish = beginMutation();
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
      if (editingId && formBaseline) {
        const baseline = JSON.parse(formBaseline);
        // Metadata edits must not resubmit immutable legacy money fields.
        if (payload.priceMinor === priceToMinor(baseline.values.price)) delete payload.priceMinor;
        if (payload.currency === baseline.values.currency) delete payload.currency;
        if (payload.active === baseline.active) delete payload.active;
      }
      const file = form.elements.image.files[0];
      if (file) payload.imageDataUrl = await readImage(file);
      else if (pendingRemove) payload.imageDataUrl = null;
      const saved = await api(editingId ? 'PATCH' : 'POST', editingId ? `/api/v1/seller/products/${editingId}` : '/api/v1/seller/products', payload);
      resetForm();
      await load();
      await edit(saved, { skipGuard: true });
      onSaved(saved.id);
      setFormSuccess('productSaved');
      form.scrollIntoView({ block: 'start' });
      formSuccess.focus({ preventScroll: true });
    } catch (failure) {
      const galleryConflict = pendingRemove && failure.field === 'imageDataUrl';
      setError(galleryConflict ? 'removeGalleryFirst' : failure.code === 'COMPANY_CURRENCY_CONFLICT' ? 'currencyConflict' : failure.code === 'DUPLICATE_SKU' ? 'duplicateSku' : failure.code === 'DUPLICATE_VARIANT' ? 'duplicateVariant' : 'productError');
      if (galleryConflict && productId && editingId === productId) {
        try {
          const detail = await api('GET', `/api/v1/seller/products/${productId}`);
          if (editingId === productId) { galleryImages = detail.images.slice(1); galleryLoaded = true; renderGallery(); }
        } catch { /* Keep the actionable server error visible. */ }
        galleryPanel.scrollIntoView({ block: 'nearest' });
      } else {
        const field = failure.code === 'DUPLICATE_SKU' ? 'sku' : failure.field === 'priceMinor' ? 'price' : failure.field === 'imageDataUrl' ? 'image' : failure.field;
        if (field && form.elements[field]) form.elements[field].focus();
      }
    } finally { saving = false; finish(); save.disabled = false; document.dispatchEvent(new Event('updateguardchange')); }
  });

  const settingsPromise = loadSettings();
  settingsPromise.then(() => { if (root.isConnected && loadSequence === 0) load(); });
  search.placeholder = t('searchNameOrSkuHint');
  return {
    showRoute,
    refreshLocale() {
      translate(root);
      renderList();
      renderGallery();
      populateCategories(form.elements.category.value);
      search.placeholder = t('searchNameOrSkuHint');
      status.textContent = statusKey ? `${statusProductName ? `${statusProductName}: ` : ''}${t(statusKey)}` : '';
      error.textContent = formErrorKey ? t(formErrorKey) : '';
      formSuccess.textContent = formSuccessKey ? t(formSuccessKey) : '';
      editorStatus.textContent = editorStatusKey ? t(editorStatusKey) : '';
    },
    hasUnsavedChanges,
    draftSignature: () => JSON.stringify([editingId, form.hidden, formState()]),
    isBusy: () => saving || mutations > 0,
  };
}
