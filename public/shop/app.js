import { mountAppearance } from '../shared/appearance.js';
import { storageKey } from './storage-scope.js';
import { categoryIconPath, formatCatalogPrice } from './catalog-presentation.js';
import { mountShopUpdates } from './update-view.js';
import { draftSignature } from '../shared/update-guard.js';
import { mountMobileNavigation } from './mobile-navigation.js';
import { countryForCurrency, mountAddressBook } from './addresses.js';
import { mountProfile } from './profile.js';
import { createCartSelection } from './cart-selection.js';
import { createContactHistory } from './history.js';
import { mountProductDetail } from './product-detail.js';
import { productHash, orderHash, ordersHash, readShopRoute, readCatalogFilters, catalogFilterURL } from './shop-route.js';
import { formatDate, formatMoney, locale, setupLanguageMenu, t, translate } from '../shared/i18n.js';
import { createCartStore, resolveCartSnapshot } from './cart.js';
import { mountCheckout } from './checkout.js';
import { createLocalOrderStore, isLocalOrderCurrent } from './local-orders.js';

const byId = (id) => document.getElementById(id);
mountAppearance(document.querySelector('.palette-settings'), 'shop');
const grid = byId('catalog-grid');
const list = byId('cart-list');
const category = byId('catalog-category');
const bootOverlay = byId('shop-boot-loader');
const bootRetry = byId('shop-boot-retry');
let bootFinished = false;
let bootBackground = [];
const bootShowTimer = setTimeout(() => {
  if (bootFinished) return;
  bootBackground = [...document.body.children].filter((child) => child !== bootOverlay && child.tagName !== 'SCRIPT').map((child) => [child, child.inert]);
  for (const [child] of bootBackground) child.inert = true;
  document.body.classList.add('shop-booting');
  bootOverlay.hidden = false;
  bootOverlay.focus({ preventScroll: true });
}, 180);
const bootRetryTimer = setTimeout(() => {
  if (bootFinished) return;
  bootRetry.hidden = false;
  if (!bootOverlay.hidden) bootRetry.focus();
}, 8000);
bootRetry.addEventListener('click', () => location.reload());
function finishBoot() {
  bootFinished = true;
  clearTimeout(bootShowTimer);
  clearTimeout(bootRetryTimer);
  bootOverlay.hidden = true;
  document.body.classList.remove('shop-booting');
  for (const [child, wasInert] of bootBackground) child.inert = wasInert;
}
let products = [];
let categories = [];
let nextOffset = null;
let catalogRequest = 0;
let catalogLoading = false;
let catalogFilters = { search: '', category: '' };
let cartRequest = 0;
let checkoutRouteRequest = 0;
let resolvedCart = [];
let detailPage;
let profilePage;
let addressBook;
let profileReturn = null;
let focusCheckoutAfterProfile = false;
let directPurchase = null;
let selection;
let previousRoute = '';
let catalogScroll = 0;
let catalogReturnFocus = null;
let restoreCatalogFocus = false;
let cartMutation = Promise.resolve();
let cartWrites = 0;
let checkoutStarting = false;
function trackCart(promise) {
  cartWrites++;
  document.dispatchEvent(new Event('updateguardchange'));
  return promise.finally(() => { cartWrites--; document.dispatchEvent(new Event('updateguardchange')); });
}
let shopInfo = null;
let catalogStatus = '';
let catalogPageStatus = '';
let retryCatalogReset = true;
let cartStatus = '';
let shopStatus = '';
let messageTimeout;
let cartReady = false;
let cartLoading = false;
let pendingCartFocusKey = null;
let priceChangedNotice = false;
let checkoutPage = null;
let lastReceipt = null;
let receiptNotes = [];
let localOrderStore;
let localOrdersRequest = 0;
let localOrdersController;

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function action(label, handler, className = 'outline-button') {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function imageFor(product, className) {
  if (!product.imageUrl) return element('div', `${className} image-placeholder`, t('imageMissing'));
  const image = element('img', className);
  image.src = product.imageUrl;
  image.alt = product.name;
  image.loading = 'lazy';
  return image;
}

function setCatalogStatus(key) {
  catalogStatus = key;
  byId('catalog-status').textContent = key ? t(key) : '';
  byId('catalog-clear-filters').hidden = key !== 'noResults';
}

function catalogHasError() {
  return catalogStatus === 'networkError' || catalogStatus === 'offlineCatalogRetry';
}

function setCatalogPageStatus(key) {
  catalogPageStatus = key;
  const feedback = byId('catalog-page-feedback');
  feedback.hidden = !key;
  feedback.dataset.state = key === 'loadingMore' ? 'loading' : key === 'allProductsShown' ? 'end' : 'error';
  byId('catalog-page-message').textContent = key ? t(key) : '';
  byId('catalog-page-retry').hidden = key !== 'networkError' && key !== 'offlineCatalogRetry';
}

const skeletonTimers = new WeakMap();
function showSkeleton(skeleton) {
  clearTimeout(skeletonTimers.get(skeleton));
  skeleton.style.visibility = 'hidden';
  skeleton.hidden = false;
  skeletonTimers.set(skeleton, setTimeout(() => {
    if (!skeleton.hidden) skeleton.style.visibility = 'visible';
  }, 250));
}

function hideSkeleton(skeleton) {
  clearTimeout(skeletonTimers.get(skeleton));
  skeleton.hidden = true;
  skeleton.style.visibility = '';
}

function setCartStatus(key) {
  cartStatus = key;
  byId('cart-status').textContent = key ? t(key) : '';
}

function setMessage(key) {
  shopStatus = key;
  byId('shop-message').textContent = key ? t(key) : '';
  clearTimeout(messageTimeout);
  if (key) messageTimeout = setTimeout(() => setMessage(''), 4500);
}

async function api(path) {
  const response = await fetch(path);
  if (!response.ok) throw Object.assign(new Error('Request failed'), { status: response.status });
  return response.json();
}

function renderCategories() {
  const chosen = category.value;
  category.replaceChildren(new Option(t('allCategories'), ''));
  for (const value of categories) category.add(new Option(value, value));
  category.value = categories.includes(chosen) ? chosen : '';
  const rail = byId('category-rail');
  const focusedCategory = rail.contains(document.activeElement) ? document.activeElement.dataset.category : null;
  const railScroll = rail.scrollLeft;
  rail.replaceChildren();
  for (const value of ['', ...categories]) {
    const button = element('button', 'category-option');
    button.type = 'button'; button.dataset.category = value;
    button.setAttribute('aria-pressed', String(category.value === value));
    const symbol = element('span', 'category-symbol');
    const paths = categoryIconPath(value);
    symbol.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths}"/></svg>`;
    symbol.setAttribute('aria-hidden', 'true');
    button.append(symbol, element('span', '', value || t('allCategories')));
    button.addEventListener('click', () => {
      category.value = value;
      applyCatalogFilters(false, value);
    });
    rail.append(button);
  }
  rail.scrollLeft = railScroll;
  if (focusedCategory !== null) [...rail.children].find(button => button.dataset.category === focusedCategory)?.focus({ preventScroll: true });
  revealCategory(rail.querySelector('[aria-pressed=true]'));
}
function revealCategory(button) {
  if (!button) return; const rail = byId('category-rail'); const bounds = rail.getBoundingClientRect(); const item = button.getBoundingClientRect();
  const delta = item.left < bounds.left + 3 ? item.left - bounds.left - 3 : item.right > bounds.right - 3 ? item.right - bounds.right + 3 : 0;
  if (delta) rail.scrollBy({ left: delta, behavior: 'instant' });
}
byId('category-rail').addEventListener('focusin', event => revealCategory(event.target.closest('button')));

