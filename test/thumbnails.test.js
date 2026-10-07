import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { openDatabase } from '../src/db.js';
import { createCategory } from '../src/settings.js';
import { addGalleryImage, createProduct, getGalleryImage, getProduct, getProductImage, setGalleryThumbnail, setProductThumbnail, updateProduct } from '../src/products.js';

const png = readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url));
const url = (label, size = 0) => 'data:image/png;base64,' + Buffer.concat([png, Buffer.from(label), Buffer.alloc(size)]).toString('base64');
const base = { description: 'Soft', category: 'WEAR', currency: 'MYR', active: true, priceMinor: 1200 };
const shop = async () => { const s = await openDatabase(':memory:'); await createCategory(s, { code: 'WEAR', label: 'Wear' }); return s; };
const bytesOf = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');

test('a product keeps a preview next to its image; the preview is served on request and falls back to the full image', async () => {
  const store = await shop();
  try {
    const withThumb = await createProduct(store, { ...base, sku: 'A', name: 'A', imageDataUrl: url('full-a', 200), thumbDataUrl: url('small-a') });
    const without = await createProduct(store, { ...base, sku: 'B', name: 'B', imageDataUrl: url('full-b', 200) });
    assert.deepEqual(Buffer.from((await getProductImage(store, withThumb.id, true, true)).data), bytesOf(url('small-a')));
    assert.deepEqual(Buffer.from((await getProductImage(store, withThumb.id, true, false)).data), bytesOf(url('full-a', 200)));
    assert.deepEqual(Buffer.from((await getProductImage(store, without.id, true, true)).data), bytesOf(url('full-b', 200)), 'no preview: the full image answers');
    // A new image without a preview drops the old preview rather than keeping a wrong one.
    await updateProduct(store, withThumb.id, { imageDataUrl: url('new-a', 200) });
    assert.deepEqual(Buffer.from((await getProductImage(store, withThumb.id, true, true)).data), bytesOf(url('new-a', 200)));
    await updateProduct(store, withThumb.id, { imageDataUrl: url('newer-a', 200), thumbDataUrl: url('newer-small') });
    assert.deepEqual(Buffer.from((await getProductImage(store, withThumb.id, true, true)).data), bytesOf(url('newer-small')));
  } finally { await store.close(); }
});

test('previews are validated: tied to an image, small, and a real image format', async () => {
  const store = await shop();
  try {
    const made = await createProduct(store, { ...base, sku: 'A', name: 'A', imageDataUrl: url('a') });
    await assert.rejects(updateProduct(store, made.id, { thumbDataUrl: url('x') }), (error) => error.field === 'thumbDataUrl');
    await assert.rejects(createProduct(store, { ...base, sku: 'B', name: 'B', imageDataUrl: url('b'), thumbDataUrl: url('big', 90 * 1024) }), (error) => error.field === 'thumbDataUrl');
    await assert.rejects(createProduct(store, { ...base, sku: 'C', name: 'C', imageDataUrl: url('c'), thumbDataUrl: 'data:image/png;base64,' + Buffer.from('not an image').toString('base64') }), (error) => error.field === 'thumbDataUrl');
  } finally { await store.close(); }
});

test('gallery uploads carry previews through add, reorder and variant sharing; existing photos can be back-filled', async () => {
  const store = await shop();
  try {
    const white = await createProduct(store, { ...base, sku: 'TEE-WHITE', name: 'Tee', imageDataUrl: url('white'), thumbDataUrl: url('white-small'), variantGroup: 'TEE', variantLabel: 'W' });
    const withPreview = await addGalleryImage(store, white.id, url('front'), 'manual', url('front-small'));
    const plain = await addGalleryImage(store, white.id, url('back'));
    await createProduct(store, { ...base, sku: 'TEE-BLACK', name: 'Tee', imageDataUrl: url('black'), variantGroup: 'TEE', variantLabel: 'B' });
    const ids = (await getProduct(store, white.id, true)).galleryItems.filter((item) => item.shared).map((item) => item.id);
    assert.equal(ids.length, 3, 'the white photo moved into the gallery, plus front and back');
    const thumbs = [];
    for (const id of ids) thumbs.push((await getGalleryImage(store, white.id, id, true, true)).data.length);
    assert.ok(thumbs.some((size) => size === bytesOf(url('white-small')).length), 'the main photo kept its preview when it moved into the gallery');
    assert.ok(thumbs.some((size) => size === bytesOf(url('front-small')).length), 'a gallery upload kept its preview');
    // Back-fill a photo that has none.
    const target = (await store.all('SELECT id FROM product_gallery_image WHERE product_id = ? AND thumb_data IS NULL', white.id))[0];
    await setGalleryThumbnail(store, white.id, target.id, url('filled'));
    assert.deepEqual(Buffer.from((await getGalleryImage(store, white.id, target.id, true, true)).data), bytesOf(url('filled')));
    await setProductThumbnail(store, white.id, url('main-filled'));
    assert.deepEqual(Buffer.from((await getProductImage(store, white.id, true, true)).data), bytesOf(url('main-filled')));
    await assert.rejects(setGalleryThumbnail(store, white.id, '00000000-0000-4000-8000-000000000000', url('x')), (error) => error.status === 404);
    assert.ok(withPreview && plain);
  } finally { await store.close(); }
});

test('over HTTP: ?size=thumb serves the preview, and setting a preview needs the seller session and CSRF', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'online-shopping-thumb-'));
  const config = { username: 'thumb_owner', password: 'LocalThumbPass123!', dbPath: path.join(directory, 'private.db'), production: false, publicOrigin: null };
  const app = await createApp(config);
  await createCategory(app.database, { code: 'WEAR', label: 'Wear' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const login = await fetch(`${origin}/api/v1/seller/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: config.username, password: config.password }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrfToken;
    const send = (method, route, body, extra = {}) => fetch(`${origin}${route}`, { method, headers: { origin, cookie, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
    const created = await (await send('POST', '/api/v1/seller/products', { ...base, sku: 'HTTP-1', name: 'Http', imageDataUrl: url('http-full', 300), thumbDataUrl: url('http-small') }, { 'x-csrf-token': csrf })).json();
    const thumb = Buffer.from(await (await fetch(`${origin}/api/v1/products/${created.id}/image?size=thumb`)).arrayBuffer());
    const full = Buffer.from(await (await fetch(`${origin}/api/v1/products/${created.id}/image`)).arrayBuffer());
    assert.deepEqual(thumb, bytesOf(url('http-small')));
    assert.deepEqual(full, bytesOf(url('http-full', 300)));
    assert.equal((await send('PUT', `/api/v1/seller/products/${created.id}/thumbnail`, { thumbDataUrl: url('late') })).status, 403, 'CSRF is required');
    assert.equal((await fetch(`${origin}/api/v1/seller/products/${created.id}/thumbnail`, { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ thumbDataUrl: url('late') }) })).status, 401);
    assert.equal((await send('PUT', `/api/v1/seller/products/${created.id}/thumbnail`, { thumbDataUrl: url('late') }, { 'x-csrf-token': csrf })).status, 200);
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}/api/v1/seller/products/${created.id}/image?size=thumb`, { headers: { cookie } })).arrayBuffer()), bytesOf(url('late')));
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
