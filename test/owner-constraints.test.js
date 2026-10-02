import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/app.js';
import { createSession, ensureAdmin } from '../src/auth.js';
import { initializeShop } from '../src/shop-setup.js';
import { createCategory, getCompanySettings, updateCompanySettings } from '../src/settings.js';
import { createProduct, getProduct, updateProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';

const input = { sku: 'SYNTHETIC', name: 'Fictional item', description: 'Test fixture', category: 'GENERAL', priceMinor: 900, active: true };
function storeFor(t) {
  const store = openDatabase(':memory:'); t.after(() => store.close());
  createCategory(store, { code: 'GENERAL', label: 'General' });
  return store;
}
function checkout(product) {
  return { buyer: { fullName: 'Fictional Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true, deliveries: [{
    recipient: { fullName: 'Fictional Recipient', phone: '+60123456789' },
    address: { line1: 'Synthetic fixture address', postcode: '50000', country: 'MY' },
    items: [{ productId: product.id, quantity: 1, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency }],
  }] };
}

test('company currency is inherited, immutable through product API, and never relabels price or order snapshots', t => {
  const store = storeFor(t);
  updateCompanySettings(store, { defaultCurrency: 'SGD' });
  const product = createProduct(store, input); assert.equal(product.currency, 'SGD');
  assert.throws(() => createProduct(store, { ...input, sku: 'BAD', currency: 'MYR' }), error => error.field === 'currency');
  assert.throws(() => updateProduct(store, product.id, { currency: 'MYR' }), error => error.field === 'currency');
  const order = createOrder(store, 'synthetic-currency-000001', checkout(product));
  const beforeOrder = store.all('SELECT * FROM shop_order'), beforeItems = store.all('SELECT * FROM order_item');
  const beforeEvents = store.all('SELECT * FROM order_event');
  assert.equal(order.receipt.currency, 'SGD');
  updateProduct(store, product.id, { active: false, priceMinor: 1200, name: 'Fictional revised item' });
  assert.throws(() => updateCompanySettings(store, { defaultCurrency: 'MYR' }), error => error.status === 409 && error.code === 'COMPANY_CURRENCY_CONFLICT');
  assert.equal(getCompanySettings(store).defaultCurrency, 'SGD');
  assert.equal(getProduct(store, product.id, true).currency, 'SGD');
  assert.equal(getProduct(store, product.id, true).priceMinor, 1200);
  assert.deepEqual(store.all('SELECT * FROM shop_order'), beforeOrder);
  assert.deepEqual(store.all('SELECT * FROM order_item'), beforeItems);
  assert.deepEqual(store.all('SELECT * FROM order_event'), beforeEvents);
});

test('legacy mismatched products allow metadata/deactivation but reject price edits, relabelling and activation', t => {
  const store = storeFor(t), product = createProduct(store, input);
  store.run('UPDATE product SET currency = ?, active = 0 WHERE id = ?', 'SGD', product.id);
  for (const patch of [{ priceMinor: 950 }, { currency: 'SGD' }, { active: true }]) {
    assert.throws(() => updateProduct(store, product.id, patch), error => error.code === 'COMPANY_CURRENCY_CONFLICT');
  }
  assert.equal(updateProduct(store, product.id, { name: 'Reviewed metadata', active: false }).name, 'Reviewed metadata');
  assert.equal(getProduct(store, product.id, true).priceMinor, 900);
  assert.equal(getProduct(store, product.id, true).currency, 'SGD');
});

test('all 35 demo seller details expose their unchanged primary image and all six gallery photos', async t => {
  const store = openDatabase(':memory:'); t.after(() => store.close());
  const config = { shopMode: 'public-demo', production: false, username: 'synthetic-owner' };
  initializeShop(store, config); ensureAdmin(store, config.username, 'SyntheticTestPass123!');
  const session = createSession(store), handle = createApi({ store, config });
  const before = store.all('SELECT * FROM product ORDER BY id');
  const request = async path => handle(new Request('http://localhost' + path, { headers: { cookie: `seller_session=${session.token}` } }));
  const list = await (await request('/api/v1/seller/products?limit=100')).json(); assert.equal(list.items.length, 35);
  for (const product of list.items) {
    const response = await request(`/api/v1/seller/products/${product.id}`); assert.equal(response.status, 200);
    const detail = await response.json(); assert.equal(detail.images.length, 6, detail.sku);
    assert.equal(detail.images[0], detail.imageUrl); assert.match(detail.imageUrl, /^\/api\/v1\/seller\/products\//);
    assert.equal((await request(detail.imageUrl)).status, 200);
    assert.equal(detail.imageMedia.length, 6);
  }
  assert.deepEqual(store.all('SELECT * FROM product ORDER BY id'), before);
});
