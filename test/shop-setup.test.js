import { revertTenantSchema } from './helpers/schema13.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, migrateStore } from '../src/db.js';
import { getShopSetup, setupShop } from '../src/shop-setup.js';
import { createProduct, listProducts } from '../src/products.js';
import { createCategory, getCompanySettings, updateCompanySettings } from '../src/settings.js';
import { createApi } from '../src/app.js';
import { createSession } from '../src/auth.js';

function fixture(t) {
  const store = openDatabase(':memory:');
  t.after(() => store.close());
  return store;
}

test('demo seeds all 35 images and prices once, preserving subsequent edits', (t) => {
  const store = fixture(t);
  assert.equal(getShopSetup(store).mode, null);
  assert.equal(setupShop(store, { mode: 'demo' }).shopName, 'Demo General Store');
  const products = listProducts(store, new URLSearchParams('limit=100')).items;
  assert.equal(products.length, 35);
  assert.equal(new Set(products.map((p) => p.sku)).size, 35);
  assert.ok(products.every((p) => p.currency === 'MYR' && p.imageUrl));
  assert.equal(products.find((p) => p.sku === 'DEMO-001').priceMinor, 2490);
  assert.equal(products.find((p) => p.sku === 'DEMO-010').priceMinor, 2690);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM general_code').n, 7);
  assert.equal(store.get('SELECT seller_whatsapp_phone FROM company_setting').seller_whatsapp_phone, null);
  store.run("UPDATE product SET name = 'Seller edit', active = 0 WHERE sku = 'DEMO-001'");
  store.run('UPDATE company_setting SET seller_whatsapp_phone = NULL');
  setupShop(store, { mode: 'demo' });
  assert.equal(store.get("SELECT name FROM product WHERE sku = 'DEMO-001'").name, 'Seller edit');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM product').n, 35);
  assert.equal(store.get('SELECT seller_whatsapp_phone FROM company_setting').seller_whatsapp_phone, null);
  assert.throws(() => setupShop(store, { mode: 'production', shopName: 'Live' }), { code: 'SHOP_ALREADY_CONFIGURED' });
});

test('production seeds nothing and supports manual catalog creation', (t) => {
  const store = fixture(t);
  assert.throws(() => setupShop(store, { mode: 'invalid' }));
  assert.throws(() => setupShop(store, { mode: 'production', shopName: ' ' }));
  assert.deepEqual(setupShop(store, { mode: 'production', shopName: 'My Pet Store' }), { mode: 'production', shopName: 'My Pet Store' });
  assert.equal(store.get('SELECT COUNT(*) AS n FROM product').n, 0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM general_code').n, 0);
  createCategory(store, { code: 'FOOD', label: 'Food' });
  createProduct(store, { sku: 'FOOD-1', name: 'Cat food', description: 'Food', category: 'FOOD', priceMinor: 100, currency: 'MYR', active: true });
  assert.equal(listProducts(store, new URLSearchParams()).items.length, 1);
  assert.throws(() => setupShop(store, { mode: 'demo' }), { code: 'SHOP_ALREADY_CONFIGURED' });
});

test('demo refuses existing data and rolls back the entire seed on failure', (t) => {
  const store = fixture(t);
  createCategory(store, { code: 'KEEP', label: 'Keep' });
  assert.throws(() => setupShop(store, { mode: 'demo' }), { code: 'SHOP_NOT_EMPTY' });
  assert.equal(getShopSetup(store).mode, null);
  store.run('DELETE FROM general_code');
  const failingStore = { ...store, run(sql, ...params) {
    if (params.includes('DEMO-020')) throw new Error('Injected failure');
    return store.run(sql, ...params);
  } };
  assert.throws(() => setupShop(failingStore, { mode: 'demo' }), /Injected failure/);
  assert.equal(getShopSetup(store).mode, null);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM product').n, 0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM general_code').n, 0);
});

