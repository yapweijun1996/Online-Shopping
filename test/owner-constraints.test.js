import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/app.js';
import { createSession, ensureAdmin } from '../src/auth.js';
import { initializeShop } from '../src/shop-setup.js';
import { createCategory, getCompanySettings, updateCompanySettings } from '../src/settings.js';
import { createProduct, getProduct, updateProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';

const input = { sku: 'SYNTHETIC', name: 'Fictional item', description: 'Test fixture', category: 'GENERAL', priceMinor: 900, active: true };
async function storeFor(t) {
  const store = await openDatabase(':memory:'); t.after(async () => await store.close());
  await createCategory(store, { code: 'GENERAL', label: 'General' });
  return store;
}
function checkout(product) {
  return { buyer: { fullName: 'Fictional Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true, deliveries: [{
    recipient: { fullName: 'Fictional Recipient', phone: '+60123456789' },
    address: { line1: 'Synthetic fixture address', postcode: '50000', country: 'MY' },
    items: [{ productId: product.id, quantity: 1, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency }],
  }] };
}

test('company currency is inherited, immutable through product API, and never relabels price or order snapshots', async t => {
  const store = await storeFor(t);
  await updateCompanySettings(store, { defaultCurrency: 'SGD' });
  const product = await createProduct(store, input); assert.equal(product.currency, 'SGD');
  await assert.rejects(async () => await createProduct(store, { ...input, sku: 'BAD', currency: 'MYR' }), error => error.field === 'currency');
  await assert.rejects(async () => await updateProduct(store, product.id, { currency: 'MYR' }), error => error.field === 'currency');
  const order = await createOrder(store, 'synthetic-currency-000001', checkout(product));
  const beforeOrder = await store.all('SELECT * FROM shop_order'), beforeItems = await store.all('SELECT * FROM order_item');
  const beforeEvents = await store.all('SELECT * FROM order_event');
  assert.equal(order.receipt.currency, 'SGD');
  await updateProduct(store, product.id, { active: false, priceMinor: 1200, name: 'Fictional revised item' });
  await assert.rejects(async () => await updateCompanySettings(store, { defaultCurrency: 'MYR' }), error => error.status === 409 && error.code === 'COMPANY_CURRENCY_CONFLICT');
  assert.equal((await getCompanySettings(store)).defaultCurrency, 'SGD');
  assert.equal((await getProduct(store, product.id, true)).currency, 'SGD');
  assert.equal((await getProduct(store, product.id, true)).priceMinor, 1200);
  assert.deepEqual(await store.all('SELECT * FROM shop_order'), beforeOrder);
  assert.deepEqual(await store.all('SELECT * FROM order_item'), beforeItems);
  assert.deepEqual(await store.all('SELECT * FROM order_event'), beforeEvents);
});

test('legacy mismatched products allow metadata/deactivation but reject price edits, relabelling and activation', async t => {
  const store = await storeFor(t), product = await createProduct(store, input);
  await store.run('UPDATE product SET currency = ?, active = 0 WHERE id = ?', 'SGD', product.id);
  for (const patch of [{ priceMinor: 950 }, { currency: 'SGD' }, { active: true }]) {
    await assert.rejects(async () => await updateProduct(store, product.id, patch), error => error.code === 'COMPANY_CURRENCY_CONFLICT');
  }
  assert.equal((await updateProduct(store, product.id, { name: 'Reviewed metadata', active: false })).name, 'Reviewed metadata');
  assert.equal((await getProduct(store, product.id, true)).priceMinor, 900);
  assert.equal((await getProduct(store, product.id, true)).currency, 'SGD');
});

