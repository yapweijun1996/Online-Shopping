import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/db.js';
import { initializeShop } from '../src/shop-setup.js';
import { createApi } from '../src/app.js';
import { createSession } from '../src/auth.js';
import { listProducts } from '../src/products.js';
import { updateCompanySettings } from '../src/settings.js';
import { sellerChatURL } from '../public/shop/product-detail.js';
import { presentCatalogCopy, presentShopName } from '../src/catalog-copy.js';
import { languages, messages } from '../public/shared/i18n.js';

const png = readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url));
const dataURL = (n = 0) => 'data:image/png;base64,' + Buffer.concat([png, Buffer.from(`fixture-${n}`)]).toString('base64');
function fixture(t) {
  const store = openDatabase(':memory:'); t.after(() => store.close());
  const config = { shopMode: 'public-demo', demoRevision: 'qa-fix', production: false };
  initializeShop(store, config);
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
  const a = fixture(t), b = fixture(t);
  assert.equal((await (await a.call('/api/v1/shop')).json()).sellerWhatsAppPhone, null);
  updateCompanySettings(a.store, { sellerWhatsAppPhone: '+60 12-345 6789' });
  const response = await a.call('/api/v1/shop'), shop = await response.json();
  assert.equal(shop.sellerWhatsAppPhone, '60123456789');
  assert.equal(sellerChatURL(shop.sellerWhatsAppPhone), 'https://wa.me/60123456789');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(shop).sort(), ['currency', 'demoNamespace', 'demoRolesAvailable', 'mobileHideBarsOnScroll', 'mode', 'sellerWhatsAppPhone', 'shopName'].sort());
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