function renderCatalog(startIndex = 0) {
  if (!startIndex) grid.replaceChildren();
  const cards = document.createDocumentFragment();
  for (const product of products.slice(startIndex)) {
    const card = element('article', 'catalog-card');
    const imageButton = element('a', 'catalog-image-button');
    imageButton.href = productHash(product.id); imageButton.dataset.productId = product.id; imageButton.dataset.catalogLink = 'image';
    imageButton.setAttribute('aria-label', `${t('viewDetails')}: ${product.name}`);
    imageButton.append(imageFor(product, 'catalog-image'));
    card.append(imageButton);
    const body = element('div', 'catalog-card-body');
    const name = element('h3');
    const nameLink = element('a', 'product-name-link', product.name); nameLink.href = productHash(product.id); nameLink.dataset.productId = product.id; nameLink.dataset.catalogLink = 'title'; name.append(nameLink);
    body.append(name, element('strong', 'catalog-price', formatCatalogPrice(product.priceMinor, product.currency, locale())));
    if (product.inStock === false) body.append(element('span', 'catalog-stock', t('outOfStock')));
    card.append(body);
    cards.append(card);
  }
  grid.append(cards);
  restoreCatalogLinkFocus();
  byId('catalog-more').hidden = catalogPageStatus === 'loadingMore' || nextOffset === null ||
    (catalogHasError() && !retryCatalogReset);
  byId('catalog-count').textContent = products.length ? t('showingProducts').replace('{count}', String(products.length)) : '';
  const query = byId('catalog-search').value.trim();
  byId('catalog-query').textContent = query ? t('searchResultsFor').replace('{query}', query) : '';
  byId('catalog-query').hidden = !query;
}

grid.addEventListener('click', event => {
  const link = event.target.closest('a[data-catalog-link]');
  if (link) catalogReturnFocus = { id: link.dataset.productId, kind: link.dataset.catalogLink };
});
function restoreCatalogLinkFocus() {
  if (!restoreCatalogFocus || readShopRoute(location.hash).page !== 'catalog') return;
  const link = [...grid.querySelectorAll('a[data-catalog-link]')].find(link => link.dataset.productId === catalogReturnFocus?.id && link.dataset.catalogLink === catalogReturnFocus?.kind);
  if (link) { link.focus({ preventScroll: true }); restoreCatalogFocus = false; }
}

async function loadCatalog(reset = true) {
  if (!reset && (catalogLoading || nextOffset === null)) return;
  const request = ++catalogRequest;
  catalogLoading = true;
  if (reset) { products = []; nextOffset = null; renderCatalog(); }
  if (reset) showSkeleton(byId('catalog-skeleton'));
  else hideSkeleton(byId('catalog-skeleton'));
  grid.setAttribute('aria-busy', 'true');
  byId('catalog-more').hidden = true;
  setCatalogStatus(reset ? 'loading' : '');
  setCatalogPageStatus(reset ? '' : 'loadingMore');
  if (document.getElementById('catalog-retry')) document.getElementById('catalog-retry').hidden = true;
  try {
    const params = new URLSearchParams({
      limit: '24', offset: String(reset ? 0 : nextOffset),
      search: byId('catalog-search').value.trim(), category: category.value,
    });
    if (reset) catalogFilters = { search: params.get('search'), category: params.get('category') };
    const [data, shop] = await Promise.all([api(`/api/v1/products?${params}`), api('/api/v1/shop')]);
    if (request !== catalogRequest) return;
    if ((shop.demoNamespace || '') !== globalThis.shopStorageNamespace) { location.reload(); return; }
    shopInfo = shop;
    mobileNavigation.setAutoHide(shop.mobileHideBarsOnScroll);
    profilePage?.setCountry(countryForCurrency(shop.currency));
    addressBook?.render();
    checkoutPage?.refreshAddress();
    checkoutPage.setDemoMode(shop.mode === 'demo');
    byId('catalog-shop-name').textContent = shop.shopName || '';
    byId('shop-brand-name').textContent = shop.shopName || t('shop');
    byId('shop-brand-kind').hidden = true;
    if (request !== catalogRequest) return;
    const previousCount = products.length;
    products = reset ? data.items : [...products, ...data.items];
    categories = data.categories;
    nextOffset = data.nextOffset;
    renderCategories();
    renderEmptyCartCategories();
    setCatalogStatus(products.length ? '' : (params.get('search') || params.get('category') ? 'noResults' : 'noProducts'));
    setCatalogPageStatus(products.length && nextOffset === null ? 'allProductsShown' : '');
    renderCatalog(reset ? 0 : previousCount);
  } catch {
    if (request === catalogRequest) {
      retryCatalogReset = reset;
      const errorKey = navigator.onLine === false ? 'offlineCatalogRetry' : 'networkError';
      setCatalogStatus(errorKey);
      setCatalogPageStatus(reset ? '' : errorKey);
      document.getElementById('catalog-retry').hidden = false;
    }
  } finally {
    if (request === catalogRequest) {
      catalogLoading = false;
      hideSkeleton(byId('catalog-skeleton'));
      grid.setAttribute('aria-busy', 'false');
    }
  }
}

function updateCount() {
  const count = cartStore.list().reduce((sum, line) => sum + line.quantity, 0);
  for (const id of ['cart-count', 'mobile-cart-count']) {
    byId(id).textContent = count > 99 ? '99+' : String(count);
    byId(id).hidden = count === 0;
  }
  detailPage?.updateCartCount();
  document.querySelector('#mobile-navigation a[href="#cart"]').setAttribute('aria-label', `${t('cart')}: ${count}`);
  document.querySelector('.shop-nav a[href="#cart"]').setAttribute('aria-label', `${t('cart')}: ${count}`);
}

function updatePersistence() {
  const note = byId('cart-persistence');
  note.hidden = cartStore.persistent;
  note.textContent = cartStore.persistent ? '' : t('cartMemoryOnly');
}

function addToCart(product, quantity = 1) {
  const result = trackCart(cartMutation.then(() => addCartQuantity(product, quantity)));
  cartMutation = result.catch(() => {});
  return result;
}

async function addCartQuantity(product, quantity) {
  const existing = cartStore.list().find((line) => line.productId === product.id)?.quantity || 0;
  if (!Number.isInteger(quantity) || quantity < 1 || existing + quantity > 100) {
    setMessage('quantityLimit');
    return false;
  }
  await cartStore.set(product.id, existing + quantity);
  updateCount();
  updatePersistence();
  setMessage('addedToCart');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const icon of document.querySelectorAll('.shop-nav a[href="#cart"], .product-nav-cart, #mobile-navigation a[href="#cart"]')) {
      icon.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 280, easing: 'ease-out' });
    }
  }
  if (!byId('cart-view').hidden) refreshCart();
  return true;
}

