import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase, migrateStore } from '../worker-runtime/db.js';
import { initializeShop } from '../worker-runtime/shop-setup.js';
import { createApi } from '../worker-runtime/app.js';
import { createSession } from '../worker-runtime/auth.js';
import { listProducts, getProduct, createProduct } from '../worker-runtime/products.js';
import { updateCompanySettings } from '../worker-runtime/settings.js';
import { sellerChatURL } from '../public/shop/product-detail.js';
import { presentCatalogCopy, presentShopName } from '../src/catalog-copy.js';
import { languages, messages } from '../public/shared/i18n.js';

const png = readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url));
const dataURL = (n = 0) => 'data:image/png;base64,' + Buffer.concat([png, Buffer.from(`fixture-${n}`)]).toString('base64');
function fixture(t, productionContact = false) {
  const store = openDatabase(':memory:'); t.after(() => store.close());
  const config = { shopMode: 'public-demo', demoRevision: 'qa-fix', production: false };
  initializeShop(store, config);
  if (productionContact) {
    // Public contacts belong to configured shops; preview mode retains main's no-contact contract.
    store.run("UPDATE shop_setup SET mode = 'production' WHERE id = 1");
    config.shopMode = 'manual';
  }
  const api = createApi({ store, config }), session = createSession(store);
  const id = listProducts(store, new URLSearchParams('limit=100')).items.find(p => p.sku === 'DEMO-020').id;
  const call = (path, method = 'GET', body, auth = true) => api(new Request('http://fixture.test' + path, {
    method, headers: { ...(auth ? { cookie: 'seller_session=' + session.token, 'x-csrf-token': session.csrfToken } : {}),
      ...(method === 'GET' ? {} : { origin: 'http://fixture.test', 'content-type': 'application/json' }) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  return { store, call, id, session, seller: '/api/v1/seller/products/' + id, customer: '/api/v1/products/' + id };
}
test('adding one upload preserves all six existing images in Seller and Customer', async t => {
  const f = fixture(t), before = await (await f.call(f.customer)).json();
  assert.equal(before.images.length, 6);
  const response = await f.call(f.seller + '/gallery', 'POST', { imageDataUrl: dataURL() });
  assert.equal(response.status, 201);
  for (const path of [f.seller, f.customer]) {
    const after = await (await f.call(path)).json(); assert.equal(after.images.length, 7);
    assert.deepEqual(after.images.slice(1, 6), before.images.slice(1));
  }
});
test('atomic gallery edits retain static references, canonical primary/order, dedupe and preserve rejected writes', async t => {
  const f = fixture(t), before = await (await f.call(f.seller)).json();
  const originalHero = f.store.get('SELECT image_data FROM product WHERE id = ?', f.id).image_data;
  const refs = before.galleryItems.map(item => ({ id: item.id }));
  const gallery = [refs[2], refs[0], refs[1], ...refs.slice(3), ...[1, 2, 3, 4].map(n => ({ imageDataUrl: dataURL(n) }))];
  const saved = await f.call(f.seller, 'PATCH', { gallery, expectedUpdatedAt: before.updatedAt });
  assert.equal(saved.status, 200); const detail = await saved.json();
  assert.equal(detail.images.length, 10); assert.equal(detail.imageUrl, before.images[2]);
  assert.equal(detail.galleryItems[0].id, refs[2].id);
  assert.deepEqual(f.store.get('SELECT image_data FROM product WHERE id = ?', f.id).image_data, originalHero);
  const snapshot = f.store.all('SELECT * FROM product_gallery_image WHERE product_id = ?', f.id);
  const state = f.store.get('SELECT * FROM product WHERE id = ?', f.id);
  for (const patch of [
    { gallery: [...detail.galleryItems.map(x => ({ id: x.id })), { imageDataUrl: dataURL(5) }], expectedUpdatedAt: detail.updatedAt },
    { gallery: [{ id: 'static:DEMO-001:1' }], expectedUpdatedAt: detail.updatedAt },
    { gallery: [{ id: refs[0].id }], expectedUpdatedAt: before.updatedAt },
    { gallery: [{ imageDataUrl: 'data:text/html;base64,SGk=' }], expectedUpdatedAt: detail.updatedAt },
  ]) assert.ok((await f.call(f.seller, 'PATCH', patch)).status >= 400);
  assert.deepEqual(f.store.all('SELECT * FROM product_gallery_image WHERE product_id = ?', f.id), snapshot);
  assert.deepEqual(f.store.get('SELECT * FROM product WHERE id = ?', f.id), state);
  const publicDetail = await (await f.call(f.customer)).json();
  assert.deepEqual(publicDetail.galleryItems.map(x => x.id), detail.galleryItems.map(x => x.id));
  const duplicate = await f.call(f.seller, 'PATCH', { gallery: [{ id: refs[2].id }, { id: refs[2].id }, { imageDataUrl: dataURL(1) }, { imageDataUrl: dataURL(1) }], expectedUpdatedAt: detail.updatedAt });
  assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).images.length, 2);
});
test('gallery mutation requires authentication and CSRF and cannot resolve another store or product image', async t => {
  const a = fixture(t), b = fixture(t);
  assert.equal((await a.call(a.seller, 'PATCH', { name: 'Denied' }, false)).status, 401);
  assert.equal((await b.call(a.seller, 'GET')).status, 404);
  const missingCsrf = await createApi({ store: a.store, config: { shopMode: 'public-demo' } })(new Request('http://fixture.test' + a.seller, { method: 'PATCH', headers: { cookie: 'seller_session=' + a.session.token, origin: 'http://fixture.test', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Denied' }) }));
  assert.equal(missingCsrf.status, 403);
  await b.call(b.seller + '/gallery', 'POST', { imageDataUrl: dataURL() });
  const foreign = b.store.get('SELECT id FROM product_gallery_image').id;
  const detail = await (await a.call(a.seller)).json();
  assert.equal((await a.call(a.seller, 'PATCH', { gallery: [{ id: foreign }], expectedUpdatedAt: detail.updatedAt })).status, 400);
});
test('configured public business contact survives shop DTO; private data and other stores remain isolated', async t => {
  const a = fixture(t, true), b = fixture(t, true);
  assert.equal((await (await a.call('/api/v1/shop')).json()).sellerWhatsAppPhone, null);
  updateCompanySettings(a.store, { sellerWhatsAppPhone: '+60 12-345 6789' });
  const response = await a.call('/api/v1/shop'), shop = await response.json();
  assert.equal(shop.sellerWhatsAppPhone, '60123456789');
  assert.equal(sellerChatURL(shop.sellerWhatsAppPhone), 'https://wa.me/60123456789');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(shop).sort(), ['currency', 'demoRolesAvailable', 'mobileHideBarsOnScroll', 'mode', 'sellerWhatsAppPhone', 'shopName'].sort());
  assert.equal((await (await b.call('/api/v1/shop')).json()).sellerWhatsAppPhone, null);
  assert.throws(() => updateCompanySettings(a.store, { sellerWhatsAppPhone: '1234' }));
  assert.equal((await (await a.call('/api/v1/shop')).json()).sellerWhatsAppPhone, '60123456789');
  updateCompanySettings(a.store, { sellerWhatsAppPhone: '' });
  assert.equal(sellerChatURL((await (await a.call('/api/v1/shop')).json()).sellerWhatsAppPhone), null);
  a.store.run("UPDATE company_setting SET seller_whatsapp_phone = '12345678' WHERE id = 1");
  assert.equal((await (await a.call('/api/v1/shop')).json()).sellerWhatsAppPhone, null);
  for (const invalid of [null, '', '+60123456789', '6012<script>', '123']) assert.equal(sellerChatURL(invalid), null);
});
test('controlled legacy copy is neutral in seven locales without rewriting arbitrary seller text or identities', () => {
  const catalog = JSON.parse(readFileSync(new URL('../src/public-demo-catalog.json', import.meta.url)));
  const current = catalog.find(item => item.sku === 'DEMO-020');
  const legacy = { ...current, description: current.description.replace('Fictional preview ', 'Fictional demo ').replace('automatic contact', 'contact') };
  assert.equal(presentCatalogCopy(legacy, 'public-demo').description, current.description);
  assert.equal(legacy.description.startsWith('Fictional demo'), true);
  const edited = { ...legacy, description: 'Seller-written Demo instructions' };
  assert.equal(presentCatalogCopy(edited, 'public-demo'), edited);
  assert.equal(presentShopName({ mode: 'demo', shopName: 'Demo General Store' }).shopName, 'Preview General Store');
  assert.equal(presentShopName({ mode: 'production', shopName: 'Demo General Store' }).shopName, 'Demo General Store');
  const banned = /demo|演示|示范|デモ|데모|สาธิต|เดโม/i;
  for (const { code } of languages) {
    for (const [key, value] of Object.entries(messages[code])) assert.doesNotMatch(value, banned, `${code}/${key}`);
    for (const key of ['primaryPhoto', 'setPrimaryPhoto', 'movePhotoEarlier', 'movePhotoLater', 'productChangedReopen']) assert.ok(messages[code][key]);
  }
  assert.match(messages.en.documentDemo, /No payment or shipment/);
  assert.match(messages.en.sellerWhatsAppHelp, /does not enable automatic messaging/);
});

test('v11 preview migration preserves every stored upload and keeps an editable ten-image canonical gallery', async t => {
  for (const count of [0, 1, 4, 5, 9]) {
    const f = fixture(t);
    for (let n = 0; n < count; n++) f.store.run('INSERT INTO product_gallery_image VALUES (?, ?, ?, ?, ?, ?)',
      `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`, f.id, n + 1, 'image/png', Buffer.concat([png, Buffer.from(String(n))]), '2026-10-01T00:00:00Z');
    const before = f.store.all('SELECT * FROM product_gallery_image ORDER BY position');
    f.store.exec('ALTER TABLE product DROP COLUMN gallery_layout_json'); f.store.setSchemaVersion(11); migrateStore(f.store);
    assert.deepEqual(f.store.all('SELECT * FROM product_gallery_image ORDER BY position'), before);
    const detail = await (await f.call(f.seller)).json();
    assert.equal(detail.images.length, count <= 4 ? count + 6 : count + 1);
    assert.equal((detail.galleryReferenceItems || []).length, count <= 4 ? 0 : 5);
    const saved = await f.call(f.seller, 'PATCH', { name: 'Reviewed legacy metadata', gallery: detail.galleryItems.map(x => ({ id: x.id })), expectedUpdatedAt: detail.updatedAt });
    assert.equal(saved.status, 200);
    assert.deepEqual(f.store.all('SELECT * FROM product_gallery_image ORDER BY position'), before);
    assert.equal(((await (await f.call(f.seller)).json()).galleryReferenceItems || []).length, count <= 4 ? 0 : 5);
    assert.equal((await (await f.call(f.customer)).json()).images.length, count <= 4 ? count + 6 : count + 1);
  }
});

test('legacy image-only replacement restores a removed main without discarding selected primary/order', async t => {
  const f = fixture(t), detail = await (await f.call(f.seller)).json();
  const removed = await f.call(f.seller, 'PATCH', { gallery: [], expectedUpdatedAt: detail.updatedAt });
  assert.equal(removed.status, 200);
  const replaced = await f.call(f.seller, 'PATCH', { imageDataUrl: dataURL(9) });
  assert.equal(replaced.status, 200); assert.equal((await replaced.json()).galleryItems[0]?.id, 'main');
  const publicDetail = await (await f.call(f.customer)).json(); assert.ok(publicDetail.imageUrl); assert.equal(publicDetail.images.length, 1);
  const current = await (await f.call(f.seller)).json();
  await f.call(f.seller, 'PATCH', { gallery: [{ imageDataUrl: dataURL(2) }], expectedUpdatedAt: current.updatedAt });
  const before = await (await f.call(f.seller)).json();
  const changed = await f.call(f.seller, 'PATCH', { imageDataUrl: dataURL(3) }); assert.equal(changed.status, 200);
  const after = await changed.json(); assert.equal(after.galleryItems[0].id, before.galleryItems[0].id); assert.equal(after.galleryItems[1].id, 'main');
  const ten = await f.call(f.seller, 'PATCH', { gallery: Array.from({ length: 10 }, (_, n) => ({ imageDataUrl: dataURL(20 + n) })), expectedUpdatedAt: after.updatedAt });
  assert.equal(ten.status, 200);
  const state = f.store.get('SELECT * FROM product WHERE id = ?', f.id);
  const uploads = f.store.all('SELECT * FROM product_gallery_image WHERE product_id = ? ORDER BY position', f.id);
  assert.equal((await f.call(f.seller, 'PATCH', { imageDataUrl: dataURL(40) })).status, 400);
  assert.deepEqual(f.store.get('SELECT * FROM product WHERE id = ?', f.id), state);
  assert.deepEqual(f.store.all('SELECT * FROM product_gallery_image WHERE product_id = ? ORDER BY position', f.id), uploads);
});

test('list and variant covers never select image BLOBs; detail does not select gallery BLOBs', t => {
  const f = fixture(t), queries = [];
  const traced = { ...f.store, get(sql, ...values) { queries.push(sql); return f.store.get(sql, ...values); },
    all(sql, ...values) { queries.push(sql); return f.store.all(sql, ...values); } };
  f.store.run('UPDATE product SET variant_group = ?, variant_label = ? WHERE id = ?', 'QA-GROUP', 'First', f.id);
  const p = getProduct(f.store, f.id, true);
  createProduct(f.store, { sku: 'QA-SECOND', name: 'Fictional Second', description: 'Synthetic fixture', category: p.categoryCode, priceMinor: 900, active: true, variantGroup: 'QA-GROUP', variantLabel: 'Second' });
  listProducts(traced, new URLSearchParams('limit=100'), false, 'public-demo');
  assert.equal(queries.some(sql => /\bimage_data\b|SELECT\s+\*\s+FROM\s+product_gallery_image|SELECT[^;]*\bdata\b[^;]*FROM\s+product_gallery_image/i.test(sql)), false, queries.join('\n'));
  queries.length = 0; getProduct(traced, f.id, true, 'public-demo');
  assert.equal(queries.some(sql => /SELECT[^;]*\bdata\b[^;]*FROM\s+product_gallery_image/i.test(sql)), false, queries.join('\n'));
});

test('desired empty gallery and primary removal commit atomically with all metadata; rejected image writes roll everything back', async t => {
  const f = fixture(t);
  await f.call(f.seller + '/gallery', 'POST', { imageDataUrl: dataURL(2) });
  const detail = await (await f.call(f.seller)).json();
  const intended = { name: 'Fictional revised name', description: 'Reviewed description', priceMinor: 3456, active: false };
  const rejected = await f.call(f.seller, 'PATCH', { ...intended, imageDataUrl: null, gallery: [{ id: 'main' }], expectedUpdatedAt: detail.updatedAt });
  assert.equal(rejected.status, 400);
  assert.equal((await (await f.call(f.seller)).json()).priceMinor, detail.priceMinor);
  const saved = await f.call(f.seller, 'PATCH', { ...intended, imageDataUrl: null, gallery: [], expectedUpdatedAt: detail.updatedAt });
  assert.equal(saved.status, 200); const result = await saved.json();
  for (const [key, value] of Object.entries(intended)) assert.equal(result[key], value);
  assert.deepEqual(result.images, []); assert.equal(f.store.get('SELECT image_data FROM product WHERE id = ?', f.id).image_data, null);
});
