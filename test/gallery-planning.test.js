import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { createCategory } from '../src/settings.js';
import { addGalleryImage, createProduct, getProduct, planGalleryImageAddition, updateProduct } from '../src/products.js';
import { planProductGallery, prepareGalleryUploadEntry, requireMainImageRemoval } from '../src/product-gallery.js';
import { rowsDigest } from '../src/sqlite-import.js';
import { importProducts } from '../src/product-import.js';
import demo from '../src/public-demo-catalog.json' with { type: 'json' };

const png = readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url));
const bytes = label => Buffer.concat([png, Buffer.from(label)]);
const photo = label => 'data:image/png;base64,' + bytes(label).toString('base64');
const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, dialect) {
  const f = await reviewFixture(t, dialect);
  await createCategory(f.store, { code: 'SYNTHETIC', label: 'Synthetic' });
  const make = (sku, image = 'main', extra = {}) => createProduct(f.store, { sku, name: 'Synthetic gallery', description: 'Synthetic description', category: 'SYNTHETIC',
    priceMinor: 1250, active: true, imageDataUrl: image === null ? null : photo(image), ...extra });
  return { ...f, make };
}
function selectOnly(store) {
  let count = 0;
  const query = sql => { assert.match(sql, /^\s*SELECT\b/i); assert.equal(sql.includes(';'), false); count++; return sql; };
  return { read: { dialect: store.dialect, get: (sql, ...args) => store.get(query(sql), ...args), all: (sql, ...args) => store.all(query(sql), ...args) },
    assertRead: () => assert.ok(count > 0) };
}
async function state(store) {
  return Promise.all(['product', 'listing', 'product_gallery_image', 'product_event'].map(async table => rowsDigest(await store.all('SELECT * FROM ' + table + ' ORDER BY id'))));
}
async function actualSelection(store, productId) {
  const p = await store.get('SELECT image_data, gallery_layout_json FROM product WHERE id = ?', productId);
  const images = new Map((await store.all('SELECT id, data FROM product_gallery_image WHERE product_id = ?', productId)).map(row => [row.id, row.data]));
  return JSON.parse(p.gallery_layout_json).map(id => id === 'main' ? digest(p.image_data) : images.has(id) ? digest(images.get(id)) : id);
}
const plannedSelection = (plan, main) => plan.selected.map(ref => ref === 'main' ? digest(main) : plan.pending.has(ref) ? digest(plan.pending.get(ref).data) : plan.retained.has(ref) ? digest(plan.retained.get(ref).data) : ref);
for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: layout planning is SELECT-only and matches portal order/dedup/old-byte/thumb persistence`, options, async t => {
    const f = await fixture(t, dialect), product = await f.make('PLAN');
    await addGalleryImage(f.store, product.id, photo('A'), 'manual', photo('thumb-A'));
    await addGalleryImage(f.store, product.id, photo('B'), 'manual', photo('thumb-B'));
    const old = await f.store.all('SELECT * FROM product_gallery_image WHERE product_id = ? ORDER BY position', product.id), current = await getProduct(f.store, product.id, true);
    const requested = [{ id: old[1].id }, { imageDataUrl: photo('C'), thumbDataUrl: photo('thumb-C') }, { id: old[0].id },
      { id: 'main' }, { imageDataUrl: photo('C'), thumbDataUrl: 'ignored-invalid-duplicate-thumb' }, { imageDataUrl: photo('A'), thumbDataUrl: 'ignored-existing-thumb' }];
    const before = await state(f.store), guard = selectOnly(f.store);
    const plan = await planProductGallery(guard.read, product.id, requested, current), again = await planProductGallery(guard.read, product.id, requested, current);
    guard.assertRead(); assert.deepEqual(await state(f.store), before); assert.deepEqual(plan.selected, again.selected);
    assert.equal(plan.role, 'single'); assert.equal(plan.pending.size, 1); assert.equal(plan.pending.has('upload:sha256:' + digest(bytes('C'))), true);
    assert.deepEqual(plannedSelection(plan, bytes('main')), ['B', 'C', 'A', 'main'].map(label => digest(bytes(label))));
    await updateProduct(f.store, product.id, { gallery: requested, expectedUpdatedAt: current.updatedAt });
    assert.deepEqual(await actualSelection(f.store, product.id), plannedSelection(plan, bytes('main')));
    const saved = await f.store.all('SELECT * FROM product_gallery_image WHERE product_id = ? ORDER BY position', product.id);
    for (const row of old) {
      const kept = saved.find(item => item.id === row.id);
      assert.deepEqual([kept.mime, digest(kept.data), kept.created_at, kept.thumb_mime, digest(kept.thumb_data)], [row.mime, digest(row.data), row.created_at, row.thumb_mime, digest(row.thumb_data)]);
    }
    const added = saved.find(row => !old.some(item => item.id === row.id));
    assert.match(added.id, /^[0-9a-f-]{36}$/); assert.equal(digest(added.thumb_data), digest(bytes('thumb-C')));
  });
  test(`${dialect}: upload-entry plans retain main precedence and legacy duplicate identities without tightening thumbnails`, options, async t => {
    const f = await fixture(t, dialect), product = await f.make('DUPLICATE');
    await f.store.run('INSERT INTO product_gallery_image(id, product_id, position, mime, data, created_at) VALUES (?, ?, 1, ?, ?, ?)',
      'legacy-main-copy', product.id, 'image/png', bytes('main'), '2025-01-01T00:00:00.000Z');
    const current = await getProduct(f.store, product.id, true), read = selectOnly(f.store), before = await state(f.store);
    const requested = [{ imageDataUrl: photo('main'), thumbDataUrl: 'ignored-main-twin-thumb' }, { id: 'legacy-main-copy' }, { id: 'main' }];
    const plan = await planProductGallery(read.read, product.id, requested, current);
    assert.deepEqual(plan.selected, ['main', 'legacy-main-copy']); assert.equal(plan.pending.size, 0); assert.deepEqual(await state(f.store), before);
    assert.deepEqual(Object.keys(prepareGalleryUploadEntry(photo('main'), '')), ['imageDataUrl']);
    const addition = await planGalleryImageAddition(read.read, product.id, prepareGalleryUploadEntry(photo('main'), 'ignored-duplicate-thumb'));
    assert.deepEqual(addition.plan.selected, ['main', 'legacy-main-copy']); assert.deepEqual(await state(f.store), before);
    await updateProduct(f.store, product.id, { gallery: requested, expectedUpdatedAt: current.updatedAt });
    assert.equal((await getProduct(f.store, product.id, true)).galleryItems.length, 2);
    await assert.rejects(planProductGallery(read.read, product.id, [{ imageDataUrl: photo('new'), thumbDataUrl: 'invalid-first-thumb' }], await getProduct(f.store, product.id, true)), error => error.field === 'thumbDataUrl');
  });
  test(`${dialect}: new content aliases cannot collide with a retained legacy gallery ID`, options, async t => {
    const f = await fixture(t, dialect), product = await f.make('ALIAS'), alias = 'upload:sha256:' + digest(bytes('new'));
    await f.store.run('INSERT INTO product_gallery_image(id, product_id, position, mime, data, created_at) VALUES (?, ?, 1, ?, ?, ?)', alias, product.id, 'image/png', bytes('legacy'), '2025-01-01T00:00:00.000Z');
    const current = await getProduct(f.store, product.id, true), before = await state(f.store), { read } = selectOnly(f.store), requested = [{ imageDataUrl: photo('new') }, { id: alias }];
    const plan = await planProductGallery(read, product.id, requested, current);
    assert.deepEqual(plan.selected, [alias + ':1', alias]); assert.equal(plan.pending.size, 1); assert.deepEqual(await state(f.store), before);
    await updateProduct(f.store, product.id, { gallery: requested, expectedUpdatedAt: current.updatedAt });
    assert.deepEqual(await actualSelection(f.store, product.id), [digest(bytes('new')), digest(bytes('legacy'))]);
    assert.ok(await f.store.get('SELECT id FROM product_gallery_image WHERE id = ?', alias));
  });

  test(`${dialect}: shared ten-image planning preserves distinct own-main eleven and legacy variant handling`, options, async t => {
    const f = await fixture(t, dialect), holder = await f.make('HOLDER', 'holder', { variantGroup: 'GROUP', variantLabel: 'A' });
    for (let n = 0; n < 9; n++) await addGalleryImage(f.store, holder.id, photo('shared-' + n));
    const variant = await f.make('VARIANT', 'variant', { variantGroup: 'GROUP', variantLabel: 'B' });
    const current = await getProduct(f.store, holder.id, true), sibling = await getProduct(f.store, variant.id, true), before = await state(f.store), guard = selectOnly(f.store);
    assert.equal(current.galleryItems.length, 10); assert.equal(sibling.galleryItems.length, 11); assert.equal(sibling.galleryItems[0].id, 'main');
    const request = [{ id: 'main' }, ...current.galleryItems.map(row => ({ id: row.id })).reverse(), { imageDataUrl: photo('holder'), thumbDataUrl: 'ignored-existing-thumb' }];
    const plan = await planProductGallery(guard.read, holder.id, request, current);
    assert.equal(plan.role, 'holder'); assert.equal(plan.holderId, holder.id); assert.equal(plan.selected.length, 10); assert.equal(plan.pending.size, 0); assert.equal(plan.selected.includes('main'), false);
    await assert.rejects(planGalleryImageAddition(guard.read, variant.id, prepareGalleryUploadEntry(photo('new'))), { code: 'GALLERY_SHARED' });
    await assert.rejects(planGalleryImageAddition(guard.read, holder.id, prepareGalleryUploadEntry(photo('overflow'))), error => error.field === 'gallery');
    assert.deepEqual(await state(f.store), before);
    await updateProduct(f.store, holder.id, { gallery: request, expectedUpdatedAt: current.updatedAt });
    const changed = await getProduct(f.store, variant.id, true);
    assert.equal(changed.galleryItems.length, 11); assert.deepEqual(changed.galleryItems.slice(1).map(row => row.id), plan.selected);
    await updateProduct(f.store, variant.id, { gallery: [], expectedUpdatedAt: changed.updatedAt, name: 'Legacy allowed metadata' });
    assert.deepEqual((await getProduct(f.store, variant.id, true)).galleryItems.slice(1).map(row => row.id), plan.selected);
    assert.equal(digest((await f.store.get('SELECT image_data FROM product WHERE id = ?', variant.id)).image_data), digest(bytes('variant')));
  });
  test(`${dialect}: ownership, shape, twenty-request and ten-selected errors remain read-only`, options, async t => {
    const f = await fixture(t, dialect), product = await f.make('BOUNDS'), other = await f.make('OTHER');
    await addGalleryImage(f.store, other.id, photo('foreign'));
    const foreign = (await f.store.get('SELECT id FROM product_gallery_image WHERE product_id = ?', other.id)).id;
    const current = await getProduct(f.store, product.id, true), before = await state(f.store), { read } = selectOnly(f.store);
    for (const requested of [null, Array(21).fill({ id: 'main' }), [{}], [{ id: foreign }], [{ id: 'https://foreign.example/image.png' }], [{ imageDataUrl: photo('x'), approved: true }],
      Array.from({ length: 11 }, (_, n) => ({ imageDataUrl: photo('unique-' + n) }))]) await assert.rejects(planProductGallery(read, product.id, requested, current), error => error.field === 'gallery');
    assert.deepEqual(await state(f.store), before);
    const empty = await f.make('EMPTY', null), emptyBefore = await state(f.store);
    await assert.rejects(planGalleryImageAddition(read, empty.id, prepareGalleryUploadEntry(photo('x'))), error => error.field === 'imageDataUrl');
    assert.deepEqual(await state(f.store), emptyBefore);
    assert.equal((await planProductGallery(read, product.id, Array(20).fill({ id: 'main' }), current)).selected.length, 1);
    assert.deepEqual(await state(f.store), emptyBefore);
  });
  test(`${dialect}: static references retain selection identity and never turn into uploaded bytes`, options, async t => {
    const f = await fixture(t, dialect), entry = demo.find(row => row.sku === 'DEMO-001');
    await createCategory(f.store, { code: entry.category, label: 'Synthetic demo category' });
    const product = await createProduct(f.store, entry), current = await getProduct(f.store, product.id, true, 'public-demo');
    assert.ok(current.galleryItems.some(row => row.id === 'static:DEMO-001:3'));
    const requested = [{ id: 'static:DEMO-001:3' }, { id: 'main' }, { id: 'static:DEMO-001:3' }], before = await state(f.store), { read } = selectOnly(f.store);
    const plan = await planProductGallery(read, product.id, requested, current);
    assert.deepEqual(plan.selected, ['static:DEMO-001:3', 'main']); assert.equal(plan.pending.size, 0); assert.deepEqual(await state(f.store), before);
    await assert.rejects(planProductGallery(read, product.id, [{ id: 'static:DEMO-002:1' }], current), error => error.field === 'gallery');
    const saved = await updateProduct(f.store, product.id, { gallery: requested, expectedUpdatedAt: current.updatedAt }, 'public-demo');
    assert.deepEqual(saved.galleryItems.map(row => row.id), plan.selected);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM product_gallery_image WHERE product_id = ?', product.id)).n), 0);
  });
  test(`${dialect}: trusted projected main reproduces combined portal dedup/removal planning without dry-run DML`, options, async t => {
    const f = await fixture(t, dialect), product = await f.make('PROJECTED'); await addGalleryImage(f.store, product.id, photo('A'));
    const upload = await f.store.get('SELECT id FROM product_gallery_image WHERE product_id = ?', product.id), current = await getProduct(f.store, product.id, true), before = await state(f.store), { read } = selectOnly(f.store);
    const requested = [{ imageDataUrl: photo('A'), thumbDataUrl: 'ignored-new-main-twin' }, { id: 'main' }, { id: upload.id }];
    const plan = await planProductGallery(read, product.id, requested, current, { mainImageDataUrl: photo('A') });
    assert.equal(plan.mainDigest, digest(bytes('A'))); assert.deepEqual(plan.selected, ['main', upload.id]); assert.equal(plan.pending.size, 0);
    await assert.rejects(planProductGallery(read, product.id, [{ id: 'main' }], current, { mainImageDataUrl: null }), error => error.field === 'gallery');
    assert.throws(() => requireMainImageRemoval(current, null), error => error.field === 'imageDataUrl');
    assert.deepEqual(await state(f.store), before);
    await updateProduct(f.store, product.id, { imageDataUrl: photo('A'), gallery: requested, expectedUpdatedAt: current.updatedAt });
    assert.deepEqual(await actualSelection(f.store, product.id), [digest(bytes('A')), digest(bytes('A'))]);
  });

  test(`${dialect}: main removal, invalid uploads and an insertion failure roll metadata/binary/layout back atomically`, options, async t => {
    const f = await fixture(t, dialect), product = await f.make('ROLLBACK'); await addGalleryImage(f.store, product.id, photo('keep'));
    const current = await getProduct(f.store, product.id, true), before = await state(f.store);
    await assert.rejects(updateProduct(f.store, product.id, { imageDataUrl: null }), error => error.field === 'imageDataUrl');
    assert.deepEqual(await state(f.store), before);
    await assert.rejects(updateProduct(f.store, product.id, { name: 'Must roll back', imageDataUrl: null, gallery: [{ id: 'main' }], expectedUpdatedAt: current.updatedAt }), error => error.field === 'gallery');
    assert.deepEqual(await state(f.store), before);
    await assert.rejects(updateProduct(f.store, product.id, { name: 'Must roll back', gallery: [{ imageDataUrl: photo('new'), thumbDataUrl: 'invalid' }], expectedUpdatedAt: current.updatedAt }), error => error.field === 'thumbDataUrl');
    assert.deepEqual(await state(f.store), before);
    const run = f.store.run;
    f.store.run = (sql, ...args) => { if (sql.startsWith('INSERT INTO product_gallery_image')) throw new Error('Synthetic gallery insert failure.'); return run(sql, ...args); };
    try { await assert.rejects(updateProduct(f.store, product.id, { name: 'Must roll back', gallery: [{ imageDataUrl: photo('new') }], expectedUpdatedAt: current.updatedAt }), /Synthetic gallery insert failure/); }
    finally { f.store.run = run; }
    assert.deepEqual(await state(f.store), before);
    const removed = await updateProduct(f.store, product.id, { imageDataUrl: null, gallery: [], expectedUpdatedAt: current.updatedAt });
    assert.equal(removed.galleryItems.length, 0); assert.equal(removed.imageUrl, null);
  });
  test(`${dialect}: ordinary CSV metadata updates preserve gallery identities/bytes and variant shared membership`, options, async t => {
    const f = await fixture(t, dialect), holder = await f.make('IMPORT-H', 'holder', { variantGroup: 'IMPORT-G', variantLabel: 'A' });
    const variant = await f.make('IMPORT-V', 'variant', { variantGroup: 'IMPORT-G', variantLabel: 'B' }); await addGalleryImage(f.store, holder.id, photo('shared'));
    const before = rowsDigest(await f.store.all('SELECT * FROM product_gallery_image ORDER BY id')), own = rowsDigest(await f.store.all('SELECT id, image_data, thumb_data, listing_id FROM product ORDER BY id'));
    const csv = 'SKU,Name,Description,Category,Currency,Price,Stock (blank = unlimited),Active\nIMPORT-V,Imported shared title,Synthetic imported description,SYNTHETIC,MYR,15.00,,yes';
    const result = await importProducts(f.store, csv, 'synthetic_owner'); assert.equal(result.summary.update, 1);
    assert.equal(rowsDigest(await f.store.all('SELECT * FROM product_gallery_image ORDER BY id')), before);
    assert.equal(rowsDigest(await f.store.all('SELECT id, image_data, thumb_data, listing_id FROM product ORDER BY id')), own);
    assert.equal((await getProduct(f.store, holder.id, true)).name, 'Imported shared title');
    assert.equal((await getProduct(f.store, variant.id, true)).priceMinor, 1500);
  });
}
