import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';

const username = 'product_owner';
const password = 'LocalProductPass123!';
const draft = {
  sku: 'item-1', name: 'Example item', description: 'Example description', category: 'Example category',
  priceMinor: 900, currency: 'MYR', active: false,
};

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'online-shopping-products-'));
  const config = { username, password, dbPath: path.join(directory, 'private.db'), production: false, publicOrigin: null };
  const app = createApp(config);
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
    const wrongCurrency = await f.request('POST', '/api/v1/seller/products', { ...draft, sku: 'item-2', currency: 'SGD' }, headers);
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

test('schema version one upgrades without losing the provisioned seller', async () => {
  const f = await fixture();
  const config = f.config;
  const directory = path.dirname(config.dbPath);
  const { cookie } = await f.login();
  await f.app.close();
  const old = new DatabaseSync(config.dbPath);
  old.exec(`DROP TABLE checkout_idempotency; DROP TABLE order_event; DROP TABLE order_item;
    DROP TABLE delivery; DROP TABLE shop_order; DROP TABLE order_sequence;
    DROP TABLE product; PRAGMA user_version = 1`);
  old.close();
  const migrated = createApp(config);
  try {
    await new Promise((resolve) => migrated.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${migrated.server.address().port}`;
    assert.equal((await fetch(`${origin}/ready`)).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/seller/session`, { headers: { cookie } })).status, 200);
    assert.equal(migrated.database.schemaVersion(), 3);
  } finally {
    await migrated.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
