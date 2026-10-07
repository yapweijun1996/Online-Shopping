import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateStore, openDatabase } from '../src/db.js';
import { createCategory } from '../src/settings.js';
import { createProduct, getProduct, updateProduct } from '../src/products.js';

const base = { description: 'Soft cotton', category: 'WEAR', currency: 'MYR', active: true };
async function shop() {
  const store = await openDatabase(':memory:');
  await createCategory(store, { code: 'WEAR', label: 'Wear' });
  await createCategory(store, { code: 'HOME', label: 'Home' });
  return store;
}
const make = (store, sku, extra = {}) => createProduct(store, { ...base, sku, name: 'Tee', priceMinor: 1200, ...extra });
const listingsOf = (store) => store.all('SELECT * FROM listing ORDER BY code');

test('products of one variant group share one listing; an ungrouped product has its own', async () => {
  const store = await shop();
  try {
    const s = await make(store, 'TEE-S', { variantGroup: 'TEE', variantLabel: 'S' });
    const m = await make(store, 'TEE-M', { variantGroup: 'TEE', variantLabel: 'M', name: 'Ignored name' });
    const mug = await make(store, 'MUG', { name: 'Mug' });
    assert.equal(s.listingId, m.listingId);
    assert.notEqual(s.listingId, mug.listingId);
    assert.equal(m.name, 'Tee', 'a later variant takes the listing title');
    assert.equal((await listingsOf(store)).length, 2);
  } finally { await store.close(); }
});

test('editing the title, description or category of one variant updates the listing and every sibling', async () => {
  const store = await shop();
  try {
    const s = await make(store, 'TEE-S', { variantGroup: 'TEE', variantLabel: 'S' });
    const m = await make(store, 'TEE-M', { variantGroup: 'TEE', variantLabel: 'M' });
    await updateProduct(store, m.id, { name: 'Classic tee', description: 'Heavier cotton', category: 'HOME' });
    for (const id of [s.id, m.id]) {
      const product = await getProduct(store, id, true);
      assert.deepEqual([product.name, product.description, product.categoryCode], ['Classic tee', 'Heavier cotton', 'HOME']);
    }
    const [listing] = await listingsOf(store);
    assert.deepEqual([listing.name, listing.description, listing.category], ['Classic tee', 'Heavier cotton', 'HOME']);
    await updateProduct(store, s.id, { priceMinor: 1300 });
    assert.equal((await getProduct(store, m.id, true)).priceMinor, 1200, 'price stays per variant');
  } finally { await store.close(); }
});

test('moving a variant to another group or out of its group re-homes it and drops an empty listing', async () => {
  const store = await shop();
  try {
    const s = await make(store, 'TEE-S', { variantGroup: 'TEE', variantLabel: 'S' });
    const solo = await make(store, 'HAT-S', { name: 'Hat', variantGroup: 'HAT', variantLabel: 'S' });
    assert.equal((await listingsOf(store)).length, 2);
    await updateProduct(store, solo.id, { variantGroup: 'TEE', variantLabel: 'M' });
    const moved = await getProduct(store, solo.id, true);
    assert.equal(moved.listingId, s.listingId);
    assert.equal(moved.name, 'Tee', 'it takes the title of the listing it joins');
    assert.equal((await listingsOf(store)).length, 1, 'the emptied listing is removed');
    await updateProduct(store, solo.id, { variantGroup: '' });
    const left = await getProduct(store, solo.id, true);
    assert.notEqual(left.listingId, s.listingId);
    assert.equal(left.name, 'Tee');
    assert.equal((await listingsOf(store)).length, 2);
  } finally { await store.close(); }
});

test('schema 17 upgrades into listings: one per variant group and per ungrouped product, ids and orders untouched', async () => {
  const store = await shop();
  try {
    const s = await make(store, 'TEE', { variantGroup: 'TEE', variantLabel: 'S', name: 'Plain tee' });
    const m = await make(store, 'TEE-M', { variantGroup: 'TEE', variantLabel: 'M' });
    const mug = await make(store, 'MUG', { name: 'Mug' });
    const before = await store.all('SELECT id, sku, name, price_minor FROM product ORDER BY id');
    await store.exec('PRAGMA foreign_keys = OFF');
    await store.exec('UPDATE product SET listing_id = NULL; DELETE FROM listing');
    await store.exec('PRAGMA foreign_keys = ON');
    await store.setSchemaVersion(17);
    await migrateStore(store);
    assert.equal(await store.schemaVersion(), 19);
    assert.deepEqual(await store.all('SELECT id, sku, name, price_minor FROM product ORDER BY id'), before);
    const listings = await listingsOf(store);
    assert.equal(listings.length, 2);
    assert.equal((await getProduct(store, s.id, true)).listingId, (await getProduct(store, m.id, true)).listingId);
    assert.notEqual((await getProduct(store, mug.id, true)).listingId, (await getProduct(store, s.id, true)).listingId);
    assert.equal(listings.find((row) => row.code === 'TEE').name, 'Plain tee', 'the listing takes the text of the product named after the group');
    assert.equal(await store.get('SELECT COUNT(*) AS n FROM product WHERE listing_id IS NULL').then((row) => row.n), 0);
    await migrateStore(store);
    assert.equal((await listingsOf(store)).length, 2, 'running it again changes nothing');
  } finally { await store.close(); }
});