const quantityRevisions = new Map();
const quantityPending = new Map();
const quantityErrors = new Map();
function cartRow(productId) { return [...list.querySelectorAll('.cart-row')].find(row => row.dataset.productId === productId); }
function patchCartRow(productId, revision) {
  const row = cartRow(productId), line = resolvedCart.find(item => item.productId === productId);
  if (!row || !line) return;
  const input = row.querySelector('input[type=number]');
  if (revision === undefined || revision === quantityRevisions.get(productId)) {
    if (input.value !== String(line.quantity) && !(input === document.activeElement && input.valueAsNumber === line.quantity)) input.value = String(line.quantity);
  }
  const buttons = row.querySelectorAll('.quantity-stepper button');
  buttons[0].disabled = line.quantity <= 1; buttons[1].disabled = line.quantity >= 100;
  row.querySelector('.cart-unit-price').textContent = line.product ? formatMoney(line.product.priceMinor, line.product.currency).replace(/\u00a0/g, ' ') : '—';
  row.querySelector('.cart-line-subtotal').textContent = line.product ? formatMoney(line.product.priceMinor * line.quantity, line.product.currency) : '—';
  const pending = (quantityPending.get(productId) || 0) > 0;
  row.setAttribute('aria-busy', String(pending));
  const feedback = row.querySelector('.cart-quantity-feedback');
  const key = quantityErrors.get(productId) || (pending ? 'loading' : '');
  feedback.textContent = key ? t(key) : ''; feedback.hidden = !key;
  input.setAttribute('aria-invalid', String(Boolean(quantityErrors.get(productId))));
}
function changeQuantity(productId, value) {
  const revision = (quantityRevisions.get(productId) || 0) + 1;
  quantityRevisions.set(productId, revision);
  quantityPending.set(productId, (quantityPending.get(productId) || 0) + 1);
  patchCartRow(productId, -1); renderCartSummary();
  const result = trackCart(cartMutation.then(async () => {
    const current = cartStore.list().find(line => line.productId === productId)?.quantity;
    if (current === undefined) return;
    const next = typeof value === 'function' ? value(current) : value;
    if (!Number.isInteger(next) || next < 1 || next > 100) {
      quantityErrors.set(productId, 'quantityLimit'); setMessage('quantityLimit'); return;
    }
    const product = await api(`/api/v1/products/${encodeURIComponent(productId)}`);
    const previous = resolvedCart.find(line => line.productId === productId)?.product;
    if (previous && (previous.priceMinor !== product.priceMinor || previous.currency !== product.currency)) priceChangedNotice = true;
    await cartStore.set(productId, next);
    resolvedCart = resolvedCart.map(line => line.productId === productId ? { productId, quantity: next, product } : line);
    quantityErrors.delete(productId);
    updateCount(); updatePersistence(); setMessage('quantityUpdated');
  }).catch(error => {
    quantityErrors.set(productId, error.status === 404 ? 'cartUnavailable' : 'networkError');
    setMessage(error.status === 404 ? 'cartUnavailable' : 'networkError');
  }).finally(() => {
    quantityPending.set(productId, Math.max(0, (quantityPending.get(productId) || 1) - 1));
    patchCartRow(productId, revision); renderCartSummary();
  }));
  cartMutation = result.catch(() => {});
  return result;
}

async function removeLine(productId) {
  const result = trackCart(cartMutation.then(async () => {
    await cartStore.set(productId, 0);
    quantityErrors.delete(productId);
    const row = cartRow(productId), hadFocus = row?.contains(document.activeElement);
    const next = row?.nextElementSibling || row?.previousElementSibling;
    row?.remove(); resolvedCart = resolvedCart.filter(line => line.productId !== productId);
    selection.sync(cartStore.list()); updateCount(); updatePersistence(); renderCartSummary();
    if (hadFocus) (next?.querySelector('.cart-remove') || byId('cart-empty').querySelector('.empty-browse')).focus({ preventScroll: true });
    setMessage('removedFromCart');
  }));
  cartMutation = result.catch(() => setMessage('networkError'));
  return cartMutation;
}

function renderEmptyCartCategories() {
  const nav = byId('empty-cart-categories');
  nav.replaceChildren();
  for (const value of categories) {
    const shortcut = action(value, () => {
      searchInput.value = ''; syncSearchClear(); category.value = value; applyCatalogFilters();
    }, 'outline-button');
    nav.append(shortcut);
  }
}

function renderCart() {
  if (cartLoading) return;
  const focusedKey = pendingCartFocusKey || (list.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null);
  pendingCartFocusKey = null;
  list.replaceChildren();
  const empty = cartStore.list().length === 0;
  byId('cart-view').classList.toggle('is-empty', empty);
  byId('cart-empty').hidden = !empty;
  for (const { productId, quantity, product } of resolvedCart) {
    const row = element('article', 'cart-row');
    row.dataset.productId = productId;
    const chosen = element('input', 'cart-select');
    chosen.type = 'checkbox';
    chosen.dataset.productId = productId;
    chosen.dataset.focusKey = `select-${productId}`;
    chosen.checked = selection.has(productId);
    chosen.setAttribute('aria-label', `${t('selectItem')}: ${product?.name || t('productUnavailable')}`);
    chosen.addEventListener('change', () => {
      selection.set(productId, chosen.checked); renderCartSummary();
    });
    row.append(chosen);
    row.append(product ? imageFor(product, 'cart-image') : element('div', 'cart-image image-placeholder', t('imageMissing')));
    const detail = element('div', 'cart-row-detail');
    const title = element('h2');
    if (product) { const link = element('a', 'product-name-link', product.name); link.href = productHash(product.id); title.append(link); }
    else title.textContent = t('productUnavailable');
    detail.append(title);
    if (product) {
      detail.append(element('p', '', product.category));
    }
    const controls = element('div', 'cart-row-controls');
    const label = element('div', 'quantity-stepper');
    const input = element('input');
    input.type = 'number'; input.min = '1'; input.max = '100'; input.step = '1'; input.inputMode = 'numeric';
    input.value = String(quantity);
    input.dataset.focusKey = `quantity-${productId}`;
    input.setAttribute('aria-label', `${t('quantity')}: ${product?.name || t('productUnavailable')}`);
    input.addEventListener('input', () => quantityRevisions.set(productId, (quantityRevisions.get(productId) || 0) + 1));
    input.addEventListener('change', () => changeQuantity(productId, input.valueAsNumber));
    const decrease = action('−', () => changeQuantity(productId, current => current - 1));
    decrease.dataset.focusKey = `decrease-${productId}`;
    decrease.disabled = quantity <= 1;
    decrease.setAttribute('aria-label', `${t('decreaseQuantity')}: ${product?.name || t('productUnavailable')}`);
    const increase = action('+', () => changeQuantity(productId, current => current + 1));
    increase.dataset.focusKey = `increase-${productId}`;
    increase.disabled = quantity >= 100;
    increase.setAttribute('aria-label', `${t('increaseQuantity')}: ${product?.name || t('productUnavailable')}`);
    label.append(decrease, input, increase);
    controls.append(label);
    const feedback = element('span', 'cart-quantity-feedback'); feedback.setAttribute('role', 'status'); feedback.hidden = true; controls.append(feedback);
    const unit = element('span', 'cart-unit-price', product ? formatMoney(product.priceMinor, product.currency).replace(/\u00a0/g, ' ') : '—');
    const subtotal = element('strong', 'cart-line-subtotal', product ? formatMoney(product.priceMinor * quantity, product.currency) : '—');
    const remove = action(t('remove'), () => removeLine(productId)); remove.classList.add('cart-remove');
    row.append(detail, unit, controls, subtotal, remove);
    list.append(row);
  }
  if (focusedKey) [...list.querySelectorAll('[data-focus-key]')].find(control => control.dataset.focusKey === focusedKey && !control.disabled)?.focus({ preventScroll: true });
  renderCartSummary();
  for (const line of resolvedCart) patchCartRow(line.productId, -1);
}

