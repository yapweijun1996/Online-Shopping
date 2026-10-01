import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createCategory } from '../src/settings.js';
import { setupShop } from '../src/shop-setup.js';

const username = 'product_owner';
const password = 'LocalProductPass123!';
const draft = {
  sku: 'item-1', name: 'Example item', description: 'Example description', category: 'EXAMPLE',
  priceMinor: 900, currency: 'MYR', active: false,
};

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'online-shopping-products-'));
  const config = { username, password, dbPath: path.join(directory, 'private.db'), production: false, publicOrigin: null };
  const app = createApp(config);
  createCategory(app.database, { code: 'EXAMPLE', label: 'Example category' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app, config, origin,
    async request(method, route, body, headers = {}) {
      const response = await fetch(`${origin}${route}`, {
        method, headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { response, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : null };
    },
    async login() {
      const { response, data } = await this.request('POST', '/api/v1/seller/session', { username, password });
      return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
    },
    async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('seller product writes are authorized and public reads reveal active products only', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('GET', '/api/v1/seller/products')).response.status, 401);
    assert.equal((await f.request('POST', '/api/v1/seller/products', draft)).response.status, 401);
    const { cookie, csrf } = await f.login();
    assert.equal((await f.request('POST', '/api/v1/seller/products', draft, { cookie })).response.status, 403);
    const headers = { cookie, 'x-csrf-token': csrf };
    const created = await f.request('POST', '/api/v1/seller/products', draft, headers);
    assert.equal(created.response.status, 201);
    assert.equal(created.data.sku, 'ITEM-1');
    assert.equal(created.data.active, false);
    assert.equal(created.data.priceMinor, 900);
    const id = created.data.id;
    assert.equal((await f.request('GET', `/api/v1/products/${id}`)).response.status, 404);
    assert.deepEqual((await f.request('GET', '/api/v1/products')).data.items, []);
    assert.equal((await f.request('GET', '/api/v1/seller/products', null, { cookie })).data.items.length, 1);
    const active = await f.request('PATCH', `/api/v1/seller/products/${id}`, { active: true, priceMinor: 1200 }, headers);
    assert.equal(active.response.status, 200);
    assert.equal(active.data.priceMinor, 1200);
    assert.equal((await f.request('GET', `/api/v1/products/${id}`)).data.priceMinor, 1200);
    assert.equal((await f.request('GET', '/api/v1/products?search=item&category=Example%20category')).data.items.length, 1);
    assert.equal((await f.request('GET', '/api/v1/products?category=Missing')).data.items.length, 0);
    assert.equal((await f.request('PATCH', `/api/v1/seller/products/${id}`, { active: false }, headers)).response.status, 200);
    assert.equal((await f.request('GET', `/api/v1/products/${id}`)).response.status, 404);
  } finally { await f.close(); }
});

test('product API rejects invalid writes and duplicate SKUs without changing the first product', async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await f.login();
    const headers = { cookie, 'x-csrf-token': csrf };
    const created = await f.request('POST', '/api/v1/seller/products', draft, headers);
    assert.equal(created.response.status, 201);
    const duplicate = await f.request('POST', '/api/v1/seller/products', { ...draft, sku: 'ITEM-1' }, headers);
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.data.error.code, 'DUPLICATE_SKU');
    const wrongCurrency = await f.request('POST', '/api/v1/seller/products', { ...draft, sku: 'item-2', currency: 'USD' }, headers);
    assert.equal(wrongCurrency.response.status, 400);
    assert.equal(wrongCurrency.data.error.field, 'currency');
    const invalidPrice = await f.request('PATCH', `/api/v1/seller/products/${created.data.id}`, { priceMinor: -1 }, headers);
    assert.equal(invalidPrice.response.status, 400);
    assert.equal(invalidPrice.data.error.field, 'priceMinor');
    assert.equal((await f.request('GET', '/api/v1/seller/products', null, { cookie })).data.items[0].priceMinor, 900);
  } finally { await f.close(); }
});

