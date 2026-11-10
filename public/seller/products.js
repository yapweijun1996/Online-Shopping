import { apiUrl } from '../shared/base-path.js';
import { icon } from '../shared/icons.js';
import { formatMoney, t, translate } from '../shared/i18n.js';
import { confirmModal } from '../shared/modal.js';
import { beginMutation } from '../shared/update-guard.js';
import { revealImage } from '../shared/image-reveal.js';
import { makeThumbnail, thumbUrl } from '../shared/image-thumb.js';
import { inputFailure, priceToMinor, stockFromInput } from './product-fields.js';
import './ops-copy.js';
import { openImportDialog } from './product-import.js';
import { editorText } from './product-editor-copy.js';
import { mountProductDetailEditor } from './product-detail-editor.js';

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
  const galleryStatus = find('#product-gallery-status');
  const format = (text, values) => text.replace(/\{(\w+)\}/g, (match, key) => String(values[key] ?? match));
  find('#product-photo-preview .photo-preview-close').addEventListener('click', () => find('#product-photo-preview').close());
  find('#product-photo-preview').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
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
  const backText = document.createElement('span');
  backText.dataset.i18n = 'backToProducts';
  backText.textContent = t('backToProducts');
  back.replaceChildren(icon('left'), backText);
  const editorStatus = document.createElement('p');
  editorStatus.id = 'product-editor-status';
  editorStatus.className = 'message';
  editorStatus.setAttribute('role', 'status');
  editorStatus.setAttribute('aria-live', 'polite');
  const listRecovery = document.createElement('div');
  listRecovery.className = 'product-list-recovery';
  const clearSearch = button(t('clearSearch'), () => {
    search.value = '';
    load(true, '');
  });
  clearSearch.dataset.i18n = 'clearSearch';
  clearSearch.hidden = true;
  const retryList = button(t('retry'), () => loadSettings().then(() => load()));
  retryList.dataset.i18n = 'retry';
  retryList.hidden = true;
  listRecovery.append(clearSearch, retryList);
  const listHeading = document.createElement('div');
  listHeading.className = 'product-list-heading';
  for (const key of ['product', 'sku', 'price', 'catalogInventory', 'orderStatus', 'actions']) {
    const label = document.createElement('span');
    label.setAttribute('aria-hidden', 'true');
    label.dataset.i18n = key;
    label.textContent = t(key);
    listHeading.append(label);
  }
  const statusTabs = document.createElement('div');
  statusTabs.className = 'product-status-tabs';
  statusTabs.setAttribute('role', 'group'); statusTabs.setAttribute('aria-label', t('orderStatus'));
  const statValues = new Map(), statusTabButtons = new Map();
  for (const [name, key] of [['active', 'active'], ['inactive', 'inactive'], ['all', 'catalogAll']]) {
    const tab = button('', () => { filterStatus = name; load(); });
    tab.dataset.catalogStatus = name; tab.setAttribute('aria-controls', 'product-list');
    const label = document.createElement('span'); label.dataset.i18n = key; label.textContent = t(key);
    const value = document.createElement('span'); value.textContent = '—'; value.dataset.stat = name === 'all' ? 'total' : name;
    statValues.set(name === 'all' ? 'total' : name, value); statusTabButtons.set(name, tab);
    tab.replaceChildren(label, document.createTextNode(' ('), value, document.createTextNode(')')); statusTabs.append(tab);
  }
  const statusFilter = document.createElement('div'); statusFilter.className = 'product-list-filters';
  const filterSelect = (id, key, choices) => {
    const label = document.createElement('label'); label.className = 'product-filter-select';
    const text = document.createElement('span'); text.dataset.i18n = key; text.textContent = t(key);
    const select = document.createElement('select'); select.id = id;
    for (const [value, title] of choices) { const option = new Option(t(title), value); option.dataset.i18n = title; select.add(option); }
    label.append(text, select); statusFilter.append(label);
    select.addEventListener('change', () => load());
    return select;
  };
  const categoryFilter = filterSelect('product-filter-category', 'category', [['', 'allCategories']]);
  const stockFilter = filterSelect('product-filter-stock', 'stockLabel', [['', 'stockAll'], ['in-stock', 'inStock'], ['out-of-stock', 'outOfStock'], ['unlimited', 'unlimitedStock']]);
  const sortFilter = filterSelect('product-filter-sort', 'productSort', [['updated', 'productSortUpdated'], ['name', 'productSortName'], ['price_asc', 'productSortPriceAsc'], ['price_desc', 'productSortPriceDesc']]);
  const listSummary = document.createElement('p'); listSummary.className = 'product-list-summary'; listSummary.setAttribute('role', 'status'); listSummary.setAttribute('aria-live', 'polite');
  const removedUndo = document.createElement('div'); removedUndo.className = 'product-filter-undo'; removedUndo.hidden = true;
  removedUndo.setAttribute('role', 'status');
  listRecovery.append(removedUndo);
  function refreshStatusFilter() {
    for (const [name, tab] of statusTabButtons) tab.setAttribute('aria-pressed', String(filterStatus === name));
    categoryFilter.value = filterCategory; stockFilter.value = filterStock; sortFilter.value = filterSort;
  }
  function refreshStats() {
    listSummary.textContent = matchingTotal === null ? '' : `${format(t('productResultsFormat'), { count: items.length, total: matchingTotal })} · ${t(appliedStatus === 'all' ? 'catalogAll' : appliedStatus)}`;
    clearFilters.hidden = !appliedSearch && appliedStatus === 'active' && !appliedCategory && !appliedStock && appliedSort === 'updated';
    exportHint.textContent = matchingTotal === null ? '' : format(t('catalogExportScope'), { count: matchingTotal });
    for (const [key, value] of statValues) value.textContent = catalogStats ? String(catalogStats[key]) : '—';
    for (const tab of statusTabButtons.values()) tab.setAttribute('aria-label', tab.textContent);
  }
  function renderRemovedUndo(product) {
    removedUndo.replaceChildren();
    removedUndo.hidden = appliedStatus === 'all' || (appliedStatus === 'active' ? product.active : !product.active);
    if (removedUndo.hidden) return;
    const text = document.createElement('span'); text.textContent = `${product.name}: ${t(product.active ? 'productActivatedInline' : 'productDeactivatedInline')}`;
    const undo = button(t('undoChange'), event => undoToggle(product, event.currentTarget));
    removedUndo.append(text, undo);
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
  // Price shows its currency inside the field; the read-only currency below explains where it comes from.
  const pricePrefix = document.createElement('span');
  pricePrefix.className = 'input-prefix';
  pricePrefix.setAttribute('aria-hidden', 'true');
  const priceBox = document.createElement('span');
  priceBox.className = 'input-affix';
  form.elements.price.before(priceBox);
  priceBox.append(pricePrefix, form.elements.price);
  const setCurrency = (value) => { form.elements.currency.value = value; pricePrefix.textContent = value; pricePrefix.hidden = !value; };
  form.elements.stockQuantity.placeholder = t('stockUnlimited');
  const activeHelp = document.createElement('small');
  activeHelp.id = 'product-active-help';
  activeHelp.className = 'check-help';
  activeHelp.dataset.i18n = 'activeHelp';
  activeHelp.textContent = t('activeHelp');
  form.elements.active.setAttribute('aria-describedby', 'product-active-help');
  form.elements.active.closest('label').after(activeHelp);
  // Stock is availability: it sits with price and the shop switch, so the details card keeps only descriptive fields.
  priceFields.append(form.elements.price.closest('label'), form.elements.currency.closest('label'), form.elements.stockQuantity.closest('label'), form.elements.active.closest('label'), activeHelp);
  pricing.append(priceFields);
  const imageColumn = group('productImages', 'product-image-column');
  imageColumn.className = 'product-image-column';
  imageColumn.append(form.elements.image.closest('label'), imagePanel, galleryPanel);
  const editorLayout = document.createElement('div');
  editorLayout.className = 'product-editor-layout';
  formFields.before(editorLayout);
  details.append(formFields);
  editorLayout.append(details, pricing, imageColumn);
  const summaryLabel = form.elements.description.closest('label');
  const summaryTitle = summaryLabel.querySelector('span'); summaryTitle.dataset.i18n = 'pedit_summary'; summaryTitle.textContent = editorText('summary');
  const summaryHelp = document.createElement('small'); summaryHelp.id = 'product-summary-help'; summaryHelp.dataset.i18n = 'pedit_summaryHelp'; summaryHelp.textContent = editorText('summaryHelp'); summaryLabel.append(summaryHelp); form.elements.description.setAttribute('aria-describedby', summaryHelp.id);
  const nameLabel = form.elements.name.closest('label');
  nameLabel.classList.add('full');
  formFields.prepend(nameLabel, form.elements.sku.closest('label'), form.elements.category.closest('label'), form.elements.description.closest('label'));
  // Variant group and option label belong together: one section, side by side, with their explanation directly below.
  const variantConfig = document.createElement('section');
  variantConfig.className = 'product-variant-config full';
  variantConfig.setAttribute('aria-labelledby', 'product-variant-config-title');
  const variantTitle = document.createElement('h3');
  variantTitle.id = 'product-variant-config-title';
  variantTitle.dataset.i18n = 'variantConfigTitle';
  variantTitle.textContent = t('variantConfigTitle');
  const variantPair = document.createElement('div');
  variantPair.className = 'product-variant-pair';
  const variantInputs = [form.elements.variantGroup, form.elements.variantLabel];
  variantPair.append(...variantInputs.map((input) => input.closest('label')));
  const variantHelp = formFields.querySelector('[data-i18n="variantHelp"]');
  variantHelp.id = 'product-variant-help';
  variantHelp.classList.remove('full');
  for (const input of variantInputs) input.setAttribute('aria-describedby', 'product-variant-help');
  variantConfig.append(variantTitle, variantPair, variantHelp, find('#product-options'));
  // Keep each panel mounted: switching sections never resets file inputs or drafts.
  const richEditor = mountProductDetailEditor({ api, isCurrent: () => isCurrent(), fallbackText: () => form.elements.description.value });
  const identity = document.createElement('section'); identity.className = 'product-editor-identity';
  const identityImage = document.createElement('img'); identityImage.alt = ''; identityImage.hidden = true;
  const identityText = document.createElement('div');
  const identityName = document.createElement('h2'); const identityMeta = document.createElement('p'); identityMeta.className = 'shop-note';
  identityText.append(identityName, identityMeta); identity.append(identityImage, identityText);
  const sharedHint = document.createElement('p'); sharedHint.className = 'shop-note product-editor-shared'; sharedHint.dataset.i18n = 'pedit_shared'; sharedHint.textContent = editorText('shared');
  const tabs = document.createElement('div'); tabs.className = 'product-editor-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', editorText('tabs'));
  const panels = new Map(), tabButtons = new Map(); let selectedTab = 'basic';
  for (const key of ['basic', 'images', 'detail', 'variants']) {
    const panel = document.createElement('section'); panel.className = 'product-editor-tabpanel'; panel.id = `product-editor-panel-${key}`; panel.dataset.productTab = key; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `product-editor-tab-${key}`); panel.tabIndex = 0;
    const tab = button(editorText(key), () => selectTab(key)); tab.id = `product-editor-tab-${key}`; tab.dataset.i18n = `pedit_${key}`; tab.dataset.i18nAria = `pedit_${key}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id);
    panels.set(key, panel); tabButtons.set(key, tab); tabs.append(tab);
    tab.addEventListener('keydown', (event) => {
      const keys = [...tabButtons.keys()]; const index = keys.indexOf(key);
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : event.key === 'ArrowRight' ? (index + 1) % keys.length : event.key === 'ArrowLeft' ? (index + keys.length - 1) % keys.length : null;
      if (target === null) return; event.preventDefault(); selectTab(keys[target]); tabButtons.get(keys[target]).focus();
    });
  }
  function selectTab(key) {
    selectedTab = key;
    form.querySelector('.product-editor-actions')?.toggleAttribute('hidden', key === 'detail');
    for (const [name, panel] of panels) { panel.hidden = name !== key; const tab = tabButtons.get(name); tab.setAttribute('aria-selected', String(name === key)); tab.tabIndex = name === key ? 0 : -1; }
    if (key === 'detail') richEditor.refreshPreview();
  }
  panels.get('basic').append(editorLayout);
  panels.get('images').append(imageColumn);
  panels.get('detail').append(richEditor.root);
  panels.get('variants').append(find('#product-variants'), variantConfig);
  variantConfig.classList.remove('full');
  const aiPanel = document.createElement('section'); aiPanel.className = 'product-editor-ai';
  const aiTitle = document.createElement('h3'); aiTitle.dataset.i18n = 'pedit_ai'; aiTitle.textContent = editorText('ai');
  const aiHelp = document.createElement('p'); aiHelp.className = 'shop-note'; aiHelp.dataset.i18n = 'pedit_aiHelp'; aiHelp.textContent = editorText('aiHelp');
  const aiHint = document.createElement('p'); aiHint.className = 'shop-note';
  const openAI = button(editorText('ai'), () => { if (editingId) onNavigate(`aistudio/${editingId}`); }); openAI.id = 'product-open-ai'; openAI.dataset.i18n = 'pedit_ai'; openAI.dataset.i18nAria = 'pedit_ai';
  aiPanel.append(aiTitle, aiHelp, aiHint, openAI); imageColumn.append(aiPanel);
  form.prepend(identity, sharedHint, tabs, ...panels.values());
  selectTab('basic');
  function refreshIdentity() {
    identityName.textContent = form.elements.name.value || editorText('new');
    identityMeta.textContent = [form.elements.sku.value, form.elements.active.checked ? t('active') : t('inactive')].filter(Boolean).join(' · ');
    identityImage.hidden = !originalImageUrl; if (originalImageUrl) identityImage.src = originalImageUrl; else identityImage.removeAttribute('src');
    aiHint.textContent = !editingId ? editorText('saveFirst') : !galleryEditable ? editorText('aiHolder') : '';
    aiHint.hidden = !aiHint.textContent; openAI.disabled = !editingId || !galleryLoaded || !galleryEditable || saving || richEditor.busy();
  }
  form.addEventListener('invalid', (event) => { const panel = event.target.closest('[data-product-tab]'); if (panel) selectTab(panel.dataset.productTab); }, true);
  form.elements.name.addEventListener('input', refreshIdentity);
  form.elements.sku.addEventListener('input', refreshIdentity);
  form.elements.active.addEventListener('change', refreshIdentity);
  const editorActions = document.createElement('div');
  editorActions.className = 'product-editor-actions';
  editorActions.append(find('#product-cancel'), find('#product-save'));
  form.append(editorActions);
  find('.product-form-heading').remove();
  const listShell = document.createElement('div');
  listShell.className = 'product-list-shell';
  listShell.hidden = true;
  listShell.append(listHeading, list);
  const heading = document.createElement('div'); heading.className = 'product-page-heading';
  const intro = document.createElement('p'); intro.dataset.i18n = 'catalogIntro'; intro.textContent = t('catalogIntro');
  heading.append(intro, find('#product-new'));
  const toolbar = find('.product-toolbar');
  const transfers = document.createElement('div'); transfers.className = 'product-transfer-actions';
  transfers.append(find('#product-import'), find('#product-export'));
  const clearFilters = button(t('clearFilters'), () => {
    search.value = ''; filterStatus = 'active'; categoryFilter.value = ''; stockFilter.value = ''; sortFilter.value = 'updated'; load(true, '');
  }); clearFilters.id = 'product-clear-filters'; clearFilters.dataset.i18n = 'clearFilters'; clearFilters.hidden = true;
  const exportHint = document.createElement('p'); exportHint.className = 'product-export-scope'; exportHint.id = 'product-export-scope';
  transfers.querySelector('#product-export').setAttribute('aria-describedby', exportHint.id);
  toolbar.append(statusFilter, clearFilters, transfers);
  listView.append(heading, statusTabs, toolbar, exportHint, status, listRecovery, listShell, listSummary, more);
  // Change history is secondary: a compact disclosure after the cards, not a full-width bar above them.
  editorActions.before(find('#product-history'));
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
  let filterStatus = 'active', appliedStatus = 'active';
  let filterCategory = '', filterStock = '', filterSort = 'updated';
  let appliedCategory = '', appliedStock = '', appliedSort = 'updated';
  let catalogStats = null;
  let matchingTotal = null;
  let loadSequence = 0;
  let editingId = null;
  let imageEntryId = null;
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

  const urlKeys = { search: 'productSearch', status: 'productStatus', category: 'productCategory', stock: 'productStock', sort: 'productSort' };
  function restoreFilters() {
    const params = new URL(location.href).searchParams;
    search.value = appliedSearch = params.get(urlKeys.search) || '';
    filterStatus = ['active', 'inactive', 'all'].includes(params.get(urlKeys.status)) ? params.get(urlKeys.status) : 'active';
    filterCategory = params.get(urlKeys.category) || '';
    filterStock = ['', 'in-stock', 'out-of-stock', 'unlimited'].includes(params.get(urlKeys.stock) || '') ? params.get(urlKeys.stock) || '' : '';
    filterSort = ['updated', 'name', 'price_asc', 'price_desc'].includes(params.get(urlKeys.sort)) ? params.get(urlKeys.sort) : 'updated';
    refreshStatusFilter();
  }
  function saveFilters() {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({ search: appliedSearch, status: appliedStatus === 'active' ? '' : appliedStatus, category: appliedCategory, stock: appliedStock, sort: appliedSort === 'updated' ? '' : appliedSort })) {
      if (value) url.searchParams.set(urlKeys[key], value); else url.searchParams.delete(urlKeys[key]);
    }
    history.replaceState(history.state, '', url);
  }
  restoreFilters();
  async function confirmDeactivation(name) {
    return confirmModal(format(t('catalogDeactivateConfirm'), { name }), { title: t('deactivateProduct'), confirmLabel: t('deactivateProduct') });
  }

  function setStatus(key, productName = '') {
    statusKey = key;
    statusProductName = productName;
    status.classList.remove('sr-only');
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
  function hasUnsavedChanges() { return saving || readingGallery || richEditor.busy() || richEditor.dirty() || (!form.hidden && formBaseline !== JSON.stringify(formState())); }
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

  // A small accessible menu: Enter/Space/ArrowDown open it, arrows move, Escape or Tab closes it and returns focus.
  function createMenu(label, items) {
    const wrap = document.createElement('div'); wrap.className = 'product-gallery-menu';
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'product-gallery-more icon-button';
    toggle.setAttribute('aria-label', label); toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false');
    toggle.append(icon('more'));
    const list = document.createElement('div'); list.className = 'product-gallery-menu-list'; list.setAttribute('role', 'menu'); list.hidden = true;
    list.setAttribute('aria-label', label); list.append(...items);
    const enabled = () => items.filter((node) => !node.disabled);
    const close = (refocus) => { list.hidden = true; toggle.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); if (refocus) toggle.focus(); };
    const outside = (event) => { if (!wrap.contains(event.target)) close(false); };
    const open = (focusLast = false) => {
      galleryList.querySelectorAll('.product-gallery-menu-list:not([hidden])').forEach((other) => other.closest('.product-gallery-menu').closeMenu(false));
      list.hidden = false; toggle.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true);
      const choices = enabled(); (focusLast ? choices.at(-1) : choices[0])?.focus();
    };
    wrap.closeMenu = close;
    toggle.addEventListener('click', () => (list.hidden ? open() : close(true)));
    toggle.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(event.key === 'ArrowUp'); } });
    list.addEventListener('keydown', (event) => {
      const choices = enabled(), at = choices.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
      else if (event.key === 'Tab') close(false);
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); choices[(at + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus(); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); (event.key === 'Home' ? choices[0] : choices.at(-1))?.focus(); }
    });
    wrap.append(toggle, list);
    return wrap;
  }
  function openPhotoPreview(src, position) {
    const dialog = find('#product-photo-preview');
    dialog.querySelector('img').src = src;
    dialog.querySelector('img').alt = `${form.elements.name.value}: ${t('gallery')} ${position}`;
    dialog.querySelector('h3').textContent = format(t('viewPhotoFormat'), { number: position });
    dialog.showModal();
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
    const count = find('#product-gallery-count');
    count.textContent = galleryLoaded ? format(t('galleryCountFormat'), { count: galleryImages.length, max: 10 }) : '';
    const locked = !galleryEditable || saving || readingGallery;
    galleryImages.forEach((entry, index) => {
      // Image first: the photo, its position and Primary badge, then one main action and a More menu for the rest.
      const item = document.createElement('div');
      item.className = 'product-gallery-item'; item.dataset.imageId = entry.id || 'new';
      const position = index + 1;
      const view = document.createElement('button');
      view.type = 'button'; view.className = 'product-gallery-view';
      view.setAttribute('aria-label', format(t('viewPhotoFormat'), { number: position }));
      view.addEventListener('click', () => openPhotoPreview(entry.src, position));
      const photo = document.createElement('img');
      revealImage(photo);
      photo.src = entry.src;
      photo.alt = `${form.elements.name.value}: ${t('gallery')} ${position}`;
      view.append(photo);
      const meta = document.createElement('p'); meta.className = 'product-gallery-meta';
      const number = document.createElement('span'); number.textContent = String(position).padStart(2, '0');
      meta.append(number);
      if (index === 0) { const badge = document.createElement('span'); badge.className = 'product-gallery-badge'; badge.textContent = t('primaryPhoto'); meta.append(badge); }
      const actions = document.createElement('div'); actions.className = 'product-gallery-actions';
      // Staged edits: nothing is sent until Save. Focus follows the moved photo and the result is announced.
      const change = (fn, nextIndex, messageKey) => {
        if (saving || readingGallery || !item.isConnected) return;
        fn(); renderGallery();
        const target = galleryList.children[Math.max(0, Math.min(nextIndex, galleryImages.length - 1))];
        (target?.querySelector('.product-gallery-more') || find('#product-gallery-panel input[name=gallery]'))?.focus({ preventScroll: true });
        galleryStatus.textContent = format(t(messageKey), { number: nextIndex + 1 });
        document.dispatchEvent(new Event('updateguardchange'));
      };
      if (index > 0) {
        const primary = button(t('setPrimaryPhoto'), () => change(() => { galleryImages.splice(index, 1); galleryImages.unshift(entry); preview('current', entry.src); }, 0, 'photoNowPrimary'), `${t('setPrimaryPhoto')} ${position}`);
        primary.dataset.galleryAction = 'primary'; primary.disabled = locked;
        actions.append(primary);
      }
      const menuItem = (key, action, disabled, run) => {
        const node = document.createElement('button');
        node.type = 'button'; node.setAttribute('role', 'menuitem'); node.dataset.galleryAction = action;
        node.textContent = t(key); node.setAttribute('aria-label', `${t(key)} ${position}`);
        node.disabled = disabled; node.addEventListener('click', run);
        return node;
      };
      const more = createMenu(format(t('photoActionsFormat'), { number: position }), [
        menuItem('movePhotoEarlier', 'earlier', locked || index === 0, () => change(() => { [galleryImages[index - 1], galleryImages[index]] = [entry, galleryImages[index - 1]]; preview('current', galleryImages[0]?.src); }, index - 1, 'photoMovedFormat')),
        menuItem('movePhotoLater', 'later', locked || index === galleryImages.length - 1, () => change(() => { [galleryImages[index + 1], galleryImages[index]] = [entry, galleryImages[index + 1]]; preview('current', galleryImages[0]?.src); }, index + 1, 'photoMovedFormat')),
        menuItem('removePhoto', 'remove', locked, () => change(() => { galleryImages.splice(index, 1); preview(galleryImages.length ? 'current' : 'none', galleryImages[0]?.src); }, index, 'photoRemovedFormat')),
      ]);
      actions.append(more);
      item.append(view, meta, actions); galleryList.append(item);
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
    refreshIdentity();
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
        api('GET', apiUrl('v1/seller/categories')), api('GET', apiUrl('v1/seller/company-settings')),
        api('GET', apiUrl('v1/seller/option-types')).catch(() => ({ items: [] })),
      ]);
      if (!isCurrent()) return;
      categories = categoryResult.items;
      const pickedCategory = filterCategory || categoryFilter.value;
      const allCategoriesOption = new Option(t('allCategories'), ''); allCategoriesOption.dataset.i18n = 'allCategories';
      categoryFilter.replaceChildren(allCategoriesOption);
      for (const category of categories) categoryFilter.add(new Option(category.label, category.label));
      categoryFilter.value = pickedCategory;
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
      const data = await api('GET', apiUrl(`v1/seller/products/${id}/history?limit=50`));
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
            await api('PATCH', apiUrl(`v1/seller/products/${variant.id}`), { active: !variant.active });
            if (!isCurrent() || editingId !== detail.id) return;
            renderVariants(await api('GET', apiUrl(`v1/seller/products/${detail.id}`)));
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
  const selectBar = document.createElement('div');
  selectBar.className = 'product-select-all';
  const selectLabel = document.createElement('label');
  const selectAll = document.createElement('input');
  selectAll.type = 'checkbox';
  const selectText = document.createElement('span');
  selectText.dataset.i18n = 'bulkSelectLoaded';
  selectText.textContent = t('bulkSelectLoaded');
  selectLabel.append(selectAll, selectText);
  const variantsNote = document.createElement('span');
  variantsNote.className = 'product-select-note';
  variantsNote.dataset.i18n = 'bulkVariantsNote';
  selectBar.append(selectLabel);
  selectAll.addEventListener('change', () => {
    for (const product of items) {
      if (product.variantCount <= 1) {
        if (selectAll.checked) selected.add(product.id); else selected.delete(product.id);
      }
    }
    bulkMessageKey = '';
    renderList();
  });
  const bulkBar = document.createElement('div');
  bulkBar.className = 'product-bulk'; bulkBar.hidden = true;
  const bulkCount = document.createElement('strong');
  const bulkMessage = document.createElement('p');
  bulkMessage.className = 'message'; bulkMessage.setAttribute('role', 'status');
  let bulkBusy = false, bulkMessageKey = '', bulkMessageCount = 0, bulkMessageValues = null;
  const bulkButtons = [['bulkActivate', 'activate'], ['bulkDeactivate', 'deactivate']].map(([label, action]) => {
    const control = button(t(label), () => runBulk(action));
    control.dataset.labelKey = label;
    return control;
  });
  const bulkClear = button(t('bulkClear'), () => { selected.clear(); renderList(); });
  bulkClear.dataset.labelKey = 'bulkClear';
  bulkBar.append(bulkCount, ...bulkButtons, bulkClear, bulkMessage);
  listHeading.prepend(selectBar);
  list.before(variantsNote, bulkBar);
  function refreshBulk() {
    const eligible = items.filter((product) => product.variantCount <= 1);
    const selectedCount = eligible.filter((product) => selected.has(product.id)).length;
    listShell.hidden = !items.length && !bulkMessageKey;
    listHeading.hidden = !items.length;
    selectBar.hidden = list.hidden || !items.length;
    variantsNote.hidden = list.hidden || !items.some((product) => product.variantCount > 1);
    variantsNote.textContent = t('bulkVariantsNote');
    selectAll.disabled = bulkBusy || !eligible.length;
    selectAll.checked = eligible.length > 0 && selectedCount === eligible.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < eligible.length;
    selectText.textContent = t('bulkSelectLoaded');
    for (const box of list.querySelectorAll('[data-action="select"]')) box.disabled = bulkBusy;
    bulkBar.hidden = list.hidden || (selected.size === 0 && !bulkMessageKey);
    bulkCount.textContent = selected.size ? t('bulkSelected').replace('{count}', selected.size) : '';
    for (const control of [...bulkButtons, bulkClear]) { control.textContent = t(control.dataset.labelKey); control.hidden = selected.size === 0; control.disabled = bulkBusy; }
    const tooMany = selected.size > 100;
    if (tooMany) for (const control of bulkButtons) control.disabled = true;
    bulkMessage.textContent = tooMany ? t('bulkLimit') : bulkMessageKey ? Object.entries(bulkMessageValues ?? { count: bulkMessageCount }).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(bulkMessageKey)) : '';
    bulkMessage.classList.toggle('is-error', tooMany || ['bulkFailed', 'exportFailed', 'exportTooMany'].includes(bulkMessageKey));
  }
  find('#product-import').addEventListener('click', (event) => {
    openImportDialog({ trigger: event.currentTarget, onUnauthorized,
      post: async (body) => {
        const response = await fetch(apiUrl('v1/seller/products/import'), { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() }, body: JSON.stringify(body) });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw Object.assign(new Error('import'), { status: response.status, data });
        return data;
      },
      onImported: async (summary) => {
        if (!isCurrent()) return;
        bulkMessageKey = 'catalogImportDone'; bulkMessageValues = { created: summary.create, updated: summary.update };
        const refreshed = await load(true);
        if (!refreshed && isCurrent()) setStatus('catalogImportRefreshFailed');
        refreshBulk();
      } });
  });
  find('#product-export').addEventListener('click', async (event) => {
    const control = event.currentTarget;
    control.disabled = true;
    try {
      const response = await fetch(apiUrl(`v1/seller/products/export.csv?${new URLSearchParams({ search: appliedSearch, catalogStatus: appliedStatus, category: appliedCategory, stock: appliedStock, sort: appliedSort })}`), { cache: 'no-store' });
      if (response.status === 401) { if (isCurrent()) onUnauthorized(); return; }
      if (!response.ok) {
        const code = (await response.json().catch(() => ({}))).error?.code;
        if (isCurrent()) { bulkMessageValues = null; bulkMessageKey = code === 'TOO_MANY_ROWS' ? 'exportTooMany' : 'exportFailed'; refreshBulk(); }
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
    if (!selected.size || selected.size > 100 || bulkBusy) return;
    if (action === 'deactivate' && !await confirmDeactivation(format(t('bulkSelected'), { count: selected.size }), document.activeElement)) return;
    if (!isCurrent()) return;
    bulkBusy = true; bulkMessageKey = ''; refreshBulk();
    try {
      const result = await api('POST', apiUrl('v1/seller/products/bulk'), { ids: [...selected], action });
      if (!isCurrent()) return;
      selected.clear(); bulkMessageKey = 'bulkDone'; bulkMessageCount = result.changed; bulkMessageValues = null;
    } catch (failure) {
      if (!isCurrent() || failure.message === 'unauthorized') return;
      bulkMessageKey = 'bulkFailed';
    }
    bulkBusy = false;
    const refreshed = await load(true);
    if (!refreshed && isCurrent() && bulkMessageKey === 'bulkDone') setStatus('catalogChangedRefreshFailed');
    refreshBulk();
  }

  function imageEntry(product, message) {
    const entry = button('', () => { imageEntryId = product.id; onNavigate(`products/${product.id}`); }, `${t('catalogManageImage')}: ${product.name}`);
    entry.className = 'product-placeholder product-image-entry'; entry.title = `${t(message)} · ${t('catalogManageImage')}`;
    const label = document.createElement('span'); label.textContent = t(message); entry.append(icon('image'), label); return entry;
  }

  function renderList() {
    list.replaceChildren();
    for (const id of [...selected]) if (!items.some((product) => product.id === id && product.variantCount <= 1)) selected.delete(id);
    for (const product of items) {
      const card = document.createElement('article');
      card.className = 'product-card';
      card.dataset.productId = product.id;
      const grouped = product.variantCount > 1;
      const pick = document.createElement(grouped ? 'span' : 'label');
      pick.className = 'product-select';
      if (grouped) {
        pick.setAttribute('aria-hidden', 'true');
      } else {
        const box = document.createElement('input');
        box.type = 'checkbox'; box.checked = selected.has(product.id); box.dataset.action = 'select';
        box.setAttribute('aria-label', t('bulkSelectProduct').replace('{name}', `${product.name} (${product.sku})`));
        box.addEventListener('change', () => { if (box.checked) selected.add(product.id); else selected.delete(product.id); bulkMessageKey = ''; refreshBulk(); });
        pick.append(box);
      }
      card.append(pick);
      if (product.imageUrl) {
        const image = document.createElement('img');
        revealImage(image);
        image.src = thumbUrl(product.imageUrl);
        image.alt = product.name;
        image.addEventListener('error', () => { const fallback = imageEntry(product, 'catalogImageFailed'); image.replaceWith(fallback); }, { once: true });
        card.append(image);
      } else {
        card.append(imageEntry(product, 'imageMissing'));
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
      stock.classList.add('product-row-stock');
      main.append(identity, sku, price, stock, chip);
      const actions = document.createElement('div');
      actions.className = 'product-card-actions';
      const toggleButton = button(t(product.active ? 'deactivateProduct' : 'catalogReactivate'),
        (event) => toggle(product, event.currentTarget),
        `${t(product.active ? 'deactivateProduct' : 'catalogReactivate')}: ${product.name} (${product.sku})`);
      toggleButton.dataset.action = 'toggle';
      toggleButton.disabled = pendingChanges.has(product.id);
      // A product with several variants is switched on or off per variant, inside the product.
      actions.append(button(t('editProduct'), () => onNavigate(`products/${product.id}`), `${t('editProduct')}: ${product.name} (${product.sku})`));
      if (!grouped) {
        const menu = document.createElement('details'); menu.className = 'product-more-menu';
        const summary = document.createElement('summary'); summary.setAttribute('aria-label', `${t('catalogMore')}: ${product.name}`); summary.dataset.action = 'more'; summary.append(icon('more'));
        summary.addEventListener('click', () => { for (const other of list.querySelectorAll('.product-more-menu[open]')) if (other !== menu) other.open = false; });
        menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; summary.focus(); } });
        menu.append(summary, toggleButton); actions.append(menu);
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

  async function load(reset = true, submittedSearch = appliedSearch) {
    if (!reset && nextOffset === null) return false;
    selected.clear();
    const sequence = ++loadSequence;
    const query = reset ? submittedSearch : appliedSearch;
    const queryStatus = reset ? filterStatus : appliedStatus;
    const queryCategory = reset ? categoryFilter.value : appliedCategory;
    const queryStock = reset ? stockFilter.value : appliedStock;
    const querySort = reset ? sortFilter.value : appliedSort;
    const filtersChanged = reset && (query !== appliedSearch || queryStatus !== appliedStatus || queryCategory !== appliedCategory || queryStock !== appliedStock || querySort !== appliedSort);
    if (filtersChanged) { selected.clear(); removedUndo.hidden = true; refreshBulk(); }
    const offset = reset ? 0 : nextOffset;
    if (reset && (list.hidden || filtersChanged)) {
      list.hidden = true;
      selectBar.hidden = true;
      variantsNote.hidden = true;
      bulkBar.hidden = true;
    }
    more.disabled = true;
    find('#product-export').disabled = true;
    list.setAttribute('aria-busy', 'true');
    retryList.hidden = true;
    clearSearch.hidden = true;
    setStatus('loading');
    try {
      const params = new URLSearchParams({ limit: '24', offset: String(offset), search: query });
      params.set('catalogStatus', queryStatus);
      params.set('category', queryCategory); params.set('stock', queryStock); params.set('sort', querySort);
      const result = await api('GET', apiUrl(`v1/seller/products?${params}`));
      if (sequence !== loadSequence || !isCurrent()) return false;
      items = reset ? result.items : [...items, ...result.items];
      if (reset) {
        appliedSearch = query; appliedStatus = filterStatus = queryStatus;
        appliedCategory = filterCategory = queryCategory; appliedStock = filterStock = queryStock; appliedSort = filterSort = querySort;
      }
      saveFilters();
      matchingTotal = result.total;
      catalogStats = result.stats; refreshStats(); refreshStatusFilter();
      nextOffset = result.nextOffset;
      setStatus(items.length ? '' : appliedSearch ? 'noMatchingProducts' : appliedStatus ? 'noProductsInStatus' : 'noProducts');
      clearSearch.hidden = Boolean(items.length) || !appliedSearch;
      renderList();
      return true;
    } catch {
      if (sequence === loadSequence && isCurrent()) {
        if (reset) {
          filterStatus = appliedStatus; filterCategory = appliedCategory; filterStock = appliedStock; filterSort = appliedSort;
          refreshStatusFilter();
        }
        setStatus('networkError');
        retryList.hidden = false;
      }
      return false;
    } finally {
      if (sequence === loadSequence && isCurrent()) {
        more.disabled = false;
        find('#product-export').disabled = false;
        list.setAttribute('aria-busy', 'false');
        list.hidden = false;
        refreshBulk();
      }
    }
  }

  function resetForm({ keepDetail = false } = {}) {
    if (!keepDetail) { richEditor.load(null); selectTab('basic'); }
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
    refreshIdentity();
    renderGallery();
    setError('');
    setFormSuccess('');
    document.dispatchEvent(new Event('updateguardchange'));
  }

  async function edit(product, { skipGuard = false, detailLoaded = false, preserveDetail = false } = {}) {
    if (!skipGuard && !confirmDiscard()) return;
    const sequence = ++editorLoadSequence;
    editingId = product.id;
    form.hidden = false;
    form.elements.sku.value = product.sku;
    form.elements.name.value = product.name;
    form.elements.description.value = product.description;
    populateCategories(product.categoryCode);
    form.elements.price.value = (product.priceMinor / 100).toFixed(2);
    setCurrency(product.currency);
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
    refreshIdentity();
    richEditor.load(product.id, { preserve: preserveDetail });
    if (!detailLoaded) {
      form.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      form.elements.sku.focus();
    }
    if (detailLoaded) {
      acceptGallery(product);
      renderVariants(product);
      if (imageEntryId === product.id) { imageEntryId = null; selectTab('images'); find('#product-editor-tab-images').focus(); }
      return;
    }
    renderVariants(null);
    try {
      const detail = await api('GET', apiUrl(`v1/seller/products/${product.id}`));
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
        try { base = await api('GET', apiUrl(`v1/seller/products/${variantOf}`)); } catch { setEditorStatus('productNotFound'); return; }
      }
      if (sequence !== routeSequence || !isCurrent()) return;
      form.hidden = false;
      populateCategories(base?.categoryCode);
      setCurrency(base?.currency || defaultCurrency);
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
      refreshIdentity();
      return;
    }
    const id = route.slice('products/'.length);
    try {
      const detail = await api('GET', apiUrl(`v1/seller/products/${id}`));
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
    const previous = items.find(item => item.id === product.id);
    if (catalogStats && previous && previous.active !== product.active) {
      const change = product.active ? 1 : -1;
      catalogStats = { ...catalogStats, active: catalogStats.active + change, inactive: catalogStats.inactive - change };
      refreshStats();
    }
    items = items.map((item) => item.id === product.id ? { ...item, ...product } : item)
      .filter(item => appliedStatus === 'all' || (appliedStatus === 'active' ? (item.variantCount > 1 ? item.activeCount > 0 : item.active) : (item.variantCount > 1 ? item.activeCount === 0 : !item.active)));
    syncOpenFormAvailability(product);
    renderList();
  }

  function focusProductAction(productId, action) {
    [...list.children].find((card) => card.dataset.productId === productId)
      ?.querySelector(`[data-action="${action === 'toggle' ? 'more' : action}"]`)?.focus({ preventScroll: true });
  }

  async function toggle(product, control) {
    if (pendingChanges.has(product.id)) return;
    const menu = control.closest('.product-more-menu');
    if (menu) menu.open = false;
    if (product.active && !await confirmDeactivation(product.name)) { menu?.querySelector('summary')?.focus(); return; }
    if (!isCurrent() || pendingChanges.has(product.id)) return;
    pendingChanges.add(product.id);
    control.disabled = true;
    try {
      const updated = await api('PATCH', apiUrl(`v1/seller/products/${product.id}`), { active: !product.active });
      if (!isCurrent()) return;
      undoStates.set(product.id, { previousActive: product.active, appliedActive: updated.active });
      pendingChanges.delete(product.id);
      replaceProduct(updated);
      const refreshed = await load(true);
      if (!isCurrent()) return;
      renderRemovedUndo(updated);
      if (!refreshed) { setStatus('catalogChangedRefreshFailed', product.name); return; }
      setStatus(updated.active ? 'productActivatedInline' : 'productDeactivatedInline', product.name);
      if (appliedStatus !== 'all' && (appliedStatus === 'active' ? !updated.active : updated.active)) removedUndo.querySelector('button')?.focus({ preventScroll: true });
      else focusProductAction(product.id, 'toggle');
    } catch {
      pendingChanges.delete(product.id);
      control.disabled = false;
      if (isCurrent()) { setStatus('productError', product.name); focusProductAction(product.id, 'toggle'); }
    }
  }

  async function undoToggle(product, control) {
    const undo = undoStates.get(product.id);
    if (!undo || pendingChanges.has(product.id)) return;
    pendingChanges.add(product.id);
    control.disabled = true;
    try {
      const latest = await api('GET', apiUrl(`v1/seller/products/${product.id}`));
      if (!isCurrent()) return;
      if (latest.active !== undo.appliedActive) {
        undoStates.delete(product.id);
        pendingChanges.delete(product.id);
        replaceProduct(latest);
        setStatus('productUndoUnavailable', product.name);
      } else {
        const restored = await api('PATCH', apiUrl(`v1/seller/products/${product.id}`), { active: undo.previousActive });
        if (!isCurrent()) return;
        undoStates.delete(product.id);
        pendingChanges.delete(product.id);
        replaceProduct(restored);
        setStatus('productUndoRestored', product.name);
      }
      removedUndo.hidden = true;
      const undoStatus = statusKey;
      const refreshed = await load(true);
      if (!isCurrent()) return;
      setStatus(refreshed ? undoStatus : 'catalogChangedRefreshFailed', product.name);
      focusProductAction(product.id, 'toggle');
    } catch {
      pendingChanges.delete(product.id);
      control.disabled = false;
      if (isCurrent()) { setStatus('productError', product.name); focusProductAction(product.id, 'toggle'); }
    }
  }

  find('#product-new').addEventListener('click', () => onNavigate('products/new'));
  find('#product-add-variant').addEventListener('click', () => { if (editingId) onNavigate(`products/new/${editingId}`); });
  find('#product-open-main').addEventListener('click', () => { if (galleryHolderId) onNavigate(`products/${galleryHolderId}`); });
  find('#product-cancel').addEventListener('click', () => onNavigate('products'));
  form.addEventListener('input', () => { if (formSuccessKey) setFormSuccess(''); });
  form.addEventListener('change', () => { if (formSuccessKey) setFormSuccess(''); });
  find('#product-search-form').addEventListener('submit', (event) => { event.preventDefault(); load(true, search.value.trim()); });
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
  form.addEventListener('input', (event) => event.target.removeAttribute?.('aria-invalid'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || readingGallery || richEditor.busy() || (editingId && !galleryLoaded)) return;
    if (richEditor.dirty() && formBaseline && form.elements.variantGroup.value !== JSON.parse(formBaseline).values.variantGroup) { setError('pedit_membership'); selectTab('detail'); return; }
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
        if (payload.stockQuantity === stockFromInput(baseline.values.stockQuantity)) delete payload.stockQuantity;
      }
      // Snapshot the initiating editor before image decoding yields to navigation.
      if (productId) {
        payload.expectedUpdatedAt = expectedUpdatedAt;
        if (galleryEditable) {
          payload.gallery = galleryImages.map(item => item.imageDataUrl ? { imageDataUrl: item.imageDataUrl, ...(item.thumbDataUrl ? { thumbDataUrl: item.thumbDataUrl } : {}) } : { id: item.id });
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
      const saved = await api(productId ? 'PATCH' : 'POST', productId ? apiUrl(`v1/seller/products/${productId}`) : apiUrl('v1/seller/products'), payload);
      if (!ownsRoute()) return;
      const savedTab = selectedTab;
      const preserveDetail = Boolean(productId && formBaseline && payload.variantGroup === JSON.parse(formBaseline).values.variantGroup);
      resetForm({ keepDetail: preserveDetail });
      await load();
      if (!ownsRoute()) return;
      await edit(saved, { skipGuard: true, detailLoaded: true, preserveDetail });
      selectTab(savedTab);
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
      // Price and stock are checked here before anything is sent: say what a valid value looks like.
      const inputKey = failure.code ? null : failure.field === 'price' ? 'priceInvalid' : failure.field === 'stockQuantity' ? 'stockInvalid' : null;
      setError(optionKey || inputKey || (failure.code === 'DETAIL_MEMBERSHIP_CONFLICT' ? 'pedit_membershipConflict' : failure.code === 'PRODUCT_CHANGED' ? 'productChangedReopen' : failure.code === 'STOCK_TRACKING_CONFLICT' ? 'stockTrackingConflict' : failure.field === 'gallery' ? 'galleryLimit' : galleryConflict ? 'removeGalleryFirst' : failure.code === 'COMPANY_CURRENCY_CONFLICT' ? 'currencyConflict' : failure.code === 'DUPLICATE_SKU' ? 'duplicateSku' : failure.code === 'DUPLICATE_VARIANT' ? 'duplicateVariant' : failure.code === 'VARIANT_CATEGORY_MISMATCH' ? 'variantCategoryMismatch' : 'productError'));
      if (galleryConflict && productId && editingId === productId) {
        // A rejected write owns no new baseline. Preserve all draft metadata,
        // image removals and order so retry and navigation guards remain truthful.
        galleryPanel.scrollIntoView({ block: 'nearest' });
      } else {
        const field = failure.code === 'DUPLICATE_SKU' ? 'sku' : failure.field === 'priceMinor' ? 'price' : failure.field === 'imageDataUrl' ? 'image' : failure.field;
        if (field && form.elements[field]) { const panel = form.elements[field].closest('[data-product-tab]'); if (panel) selectTab(panel.dataset.productTab); form.elements[field].setAttribute('aria-invalid', 'true'); form.elements[field].focus(); }
      }
    } finally { saving = false; finish(); if (isCurrent()) { save.disabled = false; renderGallery(); refreshIdentity(); } document.dispatchEvent(new Event('updateguardchange')); }
  });

  const settingsPromise = loadSettings();
  refreshStatusFilter();
  settingsPromise.then(() => { if (isCurrent() && loadSequence === 0) load(); });
  search.placeholder = t('searchNameOrSkuHint');
  return {
    showRoute,
    refreshLocale() {
      translate(root);
      richEditor.refreshLocale();
      refreshIdentity();
      tabs.setAttribute('aria-label', editorText('tabs'));
      refreshStatusFilter();
      refreshStats();
      renderList();
      renderGallery();
      populateCategories(form.elements.category.value);
      renderOptionPickers();
      search.placeholder = t('searchNameOrSkuHint');
      form.elements.stockQuantity.placeholder = t('stockUnlimited');
      status.textContent = statusKey ? `${statusProductName ? `${statusProductName}: ` : ''}${t(statusKey)}` : '';
      error.textContent = formErrorKey ? t(formErrorKey) : '';
      formSuccess.textContent = formSuccessKey ? t(formSuccessKey) : '';
      editorStatus.textContent = editorStatusKey ? t(editorStatusKey) : '';
    },
    hasUnsavedChanges,
    draftSignature: () => JSON.stringify([editingId, form.hidden, formState(), richEditor.signature()]),
    isBusy: () => saving || readingGallery || richEditor.busy() || mutations > 0,
  };
}
