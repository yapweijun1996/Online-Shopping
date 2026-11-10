import assert from 'node:assert/strict';
import test from 'node:test';
import { sellerFixture } from './helpers/seller-app.js';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { exportProductsCsv } from '../src/product-export.js';
import { createProduct, listProducts } from '../src/products.js';
import { createCategory } from '../src/settings.js';

async function catalogFixture() {
  const f = await sellerFixture();
  await createCategory(f.app.database, { code: 'OTHER', label: 'Other category' });
  const base = { description: 'Fictional catalog fixture', category: 'EXAMPLES', priceMinor: 500, active: true };
  const make = extra => createProduct(f.app.database, { ...base, ...extra });
  const inactive = await make({ sku: 'HIDDEN', name: 'Hidden product', active: false, stockQuantity: 0 });
  await make({ sku: 'MIX-A', name: 'Mixed product', variantGroup: 'MIXED', variantLabel: 'A', stockQuantity: 2 });
  await make({ sku: 'MIX-B', name: 'Mixed product', variantGroup: 'MIXED', variantLabel: 'B', active: false, stockQuantity: 0 });
  await make({ sku: 'OTHER', name: 'Other product', category: 'OTHER', stockQuantity: 0 });
  return { ...f, inactive, make };
}

test('seller catalog: active-first opt-in, disjoint listing counts, composed server filters, deterministic pagination and legacy compatibility', async () => {
  const f = await catalogFixture();
  try {
    const { headers } = await f.login();
    const list = async query => {
      const result = await f.request('GET', '/api/v1/seller/products?' + query, null, headers);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      return result.data;
    };
    const active = await list('includeInactive=false');
    assert.deepEqual(active.stats, { active: 3, inactive: 1, total: 4 });
    assert.equal(active.total, 3);
    assert.ok(active.items.every(item => item.activeCount > 0));
    assert.ok(!active.items.some(item => item.id === f.inactive.id));
    const all = await list('includeInactive=true');
    assert.equal(all.total, 4);
    assert.deepEqual((await list('')).items.map(item => item.id), all.items.map(item => item.id), 'legacy omitted parameter keeps all listings');
    const inactiveTab = await list('catalogStatus=inactive');
    assert.equal(inactiveTab.total, 1, 'new tabs partition listings; mixed listing belongs to Active');
    assert.equal((await list('catalogStatus=active')).total + inactiveTab.total, (await list('catalogStatus=all')).total);
    assert.equal((await list('catalogStatus=inactive&search=HIDDEN&category=Examples&stock=out-of-stock&limit=1')).items[0].id, f.inactive.id);
    assert.equal((await list('status=inactive')).total, 2, 'legacy inactive still includes mixed listings');
    assert.equal((await list('includeInactive=false&search=hidden')).total, 0);
    assert.equal((await list('includeInactive=true&search=hidden')).items[0].id, f.inactive.id);
    assert.equal((await list('includeInactive=false&search=MIX-B')).items[0].variantCount, 2, 'inactive SKU still locates its active mixed listing');
    const filtered = await list('includeInactive=true&category=Examples&stock=out-of-stock&sort=name');
    assert.deepEqual(filtered.items.map(item => item.sku), ['HIDDEN']);
    assert.equal((await list('includeInactive=false&stock=unlimited')).items[0].id, f.product.id);
    const first = await list('includeInactive=true&sort=name&limit=2');
    const second = await list('includeInactive=true&sort=name&limit=2&offset=2');
    assert.equal(first.nextOffset, 2); assert.equal(second.nextOffset, null);
    assert.deepEqual([...first.items, ...second.items].map(item => item.name), ['Example item', 'Hidden product', 'Mixed product', 'Other product']);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 4);
    for (const query of ['catalogStatus=unknown', 'catalogStatus=inactive&includeInactive=true', 'catalogStatus=active&status=inactive', 'includeInactive=1', 'includeInactive=false&status=inactive', 'stock=unknown', 'sort=sql', 'limit=101']) {
      assert.equal((await f.request('GET', '/api/v1/seller/products?' + query, null, headers)).response.status, 400, query);
      if (!query.startsWith('limit')) assert.equal((await f.request('GET', '/api/v1/seller/products/export.csv?' + query, null, headers)).response.status, 400, query);
    }
    assert.equal((await f.request('GET', '/api/v1/seller/products?includeInactive=true')).response.status, 401);
    assert.equal(Number((await f.app.database.get('SELECT active FROM product WHERE id = ?', f.inactive.id)).active), 0, 'visibility reads never activate a product');
    const shopper = await f.request('GET', '/api/v1/products?includeInactive=true');
    assert.ok(!shopper.data.items.some(item => item.id === f.inactive.id), 'seller filter cannot expand shopper visibility');
  } finally { await f.close(); }
});

