import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { setupShop } from '../src/shop-setup.js';
import { createProduct, getProduct, listProducts } from '../src/products.js';
import { replaceCatalog } from '../scripts/replace-catalog.mjs';
import catalog from '../src/public-demo-catalog.json' with { type: 'json' };

async function fixture(t) {
  const store = await openDatabase(':memory:'); t.after(async () => await store.close());
  await setupShop(store, { mode: 'production', shopName: 'Synthetic shop' });
  await store.run("INSERT INTO general_code(type, code, label, active, created_at, updated_at) VALUES ('PRODUCT_CATEGORY', 'Home', 'Home', 1, 'x', 'x')");
  const png = catalog[0].imageDataUrl;
  await createProduct(store, { sku: 'DEMO-001', name: 'Old Bottle', description: 'old', category: 'Home', priceMinor: 100, currency: 'MYR', active: true, imageDataUrl: png });
  return store;
}

test('replaces the catalog, archives old products, adds gallery layouts and is idempotent', async t => {
  const store = await fixture(t);
  const first = await replaceCatalog(store);
  assert.deepEqual(first, { archived: 1, imported: 35, skipped: 0, categories: 6 });
  assert.equal((await store.get("SELECT active, sku FROM product WHERE sku = 'OLD-DEMO-001'")).active, 0);
  const lamp = await store.get("SELECT gallery_layout_json FROM product WHERE sku = 'DEMO-001'");
  assert.deepEqual(JSON.parse(lamp.gallery_layout_json), ['main', ...[1, 2, 3, 4, 5].map(n => `static:DEMO-001:${n}`)]);
  const items = (await listProducts(store, new URLSearchParams('limit=100'))).items;
  assert.equal(items.length, 35);
  assert.ok(items.every(item => item.name !== 'Old Bottle'));
  const detail = await getProduct(store, items.find(item => item.sku === 'DEMO-001').id, false, 'manual');
  assert.equal(detail.images.length, 6);
  assert.match(detail.images[1], /^\/demo-assets\/DEMO-001\//);
  const second = await replaceCatalog(store);
  assert.deepEqual(second, { archived: 0, imported: 0, skipped: 35, categories: 0 });
});

test('refuses to run when orders exist', async t => {
  const store = await fixture(t);
  const original = store.get.bind(store);
  const guarded = { ...store, get: (sql, ...p) => /COUNT\(\*\) AS n FROM shop_order/.test(sql) ? { n: 3 } : original(sql, ...p) };
  await assert.rejects(() => replaceCatalog(guarded), /orders exist/);
});