test('base64 images stay private until activation and can be removed', async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await f.login();
    const headers = { cookie, 'x-csrf-token': csrf };
    const bytes = readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url));
    const created = await f.request('POST', '/api/v1/seller/products', {
      ...draft, imageDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    }, headers);
    assert.equal(created.response.status, 201);
    const id = created.data.id;
    assert.equal((await f.request('GET', `/api/v1/products/${id}/image`)).response.status, 404);
    const sellerImage = await fetch(`${f.origin}/api/v1/seller/products/${id}/image`, { headers: { cookie } });
    assert.equal(sellerImage.status, 200);
    assert.equal(sellerImage.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await sellerImage.arrayBuffer()), bytes);
    await f.request('PATCH', `/api/v1/seller/products/${id}`, { active: true }, headers);
    const publicImage = await fetch(`${f.origin}/api/v1/products/${id}/image`);
    assert.equal(publicImage.status, 200);
    assert.equal(publicImage.headers.get('cache-control'), 'no-store');
    const listed = (await f.request('GET', '/api/v1/products')).data.items.find((item) => item.id === id);
    assert.match(listed.imageUrl, new RegExp(`^/api/v1/products/${id}/image\\?v=[0-9a-z]+$`));
    const versioned = await fetch(`${f.origin}${listed.imageUrl}`);
    assert.equal(versioned.status, 200);
    assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.deepEqual(Buffer.from(await versioned.arrayBuffer()), bytes);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await f.request('PATCH', `/api/v1/seller/products/${id}`, { name: 'Renamed product' }, headers);
    const renamed = (await f.request('GET', `/api/v1/products/${id}`)).data;
    assert.notEqual(renamed.imageUrl, listed.imageUrl);
    assert.equal((await fetch(`${f.origin}${listed.imageUrl}`)).headers.get('cache-control'), 'no-store');
    await f.request('PATCH', `/api/v1/seller/products/${id}`, { imageDataUrl: null }, headers);
    assert.equal((await f.request('GET', `/api/v1/products/${id}/image`)).response.status, 404);
  } finally { await f.close(); }
});

test('variant options remain separate SKUs and prices, with only active options public', async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await f.login();
    const headers = { cookie, 'x-csrf-token': csrf };
    const first = await f.request('POST', '/api/v1/seller/products', {
      ...draft, active: true, variantGroup: 'PET-BOWL', variantLabel: 'Small',
    }, headers);
    const second = await f.request('POST', '/api/v1/seller/products', {
      ...draft, sku: 'item-2', priceMinor: 1500, active: true,
      variantGroup: 'PET-BOWL', variantLabel: 'Large',
    }, headers);
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    const detail = await f.request('GET', `/api/v1/products/${first.data.id}`);
    assert.deepEqual(detail.data.variants.map(({ sku, priceMinor }) => [sku, priceMinor]),
      [['ITEM-2', 1500], ['ITEM-1', 900]]);
    assert.equal((await f.request('POST', '/api/v1/seller/products', {
      ...draft, sku: 'item-3', variantGroup: 'PET-BOWL', variantLabel: 'Small',
    }, headers)).data.error.code, 'DUPLICATE_VARIANT');
    assert.equal((await f.request('POST', '/api/v1/seller/products', {
      ...draft, sku: 'item-4', variantGroup: 'PET-BOWL', variantLabel: 'small',
    }, headers)).data.error.code, 'DUPLICATE_VARIANT');
    assert.equal((await f.request('PATCH', `/api/v1/seller/products/${second.data.id}`, {
      currency: 'SGD',
    }, headers)).response.status, 400);
    await f.request('PATCH', `/api/v1/seller/products/${second.data.id}`, { active: false }, headers);
    assert.deepEqual((await f.request('GET', `/api/v1/products/${first.data.id}`)).data.variants.map(({ sku }) => sku), ['ITEM-1']);
  } finally { await f.close(); }
});