function renderCartSummary() {
  const empty = cartStore.list().length === 0;
  byId('cart-view').classList.toggle('is-empty', empty);
  byId('cart-empty').hidden = !empty;
  let total = 0, missing = false;
  const currencies = new Set();
  for (const { quantity, product, productId } of resolvedCart) {
    if (!selection.has(productId)) continue;
    if (product) { total += product.priceMinor * quantity; currencies.add(product.currency); }
    else missing = true;
  }
  const pending = [...quantityPending.values()].some(count => count > 0);
  const summary = byId('cart-summary');
  summary.hidden = false;
  byId('cart-total').textContent = !missing && currencies.size === 1 && Number.isSafeInteger(total)
    ? formatMoney(total, [...currencies][0]) : total === 0 && !missing ? formatMoney(0, shopInfo?.currency || 'MYR') : '—';
  const chosen = selection ? selection.items(resolvedCart) : [];
  const selectedCount = chosen.reduce((sum, item) => sum + item.quantity, 0);
  const eligible = cartReady && !missing && currencies.size === 1 && chosen.length > 0;
  const canContinue = eligible && !pending && !quantityErrors.size;
  const hasProfile = Boolean(profilePage?.get());
  byId('cart-selected-count').textContent = `${t('selectedItems')}: ${selectedCount}`;
  byId('checkout-button').textContent = eligible && !hasProfile ? t('setupProfileToContinue') : `${t('checkout')} (${selectedCount})`;
  byId('checkout-button').disabled = !canContinue || checkoutStarting;
  byId('cart-profile-state').hidden = !eligible;
  byId('cart-profile-message').textContent = t(hasProfile ? 'profileReadyShort' : 'profileNeededShort');
  byId('cart-profile-state').querySelector('a').hidden = !hasProfile;
  const all = byId('cart-select-all');
  all.checked = resolvedCart.length > 0 && chosen.length === resolvedCart.length;
  all.indeterminate = chosen.length > 0 && chosen.length < resolvedCart.length;
  all.disabled = resolvedCart.length === 0;
  byId('cart-retry').hidden = !quantityErrors.size;
  if (cartReady && !pending) setCartStatus(quantityErrors.size ? [...quantityErrors.values()][0] : !chosen.length ? 'selectItemsFirst' : missing ? 'cartUnavailable' : currencies.size > 1 ? 'mixedCurrencies' : priceChangedNotice ? 'cartPriceChanged' : '');
}

function showCartSkeleton(count) {
  if (list.contains(document.activeElement)) pendingCartFocusKey = document.activeElement.dataset.focusKey || null;
  list.hidden = true;
  const skeleton = byId('cart-skeleton');
  skeleton.replaceChildren();
  for (let index = 0; index < Math.min(count, 3); index++) {
    const row = element('div', 'cart-row cart-skeleton-row');
    const detail = element('div', 'cart-skeleton-detail');
    detail.append(element('span', 'skeleton-line'), element('span', 'skeleton-line medium'));
    row.append(element('span', 'cart-skeleton-check skeleton-line'),
      element('span', 'cart-skeleton-image skeleton-image'), detail,
      element('span', 'cart-skeleton-unit skeleton-line'),
      element('span', 'cart-skeleton-quantity skeleton-line'),
      element('span', 'cart-skeleton-subtotal skeleton-line'),
      element('span', 'cart-skeleton-action skeleton-line'));
    skeleton.append(row);
  }
  showSkeleton(skeleton);
  byId('cart-total').textContent = '—';
  const selectedCount = cartStore.list().filter((line) => selection.has(line.productId)).reduce((sum, line) => sum + line.quantity, 0);
  byId('cart-selected-count').textContent = `${t('selectedItems')}: ${selectedCount}`;
  byId('checkout-button').textContent = `${t('checkout')} (${selectedCount})`;
  byId('cart-select-all').disabled = true;
  byId('checkout-button').disabled = true;
  byId('cart-profile-state').hidden = true;
}

function hideCartSkeleton() {
  hideSkeleton(byId('cart-skeleton'));
  list.hidden = false;
}

async function refreshCart() {
  const request = ++cartRequest;
  const lines = cartStore.list();
  selection.sync(lines);
  cartReady = false;
  cartLoading = false;
  byId('cart-retry').hidden = true;
  updateCount();
  updatePersistence();
  if (!lines.length) {
    hideCartSkeleton();
    resolvedCart = [];
    renderCart();
    setCartStatus('');
    return false;
  }
  cartLoading = true;
  showCartSkeleton(lines.length);
  setCartStatus('loading');
  try {
    const results = await Promise.all(lines.map(async (line) => {
      try { return { ...line, product: await api(`/api/v1/products/${encodeURIComponent(line.productId)}`) }; }
      catch (error) {
        if (error.status === 404) return { ...line, product: null };
        throw error;
      }
    }));
    if (request !== cartRequest) return;
    cartLoading = false;
    hideCartSkeleton();
    resolvedCart = resolveCartSnapshot(cartStore.list(), results);
    quantityErrors.clear();
    cartReady = true;
    renderCart();
    priceChangedNotice = false;
    const chosen = selection.items(results);
    return chosen.length > 0 && chosen.every(({ product }) => Boolean(product)) && new Set(chosen.map(({ product }) => product.currency)).size === 1;
  } catch {
    if (request === cartRequest) {
      cartLoading = false;
      hideCartSkeleton();
      list.replaceChildren();
      resolvedCart = [];
      pendingCartFocusKey = null;
      byId('cart-select-all').disabled = true;
      byId('cart-retry').hidden = false;
      setCartStatus('networkError');
    }
    return false;
  }
}

function setDirectPurchase(value) {
  directPurchase = value;
  try {
    if (value) sessionStorage.setItem(storageKey('online-shopping-direct-purchase-v1'), JSON.stringify(value));
    else sessionStorage.removeItem(storageKey('online-shopping-direct-purchase-v1'));
  } catch { /* The current tab still retains the intent. */ }
}

async function beginCheckout(stillCurrent = () => true, directItem = null) {
  if (directItem) {
    if (!stillCurrent()) return;
    setDirectPurchase(directItem);
    if (!profilePage.get()) {
      profileReturn = 'checkout';
      try { sessionStorage.setItem(storageKey('online-shopping-profile-return'), profileReturn); } catch { /* Optional return route. */ }
      location.hash = '#profile';
      return;
    }
    location.hash = '#checkout';
    return;
  }
  if (checkoutStarting) return;
  checkoutStarting = true;
  byId('checkout-button').disabled = true;
  try {
    setDirectPurchase(null);
    await cartMutation;
    selection.sync(cartStore.list());
    const valid = await refreshCart();
    if (!stillCurrent()) return;
    if (!valid || !shopInfo) { location.hash = '#cart'; return; }
    if (!profilePage.get()) {
      profileReturn = 'checkout';
      try { sessionStorage.setItem(storageKey('online-shopping-profile-return'), profileReturn); } catch { /* Optional return route. */ }
      location.hash = '#profile';
      return;
    }
    checkoutPage.setItems(selection.items(resolvedCart));
    location.hash = '#checkout';
  } finally {
    checkoutStarting = false;
    if (location.hash === '#cart') renderCart();
  }
}

function readReceipt() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey('online-shopping-last-receipt-v1')) || 'null');
    if (saved && /^(?:OS|DEMO)-\d{8,}$/.test(saved.orderNo) && Number.isSafeInteger(saved.totalMinor) &&
        ['MYR', 'SGD'].includes(saved.currency) && isLocalOrderCurrent(saved)) return saved;
    localStorage.removeItem(storageKey('online-shopping-last-receipt-v1'));
  } catch { /* A receipt is optional browser convenience. */ }
  return null;
}

function renderReceipt() {
  if (!lastReceipt) return;
  const simulation = lastReceipt.simulation === true || lastReceipt.orderNo.startsWith('DEMO-');
  byId('receipt-title').dataset.i18n = simulation ? 'simulationComplete' : 'thankYou';
  document.querySelector('.receipt-card > .shop-note').dataset.i18n = simulation ? 'simulationReceipt' : 'receiptMessage';
  translate(byId('receipt-view'));
  byId('receipt-number').textContent = lastReceipt.orderNo;
  byId('receipt-total').textContent = formatMoney(lastReceipt.totalMinor, lastReceipt.currency);
  byId('receipt-date').textContent = formatDate(lastReceipt.submittedAt);
  const note = byId('receipt-storage-note');
  note.hidden = receiptNotes.length === 0;
  note.textContent = receiptNotes.map((key) => t(key)).join(' ');
}