test('seller CSV follows listing search/category/stock/sort and active visibility, including mixed variants', async () => {
  const f = await catalogFixture();
  try {
    const { headers } = await f.login();
    const csv = async query => {
      const result = await f.request('GET', '/api/v1/seller/products/export.csv?' + query, null, headers);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      return result.data.replace(/^\uFEFF/, '').trim().split('\r\n').slice(1).map(line => line.split(',')[0]);
    };
    assert.deepEqual(await csv('catalogStatus=inactive&category=Examples&stock=out-of-stock&search=Hidden&limit=1&offset=100'), ['HIDDEN'], 'filtered export ignores pagination');
    assert.deepEqual(await csv('catalogStatus=active&search=MIX-B'), ['MIX-A']);
    assert.deepEqual(await csv('catalogStatus=inactive&search=MIX-B'), [], 'mixed listing is not in Inactive');
    assert.deepEqual(await csv('catalogStatus=all&search=MIX-B'), ['MIX-A', 'MIX-B']);
    assert.deepEqual(await csv('includeInactive=false&search=MIX-B'), ['MIX-A'], 'active-first exports only active variants of the matching listing');
    assert.deepEqual(await csv('includeInactive=true&search=MIX-B'), ['MIX-A', 'MIX-B'], 'show-inactive exports every variant of the matching listing');
    assert.deepEqual(await csv('search=MIX-B'), ['MIX-B'], 'legacy direct CSV search retains variant-level matching');
    assert.deepEqual(await csv('includeInactive=true&category=Examples&stock=out-of-stock&sort=name'), ['HIDDEN']);
    assert.deepEqual(await csv('includeInactive=false&search=hidden'), []);
    assert.deepEqual(await csv('includeInactive=true&sort=name'), ['SELLER-ITEM', 'HIDDEN', 'MIX-A', 'MIX-B', 'OTHER']);
  } finally { await f.close(); }
});

for (const dialect of ['sqlite', 'postgres']) test(`${dialect}: seller list and CSV share category/stock/status/sort and stable listing pagination`,
  { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async t => {
    const f = await inventoryFixture(t, dialect);
    const base = { name: 'A mixed listing', variantGroup: 'PAIR' };
    await f.product({ ...base, sku: 'PAIR-A', variantLabel: 'A', stockQuantity: 2, priceMinor: 800 });
    await f.product({ ...base, sku: 'PAIR-B', variantLabel: 'B', stockQuantity: 0, active: false, priceMinor: 300 });
    await f.product({ sku: 'OFF', name: 'Z hidden listing', active: false, stockQuantity: 0, priceMinor: 100 });
    const get = query => listProducts(f.store, new URLSearchParams(query), true);
    const first = await get('includeInactive=false&limit=1&sort=price_asc');
    assert.deepEqual(first.stats, { active: 1, inactive: 1, total: 2 });
    assert.equal(first.total, 1); assert.equal(first.nextOffset, null);
    assert.equal(first.items[0].variantCount, 2);
    assert.deepEqual([first.items[0].activeCount, first.items[0].stockTotal, first.items[0].priceFromMinor], [1, 2, 300]);
    const all = await get('includeInactive=true&category=Synthetic&sort=price_asc&limit=1');
    assert.equal(all.items[0].sku, 'OFF'); assert.equal(all.nextOffset, 1);
    const next = await get('includeInactive=true&category=Synthetic&sort=price_asc&limit=1&offset=1');
    assert.equal(next.items[0].variantGroup, 'PAIR'); assert.equal(next.nextOffset, null);
    assert.equal((await get('includeInactive=true&stock=out-of-stock')).items[0].sku, 'OFF');
    const csv = query => exportProductsCsv(f.store, new URLSearchParams(query));
    assert.match(await csv('includeInactive=false&search=PAIR-B'), /PAIR-A/);
    assert.doesNotMatch(await csv('includeInactive=false&search=PAIR-B'), /PAIR-B/);
    assert.match(await csv('includeInactive=true&search=PAIR-B'), /PAIR-B/);
    const ordered = await csv('includeInactive=true&sort=price_desc');
    assert.ok(ordered.indexOf('PAIR-A') < ordered.indexOf('OFF'), 'CSV uses the same listing price sort as the list');
    const filtered = await csv('includeInactive=true&category=Synthetic&stock=out-of-stock');
    assert.match(filtered, /OFF/); assert.doesNotMatch(filtered, /PAIR-A/);
  });