test('Demo setup establishes MYR before seeding and rolls back settings on failure', async t => {
  const store = fixture(t);
  const api = createApi({ store, config: { publicOrigin: 'https://fixture.test' } });
  const session = createSession(store);
  const call = (path, body) => api(new Request('https://fixture.test/api/v1/seller/' + path, {
    method: path === 'company-settings' ? 'PATCH' : 'POST',
    headers: { origin: 'https://fixture.test', 'content-type': 'application/json',
      cookie: `seller_session=${session.token}`, 'x-csrf-token': session.csrfToken },
    body: JSON.stringify(body),
  }));
  assert.equal((await call('company-settings', { defaultCurrency: 'SGD' })).status, 200);
  const before = store.all('SELECT * FROM company_setting');
  const failingStore = { ...store, run(sql, ...params) {
    if (params.includes('DEMO-020')) throw new Error('Injected seed failure');
    return store.run(sql, ...params);
  } };
  assert.throws(() => setupShop(failingStore, { mode: 'demo' }), /Injected seed failure/);
  assert.deepEqual(store.all('SELECT * FROM company_setting'), before);
  assert.equal(getShopSetup(store).mode, null);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM product').n, 0);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM general_code').n, 0);
  const configured = await call('setup', { mode: 'demo' });
  assert.equal(configured.status, 200);
  assert.equal(getCompanySettings(store).defaultCurrency, 'MYR');
  const products = listProducts(store, new URLSearchParams('limit=100')).items;
  assert.equal(products.length, 35);
  assert.ok(products.every(product => product.currency === 'MYR'));
});

test('existing version 6 catalogs migrate to production without altering products', (t) => {
  const store = fixture(t);
  setupShop(store, { mode: 'demo' });
  revertTenantSchema(store);
  store.exec(`DROP TABLE product_gallery_image;
    DROP INDEX product_variant_option; DROP INDEX product_variant_group;
    ALTER TABLE product DROP COLUMN stock_quantity;
    ALTER TABLE product DROP COLUMN variant_group; ALTER TABLE product DROP COLUMN variant_label;
    ALTER TABLE company_setting DROP COLUMN seller_whatsapp_phone;
    ALTER TABLE company_setting DROP COLUMN mobile_hide_bars_on_scroll;
    DROP TABLE shop_setup`);
  store.setSchemaVersion(6);
  migrateStore(store);
  assert.equal(getShopSetup(store).mode, 'production');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM product').n, 35);
  assert.equal(store.get('SELECT seller_whatsapp_phone FROM company_setting').seller_whatsapp_phone, null);
});

test('version 8 Demo migration never seeds a real contact, then preserves seller changes', (t) => {
  const store = fixture(t);
  setupShop(store, { mode: 'demo' });
  revertTenantSchema(store);
  store.exec('ALTER TABLE product DROP COLUMN stock_quantity');
  store.exec('ALTER TABLE company_setting DROP COLUMN seller_whatsapp_phone');
  store.exec('ALTER TABLE company_setting DROP COLUMN mobile_hide_bars_on_scroll');
  store.setSchemaVersion(8);
  migrateStore(store);
  assert.equal(store.get('SELECT seller_whatsapp_phone FROM company_setting').seller_whatsapp_phone, null);
  store.run('UPDATE company_setting SET seller_whatsapp_phone = NULL');
  migrateStore(store);
  assert.equal(store.get('SELECT seller_whatsapp_phone FROM company_setting').seller_whatsapp_phone, null);
});

test('version 9 migration defaults existing shops to always-visible mobile bars', (t) => {
  const store = fixture(t);
  revertTenantSchema(store);
  store.exec('ALTER TABLE product DROP COLUMN stock_quantity');
  store.exec('ALTER TABLE company_setting DROP COLUMN mobile_hide_bars_on_scroll');
  store.setSchemaVersion(9);
  migrateStore(store);
  assert.equal(store.get('SELECT mobile_hide_bars_on_scroll FROM company_setting').mobile_hide_bars_on_scroll, 0);
});

test('setup API enforces session, origin and CSRF; public catalog exposes demo images', async (t) => {
  const store = fixture(t);
  const api = createApi({ store, config: { publicOrigin: 'http://localhost' } });
  const call = (path, options = {}) => api(new Request(`http://localhost${path}`, options), { clientAddress: '127.0.0.1' });
  const body = JSON.stringify({ mode: 'demo' });
  assert.equal((await call('/api/v1/seller/setup', { method: 'POST', body })).status, 401);
  const session = createSession(store);
  const headers = { cookie: `seller_session=${session.token}`, origin: 'http://localhost', 'content-type': 'application/json' };
  assert.equal((await call('/api/v1/seller/setup', { method: 'POST', headers, body })).status, 403);
  headers['x-csrf-token'] = session.csrfToken;
  assert.equal((await call('/api/v1/seller/setup', { method: 'POST', headers: { ...headers, origin: 'http://evil.invalid' }, body })).status, 403);
  assert.equal((await call('/api/v1/seller/setup', { method: 'POST', headers, body })).status, 200);
  const publicShop = await (await call('/api/v1/shop')).json();
  assert.equal(publicShop.mode, 'demo');
  assert.equal(publicShop.currency, 'MYR');
  assert.equal(publicShop.sellerWhatsAppPhone, null);
  assert.equal(publicShop.mobileHideBarsOnScroll, false);
  const page = await (await call('/api/v1/products?limit=100')).json();
  assert.equal(page.items.length, 35);
  const image = await call(page.items[0].imageUrl);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
});