async function completeOrder(receipt, { orderItems, submittedItems, cartBacked, statusAccessKey }) {
  const savedLocally = await localOrderStore.save(receipt, orderItems, statusAccessKey);
  lastReceipt = localOrderStore.list().find(order => order.orderNo === receipt.orderNo) || receipt;
  receiptNotes = savedLocally ? [] : ['localOrdersSaveFailed'];
  try {
    localStorage.removeItem(storageKey('online-shopping-last-receipt-v1'));
    localStorage.setItem(storageKey('online-shopping-last-receipt-v1'), JSON.stringify(lastReceipt));
  }
  catch { receiptNotes.push('receiptMemoryOnly'); }
  try {
    await cartMutation;
    if (cartBacked) {
      for (const { productId, quantity } of submittedItems) {
        const current = cartStore.list().find((line) => line.productId === productId)?.quantity || 0;
        if (!(await cartStore.set(productId, Math.max(0, current - quantity)))) receiptNotes.push('cartClearFailed');
      }
    }
    selection.sync(cartStore.list());
  }
  catch { receiptNotes.push('cartClearFailed'); }
  resolvedCart = [];
  cartReady = false;
  checkoutPage.reset();
  setDirectPurchase(null);
  updateCount();
  updatePersistence();
  renderReceipt();
  setMessage('orderSubmitted');
  location.hash = '#receipt';
  showRoute();
}

let ordersScroll = 0;
let previousOrderId = null;
function drawLocalOrders(orders) {
  const list = byId('local-orders-list');
  const { id: selectedId, filter = '' } = readShopRoute(location.hash);
  const filters = byId('order-filters'); const focusedFilter = filters.contains(document.activeElement) ? document.activeElement.hash : null; filters.hidden = Boolean(selectedId);
  filters.replaceChildren();
  for (const state of ['', 'SUBMITTED', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'REJECTED', 'CANCELLED']) {
    const link = element('a', 'order-filter', state ? t(`status${state[0]}${state.slice(1).toLowerCase()}`) : t('allOrders'));
    link.href = ordersHash(state); link.setAttribute('aria-current', state === filter ? 'page' : 'false');
    link.addEventListener('click', () => { ordersScroll = 0; previousOrderId = null; }); filters.append(link);
  }
  if (focusedFilter) [...filters.querySelectorAll('a')].find(link => link.hash === focusedFilter)?.focus({ preventScroll: true });
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.orderNo : null;
  const backFocused = document.activeElement?.classList.contains('order-back');
  const titleFocused = document.activeElement?.matches('.order-detail h2');
  list.replaceChildren();
  if (selectedId) {
    const back = element('a', 'outline-button order-back', t('backToOrders')); back.href = ordersHash(filter); list.append(back);
    const order = orders.find(item => item.orderNo === selectedId);
    if (!order) { list.append(element('p', 'local-orders-empty', t('orderNotOnDevice'))); return; }
    const detail = element('article', 'local-order-card order-detail');
    const title = element('h2', '', `${t('orderDetails')}: ${order.orderNo}`); title.tabIndex = -1;
    detail.append(title, orderStatusBadge(order));
    detail.append(element('h3', '', t('localOrderItems')));
    if (order.items.length) {
      const items = element('ul', 'local-order-items');
      for (const item of order.items) {
        const row = element('li');
        row.append(orderThumbnail(item), element('span', '', `${item.name} × ${item.quantity}`), element('strong', '', formatMoney(item.unitPriceMinor * item.quantity, order.currency)));
        items.append(row);
      }
      detail.append(items);
    } else detail.append(element('p', 'shop-note', t('localOrderItemsUnavailable')));
    const total = element('div', 'order-detail-total'); total.append(element('span', '', t('orderTotal')), element('strong', 'local-order-total', formatMoney(order.totalMinor, order.currency))); detail.append(total);
    appendOrderSummary(detail, order, false);
    list.append(detail);
    if (backFocused) back.focus({ preventScroll: true });
    if (titleFocused) title.focus({ preventScroll: true });
    return;
  }
  if (!orders.length) { list.append(element('p', 'local-orders-empty', t('noLocalOrders'))); return; }
  const visibleOrders = orders.filter(order => !filter || order.status === filter);
  if (!visibleOrders.length) list.append(element('p', 'local-orders-empty', t('noOrdersInStatus')));
  for (const order of visibleOrders) {
    const card = element('a', 'local-order-card order-list-link'); card.href = orderHash(order.orderNo, filter); card.dataset.orderNo = order.orderNo;
    card.setAttribute('aria-label', `${t('orderDetails')}: ${order.orderNo}`);
    const heading = element('div', 'local-order-heading');
    heading.append(element('h2', 'order-number', order.orderNo), orderStatusBadge(order));
    card.append(heading);
    const preview = element('div', 'order-preview');
    const item = order.items[0]; const summary = element('div', 'order-preview-copy');
    summary.append(element('strong', 'order-item-name', item?.name || t('localOrderItemsUnavailable')));
    if (item) summary.append(element('span', 'shop-note', `${t('quantity')}: ${order.items.reduce((sum, line) => sum + line.quantity, 0)}`));
    preview.append(orderThumbnail(item), summary); card.append(preview);
    const footer = element('div', 'order-card-footer'); footer.append(element('span', 'shop-note', formatDate(order.submittedAt)), element('strong', 'local-order-total', formatMoney(order.totalMinor, order.currency))); card.append(footer);
    if (order.simulation) card.append(element('p', 'shop-note', t('localDemoOrder')));
    card.append(element('span', 'order-details-action', `${t('orderDetails')} ›`));
    card.addEventListener('click', () => { ordersScroll = window.scrollY; });
    list.append(card);
  }
  if (focused) [...list.querySelectorAll('[data-order-no]')].find(el => el.dataset.orderNo === focused)?.focus({ preventScroll: true });
}
function orderStatusBadge(order) {
  const badge = element('p', 'order-status-badge', order.status ? t(`status${order.status[0]}${order.status.slice(1).toLowerCase()}`) : t('olderOrderStatusUnavailable'));
  badge.dataset.status = order.status || 'unknown'; return badge;
}
function orderThumbnail(item) {
  const box = element('span', 'order-thumbnail'); box.setAttribute('aria-hidden', 'true');
  box.textContent = '▧';
  if (item?.imageUrl) { const img = element('img'); img.alt = ''; img.loading = 'lazy'; img.src = item.imageUrl; img.addEventListener('error', () => img.remove()); box.append(img); }
  return box;
}
function appendOrderSummary(card, order, total = true) {
  if (total) card.append(element('strong', 'local-order-total', formatMoney(order.totalMinor, order.currency)));
  card.append(element('p', 'shop-note', `${t('submittedAt')}: ${formatDate(order.submittedAt)}`));
  if (total) card.append(element('p', 'shop-note', order.status ? `${t('orderStatus')}: ${t(`status${order.status[0]}${order.status.slice(1).toLowerCase()}`)}` : t('olderOrderStatusUnavailable')));
  if (order.status && order.statusUpdatedAt !== order.submittedAt) card.append(element('p', 'shop-note', `${t('updatedAt')}: ${formatDate(order.statusUpdatedAt)}`));
  if (order.trackingCarrier) card.append(element('p', 'shop-note', `${t('carrier')}: ${order.trackingCarrier}${order.trackingNo ? ` · ${t('trackingNumberLabel')}: ${order.trackingNo}` : ''}`));
  if (order.simulation) card.append(element('p', 'shop-note', t('localDemoOrder')));
}