test('seller-managed gallery is bounded, private while inactive, and removable', async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await f.login();
    const headers = { cookie, 'x-csrf-token': csrf };
    const bytes = readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url));
    const imageDataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    const created = await f.request('POST', '/api/v1/seller/products', { ...draft, imageDataUrl }, headers);
    const id = created.data.id;
    const added = await f.request('POST', `/api/v1/seller/products/${id}/gallery`, { imageDataUrl }, headers);
    assert.equal(added.response.status, 201);
    assert.equal(added.data.images.length, 2);
    const extra = added.data.images[1];
    assert.equal((await fetch(`${f.origin}${extra}`, { headers: { cookie } })).status, 200);
    assert.equal((await f.request('GET', `/api/v1/products/${id}`)).response.status, 404);
    const publicPath = extra.replace('/seller/', '/');
    assert.equal((await fetch(`${f.origin}${publicPath}`)).status, 404);
    assert.equal((await f.request('PATCH', `/api/v1/seller/products/${id}`, { imageDataUrl: null }, headers)).response.status, 400);
    await f.request('PATCH', `/api/v1/seller/products/${id}`, { active: true }, headers);
    const active = await f.request('GET', `/api/v1/products/${id}`);
    assert.equal(active.data.images.length, 2);
    assert.equal((await fetch(`${f.origin}${active.data.images[1]}`)).status, 200);
    const imageId = /\/gallery\/([0-9a-f-]{36})/.exec(extra)[1];
    const deleted = await f.request('DELETE', `/api/v1/seller/products/${id}/gallery/${imageId}`, null, headers);
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.data.images.length, 1);
    assert.equal((await fetch(`${f.origin}${publicPath}`)).status, 404);
    for (let index = 0; index < 9; index++) {
      const photo = await f.request('POST', `/api/v1/seller/products/${id}/gallery`, { imageDataUrl }, headers);
      assert.equal(photo.response.status, 201);
      assert.equal(photo.data.images.length, index + 2);
    }
    const overflow = await f.request('POST', `/api/v1/seller/products/${id}/gallery`, { imageDataUrl }, headers);
    assert.equal(overflow.response.status, 400);
    assert.equal((await f.request('GET', `/api/v1/products/${id}`)).data.images.length, 10);
  } finally { await f.close(); }
});

