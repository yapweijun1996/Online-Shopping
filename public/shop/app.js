import { formatDate, formatMoney, setupLanguageMenu, t, translate } from '../shared/i18n.js';
import { registerWorker } from '../shared/pwa.js';
import { createCartStore } from './cart.js';
import { mountCheckout } from './checkout.js';

const byId = (id) => document.getElementById(id);
const grid = byId('catalog-grid');
const list = byId('cart-list');
const dialog = byId('product-dialog');
const detailContent = byId('detail-content');
const category = byId('catalog-category');
let products = [];
let categories = [];
let nextOffset = null;
let catalogRequest = 0;
let cartRequest = 0;
let resolvedCart = [];
let detailProduct = null;
let catalogStatus = '';
let cartStatus = '';
let shopStatus = '';
let cartReady = false;
let checkoutPage = null;
let lastReceipt = null;
let receiptNotes = [];

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
}

function setCartStatus(key) {
  cartStatus = key;
  byId('cart-status').textContent = key ? t(key) : '';
}

function setMessage(key) {
  shopStatus = key;
  byId('shop-message').textContent = key ? t(key) : '';
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
  rail.replaceChildren();
  for (const value of ['', ...categories]) {
    const button = element('button', 'category-option');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(category.value === value));
    const symbol = element('span', 'category-symbol', value ? value.slice(0, 1).toLocaleUpperCase() : '✦');
    symbol.setAttribute('aria-hidden', 'true');
    button.append(symbol, element('span', '', value || t('allCategories')));
    button.addEventListener('click', () => {
      category.value = value;
      applyCatalogFilters();
    });
    rail.append(button);
  }
}

function renderCatalog() {
  grid.replaceChildren();
  for (const product of products) {
    const card = element('article', 'catalog-card');
    const imageButton = action(`${t('viewDetails')}: ${product.name}`, () => openDetail(product.id), 'catalog-image-button');
    imageButton.setAttribute('aria-label', `${t('viewDetails')}: ${product.name}`);
    imageButton.replaceChildren(imageFor(product, 'catalog-image'));
    card.append(imageButton);
    const body = element('div', 'catalog-card-body');
    body.append(element('p', 'catalog-category', product.category), element('h3', '', product.name),
      element('p', 'catalog-description', product.description), element('strong', 'catalog-price', formatMoney(product.priceMinor, product.currency)));
    const actions = element('div', 'catalog-card-actions');
    actions.append(action(t('viewDetails'), () => openDetail(product.id)), action(t('addToCart'), () => addToCart(product), 'primary-button'));
    body.append(actions);
    card.append(body);
    grid.append(card);
  }
  byId('catalog-more').hidden = nextOffset === null;
  byId('catalog-count').textContent = products.length ? t('showingProducts').replace('{count}', String(products.length)) : '';
}

async function loadCatalog(reset = true) {
  const request = ++catalogRequest;
  if (reset) { products = []; nextOffset = null; renderCatalog(); }
  setCatalogStatus('loading');
  try {
    const params = new URLSearchParams({
      limit: '24', offset: String(reset ? 0 : nextOffset),
      search: byId('catalog-search').value.trim(), category: category.value,
    });
    const data = await api(`/api/v1/products?${params}`);
    if (request !== catalogRequest) return;
    products = reset ? data.items : [...products, ...data.items];
    categories = data.categories;
    nextOffset = data.nextOffset;
    renderCategories();
    renderCatalog();
    const heroImage = byId('hero-image');
    const featured = products.find((product) => product.imageUrl);
    heroImage.hidden = !featured;
    if (featured) heroImage.src = featured.imageUrl;
    else heroImage.removeAttribute('src');
    setCatalogStatus(products.length ? '' : (params.get('search') || params.get('category') ? 'noResults' : 'noProducts'));
  } catch {
    if (request === catalogRequest) setCatalogStatus('networkError');
  }
}

function renderDetail() {
  if (!detailProduct) return;
  detailContent.replaceChildren();
  detailContent.append(imageFor(detailProduct, 'detail-image'));
  const body = element('div', 'detail-body');
  const title = element('h2', '', detailProduct.name);
  title.id = 'detail-title';
  body.append(element('p', 'catalog-category', detailProduct.category), title,
    element('p', 'detail-description', detailProduct.description),
    element('strong', 'catalog-price', formatMoney(detailProduct.priceMinor, detailProduct.currency)),
    action(t('addToCart'), () => addToCart(detailProduct), 'primary-button'));
  detailContent.append(body);
}

