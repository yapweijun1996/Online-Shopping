import { formatMoney, t, translate } from '../shared/i18n.js';
import { beginMutation } from '../shared/update-guard.js';
import { revealImage } from '../shared/image-reveal.js';
import { makeThumbnail, thumbUrl } from '../shared/image-thumb.js';
import { inputFailure, priceToMinor, stockFromInput } from './product-fields.js';
import './ops-copy.js';

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
  // Seller-defined option types (see options.js); the pickers appear once at least one exists.
  let optionTypes = [];
  const optionsBox = find('#product-options');
  const optionsFields = find('#product-options-fields');
  const optionsError = find('#product-options-error');
  const selectedOptions = () => [...optionsFields.querySelectorAll('select')].filter((select) => select.value)
    .map((select) => ({ typeId: select.dataset.typeId, valueId: select.value }));
  function renderOptionPickers(options) {
    const picked = new Map((options ?? selectedOptions().map(({ typeId, valueId }) => ({ type: { id: typeId }, value: { id: valueId } })))
      .map(({ type, value }) => [type.id, value.id]));
    optionsFields.replaceChildren();
    const shown = optionTypes.filter((type) => type.active || picked.has(type.id));
    optionsBox.hidden = shown.length === 0;
    for (const type of shown) {
      const label = document.createElement('label');
      const select = document.createElement('select');
      select.dataset.typeId = type.id;
      select.setAttribute('aria-label', type.name);
      const none = document.createElement('option'); none.value = ''; none.textContent = t('optionNotSet'); select.append(none);
      for (const value of type.values.filter((item) => item.active || item.id === picked.get(type.id))) {
        const option = document.createElement('option'); option.value = value.id; option.textContent = value.label; select.append(option);
      }
      select.value = picked.get(type.id) || '';
      const name = document.createElement('span'); name.textContent = type.name;
      label.append(name, select);
      optionsFields.append(label);
    }
    optionsError.hidden = true; optionsError.textContent = '';
  }
  const optionErrorKey = { OPTIONS_GROUP_REQUIRED: 'optionsGroupNeeded', OPTIONS_SAME_TYPES: 'optionsSameTypes', OPTIONS_REQUIRED: 'optionsRequired', DUPLICATE_VARIANT: 'optionsDuplicate' };
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
  const isCurrent = () => editorView.isConnected && root.contains(editorView);
  let originalImageUrl = null;
  let pendingRemove = false;
  let galleryImages = [];
  let originalGallery = [];
  let galleryReferences = [];
  let galleryLoaded = false;
  // A product with several variants shows one shared gallery: only its main variant edits it, and the product image above
  // is this variant's own photo, which never touches the shared photos.
  let sharedGallery = false;
  let galleryEditable = true;
  let galleryHolderId = null;
  let expectedUpdatedAt = null;
  let readingGallery = false;
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
  let editorLoadSequence = 0;
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
    const fields = ['sku', 'name', 'description', 'category', 'price', 'currency', 'variantGroup', 'variantLabel', 'stockQuantity'];
    const image = form.elements.image.files[0];
    return {
      values: Object.fromEntries(fields.map((field) => [field, form.elements[field].value])),
      options: selectedOptions(),
      active: form.elements.active.checked,
      image: image ? [image.name, image.size, image.lastModified] : null,
      pendingRemove,
      gallery: galleryImages.map(({ id, imageDataUrl }) => ({ id, imageDataUrl })),
    };
  }
  function captureBaseline() { formBaseline = JSON.stringify(formState()); }
  function hasUnsavedChanges() { return saving || readingGallery || (!form.hidden && formBaseline !== JSON.stringify(formState())); }
  function confirmDiscard() { return !hasUnsavedChanges() || window.confirm(t('unsavedChangesConfirm')); }

  function showImage(state, source = null) {
    imagePanel.hidden = state === 'none';
    preview.hidden = !source;
    preview.alt = `${form.elements.name.value}: ${t('currentImage')}`;
    if (source) { revealImage(preview); preview.src = source; }
    else preview.removeAttribute('src');
    imageStatus.dataset.i18n = { current: 'currentImage', replacement: 'newImage', removed: 'imagePendingRemoval' }[state] || '';
    imageStatus.textContent = imageStatus.dataset.i18n ? t(imageStatus.dataset.i18n) : '';
    removeImage.hidden = state === 'removed' || state === 'none';
    restoreImage.hidden = state !== 'removed' || !originalImageUrl;
  }

  function renderGallery() {
    galleryPanel.hidden = !editingId;
    form.elements.gallery.disabled = saving || readingGallery || !galleryLoaded || !originalImageUrl || pendingRemove || galleryImages.length >= 10;
    removeImage.disabled = Boolean(editingId && (!galleryLoaded || galleryImages.length > 1));
    imageRemovalHelp.hidden = !editingId || !originalImageUrl || (galleryLoaded && galleryImages.length <= 1);
    imageRemovalHelp.dataset.i18n = galleryLoaded ? 'removeGalleryFirst' : 'loading';
    imageRemovalHelp.textContent = imageRemovalHelp.hidden ? '' : t(imageRemovalHelp.dataset.i18n);
    const sharedNote = find('#product-gallery-shared-note'), openMain = find('#product-open-main');
    sharedNote.hidden = !sharedGallery;
    if (sharedGallery) sharedNote.textContent = t(galleryEditable ? 'sharedGalleryHolderNote' : 'sharedGalleryNote');
    openMain.hidden = !sharedGallery || galleryEditable;
    if (sharedGallery) {
      form.elements.gallery.disabled = !galleryEditable || saving || readingGallery || !galleryLoaded || galleryImages.length >= 10;
      removeImage.disabled = !galleryLoaded;
      imageRemovalHelp.hidden = true;
    }
    const preview = (state, source) => { if (!sharedGallery) showImage(state, source); };
    galleryList.replaceChildren();
    galleryImages.forEach((entry, index) => {
      const item = document.createElement('div');
      item.className = 'product-gallery-item'; item.dataset.imageId = entry.id || 'new';
      const photo = document.createElement('img');
      revealImage(photo);
      photo.src = entry.src;
      photo.alt = `${form.elements.name.value}: ${t('gallery')} ${index + 1}`;
      const label = document.createElement('p'); label.textContent = `${index + 1} · ${t(index === 0 ? 'primaryPhoto' : 'gallery')}`;
      const actions = document.createElement('div'); actions.className = 'product-gallery-actions';
      const change = fn => {
        if (saving || readingGallery || !item.isConnected) return;
        fn(); renderGallery();
        galleryList.children[Math.min(index, galleryImages.length - 1)]?.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
        document.dispatchEvent(new Event('updateguardchange'));
      };
      const primary = button(t('setPrimaryPhoto'), () => change(() => { galleryImages.splice(index, 1); galleryImages.unshift(entry); preview('current', entry.src); }), `${t('setPrimaryPhoto')} ${index + 1}`);
      primary.dataset.galleryAction = 'primary'; primary.disabled = !galleryEditable || saving || readingGallery || index === 0;
      const earlier = button(t('movePhotoEarlier'), () => change(() => { [galleryImages[index - 1], galleryImages[index]] = [entry, galleryImages[index - 1]]; preview('current', galleryImages[0]?.src); }), `${t('movePhotoEarlier')} ${index + 1}`);
      earlier.dataset.galleryAction = 'earlier'; earlier.disabled = !galleryEditable || saving || readingGallery || index === 0;
      const later = button(t('movePhotoLater'), () => change(() => { [galleryImages[index + 1], galleryImages[index]] = [entry, galleryImages[index + 1]]; preview('current', galleryImages[0]?.src); }), `${t('movePhotoLater')} ${index + 1}`);
      later.dataset.galleryAction = 'later'; later.disabled = !galleryEditable || saving || readingGallery || index === galleryImages.length - 1;
      const remove = button(t('removePhoto'), () => change(() => { galleryImages.splice(index, 1); preview(galleryImages.length ? 'current' : 'none', galleryImages[0]?.src); }), `${t('removePhoto')} ${index + 1}`);
      remove.dataset.galleryAction = 'remove'; remove.disabled = !galleryEditable || saving || readingGallery;
      actions.append(primary, earlier, later, remove); item.append(photo, label, actions); galleryList.append(item);
    });
    const available = !galleryEditable ? [] : galleryReferences.filter(reference => !galleryImages.some(item => item.id === reference.id));
    if (available.length) {
      const heading = document.createElement('p'); heading.textContent = t('availableReferencePhotos'); galleryList.append(heading);
      for (const reference of available) {
        const item = document.createElement('div'); item.className = 'product-gallery-reference';
        const photo = document.createElement('img'); photo.src = reference.thumbnail || reference.src; photo.alt = reference.alt || t('gallery');
        const add = button(t('addReferencePhoto'), () => {
          if (saving || readingGallery || galleryImages.length >= 10 || !item.isConnected) return;
          galleryImages.push({ ...reference }); renderGallery(); document.dispatchEvent(new Event('updateguardchange'));
        });
        add.disabled = saving || readingGallery || galleryImages.length >= 10;
        item.append(photo, add); galleryList.append(item);
      }
    }
  }

  function acceptGallery(detail, { capture = true } = {}) {
    sharedGallery = Boolean(detail.galleryShared);
    galleryHolderId = detail.galleryHolderId || null;
    galleryEditable = !sharedGallery || galleryHolderId === detail.id;
    // Shared photos only: this variant's own photo is the product image above, not part of the gallery.
    galleryImages = (detail.galleryItems || []).filter(item => !sharedGallery || item.shared).map(item => ({ ...item }));
    originalGallery = galleryImages.map(item => ({ ...item }));
    galleryReferences = (detail.galleryReferenceItems || []).map(item => ({ ...item }));
    expectedUpdatedAt = detail.updatedAt;
    galleryLoaded = true;
    renderGallery();
    if (capture) captureBaseline();
    else if (formBaseline) {
      // Only the fetched gallery joins the confirmed baseline. Metadata typed
      // while the request was pending must remain dirty.
      const baseline = JSON.parse(formBaseline); baseline.gallery = formState().gallery;
      formBaseline = JSON.stringify(baseline);
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
      const [categoryResult, settings, optionResult] = await Promise.all([
        api('GET', '/api/v1/seller/categories'), api('GET', '/api/v1/seller/company-settings'),
        api('GET', '/api/v1/seller/option-types').catch(() => ({ items: [] })),
      ]);
      if (!isCurrent()) return;
      categories = categoryResult.items;
      optionTypes = optionResult.items;
      renderOptionPickers();
      defaultCurrency = settings.defaultCurrency;
      populateCategories(form.elements.category.value);
    } catch {
      if (isCurrent()) {
        setStatus('networkError');
        retryList.hidden = false;
        if (!editorView.hidden) setEditorStatus('networkError');
      }
    }
  }

  // Who changed this product, when, and from what to what. Loaded when the section is opened.
  const historyPanel = find('#product-history'), historyList = find('#product-history-list');
  let historyFor = null, historyLoaded = false;
  function historyValue(field, value, currency) {
    if (field === 'stockQuantity' && value === null) return t('historyUnlimited');
    if (value === null || value === undefined || value === '') return '–';
    if (field === 'active') return t(value ? 'active' : 'inactive');
    if (field === 'priceMinor') return formatMoney(value, currency || 'MYR');
    if (field === 'stockQuantity') return String(value);
    return String(value);
  }
  function setupHistory(id) {
    if (id === historyFor) return;
    historyFor = id; historyLoaded = false;
    historyPanel.hidden = !id; historyPanel.open = false; historyList.replaceChildren();
  }
  historyPanel.addEventListener('toggle', async () => {
    if (!historyPanel.open) { historyLoaded = false; return; }   // closing forgets the list, so reopening shows fresh entries
    if (historyLoaded || !historyFor) return;
    const id = historyFor;
    try {
      const data = await api('GET', `/api/v1/seller/products/${id}/history?limit=50`);
      if (!isCurrent() || id !== historyFor) return;
      historyLoaded = true;
      historyList.replaceChildren(...(data.items.length ? data.items.map((entry) => {
        const item = document.createElement('li');
        const meta = document.createElement('span');
        meta.className = 'history-meta';
        meta.textContent = `${new Date(entry.at).toLocaleString(document.documentElement.lang || undefined)} · ${entry.actor}${entry.action === 'CREATED' ? ` · ${t('historyCreated')}` : ''}`;
        item.append(meta);
        for (const change of entry.changes) {
          const line = document.createElement('div');
          line.textContent = entry.action === 'CREATED' ? `${t(`historyField_${change.field}`)}: ${historyValue(change.field, change.to)}`
            : `${t(`historyField_${change.field}`)}: ${historyValue(change.field, change.from)} → ${historyValue(change.field, change.to)}`;
          item.append(line);
        }
        return item;
      }) : [Object.assign(document.createElement('li'), { textContent: t('historyEmpty') })]));
    } catch { if (isCurrent() && id === historyFor) historyList.replaceChildren(Object.assign(document.createElement('li'), { textContent: t('historyLoadError') })); }
  });

  const variantsPanel = find('#product-variants');
  /* The variants of the product being edited: one line each, the one on screen marked, the others one click away. */
  function renderVariants(detail) {
    setupHistory(detail?.id || null);
    const variants = detail?.variants || [];
    variantsPanel.hidden = variants.length < 2;
    const rows = find('#product-variants-list');
    rows.replaceChildren();
    if (variants.length < 2) return;
    for (const variant of variants) {
      const row = document.createElement('li');
      row.className = `product-variant-row${variant.id === detail.id ? ' current' : ''}`;
      const name = document.createElement('span');
      name.className = 'product-variant-name';
      name.textContent = variant.label || variant.sku;
      const code = document.createElement('span');
      code.className = 'product-variant-sku';
      code.textContent = variant.sku;
      const main = document.createElement('div');
      main.className = 'product-variant-main';
      main.append(name, code);
      const price = document.createElement('span');
      price.className = 'product-variant-price';
      price.textContent = formatMoney(variant.priceMinor, variant.currency);
      const stock = document.createElement('span');
      stock.className = 'product-variant-stock';
      stock.textContent = variant.stockQuantity === null ? t('unlimitedStock') : variant.stockQuantity === 0 ? t('outOfStock') : String(variant.stockQuantity);
      const state = document.createElement('span');
      state.className = `product-status-chip${variant.active ? '' : ' inactive'}`;
      state.textContent = t(variant.active ? 'active' : 'inactive');
      const figures = document.createElement('div');
      figures.className = 'product-variant-figures';
      figures.append(price, stock);
      const actions = document.createElement('div');
      actions.className = 'product-variant-actions';
      row.append(main, figures, state, actions);
      if (variant.id !== detail.id) {
        const switchButton = button(t(variant.active ? 'deactivateProduct' : 'activateProduct'), async (event) => {
          const control = event.currentTarget;
          control.disabled = true;
          try {
            await api('PATCH', `/api/v1/seller/products/${variant.id}`, { active: !variant.active });
            if (!isCurrent() || editingId !== detail.id) return;
            renderVariants(await api('GET', `/api/v1/seller/products/${detail.id}`));
          } catch { control.disabled = false; if (isCurrent()) setError('productError'); }
        }, `${t(variant.active ? 'deactivateProduct' : 'activateProduct')}: ${variant.label || variant.sku} (${variant.sku})`);
        actions.append(switchButton);
      }
      if (variant.id === detail.id) {
        const here = document.createElement('span');
        here.className = 'product-variant-here';
        here.textContent = t('variantEditing');
        actions.append(here);
      } else {
        actions.append(button(t('editProduct'), () => onNavigate(`products/${variant.id}`), `${t('editProduct')}: ${variant.label || variant.sku} (${variant.sku})`));
      }
      rows.append(row);
    }
  }

  // Several products at once: tick the products, then switch them on or off together. All or nothing on the server.
  const selected = new Set();
  const bulkBar = document.createElement('div');
  bulkBar.className = 'product-bulk'; bulkBar.hidden = true;
  const bulkCount = document.createElement('strong');
  const bulkMessage = document.createElement('p');
  bulkMessage.className = 'message'; bulkMessage.setAttribute('role', 'status');
  let bulkBusy = false, bulkMessageKey = '', bulkMessageCount = 0;
  const bulkButtons = [['bulkActivate', 'activate'], ['bulkDeactivate', 'deactivate']].map(([label, action]) => {
    const control = button(t(label), () => runBulk(action));
    control.dataset.labelKey = label;
    return control;
  });
  const bulkClear = button(t('bulkClear'), () => { selected.clear(); renderList(); });
  bulkClear.dataset.labelKey = 'bulkClear';
  bulkBar.append(bulkCount, ...bulkButtons, bulkClear, bulkMessage);
  list.before(bulkBar);
  function refreshBulk() {
    bulkBar.hidden = selected.size === 0 && !bulkMessageKey;
    bulkCount.textContent = selected.size ? t('bulkSelected').replace('{count}', selected.size) : '';
    for (const control of [...bulkButtons, bulkClear]) { control.textContent = t(control.dataset.labelKey); control.hidden = selected.size === 0; control.disabled = bulkBusy; }
    bulkMessage.textContent = bulkMessageKey ? t(bulkMessageKey).replace('{count}', bulkMessageCount) : '';
    bulkMessage.classList.toggle('is-error', ['bulkFailed', 'exportFailed', 'exportTooMany'].includes(bulkMessageKey));
  }
  find('#product-export').addEventListener('click', async (event) => {
    const control = event.currentTarget;
    control.disabled = true;
    try {
      const response = await fetch(`/api/v1/seller/products/export.csv?${new URLSearchParams({ search: search.value.trim() })}`, { cache: 'no-store' });
      if (response.status === 401) { if (isCurrent()) onUnauthorized(); return; }
      if (!response.ok) {
        const code = (await response.json().catch(() => ({}))).error?.code;
        if (isCurrent()) { bulkMessageKey = code === 'TOO_MANY_ROWS' ? 'exportTooMany' : 'exportFailed'; refreshBulk(); }
        return;
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await response.blob());
      link.download = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || 'products.csv';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      if (isCurrent()) { bulkMessageKey = 'exportDone'; refreshBulk(); }
    } catch { if (isCurrent()) { bulkMessageKey = 'exportFailed'; refreshBulk(); } }
    finally { if (control.isConnected) control.disabled = false; }
  });

  async function runBulk(action) {
    if (!selected.size || bulkBusy) return;
    bulkBusy = true; bulkMessageKey = ''; refreshBulk();
    try {
      const result = await api('POST', '/api/v1/seller/products/bulk', { ids: [...selected], action });
      if (!isCurrent()) return;
      selected.clear(); bulkMessageKey = 'bulkDone'; bulkMessageCount = result.changed;
    } catch (failure) {
      if (!isCurrent() || failure.message === 'unauthorized') return;
      bulkMessageKey = 'bulkFailed';
    }
    bulkBusy = false;
    await load(true);
    refreshBulk();
  }

  function renderList() {
    list.replaceChildren();
    for (const id of [...selected]) if (!items.some((product) => product.id === id && product.variantCount <= 1)) selected.delete(id);
    for (const product of items) {
      const card = document.createElement('article');
      card.className = 'product-card';
      card.dataset.productId = product.id;
      if (product.imageUrl) {
        const image = document.createElement('img');
        revealImage(image);
        image.src = thumbUrl(product.imageUrl);
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
      const grouped = product.variantCount > 1;
      const sku = document.createElement('p');
      sku.className = 'product-row-sku';
      sku.textContent = grouped ? t('variantsCountFormat').replace('{count}', product.variantCount) : product.sku;
      const price = document.createElement('p');
      price.className = 'product-card-price';
      price.textContent = grouped && product.priceFromMinor !== product.priceToMinor
        ? `${formatMoney(product.priceFromMinor, product.currency)} – ${formatMoney(product.priceToMinor, product.currency)}`
        : formatMoney(grouped ? product.priceFromMinor : product.priceMinor, product.currency);
      const chip = document.createElement('span');
      const activeNow = grouped ? product.activeCount > 0 : product.active;
      chip.className = `product-status-chip${activeNow ? '' : ' inactive'}`;
      chip.textContent = grouped && product.activeCount > 0 && product.activeCount < product.variantCount
        ? t('variantsActiveFormat').replace('{active}', product.activeCount).replace('{count}', product.variantCount)
        : t(activeNow ? 'active' : 'inactive');
      const stock = document.createElement('p');
      stock.className = 'product-card-identity';
      const stockNow = grouped ? product.stockTotal : product.stockQuantity;
      stock.textContent = stockNow === null ? `${t('stockLabel')}: ${t('unlimitedStock')}`
        : stockNow === 0 ? t('outOfStock') : `${t('stockLabel')}: ${stockNow}`;
      main.append(identity, sku, price, stock, chip);
      const actions = document.createElement('div');
      actions.className = 'product-card-actions';
      const toggleButton = button(t(product.active ? 'deactivateProduct' : 'activateProduct'),
        (event) => toggle(product, event.currentTarget),
        `${t(product.active ? 'deactivateProduct' : 'activateProduct')}: ${product.name} (${product.sku})`);
      toggleButton.dataset.action = 'toggle';
      toggleButton.disabled = pendingChanges.has(product.id);
      // A product with several variants is switched on or off per variant, inside the product.
      actions.append(button(t('editProduct'), () => onNavigate(`products/${product.id}`), `${t('editProduct')}: ${product.name} (${product.sku})`));
      if (!grouped) {
        actions.append(toggleButton);
        const pick = document.createElement('label');
        pick.className = 'product-select';
        const box = document.createElement('input');
        box.type = 'checkbox'; box.checked = selected.has(product.id); box.dataset.action = 'select';
        box.setAttribute('aria-label', t('bulkSelectProduct').replace('{name}', `${product.name} (${product.sku})`));
        box.addEventListener('change', () => { if (box.checked) selected.add(product.id); else selected.delete(product.id); bulkMessageKey = ''; refreshBulk(); });
        pick.append(box);
        actions.prepend(pick);
      }
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
    refreshBulk();
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
      if (response.status === 401) { if (isCurrent()) onUnauthorized(); throw new Error('unauthorized'); }
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
      if (sequence !== loadSequence || !isCurrent()) return false;
      items = reset ? result.items : [...items, ...result.items];
      if (reset) appliedSearch = query;
      nextOffset = result.nextOffset;
      setStatus(items.length ? '' : appliedSearch ? 'noMatchingProducts' : 'noProducts');
      clearSearch.hidden = Boolean(items.length) || !appliedSearch;
      renderList();
      return true;
    } catch {
      if (sequence === loadSequence && isCurrent()) {
        setStatus('networkError');
        retryList.hidden = false;
      }
      return false;
    } finally {
      if (sequence === loadSequence && isCurrent()) more.disabled = false;
    }
  }

  function resetForm() {
    editorLoadSequence++;
    readingGallery = false;
    find('#product-save').disabled = saving;
    editingId = null;
    form.reset();
    renderOptionPickers([]);
    form.hidden = true;
    formBaseline = null;
    originalImageUrl = null;
    pendingRemove = false;
    galleryImages = [];
    galleryReferences = [];
    galleryLoaded = false;
    sharedGallery = false; galleryEditable = true; galleryHolderId = null;
    expectedUpdatedAt = null;
    showImage('none');
    renderGallery();
    setError('');
    setFormSuccess('');
    document.dispatchEvent(new Event('updateguardchange'));
  }

  async function edit(product, { skipGuard = false, detailLoaded = false } = {}) {
    if (!skipGuard && !confirmDiscard()) return;
    const sequence = ++editorLoadSequence;
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
    form.elements.stockQuantity.value = product.stockQuantity ?? '';
    form.elements.variantGroup.value = product.variantGroup || '';
    form.elements.variantLabel.value = product.variantLabel || '';
    renderOptionPickers(product.options || []);
    form.elements.image.value = '';
    originalImageUrl = product.imageUrl;
    pendingRemove = false;
    showImage(product.imageUrl ? 'current' : 'none', product.imageUrl);
    galleryImages = [];
    galleryLoaded = false;
    sharedGallery = false; galleryEditable = true; galleryHolderId = null;
    renderGallery();
    setError('');
    setFormSuccess('');
    captureBaseline();
    if (!detailLoaded) {
      form.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      form.elements.sku.focus();
    }
    if (detailLoaded) {
      acceptGallery(product);
      renderVariants(product);
      return;
    }
    renderVariants(null);
    try {
      const detail = await api('GET', `/api/v1/seller/products/${product.id}`);
      if (!isCurrent() || editingId !== product.id || sequence !== editorLoadSequence) return;
      if (detail.updatedAt !== product.updatedAt) { setError('productChangedReopen'); return; }
      acceptGallery(detail, { capture: false });
      renderVariants(detail);
    } catch { if (isCurrent() && editingId === product.id && sequence === editorLoadSequence) setError('productError'); }
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
    const variantOf = /^products\/new\/([0-9a-f-]{36})$/.exec(route)?.[1];
    if (route === 'products/new' || variantOf) {
      await settingsPromise;
      let base = null;
      if (variantOf) {
        try { base = await api('GET', `/api/v1/seller/products/${variantOf}`); } catch { setEditorStatus('productNotFound'); return; }
      }
      if (sequence !== routeSequence || !isCurrent()) return;
      form.hidden = false;
      populateCategories(base?.categoryCode);
      form.elements.currency.value = base?.currency || defaultCurrency;
      if (base) {
        // A new variant starts from the shared details of the product it joins; SKU, options and price are its own.
        form.elements.name.value = base.name;
        form.elements.description.value = base.description;
        form.elements.price.value = (base.priceMinor / 100).toFixed(2);
        form.elements.variantGroup.value = base.variantGroup || '';
        form.elements.active.checked = true;
        setEditorStatus('');
        form.elements.sku.focus();
      }
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
      if (sequence !== routeSequence || !isCurrent()) return;
      await edit(detail, { skipGuard: true, detailLoaded: true });
      setEditorStatus('');
    } catch (failure) {
      if (sequence !== routeSequence || !isCurrent() || failure.status === 401) return;
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
      if (isCurrent()) setStatus('productError', product.name);
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
      if (isCurrent()) setStatus('productError', product.name);
    }
  }

  find('#product-new').addEventListener('click', () => onNavigate('products/new'));
  find('#product-add-variant').addEventListener('click', () => { if (editingId) onNavigate(`products/new/${editingId}`); });
  find('#product-open-main').addEventListener('click', () => { if (galleryHolderId) onNavigate(`products/${galleryHolderId}`); });
  find('#product-cancel').addEventListener('click', () => onNavigate('products'));
  form.addEventListener('input', () => { if (formSuccessKey) setFormSuccess(''); });
  form.addEventListener('change', () => { if (formSuccessKey) setFormSuccess(''); });
  find('#product-search-form').addEventListener('submit', (event) => { event.preventDefault(); load(); });
  more.addEventListener('click', () => load(false));
  removeImage.addEventListener('click', () => {
    if (!galleryLoaded || (galleryImages.length > 1 && !sharedGallery)) return;
    form.elements.image.value = '';
    pendingRemove = Boolean(originalImageUrl);
    if (!sharedGallery) galleryImages = [];
    showImage(pendingRemove ? 'removed' : 'none');
    renderGallery();
  });
  restoreImage.addEventListener('click', () => {
    pendingRemove = false;
    galleryImages = originalGallery.map(item => ({ ...item }));
    showImage('current', originalImageUrl);
    renderGallery();
  });
  form.elements.image.addEventListener('change', async () => {
    const file = form.elements.image.files[0];
    const sequence = routeSequence;
    const ownsRead = () => isCurrent() && sequence === routeSequence && form.elements.image.files[0] === file;
    if (file) {
      try {
        const dataUrl = await readImage(file);
        if (!ownsRead()) return;
        pendingRemove = false;
        if (editingId && !sharedGallery) {
          galleryImages = galleryImages.filter(item => item.id !== 'main');
          galleryImages.unshift({ id: 'main', src: dataUrl });
        }
        showImage('replacement', dataUrl);
        renderGallery();
      } catch {
        if (ownsRead()) setError('productError');
      }
    } else showImage(originalImageUrl ? 'current' : 'none', originalImageUrl);
  });
  form.elements.gallery.addEventListener('change', async () => {
    const files = [...form.elements.gallery.files];
    if (!files.length || readingGallery || saving) return;
    if (files.length + galleryImages.length > 10) { setError('galleryLimit'); form.elements.gallery.value = ''; return; }
    const sequence = routeSequence;
    const ownsRead = () => isCurrent() && sequence === routeSequence;
    readingGallery = true; renderGallery(); find('#product-save').disabled = true; setError('');
    try {
      const data = await Promise.all(files.map(readImage));
      const previews = await Promise.all(files.map(file => makeThumbnail(file)));
      if (!ownsRead()) return;
      data.forEach((imageDataUrl, index) => {
        if (!galleryImages.some(item => item.imageDataUrl === imageDataUrl)) galleryImages.push({ imageDataUrl, src: imageDataUrl, thumbDataUrl: previews[index] });
      });
    } catch { if (ownsRead()) setError('productError'); }
    finally {
      if (ownsRead()) {
        readingGallery = false;
        form.elements.gallery.value = '';
        find('#product-save').disabled = saving;
        renderGallery();
        document.dispatchEvent(new Event('updateguardchange'));
      }
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || readingGallery || (editingId && !galleryLoaded)) return;
    const save = find('#product-save');
    const productId = editingId;
    const sequence = routeSequence;
    const ownsRoute = () => isCurrent() && sequence === routeSequence;
    saving = true;
    const finish = beginMutation();
    save.disabled = true;
    renderGallery();
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
        stockQuantity: stockFromInput(form.elements.stockQuantity.value),
        ...(optionTypes.length ? { options: selectedOptions() } : {}),
      };
      if (productId && formBaseline) {
        const baseline = JSON.parse(formBaseline);
        // Metadata edits must not resubmit immutable legacy money fields.
        if (payload.priceMinor === priceToMinor(baseline.values.price)) delete payload.priceMinor;
        if (payload.currency === baseline.values.currency) delete payload.currency;
        if (payload.active === baseline.active) delete payload.active;
      }
      // Snapshot the initiating editor before image decoding yields to navigation.
      if (productId) {
        if (galleryEditable) {
          payload.gallery = galleryImages.map(item => item.imageDataUrl ? { imageDataUrl: item.imageDataUrl, ...(item.thumbDataUrl ? { thumbDataUrl: item.thumbDataUrl } : {}) } : { id: item.id });
          payload.expectedUpdatedAt = expectedUpdatedAt;
        }
      }
      const file = form.elements.image.files[0];
      if (file) {
        payload.imageDataUrl = await readImage(file);
        const preview = await makeThumbnail(file);   // the browser makes the small copy that lists download
        if (preview) payload.thumbDataUrl = preview;
      }
      else if (pendingRemove) payload.imageDataUrl = null;
      if (!ownsRoute()) return;
      const saved = await api(productId ? 'PATCH' : 'POST', productId ? `/api/v1/seller/products/${productId}` : '/api/v1/seller/products', payload);
      if (!ownsRoute()) return;
      resetForm();
      await load();
      if (!ownsRoute()) return;
      await edit(saved, { skipGuard: true, detailLoaded: true });
      if (!ownsRoute()) return;
      onSaved(saved.id);
      setFormSuccess('productSaved');
      form.scrollIntoView({ block: 'start' });
      formSuccess.focus({ preventScroll: true });
    } catch (failure) {
      if (!ownsRoute()) return;
      const galleryConflict = pendingRemove && failure.field === 'imageDataUrl';
      const optionKey = failure.field === 'options' ? (optionErrorKey[failure.code] || 'productError') : null;
      if (optionKey) { optionsError.textContent = t(optionKey); optionsError.hidden = false; }
      setError(optionKey || (failure.code === 'PRODUCT_CHANGED' ? 'productChangedReopen' : failure.field === 'gallery' ? 'galleryLimit' : galleryConflict ? 'removeGalleryFirst' : failure.code === 'COMPANY_CURRENCY_CONFLICT' ? 'currencyConflict' : failure.code === 'DUPLICATE_SKU' ? 'duplicateSku' : failure.code === 'DUPLICATE_VARIANT' ? 'duplicateVariant' : 'productError'));
      if (galleryConflict && productId && editingId === productId) {
        // A rejected write owns no new baseline. Preserve all draft metadata,
        // image removals and order so retry and navigation guards remain truthful.
        galleryPanel.scrollIntoView({ block: 'nearest' });
      } else {
        const field = failure.code === 'DUPLICATE_SKU' ? 'sku' : failure.field === 'priceMinor' ? 'price' : failure.field === 'imageDataUrl' ? 'image' : failure.field;
        if (field && form.elements[field]) form.elements[field].focus();
      }
    } finally { saving = false; finish(); if (isCurrent()) { save.disabled = false; renderGallery(); } document.dispatchEvent(new Event('updateguardchange')); }
  });

  const settingsPromise = loadSettings();
  settingsPromise.then(() => { if (isCurrent() && loadSequence === 0) load(); });
  search.placeholder = t('searchNameOrSkuHint');
  return {
    showRoute,
    refreshLocale() {
      translate(root);
      renderList();
      renderGallery();
      populateCategories(form.elements.category.value);
      renderOptionPickers();
      search.placeholder = t('searchNameOrSkuHint');
      status.textContent = statusKey ? `${statusProductName ? `${statusProductName}: ` : ''}${t(statusKey)}` : '';
      error.textContent = formErrorKey ? t(formErrorKey) : '';
      formSuccess.textContent = formSuccessKey ? t(formSuccessKey) : '';
      editorStatus.textContent = editorStatusKey ? t(editorStatusKey) : '';
    },
    hasUnsavedChanges,
    draftSignature: () => JSON.stringify([editingId, form.hidden, formState()]),
    isBusy: () => saving || readingGallery || mutations > 0,
  };
}
