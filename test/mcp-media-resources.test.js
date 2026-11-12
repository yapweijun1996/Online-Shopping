import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { createCategory } from '../src/settings.js';
import { addGalleryImage, createProduct, getProduct, planGalleryImageAddition, setProductThumbnail, setGalleryThumbnail, updateProduct } from '../src/products.js';
import { planProductGallery, prepareGalleryUploadEntry, requireMainImageRemoval } from '../src/product-gallery.js';
import { readMediaSnapshot, loadOldMediaAsset } from '../src/mcp/media-resources.js';
import { MEDIA_LIMITS } from '../src/mcp/media-schema.js';
import { mediaAssetKey } from '../src/mcp/media-manifest.js';
import { rowsDigest } from '../src/sqlite-import.js';
import { createOrder } from '../src/orders.js';
import { decideSellerOrder } from '../src/seller-orders.js';

const png = readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url));
const bytes = label => Buffer.concat([png, Buffer.from(label)]), photo = label => 'data:image/png;base64,' + bytes(label).toString('base64');
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, dialect) {
  const f = await reviewFixture(t, dialect); await createCategory(f.store, { code: 'SYNTHETIC', label: 'Synthetic category' });
  const make = (sku, image = 'main', extra = {}) => createProduct(f.store, { sku, name: 'Synthetic ' + sku, description: 'Synthetic media resources', category: 'SYNTHETIC', priceMinor: 1250, stockQuantity: 8,
    active: true, ...(image === null ? {} : { imageDataUrl: photo(image) }), ...extra });
  return { ...f, make };
}
const sourceRef = value => Object.fromEntries(['source_kind','source_id','source_product_id','stage_id','byte_sha256','mime','byte_length'].map(key => [key, value[key]]));
async function state(store) { return Promise.all(['product','listing','product_gallery_image','product_event'].map(async table => rowsDigest(await store.all('SELECT * FROM ' + table + ' ORDER BY id')))); }
function guarded(store) {
  let blobs = 0, active = 0, maximum = 0;
  const inspect = value => {
    if (value instanceof Uint8Array) assert.fail('Unexpected unscoped BLOB projection.');
    if (value && typeof value === 'object') for (const child of Object.values(value)) inspect(child);
  };
  const query = (method, sql, args) => {
    assert.match(sql, /^\s*SELECT\b/i); assert.doesNotMatch(sql, /\bcurrency\b|stock_quantity|buyer_|recipient_|address_|shop_order|order_item|\bnotes\b/i); assert.equal(sql.includes(';'), false);
    const binary = sql.includes(' AS media_bytes ');
    if (binary) { assert.equal(method, 'get'); assert.match(sql, /LIMIT 1$/); blobs++; active++; maximum = Math.max(maximum, active); }
    return store[method](sql, ...args).then(value => {
      if (binary && value) { assert.deepEqual(Object.keys(value), ['media_bytes']); assert.ok(value.media_bytes.byteLength <= MEDIA_LIMITS.sourceBytes); }
      else inspect(value);
      return value;
    }).finally(() => { if (binary) active--; });
  };
  return { read: { dialect: store.dialect, get: (sql, ...args) => query('get', sql, args), all: (sql, ...args) => query('all', sql, args) }, get blobs() { return blobs; }, get maximum() { return maximum; } };
}
function noBytes(value) {
  assert.equal(value instanceof Uint8Array, false);
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { assert.doesNotMatch(key, /^(?:currency|stockQuantity|stock_quantity|buyer|recipient|notes|data|image_data|thumb_data)$/); noBytes(child); }
}
async function cloneMembers(store, product, number, image, start = 0) {
  const ids = [], tuples = [], values = [];
  for (let n = 0; n < number; n++) {
    const id = randomUUID(); ids.push(id); tuples.push("(?, ?, 'Synthetic member', 'Synthetic', 'SYNTHETIC', 1250, 'MYR', 1, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, ?)");
    values.push(id, 'MEMBER-' + (n + start), product.listingId, image ? 'image/png' : null, image ? (typeof image === 'function' ? image(n) : image) : null);
  }
  await store.run('INSERT INTO product(id,sku,name,description,category,price_minor,currency,active,listing_id,created_at,updated_at,image_mime,image_data) VALUES ' + tuples.join(','), ...values);
  return ids;
}
for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: snapshot is bounded SELECT-only metadata, streams private bytes and preserves exact source identity`, options, async t => {
    const f = await fixture(t, dialect), product = await f.make('SINGLE');
    await setProductThumbnail(f.store, product.id, photo('thumb-main')); await addGalleryImage(f.store, product.id, photo('extra'), 'manual', photo('thumb-extra'));
    const before = await state(f.store), guard = guarded(f.store), snapshot = await readMediaSnapshot(guard.read, product.id);
    assert.deepEqual(await state(f.store), before); assert.equal(guard.maximum, 1); assert.equal(guard.blobs, 4); noBytes(snapshot);
    assert.match(snapshot.revision, /^[0-9a-f]{64}$/); assert.equal(snapshot.before.products[0].role, 'single'); assert.equal(snapshot.before.listings[0].holderId, null);
    assert.equal(snapshot.before.listings[0].galleryAssetKeys.length, 2); assert.equal(snapshot.sources.length, 2);
    assert.equal(snapshot.graphReadBytes.oldBytes, snapshot.sources.reduce((n, source) => n + source.byte_length + (source.thumbnail?.byte_length || 0), 0));
    for (const source of snapshot.sources) { assert.equal(source.width, null); assert.equal(source.height, null); assert.equal(source.dimensionsVerified, false); assert.equal(source.assetKey, mediaAssetKey(source.mime, source.byte_sha256)); }
    const main = snapshot.sources.find(source => source.source_kind === 'PRODUCT_MAIN'), loaded = await loadOldMediaAsset(guard.read, snapshot, sourceRef(main));
    assert.equal(hash(loaded.data), hash(bytes('main'))); assert.equal(loaded.mime, 'image/png');
    const thumb = await loadOldMediaAsset(guard.read, snapshot, sourceRef(main), { thumbnail: true }); assert.equal(hash(thumb.data), hash(bytes('thumb-main')));
    assert.equal((await readMediaSnapshot(guard.read, product.id)).revision, snapshot.revision); assert.deepEqual(await state(f.store), before);
  });
  test(`${dialect}: shared role/ten-plus-own-eleven projection composes with the exact portal planner`, options, async t => {
    const f = await fixture(t, dialect), holder = await f.make('HOLDER', 'holder', { variantGroup: 'GROUP', variantLabel: 'A' });
    for (let n = 0; n < 9; n++) await addGalleryImage(f.store, holder.id, photo('shared-' + n));
    const variant = await f.make('VARIANT', 'variant', { variantGroup: 'GROUP', variantLabel: 'B' }), before = await readMediaSnapshot(f.store, variant.id);
    assert.deepEqual(before.before.products.map(row => row.role).sort(), ['holder','variant']);
    const h = before.views.find(row => row.productId === holder.id), v = before.views.find(row => row.productId === variant.id);
    assert.equal(h.visible.length, 10); assert.equal(v.visible.length, 11); assert.equal(v.visible[0].id, 'main'); assert.equal(before.before.listings[0].galleryAssetKeys.length, 10);
    const requested = [...h.current.galleryItems].reverse().map(({ id }) => ({ id })), plan = await planProductGallery(f.store, holder.id, requested, h.current);
    assert.deepEqual(plan.selected, requested.map(row => row.id)); requireMainImageRemoval(v.current, null);
    await assert.rejects(planGalleryImageAddition(f.store, variant.id, prepareGalleryUploadEntry(photo('new'))), { code: 'GALLERY_SHARED' });
    const current = await getProduct(f.store, holder.id, true); await updateProduct(f.store, holder.id, { gallery: requested, expectedUpdatedAt: current.updatedAt });
    const after = await readMediaSnapshot(f.store, variant.id);
    assert.notEqual(after.revision, before.revision); assert.deepEqual(after.before.listings[0].galleryAssetKeys, [...before.before.listings[0].galleryAssetKeys].reverse());
  });
  test(`${dialect}: real stock decisions are outside the media fence but unversioned thumbnail bytes invalidate it`, options, async t => {
    const f = await fixture(t, dialect), product = await f.make('FENCE', 'main-A'); await addGalleryImage(f.store, product.id, photo('extra'));
    await setProductThumbnail(f.store, product.id, photo('thumb-A'));
    const before = await readMediaSnapshot(f.store, product.id), source = before.sources.find(row => row.source_kind === 'PRODUCT_MAIN');
    const order = await createOrder(f.store, 'synthetic-media-stock-order', { buyer: { fullName: 'Synthetic Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true,
      deliveries: [{ recipient: { fullName: 'Synthetic Recipient', phone: '+60123456789' }, address: { line1: 'Synthetic Street', postcode: '50000', country: 'MY' },
        items: [{ productId: product.id, quantity: 2, expectedPriceMinor: 1250, expectedCurrency: 'MYR' }] }] });
    const id = (await f.store.get('SELECT id FROM shop_order WHERE order_no = ?', order.receipt.orderNo)).id;
    await decideSellerOrder(f.store, id, 'confirm', { expectedRevision: 1 }, 'synthetic_owner');
    assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id = ?', product.id)).stock_quantity, 6);
    assert.equal((await readMediaSnapshot(f.store, product.id)).revision, before.revision);
    const timestamp = (await f.store.get('SELECT updated_at FROM product WHERE id = ?', product.id)).updated_at;
    await setProductThumbnail(f.store, product.id, photo('thumb-B'));
    // Simulate legacy backfill without a product revision change.
    await f.store.run('UPDATE product SET updated_at=? WHERE id=?',timestamp,product.id);
    assert.equal((await f.store.get('SELECT updated_at FROM product WHERE id = ?', product.id)).updated_at, timestamp);
    const afterThumb = await readMediaSnapshot(f.store, product.id); assert.notEqual(afterThumb.revision, before.revision);
    await assert.rejects(loadOldMediaAsset(f.store, before, sourceRef(source), { thumbnail: true }), { code: 'MEDIA_RESOURCE_CHANGED' });
    const gallery = afterThumb.sources.find(row => row.source_kind === 'GALLERY'); await setGalleryThumbnail(f.store, product.id, gallery.source_id, photo('thumb-gallery'));
    assert.equal((await f.store.get('SELECT updated_at FROM product WHERE id = ?', product.id)).updated_at, timestamp);
    const beforeImage = await readMediaSnapshot(f.store, product.id); assert.notEqual(beforeImage.revision, afterThumb.revision);
    const oldMain = sourceRef(beforeImage.sources.find(row => row.source_kind === 'PRODUCT_MAIN'));
    await updateProduct(f.store, product.id, { imageDataUrl: photo('main-B'), thumbDataUrl: photo('thumb-B') });
    const afterImage = await readMediaSnapshot(f.store, product.id); assert.equal(afterImage.structureRevision, beforeImage.structureRevision); assert.notEqual(afterImage.revision, beforeImage.revision);
    const oldRead = guarded(f.store);
    await assert.rejects(loadOldMediaAsset(oldRead.read, beforeImage, oldMain), { code: 'MEDIA_RESOURCE_CHANGED' }); assert.equal(oldRead.blobs, 1);
    await assert.rejects(loadOldMediaAsset(f.store, afterImage, oldMain), { code: 'MEDIA_RESOURCE_CHANGED' });
  });
  test(`${dialect}: SKU holder order, membership and human labels stale captured resources`, options, async t => {
    const f = await fixture(t, dialect), holder = await f.make('AAA', 'holder', { variantGroup: 'GROUP', variantLabel: 'A' });
    const variant = await f.make('ZZZ', 'variant', { variantGroup: 'GROUP', variantLabel: 'B' });
    await f.store.run('UPDATE product SET created_at = ? WHERE listing_id = ?', '2026-01-01T00:00:00.000Z', holder.listingId);
    const before = await readMediaSnapshot(f.store, holder.id); assert.equal(before.before.listings[0].holderId, holder.id);
    await updateProduct(f.store, variant.id, { sku: '000' }); const changed = await readMediaSnapshot(f.store, holder.id);
    assert.equal(changed.before.listings[0].holderId, variant.id); assert.notEqual(changed.revision, before.revision);
    await assert.rejects(loadOldMediaAsset(f.store, before, before.assets[0]), { code: 'MEDIA_RESOURCE_CHANGED' });
    await updateProduct(f.store, variant.id, { variantGroup: null }); const moved = await readMediaSnapshot(f.store, holder.id);
    assert.equal(moved.products.length, 1); assert.equal(moved.before.products[0].role, 'single'); assert.notEqual(moved.revision, changed.revision);
    await updateProduct(f.store, holder.id, { name: 'Changed human review label' }); assert.notEqual((await readMediaSnapshot(f.store, holder.id)).revision, moved.revision);
  });
  test(`${dialect}: exact source ownership rejects cross-product refs and static/unknown legacy before binary reads`, options, async t => {
    const f = await fixture(t, dialect), a = await f.make('A'), b = await f.make('B');
    await addGalleryImage(f.store, a.id, photo('same-gallery')); await addGalleryImage(f.store, b.id, photo('same-gallery'));
    const left = await readMediaSnapshot(f.store, a.id), right = await readMediaSnapshot(f.store, b.id), guard = guarded(f.store);
    assert.equal(left.assets[0].byte_sha256, right.assets[0].byte_sha256);
    await assert.rejects(loadOldMediaAsset(guard.read, left, right.assets[0]), { code: 'MEDIA_RESOURCE_CHANGED' }); assert.equal(guard.blobs, 0);
    const ownedGallery = left.assets.find(row => row.source_kind === 'GALLERY');
    await assert.rejects(loadOldMediaAsset(guard.read, left, { ...ownedGallery, source_product_id: b.id }), { code: 'MEDIA_RESOURCE_CHANGED' }); assert.equal(guard.blobs, 0);
    await f.store.run('UPDATE product SET gallery_layout_json = ? WHERE id = ?', JSON.stringify(['static:DEMO-001:1']), a.id);
    await assert.rejects(readMediaSnapshot(guard.read, a.id), { code: 'MEDIA_RESOURCE_UNSUPPORTED' }); assert.equal(guard.blobs, 0);
    await f.store.run('UPDATE product SET gallery_layout_json = NULL WHERE id = ?', a.id);
    await f.store.run('INSERT INTO product_gallery_image(id,product_id,position,mime,data,created_at) VALUES (?, ?, 2, ?, ?, ?)', 'legacy-non-uuid', a.id, 'image/png', bytes('legacy'), '2026-01-01T00:00:00.000Z');
    await assert.rejects(readMediaSnapshot(guard.read, a.id), { code: 'MEDIA_RESOURCE_UNSUPPORTED' }); assert.equal(guard.blobs, 0);
    await assert.rejects(readMediaSnapshot(guard.read, randomUUID()), { code: 'MEDIA_RESOURCE_NOT_FOUND' });
  });
  test(`${dialect}: product and physical byte caps reject before loading any image bytes`, options, async t => {
    const f = await fixture(t, dialect), p = await f.make('CAP', null); await cloneMembers(f.store, p, MEDIA_LIMITS.products, null);
    const guard = guarded(f.store); await assert.rejects(readMediaSnapshot(guard.read, p.id), { code: 'MEDIA_RESOURCE_LIMIT' }); assert.equal(guard.blobs, 0);
    await f.store.run('DELETE FROM product WHERE id <> ?', p.id);
    const large = Buffer.alloc(MEDIA_LIMITS.sourceBytes); png.copy(large);
    const copies = await cloneMembers(f.store, p, 33, large);
    await assert.rejects(readMediaSnapshot(guard.read, p.id), { code: 'MEDIA_RESOURCE_LIMIT' }); assert.equal(guard.blobs, 0);
    await f.store.run('DELETE FROM product WHERE id = ?', copies[0]);
    await f.store.run('UPDATE product SET thumb_mime = ?, thumb_data = ? WHERE id = ?', 'image/png', bytes('extra-thumbnail'), copies[1]);
    await assert.rejects(readMediaSnapshot(guard.read, p.id), { code: 'MEDIA_RESOURCE_LIMIT' }); assert.equal(guard.blobs, 0);
    await f.store.run('DELETE FROM product WHERE id <> ?', p.id);
    await f.store.run('UPDATE product SET image_mime = ?, image_data = ? WHERE id = ?', 'image/png', Buffer.concat([large, Buffer.from('x')]), p.id);
    await assert.rejects(readMediaSnapshot(guard.read, p.id), { code: 'MEDIA_RESOURCE_LIMIT' }); assert.equal(guard.blobs, 0);
  });
  test(`${dialect}: metadata and thumbnail bounds precede bytes while legacy MIME mismatch is controlled`, options, async t => {
    const f = await fixture(t, dialect), p = await f.make('METADATA'), guard = guarded(f.store);
    await f.store.run('UPDATE product SET name = ? WHERE id = ?', 'x'.repeat(MEDIA_LIMITS.records * MEDIA_LIMITS.pageBytes + 1), p.id);
    await assert.rejects(readMediaSnapshot(guard.read, p.id), { code: 'MEDIA_RESOURCE_LIMIT' }); assert.equal(guard.blobs, 0);
    await f.store.run('UPDATE product SET name = ?, thumb_mime = ?, thumb_data = ? WHERE id = ?', 'Synthetic metadata', 'image/png', Buffer.alloc(MEDIA_LIMITS.thumbnailBytes + 1), p.id);
    await assert.rejects(readMediaSnapshot(guard.read, p.id), { code: 'MEDIA_RESOURCE_LIMIT' }); assert.equal(guard.blobs, 0);
    await f.store.run('UPDATE product SET thumb_mime = NULL, thumb_data = NULL, image_mime = ? WHERE id = ?', 'image/jpeg', p.id);
    await assert.rejects(readMediaSnapshot(guard.read, p.id), { code: 'MEDIA_RESOURCE_UNSUPPORTED' }); assert.equal(guard.blobs, 1);
  });
  test(`${dialect}: exactly300 metadata members and shared content remain complete`, options, async t => {
    const f = await fixture(t, dialect), p = await f.make('COMPLETE', null); await cloneMembers(f.store, p, MEDIA_LIMITS.products - 1, bytes('same'));
    const snapshot = await readMediaSnapshot(f.store, p.id);
    assert.equal(snapshot.products.length, 300); assert.equal(snapshot.before.products.length, 300); assert.equal(snapshot.assets.length, 1);
    assert.equal(snapshot.sources.length, 299); assert.ok(snapshot.graphReadBytes.oldBytes < MEDIA_LIMITS.oldBytes); noBytes(snapshot);
  });
  test(`${dialect}: all3300 physical identities fit independently of the512 effect budget`, options, async t => {
    const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=', 'base64');
    const f = await fixture(t, dialect), p = await f.make('PHYSICAL', null, { imageDataUrl: 'data:image/png;base64,' + tiny.toString('base64') }), members = [p.id, ...await cloneMembers(f.store, p, MEDIA_LIMITS.products - 1, tiny)], tuples = [], args = [];
    for (const productId of members) for (let position = 1; position <= 10; position++) {
      tuples.push("(?, ?, ?, 'image/png', ?, '2026-01-01T00:00:00.000Z')"); args.push(randomUUID(), productId, position, tiny);
    }
    await f.store.run('INSERT INTO product_gallery_image(id,product_id,position,mime,data,created_at) VALUES ' + tuples.join(','), ...args);
    const snapshot = await readMediaSnapshot(f.store, p.id);
    assert.equal(snapshot.sources.length, 3300); assert.equal(snapshot.assets.length, 1); assert.equal(snapshot.products.length, 300);
    assert.equal(snapshot.before.listings[0].galleryAssetKeys.length, 10); assert.equal(new Set(snapshot.before.listings[0].galleryAssetKeys).size, 1);
    assert.ok(snapshot.before.products.length + snapshot.before.listings.length <= MEDIA_LIMITS.records); noBytes(snapshot);
  });
  test(`${dialect}: distinct MIME/content cap stops streaming without returning a partial snapshot`, options, async t => {
    const f = await fixture(t, dialect), p = await f.make('DISTINCT', null); await cloneMembers(f.store, p, 32, n => bytes('unique-' + String(n).padStart(2, '0')));
    assert.equal((await readMediaSnapshot(f.store, p.id)).assets.length, 32);
    await cloneMembers(f.store, p, 1, () => bytes('unique-32'), 32);
    const guard = guarded(f.store); await assert.rejects(readMediaSnapshot(guard.read, p.id), { code: 'MEDIA_RESOURCE_LIMIT' });
    assert.equal(guard.blobs, 33); assert.equal(guard.maximum, 1);
  });
}