test('Seller edit payload permits legacy metadata/deactivation while actual money edits and activation remain blocked', async t => {
  const store = await storeFor(t), product = await createProduct(store, input);
  await createOrder(store, 'synthetic-edit-currency-01', checkout(product));
  const snapshots = await Promise.all(['shop_order', 'order_item', 'order_event'].map(async table => await store.all(`SELECT * FROM ${table}`)));
  await store.run('UPDATE product SET currency = ? WHERE id = ?', 'SGD', product.id);
  const source = readFileSync(new URL('../public/seller/products.js', import.meta.url), 'utf8');
  const values = { sku: product.sku, name: product.name, description: product.description, category: product.categoryCode,
    price: '9.00', currency: 'SGD', variantGroup: '', variantLabel: '', stockQuantity: '' };
  const elements = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }]));
  elements.active = { checked: true }; elements.image = { files: [] };
  const context = { optionTypes: [], selectedOptions: () => [], galleryImages: [], galleryEditable: true, sharedGallery: false, expectedUpdatedAt: product.updatedAt, productId: product.id, form: { hidden: false, elements }, saving: false, pendingRemove: false, formBaseline: null, editingId: product.id };
  vm.createContext(context);
  // Price and stock parsing now live in product-fields.js, shared with the variant generator.
  vm.runInContext(readFileSync(new URL('../public/seller/product-fields.js', import.meta.url), 'utf8').replaceAll('export ', ''), context);
  vm.runInContext(source.slice(source.indexOf('  function formState()'), source.indexOf('  function confirmDiscard()')), context);
  vm.runInContext('captureBaseline()', context);
  const start = source.indexOf('      const payload = {');
  const payloadSource = source.slice(start, source.indexOf('      const file = form.elements.image.files[0];', start));
  const payload = () => vm.runInContext(`(() => { ${payloadSource} return payload; })()`, context);
  const session = await createSession(store), handle = await createApi({ store, config: { publicOrigin: 'https://fixture.test' } });
  const submit = async body => {
    // Each policy probe uses the current revision, like a freshly reopened editor.
    body.expectedUpdatedAt = (await getProduct(store, product.id, true)).updatedAt;
    return handle(new Request(`https://fixture.test/api/v1/seller/products/${product.id}`, {
    method: 'PATCH', headers: { origin: 'https://fixture.test', 'content-type': 'application/json',
      cookie: `seller_session=${session.token}`, 'x-csrf-token': session.csrfToken }, body: JSON.stringify(body),
  }));
  };
  elements.name.value = 'Reviewed metadata'; elements.active.checked = false;
  const metadata = payload();
  assert.equal(Object.hasOwn(metadata, 'currency'), false);
  assert.equal(Object.hasOwn(metadata, 'priceMinor'), false);
  assert.equal((await submit(metadata)).status, 200);
  assert.equal((await getProduct(store, product.id, true)).name, 'Reviewed metadata');
  assert.equal((await getProduct(store, product.id, true)).active, false);
  elements.price.value = '10.00';
  assert.equal((await submit(payload())).status, 409);
  elements.price.value = '9.00'; elements.currency.value = 'MYR';
  assert.equal((await submit(payload())).status, 400);
  elements.currency.value = 'SGD';
  vm.runInContext('captureBaseline()', context);
  elements.active.checked = true;
  assert.equal((await submit(payload())).status, 409);
  assert.equal((await getProduct(store, product.id, true)).priceMinor, 900);
  assert.equal((await getProduct(store, product.id, true)).currency, 'SGD');
  assert.deepEqual(await Promise.all(['shop_order', 'order_item', 'order_event'].map(async table => await store.all(`SELECT * FROM ${table}`))), snapshots);
});

test('all 35 demo seller details expose their unchanged primary image and all six gallery photos', async t => {
  const store = await openDatabase(':memory:'); t.after(async () => await store.close());
  const config = { shopMode: 'public-demo', production: false, username: 'synthetic-owner' };
  await initializeShop(store, config); await ensureAdmin(store, config.username, 'SyntheticTestPass123!');
  const session = await createSession(store), handle = await createApi({ store, config });
  const before = await store.all('SELECT * FROM product ORDER BY id');
  const request = async path => handle(new Request('http://localhost' + path, { headers: { cookie: `seller_session=${session.token}` } }));
  const list = await (await request('/api/v1/seller/products?limit=100')).json(); assert.equal(list.items.length, 35);
  for (const product of list.items) {
    const response = await request(`/api/v1/seller/products/${product.id}`); assert.equal(response.status, 200);
    const detail = await response.json(); assert.equal(detail.images.length, 6, detail.sku);
    assert.equal(detail.images[0], detail.imageUrl); assert.match(detail.imageUrl, /^\/api\/v1\/seller\/products\//);
    assert.equal((await request(detail.imageUrl)).status, 200);
    assert.equal(detail.imageMedia.length, 6);
  }
  assert.deepEqual(await store.all('SELECT * FROM product ORDER BY id'), before);
});