test('demo orders ignore supplied personal data and never grant contact permission', async (t) => {
  const { createOrder } = await import('../src/orders.js');
  const { getSellerOrder, decideSellerOrder } = await import('../src/seller-orders.js');
  const store = fixture(t);
  setupShop(store, { mode: 'demo' });
  const product = listProducts(store, new URLSearchParams()).items[0];
  const input = { buyer: { fullName: 'Must not store', whatsappPhone: '+60123456789', email: 'private@example.test' },
    whatsappOrderContactOptIn: true, deliveries: [{ recipient: { fullName: 'Private Recipient' },
      address: { line1: 'Private address' }, items: [{ productId: product.id, quantity: 2,
        expectedPriceMinor: product.priceMinor, expectedCurrency: 'MYR' }] }] };
  const result = createOrder(store, 'demo-order-test-key-001', input);
  assert.match(result.receipt.orderNo, /^DEMO-/);
  assert.equal(result.receipt.simulation, true);
  assert.equal(result.receipt.totalMinor, product.priceMinor * 2);
  assert.equal(createOrder(store, 'demo-order-test-key-001', input).replayed, true);
  assert.deepEqual(createOrder(store, 'demo-order-test-key-001', input).receipt, result.receipt);
  const id = store.get('SELECT id FROM shop_order').id;
  const detail = getSellerOrder(store, id);
  assert.equal(detail.buyer.fullName, 'Demo Customer');
  assert.equal(detail.buyer.whatsappPhone, 'DEMO-NO-CONTACT');
  assert.equal(detail.buyer.email, null);
  assert.equal(detail.buyer.whatsappOrderContactOptIn, false);
  assert.equal(detail.buyer.whatsappConsentAt, null);
  assert.equal(detail.buyer.whatsappConsentVersion, null);
  assert.equal(detail.deliveries[0].recipient.phone, 'DEMO-NO-CONTACT');
  assert.match(detail.deliveries[0].address.line1, /no delivery/);
  assert.equal(detail.simulation, true);
  assert.equal(decideSellerOrder(store, id, 'confirm', { expectedRevision: 1 }, 'tester').status, 'CONFIRMED');
  const changed = structuredClone(input);
  changed.deliveries[0].items[0].expectedPriceMinor++;
  assert.throws(() => createOrder(store, 'demo-price-change-001', changed), { code: 'PRICE_CHANGED' });
  changed.deliveries[0].items[0].quantity = 0;
  assert.throws(() => createOrder(store, 'demo-invalid-count-001', changed));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM shop_order').n, 1);
});

test('production does not inherit Demo chat or accept simulation as a client-selected bypass', async (t) => {
  const { createOrder } = await import('../src/orders.js');
  const store = fixture(t);
  setupShop(store, { mode: 'production', shopName: 'Real shop' });
  const api = createApi({ store, config: { publicOrigin: 'http://localhost' } });
  const publicShop = await (await api(new Request('http://localhost/api/v1/shop'), { clientAddress: '127.0.0.1' })).json();
  assert.equal(publicShop.sellerWhatsAppPhone, null);
  assert.throws(() => createOrder(store, 'production-bypass-001', { simulation: true, deliveries: [] }));
  assert.equal(store.get('SELECT COUNT(*) AS n FROM shop_order').n, 0);
});

test('deployment demo initializes once; object routing isolates legacy data', async (t) => {
  const { initializeShop, shopObjectName } = await import('../src/shop-setup.js');
  const { readShopMode } = await import('../src/config.js');
  const store = fixture(t);
  initializeShop(store, { shopMode: 'manual' });
  assert.equal(getShopSetup(store).mode, null);
  initializeShop(store, { shopMode: 'demo' });
  store.run("UPDATE product SET name = 'Preserved edit' WHERE sku = 'DEMO-001'");
  initializeShop(store, { shopMode: 'demo' });
  assert.equal(store.get('SELECT COUNT(*) AS n FROM product').n, 35);
  assert.equal(store.get("SELECT name FROM product WHERE sku = 'DEMO-001'").name, 'Preserved edit');
  assert.notEqual(shopObjectName('demo'), shopObjectName('manual'));
  assert.equal(shopObjectName('manual'), 'shop');
  assert.equal(readShopMode({}), 'manual');
  assert.equal(readShopMode({ SHOP_MODE: 'demo' }), 'demo');
  for (const mode of ['', true, 'production', 'Demo']) assert.throws(() => readShopMode({ SHOP_MODE: mode }));
  assert.throws(() => shopObjectName('invalid'));
});
