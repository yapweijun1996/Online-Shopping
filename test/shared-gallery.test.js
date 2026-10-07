import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { migrateStore, openDatabase } from '../src/db.js';
import { createCategory } from '../src/settings.js';
import { addGalleryImage, createProduct, getGalleryImage, getProduct, updateProduct } from '../src/products.js';

const png = readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url));
const photo = (label) => 'data:image/png;base64,' + Buffer.concat([png, Buffer.from(label)]).toString('base64');
const base = { description: 'Soft', category: 'WEAR', currency: 'MYR', active: true, priceMinor: 1200 };

async function shop() {
  const store = await openDatabase(':memory:');
  await createCategory(store, { code: 'WEAR', label: 'Wear' });
  return store;
}
const make = (store, sku, image, extra = {}) => createProduct(store, { ...base, sku, name: 'Tee', imageDataUrl: photo(image), variantGroup: 'TEE', variantLabel: sku, ...extra });
const bytes = async (store, id) => (await store.get('SELECT image_data AS data FROM product WHERE id = ?', id)).data;
const sharedIds = (product) => product.galleryItems.filter((item) => item.shared).map((item) => item.id);

test('a listing shares one gallery; colours show their own photo first without touching it', async () => {
  const store = await shop();
  try {
    const white = await make(store, 'TEE-WHITE', 'white');
    await addGalleryImage(store, white.id, photo('front'));
    await addGalleryImage(store, white.id, photo('back'));
    const black = await make(store, 'TEE-BLACK', 'black');
    const white2 = await getProduct(store, white.id, true);
    const black2 = await getProduct(store, black.id, true);
    assert.equal(black2.galleryShared, true);
    assert.equal(black2.galleryItems[0].id, 'main', 'the colour photo comes first');
    assert.deepEqual(sharedIds(black2), sharedIds(white2), 'both show the same shared photos');
    assert.equal(sharedIds(white2).length, 3, 'white main moved into the shared gallery as an upload, plus front and back');
    assert.equal(white2.galleryItems.filter((item) => item.id === 'main').length, 0, 'no duplicate of a photo already shared');
    // A colour with the same photo as the holder adds nothing of its own.
    const twin = await make(store, 'TEE-WHITE2', 'white');
    assert.deepEqual((await getProduct(store, twin.id, true)).galleryItems.map((item) => item.id), sharedIds(white2));
  } finally { await store.close(); }
});

test('replacing a colour photo, even the holder\'s, never changes the shared gallery or another colour', async () => {
  const store = await shop();
  try {
    const white = await make(store, 'TEE-WHITE', 'white');
    const black = await make(store, 'TEE-BLACK', 'black');
    const before = await getProduct(store, white.id, true);
    const shared = sharedIds(before);
    const sharedBytes = await store.all('SELECT id, data FROM product_gallery_image ORDER BY id');
    const blackBefore = await bytes(store, black.id);
    await updateProduct(store, white.id, { imageDataUrl: photo('new white') });
    assert.deepEqual(sharedIds(await getProduct(store, white.id, true)), shared);
    assert.deepEqual(await store.all('SELECT id, data FROM product_gallery_image ORDER BY id'), sharedBytes, 'shared photo bytes are unchanged');
    assert.deepEqual(await bytes(store, black.id), blackBefore);
    assert.equal((await getProduct(store, white.id, true)).galleryItems[0].id, 'main', 'the new white photo is shown first on white');
    await updateProduct(store, black.id, { imageDataUrl: photo('new black') });
    assert.deepEqual(sharedIds(await getProduct(store, black.id, true)), shared);
  } finally { await store.close(); }
});