async function openDetail(id) {
  detailProduct = null;
  detailContent.replaceChildren(element('h2', '', t('loading')));
  detailContent.firstChild.id = 'detail-title';
  dialog.showModal();
  try {
    const product = await api(`/api/v1/products/${id}`);
    if (!dialog.open) return;
    detailProduct = product;
    renderDetail();
  } catch (error) {
    if (!dialog.open) return;
    const heading = element('h2', '', t(error.status === 404 ? 'productUnavailable' : 'networkError'));
    heading.id = 'detail-title';
    detailContent.replaceChildren(heading);
  }
}

function updateCount() {
  const count = cartStore.list().reduce((sum, line) => sum + line.quantity, 0);
  byId('cart-count').textContent = String(count);
  document.querySelector('.shop-nav a[href="#cart"]').setAttribute('aria-label', `${t('cart')}: ${count}`);
}

function updatePersistence() {
  const note = byId('cart-persistence');
  note.hidden = cartStore.persistent;
  note.textContent = cartStore.persistent ? '' : t('cartMemoryOnly');
}

async function addToCart(product) {
  const existing = cartStore.list().find((line) => line.productId === product.id)?.quantity || 0;
  if (existing >= 100) {
    setMessage('quantityLimit');
    return;
  }
  await cartStore.set(product.id, existing + 1);
  updateCount();
  updatePersistence();
  setMessage('addedToCart');
  if (!byId('cart-view').hidden) refreshCart();
}

async function changeQuantity(productId, value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    setMessage('quantityLimit');
    renderCart();
    return;
  }
  await cartStore.set(productId, value);
  updateCount();
  updatePersistence();
  setMessage('quantityUpdated');
  refreshCart();
}

async function removeLine(productId) {
  await cartStore.set(productId, 0);
  updateCount();
  updatePersistence();
  setMessage('removedFromCart');
  refreshCart();
}

function renderCart() {
  list.replaceChildren();
  let total = 0;
  let missing = false;
  const currencies = new Set();
  for (const { productId, quantity, product } of resolvedCart) {
    const row = element('article', 'cart-row');
    row.append(product ? imageFor(product, 'cart-image') : element('div', 'cart-image image-placeholder', t('imageMissing')));
    const detail = element('div', 'cart-row-detail');
    detail.append(element('h2', '', product?.name || t('productUnavailable')));
    if (product) {
      detail.append(element('p', '', `${product.category} · ${formatMoney(product.priceMinor, product.currency)}`));
      total += product.priceMinor * quantity;
      currencies.add(product.currency);
    } else missing = true;
    const controls = element('div', 'cart-row-controls');
    const label = element('label', '', t('quantity'));
    const input = element('input');
    input.type = 'number'; input.min = '1'; input.max = '100'; input.step = '1'; input.inputMode = 'numeric';
    input.value = String(quantity);
    input.setAttribute('aria-label', `${t('quantity')}: ${product?.name || t('productUnavailable')}`);
    input.addEventListener('change', () => changeQuantity(productId, input.valueAsNumber));
    label.append(input);
    controls.append(label, action(t('remove'), () => removeLine(productId)));
    detail.append(controls);
    row.append(detail);
    list.append(row);
  }
  const summary = byId('cart-summary');
  summary.hidden = resolvedCart.length === 0;
  byId('cart-total').textContent = !missing && currencies.size === 1 && Number.isSafeInteger(total)
    ? formatMoney(total, [...currencies][0]) : '—';
  byId('checkout-button').disabled = !cartReady || missing || currencies.size > 1 || resolvedCart.length === 0;
}

async function refreshCart() {
  const request = ++cartRequest;
  const lines = cartStore.list();
  cartReady = false;
  byId('checkout-button').disabled = true;
  updateCount();
  updatePersistence();
  if (!lines.length) {
    resolvedCart = [];
    renderCart();
    setCartStatus('emptyCart');
    return false;
  }
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
    resolvedCart = results;
    const currencies = new Set(results.map(({ product }) => product?.currency).filter(Boolean));
    cartReady = results.every(({ product }) => Boolean(product)) && currencies.size === 1;
    renderCart();
    setCartStatus(results.some(({ product }) => !product) ? 'cartUnavailable' : currencies.size > 1 ? 'mixedCurrencies' : '');
    return cartReady;
  } catch {
    if (request === cartRequest) setCartStatus('networkError');
    return false;
  }
}