async function renderLocalOrders(navigating = false) {
  const requestId = ++localOrdersRequest;
  localOrdersController?.abort();
  const orderRoute = location.hash;
  const currentRoute = () => requestId === localOrdersRequest && location.hash === orderRoute;
  byId('local-orders-list').setAttribute('aria-busy', 'true');
  byId('local-orders-status').textContent = t('loading');
  if (localOrderStore.list().length) drawLocalOrders(localOrderStore.list());
  else byId('local-orders-list').replaceChildren();
  await localOrderStore.refresh();
  if (!currentRoute()) return;
  byId('local-orders-list').setAttribute('aria-busy', 'false');
  byId('local-orders-status').textContent = localOrderStore.persistent ? '' : t('localOrdersUnavailable');
  const orders = localOrderStore.list();
  drawLocalOrders(orders);
  if (navigating) {
    if (readShopRoute(orderRoute).id) { window.scrollTo(0, 0); byId('local-orders-list').querySelector('.order-detail h2')?.focus({ preventScroll: true }); }
    else { window.scrollTo(0, ordersScroll); if (previousOrderId) [...byId('local-orders-list').querySelectorAll('[data-order-no]')].find(el => el.dataset.orderNo === previousOrderId)?.focus({ preventScroll: true }); }
    previousOrderId = readShopRoute(orderRoute).id;
  }
  const credentials = orders.filter((order) => order.statusAccessKey).map((order) => ({
    orderNo: order.orderNo, accessKey: order.statusAccessKey,
  }));
  const button = byId('refresh-order-statuses');
  const status = byId('local-orders-sync-status');
  button.hidden = credentials.length === 0;
  status.textContent = credentials.length ? t('checkingOrderStatuses') : '';
  if (!credentials.length) return;
  button.disabled = true;
  const controller = new AbortController();
  localOrdersController = controller;
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let incomplete = false;
  try {
    for (let offset = 0; offset < credentials.length; offset += 50) {
      const batch = credentials.slice(offset, offset + 50);
      const response = await fetch('/api/v1/orders/statuses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: batch }), signal: controller.signal,
      });
      if (!response.ok) throw new Error('Status lookup failed');
      const data = await response.json();
      if (!Array.isArray(data.items)) throw new Error('Invalid status response');
      if (!currentRoute()) return;
      if (data.items.length !== batch.length) incomplete = true;
      await localOrderStore.updateStatuses(data.items);
    }
    if (!currentRoute()) return;
    drawLocalOrders(localOrderStore.list());
    status.textContent = t(incomplete ? 'orderStatusesFailed' : 'orderStatusesCurrent');
  } catch {
    if (currentRoute()) {
      status.textContent = t('orderStatusesFailed');
    }
  } finally {
    clearTimeout(timeout);
    if (currentRoute()) button.disabled = false;
  }
}

byId('refresh-order-statuses').addEventListener('click', () => renderLocalOrders());

function revealAccountLink(link) {
  const nav = link?.closest('.account-sidebar');
  if (!nav || !matchMedia('(max-width:800px)').matches || nav.offsetParent === null) return;
  const bounds = nav.getBoundingClientRect();
  const item = link.getBoundingClientRect();
  const delta = item.left < bounds.left + 4 ? item.left - bounds.left - 4
    : item.right > bounds.right - 4 ? item.right - bounds.right + 4 : 0;
  if (delta) nav.scrollBy({ left: delta, behavior: 'instant' });
}
document.querySelector('.account-sidebar').addEventListener('focusin', event => revealAccountLink(event.target.closest('a')));