test('only the holder edits the shared gallery; a gallery sent with a variant edit is ignored', async () => {
  const store = await shop();
  try {
    const white = await make(store, 'TEE-WHITE', 'white');
    const black = await make(store, 'TEE-BLACK', 'black');
    await assert.rejects(addGalleryImage(store, black.id, photo('x')), (error) => error.code === 'GALLERY_SHARED');
    const detail = await getProduct(store, black.id, true);
    const saved = await updateProduct(store, black.id, { gallery: [], expectedUpdatedAt: detail.updatedAt, name: 'Tee renamed' });
    assert.equal(saved.name, 'Tee renamed');
    assert.deepEqual(sharedIds(saved), sharedIds(await getProduct(store, white.id, true)), 'the shared gallery survived');
    await addGalleryImage(store, white.id, photo('front'));
    assert.equal(sharedIds(await getProduct(store, black.id, true)).length, 2, 'the holder adds a photo for every colour');
    const holder = await getProduct(store, white.id, true);
    const kept = await updateProduct(store, white.id, { gallery: holder.galleryItems.map((item) => ({ id: item.id })).reverse(), expectedUpdatedAt: holder.updatedAt });
    assert.equal(kept.galleryItems.filter((item) => item.id === 'main').length, 0, 'a main photo is never put back into the shared gallery');
  } finally { await store.close(); }
});

test('shared photos stay public while any colour is on sale, even when the holder is off', async () => {
  const store = await shop();
  try {
    const white = await make(store, 'TEE-WHITE', 'white');
    const black = await make(store, 'TEE-BLACK', 'black');
    const shared = sharedIds(await getProduct(store, white.id, true))[0];
    await updateProduct(store, white.id, { active: false });
    assert.ok(await getGalleryImage(store, white.id, shared, false), 'black is still on sale');
    await updateProduct(store, black.id, { active: false });
    assert.ok(!await getGalleryImage(store, white.id, shared, false), 'nothing on sale: private again');
  } finally { await store.close(); }
});

test('schema 18 upgrades to a shared gallery: copies are removed, colour photos and unrelated products stay', async () => {
  const store = await shop();
  try {
    const white = await make(store, 'TEE-WHITE', 'white');
    const black = await make(store, 'TEE-BLACK', 'black');
    const mug = await createProduct(store, { ...base, sku: 'MUG', name: 'Mug', imageDataUrl: photo('mug') });
    // The schema 18 shape: every colour carries its own copy of the extra photos, and the main photo is in its layout.
    const extra = Buffer.concat([png, Buffer.from('extra')]);
    await store.run('DELETE FROM product_gallery_image');
    for (const [index, product] of [white, black].entries()) {
      await store.run('INSERT INTO product_gallery_image(id, product_id, position, mime, data, created_at) VALUES (?, ?, 1, ?, ?, ?)',
        `copy-${index}`, product.id, 'image/png', extra, new Date().toISOString());
      await store.run('UPDATE product SET gallery_layout_json = ? WHERE id = ?', JSON.stringify(['main', `copy-${index}`]), product.id);
    }
    await store.run('UPDATE product SET gallery_layout_json = ? WHERE id = ?', JSON.stringify(['main', 'copy-0']), white.id);
    const blackMain = await bytes(store, black.id);
    await store.setSchemaVersion(18);
    await migrateStore(store);
    assert.equal(await store.schemaVersion(), 19);
    assert.equal((await store.all('SELECT id FROM product_gallery_image WHERE product_id = ?', black.id)).length, 0, 'the copy on the other colour is gone');
    assert.equal((await store.get('SELECT gallery_layout_json AS layout FROM product WHERE id = ?', black.id)).layout, null);
    assert.deepEqual(await bytes(store, black.id), blackMain);
    const holder = await getProduct(store, white.id, true);
    assert.equal(sharedIds(holder).length, 2, 'extra photo plus the white main moved into the gallery');
    assert.equal(sharedIds(await getProduct(store, black.id, true)).length, 2);
    assert.equal((await getProduct(store, mug.id, true)).galleryItems.length, 1, 'a product without variants is unchanged');
    await migrateStore(store);
  } finally { await store.close(); }
});