function readReceipt() {
  try {
    const saved = JSON.parse(localStorage.getItem('online-shopping-last-receipt-v1') || 'null');
    if (saved && /^OS-\d{8,}$/.test(saved.orderNo) && Number.isSafeInteger(saved.totalMinor) &&
        ['MYR', 'SGD'].includes(saved.currency) && !Number.isNaN(Date.parse(saved.submittedAt))) return saved;
  } catch { /* A receipt is optional browser convenience. */ }
  return null;
}

function renderReceipt() {
  if (!lastReceipt) return;
  byId('receipt-number').textContent = lastReceipt.orderNo;
  byId('receipt-total').textContent = formatMoney(lastReceipt.totalMinor, lastReceipt.currency);
  byId('receipt-date').textContent = formatDate(lastReceipt.submittedAt);
  const note = byId('receipt-storage-note');
  note.hidden = receiptNotes.length === 0;
  note.textContent = receiptNotes.map((key) => t(key)).join(' ');
}

async function completeOrder(receipt, { historySaveFailed }) {
  lastReceipt = receipt;
  receiptNotes = historySaveFailed ? ['historyStorageUnavailable'] : [];
  try {
    localStorage.removeItem('online-shopping-last-receipt-v1');
    localStorage.setItem('online-shopping-last-receipt-v1', JSON.stringify(receipt));
  }
  catch { receiptNotes.push('receiptMemoryOnly'); }
  try { if (!(await cartStore.clear())) receiptNotes.push('cartClearFailed'); }
  catch { receiptNotes.push('cartClearFailed'); }
  resolvedCart = [];
  cartReady = false;
  checkoutPage.reset();
  updateCount();
  updatePersistence();
  renderReceipt();
  setMessage('orderSubmitted');
  location.hash = '#receipt';
  showRoute();
}

function showRoute() {
  const route = location.hash.slice(1);
  if (route === 'receipt' && !lastReceipt) { location.hash = '#catalog'; return; }
  const catalogRoute = !['cart', 'checkout', 'receipt'].includes(route);
  for (const view of ['catalog', 'cart', 'checkout', 'receipt']) {
    byId(`${view}-view`).hidden = route !== view && !(view === 'catalog' && catalogRoute);
  }
  for (const [hash, active] of [['#catalog', catalogRoute], ['#cart', route === 'cart']]) {
    const link = document.querySelector(`.shop-nav a[href="${hash}"]`);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (!catalogRoute || route === 'catalog' || route === '') window.scrollTo(0, 0);
  if (route === 'cart') refreshCart();
  if (route === 'checkout' && !cartReady) {
    refreshCart().then((valid) => {
      if (valid) checkoutPage.setItems(resolvedCart);
      else if (location.hash === '#checkout') location.hash = '#cart';
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

function applyCatalogFilters() {
  showCatalogResults();
  loadCatalog().then(() => {
    requestAnimationFrame(() => {
      if (!byId('catalog-view').hidden) byId('catalog-results').scrollIntoView({ block: 'start' });
    });
  });
}

setupLanguageMenu(document.getElementById('language'));
byId('catalog-search').placeholder = t('searchProducts');
registerWorker('/shop/sw.js', '/shop/').catch(() => console.warn('Shop offline shell unavailable.'));
const cartStore = await createCartStore();
lastReceipt = readReceipt();
checkoutPage = mountCheckout({ onSuccess: completeOrder });
updateCount();
updatePersistence();
byId('catalog-search-form').addEventListener('submit', (event) => { event.preventDefault(); applyCatalogFilters(); });
category.addEventListener('change', applyCatalogFilters);
byId('catalog-more').addEventListener('click', () => loadCatalog(false));
byId('detail-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { detailProduct = null; });
byId('checkout-button').addEventListener('click', async () => {
  if (!(await refreshCart())) return;
  checkoutPage.setItems(resolvedCart);
  location.hash = '#checkout';
});
window.addEventListener('hashchange', showRoute);
document.addEventListener('localechange', () => {
  translate(document);
  byId('catalog-search').placeholder = t('searchProducts');
  renderCategories();
  renderCatalog();
  renderCart();
  renderDetail();
  byId('catalog-status').textContent = catalogStatus ? t(catalogStatus) : '';
  byId('cart-status').textContent = cartStatus ? t(cartStatus) : '';
  byId('shop-message').textContent = shopStatus ? t(shopStatus) : '';
  updateCount();
  updatePersistence();
  checkoutPage.refreshLocale();
  renderReceipt();
});
showRoute();
loadCatalog();