function showRoute() {
  const checkoutRequest = ++checkoutRouteRequest;
  const parsed = readShopRoute(location.hash);
  const route = parsed.page;
  if (route !== 'orders') { localOrdersRequest++; localOrdersController?.abort(); }
  if (route === 'checkout' && (!profilePage.get() || !shopInfo)) { location.hash = directPurchase ? '#profile' : '#cart'; return; }
  if (['catalog', 'product', 'cart', 'receipt'].includes(route) && directPurchase) setDirectPurchase(null);
  if (previousRoute === 'catalog' && route !== 'catalog') catalogScroll = window.scrollY;
  if (route === 'receipt' && !lastReceipt) { location.hash = '#catalog'; return; }
  const catalogRoute = route === 'catalog';
  for (const view of ['catalog', 'product', 'cart', 'checkout', 'receipt', 'profile', 'orders', 'settings', 'addresses']) {
    byId(`${view}-view`).hidden = route !== view && !(view === 'catalog' && catalogRoute);
  }
  byId('account-layout').hidden = !['profile', 'orders', 'addresses', 'settings'].includes(route);
  for (const link of document.querySelectorAll('.account-sidebar a')) {
    if (link.hash === `#${route}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  requestAnimationFrame(() => revealAccountLink(document.querySelector('.account-sidebar a[aria-current=page]')));
  document.body.dataset.shopRoute = route;
  requestAnimationFrame(measureActionbar);
  for (const [hash, active] of [['#cart', route === 'cart']]) {
    const link = document.querySelector(`.shop-nav a[href="${hash}"]`);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (route === 'product') detailPage.show(parsed.id);
  else {
    detailPage.hide();
    document.title = shopInfo?.shopName || t('shop');
  }
  if (catalogRoute && previousRoute === 'product') { restoreCatalogFocus = Boolean(catalogReturnFocus); restoreCatalogLinkFocus(); }
  if (previousRoute !== route || route === 'product') {
    window.scrollTo(0, catalogRoute && previousRoute === 'product' ? catalogScroll : 0);
  }
  previousRoute = route;
  if (route === 'cart') refreshCart().then(() => {
    if (focusCheckoutAfterProfile && location.hash === '#cart') {
      focusCheckoutAfterProfile = false;
      byId('checkout-button').focus({ preventScroll: true });
    }
  });
  if (route === 'profile') profilePage.show();
  if (route === 'orders') renderLocalOrders(true);
  if (route === 'addresses') addressBook.render();
  if (route === 'checkout') {
    checkoutPage.invalidate();
    const intent = directPurchase;
    const ownsCheckoutRead = () => checkoutRequest === checkoutRouteRequest &&
      location.hash === '#checkout' && directPurchase === intent;
    if (directPurchase) {
      api(`/api/v1/products/${intent.productId}`).then((product) => {
        if (ownsCheckoutRead()) {
          checkoutPage.setItems([{ productId: intent.productId, quantity: intent.quantity, product }], { fromCart: false });
          const back = document.querySelector('#checkout-view .shop-actionbar a');
          back.href = productHash(intent.productId); back.dataset.i18n = 'continueShopping'; back.textContent = t('continueShopping');
        }
      }).catch((error) => {
        if (!ownsCheckoutRead()) return;
        setMessage(error.status === 404 ? 'productUnavailable' : 'networkError');
        location.hash = productHash(intent.productId);
      });
    } else refreshCart().then((valid) => {
      if (!ownsCheckoutRead()) return;
      if (valid) {
        checkoutPage.setItems(selection.items(resolvedCart));
        const back = document.querySelector('#checkout-view .shop-actionbar a');
        back.href = '#cart'; back.dataset.i18n = 'backToCart'; back.textContent = t('backToCart');
      } else location.hash = '#cart';
    });
  }
  if (route === 'receipt') renderReceipt();
}

function showCatalogResults() {
  if (location.hash !== '#catalog-results') location.hash = '#catalog-results';
  showRoute();
  byId('catalog-results').scrollIntoView({ block: 'start' });
  byId('catalog-results').focus({ preventScroll: true });
}

function applyCatalogFilters(replaceEntry = false, focusCategory) {
  const url = catalogFilterURL(location.href, { search: byId('catalog-search').value, category: category.value });
  history[replaceEntry === true ? 'replaceState' : 'pushState'](null, '', url);
  showCatalogResults();
  const loading = loadCatalog();
  const request = catalogRequest;
  loading.then(() => {
    requestAnimationFrame(() => {
      if (request === catalogRequest && location.hash === '#catalog-results') {
        byId('catalog-results').scrollIntoView({ block: 'start' });
        if (focusCategory !== undefined) [...byId('category-rail').children].find(button => button.dataset.category === focusCategory)?.focus({ preventScroll: true });
      }
    });
  });
}

const mobileNavigation = mountMobileNavigation({ currentCategory: () => category.value, categories: () => categories, selectCategory(value) { category.value = value; renderCategories(); applyCatalogFilters(); } });
setupLanguageMenu(document.getElementById('language'), { onOpen: mobileNavigation.openLanguage, showLabel: true });
byId('catalog-search').placeholder = t('searchProducts');

// Resolve the server's demo revision before reading any browser-local data.
// A failed initial request stays behind the existing retryable boot overlay.
shopInfo = await api('/api/v1/shop');
globalThis.shopStorageNamespace = shopInfo.demoNamespace || '';
const [cartStore, openedOrderStore] = await Promise.all([createCartStore(), createLocalOrderStore()]);
localOrderStore = openedOrderStore;
let selectionStorage;
try { selectionStorage = sessionStorage; } catch { /* Optional selection persistence. */ }
selection = createCartSelection(selectionStorage);
selection.sync(cartStore.list());
try { profileReturn = selectionStorage?.getItem(storageKey('online-shopping-profile-return')) || null; } catch { /* Optional return route. */ }
try {
  const saved = JSON.parse(selectionStorage?.getItem(storageKey('online-shopping-direct-purchase-v1')) || 'null');
  if (saved && Number.isInteger(saved.quantity) && saved.quantity >= 1 && saved.quantity <= 100) {
    productHash(saved.productId);
    directPurchase = { productId: saved.productId, quantity: saved.quantity };
  }
} catch { /* Invalid saved intent is ignored. */ }
profilePage = mountProfile({ onSaved() {
  renderCart();
  if (['cart', 'checkout'].includes(profileReturn)) {
    const returnRoute = profileReturn;
    focusCheckoutAfterProfile = returnRoute === 'cart';
    location.hash = `#${returnRoute}`;
    profileReturn = null;
    try { selectionStorage?.removeItem(storageKey('online-shopping-profile-return')); } catch { /* Optional return route. */ }
  }
} });
addressBook = mountAddressBook({
  getCountry: () => countryForCurrency(shopInfo?.currency),
  onChange() { checkoutPage?.refreshAddress(); },
});
for (const link of document.querySelectorAll('a[href="#profile"]')) link.addEventListener('click', () => {
  profileReturn = link.dataset.profileReturn || null;
  try {
    if (profileReturn) selectionStorage?.setItem(storageKey('online-shopping-profile-return'), profileReturn);
    else selectionStorage?.removeItem(storageKey('online-shopping-profile-return'));
  } catch { /* Optional return route. */ }
});
const legacyReceipt = readReceipt();
if (legacyReceipt) await localOrderStore.save(legacyReceipt, legacyReceipt.items || [], legacyReceipt.statusAccessKey);
lastReceipt = localOrderStore.list()[0] || legacyReceipt;
checkoutPage = mountCheckout({
  onSuccess: completeOrder,
  getProfile: () => profilePage.get(),
  addressBook,
  onPriceChanged() {
    if (directPurchase) {
      const productId = directPurchase.productId;
      setDirectPurchase(null);
      setMessage('productPriceChanged');
      location.hash = productHash(productId);
      return;
    }
    priceChangedNotice = true;
    location.hash = '#cart';
  },
});
const productUpdateBanner = document.createElement('aside');
productUpdateBanner.className = 'shop-update-banner product-update-banner';
productUpdateBanner.hidden = true;
detailPage = mountProductDetail(byId('product-view'), {
  api, addToCart, checkout: beginCheckout, shop: () => shopInfo, notify: setMessage,
  cartQuantity: () => cartStore.list().reduce((sum, line) => sum + line.quantity, 0),
  updateBanner: productUpdateBanner,
});
updateCount();
updatePersistence();
byId('catalog-search-form').addEventListener('submit', event => { event.preventDefault(); if (!searchComposing) commitFocusedSearch(); });
const searchInput = byId('catalog-search');
const clearSearch = action(t('clearSearch'), () => {
  searchInput.value = '';
  syncSearchClear();
  if (searchContext) renderFocusedSearch(); else applyCatalogFilters();
  searchInput.focus({ preventScroll: true });
}, 'catalog-search-clear');
clearSearch.id = 'catalog-search-clear';
clearSearch.setAttribute('aria-label', t('clearSearch'));
clearSearch.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19"/></svg>';
searchInput.after(clearSearch);
function syncSearchClear() { clearSearch.hidden = !searchInput.value; }
searchInput.addEventListener('input', syncSearchClear);
searchInput.addEventListener('keydown', event => {
  if (event.key === 'Escape' && searchContext && !event.isComposing) { event.preventDefault(); closeFocusedSearch(true); return; }
  if (event.key === 'Escape' && searchInput.value && !event.isComposing) {
    event.preventDefault(); clearSearch.click();
  }
});
let searchContext = null;
let searchPointerContext = null;
let searchComposing = false;
const searchHistoryKey = storageKey('online-shopping-search-history-v1');
let recentSearches = [];
try { const stored = JSON.parse(localStorage.getItem(searchHistoryKey) || '[]'); if (Array.isArray(stored)) recentSearches = stored.filter(x => typeof x === 'string' && x.trim() && x.length <= 100).slice(0, 8); } catch {}
function persistSearchHistory() { try { localStorage.setItem(searchHistoryKey, JSON.stringify(recentSearches)); } catch {} }
function renderFocusedSearch() {
  const recent = byId('search-recent'); recent.replaceChildren();
  byId('search-history-clear').hidden = !recentSearches.length;
  if (!recentSearches.length) recent.append(element('p', 'shop-note', t('noSearchHistory')));
  for (const query of recentSearches) recent.append(action(query, () => { searchInput.value = query; category.value = ''; commitFocusedSearch(); }, 'search-suggestion'));
  const suggestions = byId('search-suggestions'); suggestions.replaceChildren();
  const query = searchInput.value.trim().toLocaleLowerCase();
  const values = [...categories.map(value => ({ value, category: true })), ...products.map(p => ({ value: p.name, category: false }))];
  const seen = new Set();
  for (const item of values.filter(x => !query || x.value.toLocaleLowerCase().includes(query))) {
    if (seen.has(item.value)) continue; seen.add(item.value);
    suggestions.append(action(item.value, () => { category.value = item.category ? item.value : ''; searchInput.value = item.category ? '' : item.value; commitFocusedSearch(); }, 'search-suggestion'));
    if (seen.size === 8) break;
  }
  if (!seen.size) suggestions.append(element('p', 'shop-note', t('noResults')));
  byId('search-demo-note').hidden = shopInfo?.mode !== 'demo';
  syncSearchClear();
}
function updateSearchViewport() { document.documentElement.style.setProperty('--search-viewport-height', `${window.visualViewport?.height || innerHeight}px`); }
function openFocusedSearch() {
  if (searchContext) return;
  searchContext = searchPointerContext || { value: searchInput.value, scroll: scrollY };
  searchPointerContext = null;
  searchContext.url = location.href;
  if (!history.state?.shopSearchFocus) history.pushState({ shopSearchFocus: true }, '', location.href);
  byId('search-cancel').hidden = false;
  document.body.classList.add('search-focused'); byId('search-focus-panel').hidden = false;
  updateSearchViewport(); renderFocusedSearch();
}
function closeFocusedSearch(restore, navigate = true) {
  if (restore && navigate && searchContext && history.state?.shopSearchFocus) { if (!byId('search-cancel').disabled) { byId('search-cancel').disabled = true; history.back(); } return; }
  const context = searchContext; searchContext = null;
  document.body.classList.remove('search-focused'); byId('search-focus-panel').hidden = true;
  searchInput.blur();
  byId('search-cancel').hidden = true;
  byId('search-cancel').disabled = false;
  if (restore && context) { searchInput.value = context.value; syncSearchClear(); requestAnimationFrame(() => { scrollTo(0, context.scroll); const heading = document.querySelector('.shop-main section:not([hidden]) h1, .shop-main #catalog-view:not([hidden]) h2'); if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); } }); }
}
function commitFocusedSearch() {
  const query = searchInput.value.trim();
  if (query) { recentSearches = [query, ...recentSearches.filter(x => x !== query)].slice(0, 8); persistSearchHistory(); }
  const replaceEntry = Boolean(history.state?.shopSearchFocus);
  closeFocusedSearch(false, false); applyCatalogFilters(replaceEntry);
}
searchInput.addEventListener('pointerdown', () => { if (!searchContext) searchPointerContext = { value: searchInput.value, scroll: scrollY }; });
searchInput.addEventListener('focus', openFocusedSearch);
searchInput.addEventListener('input', () => { if (searchContext && !searchComposing) renderFocusedSearch(); });
searchInput.addEventListener('compositionstart', () => { searchComposing = true; });
searchInput.addEventListener('compositionend', () => { searchComposing = false; if (searchContext) renderFocusedSearch(); });
byId('search-cancel').addEventListener('click', () => closeFocusedSearch(true));
byId('search-history-clear').addEventListener('click', () => { recentSearches = []; persistSearchHistory(); renderFocusedSearch(); });
window.visualViewport?.addEventListener('resize', updateSearchViewport);
window.addEventListener('popstate', event => {
  if (searchContext && !event.state?.shopSearchFocus) {
    const sameEntry = searchContext.url === location.href;
    closeFocusedSearch(sameEntry, false);
    if (sameEntry) event.stopImmediatePropagation();
  } else if (!searchContext && event.state?.shopSearchFocus) { openFocusedSearch(); searchInput.focus({ preventScroll: true }); event.stopImmediatePropagation(); }
}, { capture: true });
syncSearchClear();
category.addEventListener('change', applyCatalogFilters);
byId('catalog-clear-filters').addEventListener('click', () => {
  searchInput.value = '';
  syncSearchClear();
  category.value = '';
  renderCategories();
  applyCatalogFilters();
});
byId('catalog-more').addEventListener('click', () => loadCatalog(false));
byId('catalog-page-retry').addEventListener('click', () => loadCatalog(false));
if ('IntersectionObserver' in window) {
  const moreObserver = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !byId('catalog-view').hidden && !catalogLoading &&
        nextOffset !== null && !catalogHasError()) loadCatalog(false);
  }, { rootMargin: '0px 0px 500px 0px' });
  moreObserver.observe(byId('catalog-more'));
}
byId('cart-retry').addEventListener('click', () => refreshCart());
byId('checkout-button').addEventListener('click', () => beginCheckout(() => location.hash === '#cart'));
byId('cart-select-all').addEventListener('change', (event) => {
  for (const { productId } of resolvedCart) selection.set(productId, event.target.checked);
  for (const control of list.querySelectorAll('.cart-select')) control.checked = selection.has(control.dataset.productId);
  renderCartSummary();
});
const accountMenu = byId('profile-menu');
const accountButton = byId('profile-menu-button');
function closeAccountMenu() { accountMenu.hidden = true; accountButton.setAttribute('aria-expanded', 'false'); }
accountButton.addEventListener('click', () => {
  accountMenu.hidden = !accountMenu.hidden;
  accountButton.setAttribute('aria-expanded', String(!accountMenu.hidden));
  if (!accountMenu.hidden) accountMenu.querySelector('a').focus();
});
document.addEventListener('click', (event) => { if (!event.target.closest('.shop-account')) closeAccountMenu(); });
accountMenu.addEventListener('click', closeAccountMenu);
window.addEventListener('hashchange', closeAccountMenu);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !accountMenu.hidden) { closeAccountMenu(); accountButton.focus(); } });
byId('settings-clear-history').addEventListener('click', () => {
  const history = createContactHistory(); history.clear();
  byId('settings-status').textContent = t(history.persistent ? 'historyCleared' : 'historyStorageUnavailable');
});
function restoreCatalogFilters() {
  const filters = readCatalogFilters(location.search);
  byId('catalog-search').value = filters.search;
  const value = filters.category;
  if (value && ![...category.options].some(option => option.value === value)) category.add(new Option(value, value));
  category.value = value;
  syncSearchClear();
}
window.addEventListener('popstate', () => {
  const filters = readCatalogFilters(location.search);
  const changed = filters.search.trim() !== catalogFilters.search || filters.category !== catalogFilters.category;
  restoreCatalogFilters();
  // Product hash navigation must retain loaded pages, scroll and return focus.
  if (changed) loadCatalog();
  if (readShopRoute(location.hash).page === 'catalog') showRoute();
});
window.addEventListener('hashchange', showRoute);
document.addEventListener('localechange', () => {
  translate(document);
  if (searchContext) renderFocusedSearch();
  requestAnimationFrame(() => revealAccountLink(document.querySelector('.account-sidebar a[aria-current=page]')));
  byId('catalog-retry').textContent = t('retry');
  byId('catalog-search').placeholder = t('searchProducts');
  clearSearch.setAttribute('aria-label', t('clearSearch'));
  renderCategories();
  renderCatalog();
  renderCart();
  if (readShopRoute(location.hash).page === 'product') detailPage.refreshLocale();
  byId('catalog-status').textContent = catalogStatus ? t(catalogStatus) : '';
  byId('catalog-page-message').textContent = catalogPageStatus ? t(catalogPageStatus) : '';
  byId('cart-status').textContent = cartStatus ? t(cartStatus) : '';
  byId('shop-message').textContent = shopStatus ? t(shopStatus) : '';
  updateCount();
  updatePersistence();
  checkoutPage.refreshLocale();
  profilePage.refreshLocale();
  addressBook.refreshLocale();
  renderReceipt();
  if (readShopRoute(location.hash).page === 'orders') renderLocalOrders();
});
function measureActionbar() {
  const bar = document.querySelector('section:not([hidden]) > .shop-actionbar, section:not([hidden]) > form > .shop-actionbar');
  document.documentElement.style.setProperty('--shop-action-height', `${bar?.getBoundingClientRect().height || 0}px`);
}
const actionObserver = new ResizeObserver(measureActionbar);
document.querySelectorAll('.shop-actionbar').forEach((bar) => actionObserver.observe(bar));