test('seller manages category codes, currency and public chat without rewriting existing products', async () => {
  const f = await fixture();
  try {
    setupShop(f.app.database, { mode: 'production', shopName: 'Example shop' });
    assert.equal((await f.request('GET', '/api/v1/seller/categories')).response.status, 401);
    const { cookie, csrf } = await f.login();
    const headers = { cookie, 'x-csrf-token': csrf };
    assert.equal((await f.request('POST', '/api/v1/seller/categories', { code: 'WORK', label: 'Work' }, { cookie })).response.status, 403);
    const category = await f.request('POST', '/api/v1/seller/categories', { code: 'WORK', label: 'Work' }, headers);
    assert.equal(category.response.status, 201);
    assert.equal((await f.request('POST', '/api/v1/seller/categories', { code: 'WORK', label: 'Work' }, headers)).response.status, 409);
    const initialSettings = await f.request('GET', '/api/v1/seller/company-settings', null, { cookie });
    assert.equal(initialSettings.data.defaultCurrency, 'MYR');
    assert.equal(initialSettings.data.mobileHideBarsOnScroll, false);
    assert.equal((await f.request('GET', '/api/v1/shop')).data.mobileHideBarsOnScroll, false);
    assert.equal((await f.request('PATCH', '/api/v1/seller/company-settings', { mobileHideBarsOnScroll: true }, { cookie })).response.status, 403);
    const enabled = await f.request('PATCH', '/api/v1/seller/company-settings', { mobileHideBarsOnScroll: true }, headers);
    assert.equal(enabled.data.mobileHideBarsOnScroll, true);
    assert.equal((await f.request('GET', '/api/v1/shop')).data.mobileHideBarsOnScroll, true);
    const invalidBars = await f.request('PATCH', '/api/v1/seller/company-settings', { mobileHideBarsOnScroll: 'false' }, headers);
    assert.equal(invalidBars.response.status, 400);
    assert.equal(invalidBars.data.error.field, 'mobileHideBarsOnScroll');
    assert.equal((await f.request('GET', '/api/v1/shop')).data.mobileHideBarsOnScroll, true);
    assert.equal((await f.request('PATCH', '/api/v1/seller/company-settings', { mobileHideBarsOnScroll: false }, headers)).data.mobileHideBarsOnScroll, false);
    assert.equal((await f.request('GET', '/api/v1/shop')).data.mobileHideBarsOnScroll, false);
    assert.equal((await f.request('GET', '/api/v1/shop')).data.sellerWhatsAppPhone, null);
    const settings = await f.request('PATCH', '/api/v1/seller/company-settings', { defaultCurrency: 'SGD' }, headers);
    assert.equal(settings.data.defaultCurrency, 'SGD');
    assert.equal(settings.data.sellerWhatsAppPhone, null);
    assert.equal((await f.request('GET', '/api/v1/shop')).data.currency, 'SGD');
    const contact = await f.request('PATCH', '/api/v1/seller/company-settings', { sellerWhatsAppPhone: '+60123456789' }, headers);
    assert.equal(contact.data.sellerWhatsAppPhone, '60123456789');
    assert.equal(contact.data.defaultCurrency, 'SGD');
    assert.equal((await f.request('GET', '/api/v1/shop')).data.sellerWhatsAppPhone, '60123456789');
    const invalidContact = await f.request('PATCH', '/api/v1/seller/company-settings', { sellerWhatsAppPhone: '+60123' }, headers);
    assert.equal(invalidContact.response.status, 400);
    assert.equal(invalidContact.data.error.field, 'sellerWhatsAppPhone');
    assert.equal((await f.request('GET', '/api/v1/shop')).data.sellerWhatsAppPhone, '60123456789');
    assert.equal((await f.request('PATCH', '/api/v1/seller/company-settings', { sellerWhatsAppPhone: '' }, headers)).data.sellerWhatsAppPhone, null);
    assert.equal((await f.request('GET', '/api/v1/shop')).data.sellerWhatsAppPhone, null);
    const myr = await f.request('POST', '/api/v1/seller/products', draft, headers);
    const sgd = await f.request('POST', '/api/v1/seller/products', { ...draft, sku: 'item-sgd', category: 'WORK', currency: 'SGD' }, headers);
    assert.equal(myr.response.status, 201);
    assert.equal(sgd.response.status, 201);
    assert.equal(myr.data.currency, 'MYR');
    assert.equal(sgd.data.currency, 'SGD');
    assert.equal(sgd.data.category, 'Work');
    assert.equal(sgd.data.categoryCode, 'WORK');
    assert.equal((await f.request('PATCH', '/api/v1/seller/categories/WORK', { label: 'Office', active: false }, headers)).data.active, false);
    assert.equal((await f.request('GET', `/api/v1/seller/products`, null, { cookie })).data.items.find((item) => item.id === sgd.data.id).category, 'Office');
    assert.equal((await f.request('PATCH', `/api/v1/seller/products/${sgd.data.id}`, { category: 'WORK', priceMinor: 1100 }, headers)).response.status, 200);
    const blocked = await f.request('POST', '/api/v1/seller/products', { ...draft, sku: 'item-next', category: 'WORK' }, headers);
    assert.equal(blocked.response.status, 400);
    assert.equal(blocked.data.error.field, 'category');
    assert.equal((await f.request('DELETE', '/api/v1/seller/categories/WORK', null, headers)).response.status, 404);
  } finally { await f.close(); }
});

test('schema version one upgrades without losing the provisioned seller', async () => {
  const f = await fixture();
  const config = f.config;
  const directory = path.dirname(config.dbPath);
  const { cookie } = await f.login();
  await f.app.close();
  const old = new DatabaseSync(config.dbPath);
  old.exec(`DROP TABLE product_gallery_image; DROP TABLE shop_setup; DROP TABLE rate_limit_attempt; DROP TABLE company_setting; DROP TABLE general_code;
    DROP TABLE checkout_idempotency; DROP TABLE order_event; DROP TABLE order_item;
    DROP TABLE delivery; DROP TABLE shop_order; DROP TABLE order_sequence;
    DROP TABLE product; PRAGMA user_version = 1`);
  old.close();
  const migrated = createApp(config);
  try {
    await new Promise((resolve) => migrated.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${migrated.server.address().port}`;
    assert.equal((await fetch(`${origin}/ready`)).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/seller/session`, { headers: { cookie } })).status, 200);
    assert.equal(migrated.database.schemaVersion(), SCHEMA_VERSION);
  } finally {
    await migrated.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