async function goHome(event) {
  event.preventDefault();
  document.getElementById('catalog-search').value = '';
  syncSearchClear();
  category.value = ''; renderCategories();
  catalogScroll = 0; catalogReturnFocus = null; restoreCatalogFocus = false;
  const url = new URL(location.href); url.searchParams.delete('search'); url.searchParams.delete('category'); url.hash = '#catalog';
  history.pushState(null, '', url); showRoute();
  mobileNavigation.route(); window.scrollTo(0, 0);
  const view = byId('catalog-view');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) view.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 180 });
  await loadCatalog();
}
for (const link of document.querySelectorAll('.shop-topbar .brand, .shop-nav a[href="#catalog"], #mobile-navigation a[href="#catalog"]')) link.addEventListener('click', goHome);
const retryCatalog = element('button', 'outline-button', t('retry'));
retryCatalog.id = 'catalog-retry'; retryCatalog.hidden = true; byId('catalog-status').after(retryCatalog);
retryCatalog.addEventListener('click', () => loadCatalog(retryCatalogReset));

restoreCatalogFilters();
await loadCatalog();
showRoute();


mountShopUpdates(() => ({ dirty: profilePage.isDirty() || addressBook.isDirty(), busy: cartWrites > 0 || checkoutPage.isBusy(), signature: draftSignature() }), productUpdateBanner);
finishBoot();
