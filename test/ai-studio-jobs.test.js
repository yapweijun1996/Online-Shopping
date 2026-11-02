import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { parseKeyFile } from '../src/secret-box.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { PRODUCT_LOCK, STYLE_IDS } from '../src/ai-studio/styles.js';

const ORIGIN = 'https://seller.example.test';
const KEY = 'sk-fictional-0123456789abcdefghij-WXYZ';
const jpeg = (size = 40) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(size)]);
const dataUrl = (buffer, mime = 'image/jpeg') => `data:${mime};base64,${buffer.toString('base64')}`;
const webp = (size = 60) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), randomBytes(size)]);

async function fixture(t, overrides = {}) {
  const store = await openDatabase(':memory:'); t.after(() => store.close());
  await ensureAdmin(store, 'fixture_owner', 'FictionalPassword123!');
  await createCategory(store, { code: 'BAGS', label: 'Bags' });
  const calls = { analyze: [], edit: [], review: [] };
  const provider = {
    validateKey: async () => true,
    analyze: async (input) => { calls.analyze.push(input); return { name: 'Canvas tote', description: 'A tote bag.', category: 'BAGS', tags: ['bag'] }; },
    edit: async (input) => { calls.edit.push(input); return { mime: 'image/webp', data: webp() }; },
    review: async (input) => { calls.review.push(input); return { verdict: 'PASS', issues: [] }; },
    ...overrides
  };
  const config = { publicOrigin: ORIGIN, shopMode: 'manual', integrationKeys: parseKeyFile(`k1=${randomBytes(32).toString('base64')}\n`) };
  const handle = await createApi({ store, config, studioProvider: () => provider });
  const request = (path, method = 'GET', body, headers = {}) => handle(new Request(`${ORIGIN}${path}`,
    { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const login = await request('/api/v1/seller/session', 'POST', { username: 'fixture_owner', password: 'FictionalPassword123!' }, { origin: ORIGIN });
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrfToken;
  const headers = { cookie, origin: ORIGIN, 'x-csrf-token': csrf };
  assert.equal((await request('/api/v1/seller/ai-studio/key', 'PUT', { apiKey: KEY, expectedRevision: 0 }, headers)).status, 200);
  const product = await createProduct(store, { sku: 'TOTE-1', name: 'Canvas tote', description: 'A tote bag.', category: 'BAGS', priceMinor: 4990, currency: 'MYR', active: false, imageDataUrl: dataUrl(jpeg()) });
  return { store, request, headers, cookie, calls, product, handle };
}
const used = async (store) => Number((await store.get("SELECT COUNT(*) AS n FROM ai_studio_usage WHERE outcome IN ('OK','AMBIGUOUS')")).n);

test('analyze returns plain suggestions, records one call and needs a saved key', async (t) => {
  const f = await fixture(t);
  const res = await f.request('/api/v1/seller/ai-studio/analyze', 'POST', { imageDataUrl: dataUrl(jpeg()) }, f.headers);
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { name: 'Canvas tote', description: 'A tote bag.', category: 'BAGS', tags: ['bag'] });
  assert.deepEqual(f.calls.analyze[0].categories, [{ code: 'BAGS', label: 'Bags', active: true }]);
  assert.equal(await used(f.store), 1);
  assert.equal((await f.store.get("SELECT kind FROM ai_studio_usage")).kind, 'ANALYZE');
  await f.request('/api/v1/seller/ai-studio/key', 'DELETE', { expectedRevision: 1 }, f.headers);
  const none = await f.request('/api/v1/seller/ai-studio/analyze', 'POST', { imageDataUrl: dataUrl(jpeg()) }, f.headers);
  assert.equal(none.status, 409); assert.equal((await none.json()).error.code, 'AI_STUDIO_NO_KEY');
  assert.equal(f.calls.analyze.length, 1);
});

test('analyze validates input, roles and CSRF before any provider call', async (t) => {
  const f = await fixture(t);
  const post = (body, headers = f.headers) => f.request('/api/v1/seller/ai-studio/analyze', 'POST', body, headers);
  for (const body of [{}, { imageDataUrl: 'data:text/html;base64,AAAA' }, { imageDataUrl: dataUrl(jpeg()), extra: 1 }, { imageDataUrl: dataUrl(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(600 * 1024)])) }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post({ imageDataUrl: dataUrl(jpeg()) }, { cookie: f.cookie })).status, 403);
  assert.equal((await post({ imageDataUrl: dataUrl(jpeg()) }, {})).status, 401);
  await f.store.run("UPDATE seller_account SET role = 'STAFF'");
  assert.equal((await post({ imageDataUrl: dataUrl(jpeg()) })).status, 403);
  assert.equal(f.calls.analyze.length, 0);
});

test('provider failures map to safe errors and only billable outcomes count towards the cap', async (t) => {
  const cases = [['STUDIO_KEY_REJECTED', 422, 'AI_STUDIO_KEY_REJECTED', 0], ['STUDIO_REQUEST_REJECTED', 422, 'AI_STUDIO_REQUEST_REJECTED', 0],
    ['STUDIO_RATE_LIMITED', 429, 'AI_STUDIO_PROVIDER_LIMIT', 0], ['STUDIO_UNAVAILABLE', 502, 'AI_STUDIO_UNAVAILABLE', 0],
    ['STUDIO_REFUSED', 422, 'AI_STUDIO_REFUSED', 1], ['STUDIO_BAD_RESPONSE', 502, 'AI_STUDIO_BAD_RESPONSE', 1], ['STUDIO_TIMEOUT', 504, 'AI_STUDIO_TIMEOUT', 1]];
  for (const [code, status, apiCode, billed] of cases) {
    const f = await fixture(t, { analyze: async () => { throw Object.assign(new Error(`secret ${KEY}`), { code }); } });
    const res = await f.request('/api/v1/seller/ai-studio/analyze', 'POST', { imageDataUrl: dataUrl(jpeg()) }, f.headers);
    assert.equal(res.status, status);
    const text = await res.text();
    assert.equal(JSON.parse(text).error.code, apiCode);
    assert.doesNotMatch(text, /sk-fictional|secret/);
    assert.equal(await used(f.store), billed);   // refused, unreadable and timed-out answers may have been charged
    assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM ai_studio_usage WHERE outcome = 'PENDING'")).n), 0);
  }
});

test('one style makes one image, stores provenance and an advisory review, and sends only name and category', async (t) => {
  const f = await fixture(t);
  const res = await f.request(`/api/v1/seller/ai-studio/products/${f.product.id}/images`, 'POST', { style: 'macro' }, f.headers);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual({ style: body.style, aiGenerated: body.aiGenerated, verdict: body.verdict, reviewed: body.reviewed }, { style: 'macro', aiGenerated: true, verdict: 'PASS', reviewed: true });
  const [edit] = f.calls.edit;
  assert.equal(edit.size, '1024x1280'); assert.equal(edit.format, 'webp');
  assert.ok(edit.prompt.startsWith(PRODUCT_LOCK)); assert.match(edit.prompt, /Canvas tote \(category: Bags\)/); assert.doesNotMatch(edit.prompt, /4990|49\.9|TOTE-1/);
  assert.equal(f.calls.review.length, 1);
  assert.equal(await used(f.store), 2);
  const gallery = await f.store.all('SELECT id FROM product_gallery_image WHERE product_id = ?', f.product.id);
  assert.deepEqual(gallery.map((row) => row.id), [body.galleryImageId]);
  const list = await (await f.request(`/api/v1/seller/ai-studio/products/${f.product.id}/images`, 'GET', null, { cookie: f.cookie })).json();
  assert.deepEqual(list.items.map((item) => [item.galleryImageId, item.style, item.verdict]), [[body.galleryImageId, 'macro', 'PASS']]);
  const product = await f.store.get('SELECT active FROM product WHERE id = ?', f.product.id);
  assert.equal(Number(product.active), 0);
  await f.store.run('DELETE FROM product_gallery_image WHERE id = ?', body.galleryImageId);
  assert.deepEqual((await (await f.request(`/api/v1/seller/ai-studio/products/${f.product.id}/images`, 'GET', null, { cookie: f.cookie })).json()).items, []);
});

test('all seven styles are accepted and each has its own size', async (t) => {
  const f = await fixture(t);
  for (const style of STYLE_IDS) assert.equal((await f.request(`/api/v1/seller/ai-studio/products/${f.product.id}/images`, 'POST', { style }, f.headers)).status, 201);
  assert.deepEqual(f.calls.edit.map((call) => call.size), ['1024x1280', '1024x1280', '1024x1280', '1024x1024', '1024x1280', '1024x1280', '1536x864']);
  for (const bad of [{}, { style: 'cinematic' }, { style: 'studio', extra: 1 }, { styles: ['studio'] }]) {
    assert.equal((await f.request(`/api/v1/seller/ai-studio/products/${f.product.id}/images`, 'POST', bad, f.headers)).status, 400);
  }
  assert.equal((await f.request('/api/v1/seller/ai-studio/products/00000000-0000-4000-8000-000000000000/images', 'POST', { style: 'studio' }, f.headers)).status, 404);
});

test('a failed review leaves the image unreviewed; an ambiguous edit is charged to the cap and never saved', async (t) => {
  const f = await fixture(t, { review: async () => { throw Object.assign(new Error('x'), { code: 'STUDIO_UNAVAILABLE' }); } });
  const res = await f.request(`/api/v1/seller/ai-studio/products/${f.product.id}/images`, 'POST', { style: 'studio' }, f.headers);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual({ verdict: body.verdict, reviewed: body.reviewed }, { verdict: null, reviewed: false });
  assert.equal(await used(f.store), 1);
  const g = await fixture(t, { edit: async () => { throw Object.assign(new Error('t'), { code: 'STUDIO_TIMEOUT', ambiguous: true }); } });
  const timed = await g.request(`/api/v1/seller/ai-studio/products/${g.product.id}/images`, 'POST', { style: 'studio' }, g.headers);
  assert.equal(timed.status, 504);
  assert.match((await timed.json()).error.message, /may still have been charged/);
  assert.equal(await used(g.store), 1);
  assert.equal((await g.store.all('SELECT id FROM product_gallery_image')).length, 0);
});

test('an image over the gallery limit is rejected after being charged and not stored', async (t) => {
  const f = await fixture(t, { edit: async () => ({ mime: 'image/webp', data: webp(600 * 1024) }) });
  const res = await f.request(`/api/v1/seller/ai-studio/products/${f.product.id}/images`, 'POST', { style: 'studio' }, f.headers);
  assert.equal(res.status, 422); assert.equal((await res.json()).error.code, 'AI_STUDIO_IMAGE_REJECTED');
  assert.equal((await f.store.all('SELECT id FROM product_gallery_image')).length, 0);
  assert.equal(await used(f.store), 1);
  assert.equal(f.calls.review.length, 0);
});

test('images are only generated for unpublished products with room in a non-shared gallery', async (t) => {
  const f = await fixture(t);
  const url = `/api/v1/seller/ai-studio/products/${f.product.id}/images`;
  await f.store.run('UPDATE product SET active = 1 WHERE id = ?', f.product.id);
  const live = await f.request(url, 'POST', { style: 'studio' }, f.headers);
  assert.equal(live.status, 409); assert.equal((await live.json()).error.code, 'AI_STUDIO_PUBLISHED');
  await f.store.run('UPDATE product SET active = 0 WHERE id = ?', f.product.id);
  const sibling = await createProduct(f.store, { sku: 'TOTE-2', name: 'Canvas tote', description: 'A tote bag.', category: 'BAGS', priceMinor: 4990, currency: 'MYR', active: true, variantGroup: 'TOTE', variantLabel: 'Red' });
  await f.store.run('UPDATE product SET listing_id = (SELECT listing_id FROM product WHERE id = ?) WHERE id = ?', f.product.id, sibling.id);
  assert.equal((await f.request(url, 'POST', { style: 'studio' }, f.headers)).status, 409);
  await f.store.run('UPDATE product SET active = 0 WHERE id = ?', sibling.id);
  for (let i = 0; i < 10; i += 1) await f.store.run("INSERT INTO product_gallery_image(id, product_id, position, mime, data, created_at) VALUES (?, ?, ?, 'image/jpeg', ?, ?)", `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, f.product.id, i + 1, jpeg(), new Date().toISOString());
  const full = await f.request(url, 'POST', { style: 'studio' }, f.headers);
  assert.equal(full.status, 409); assert.equal((await full.json()).error.code, 'AI_STUDIO_GALLERY_FULL');
  assert.equal(f.calls.edit.length, 0);               // nothing was charged for any refused request
  assert.equal(await used(f.store), 0);
});

test('two simultaneous images for one product each keep their own style and review record', async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { edit: async () => { await gate; return { mime: 'image/webp', data: webp() }; },
    review: async ({ result }) => ({ verdict: 'PASS', issues: [] }) });
  const send = (style) => f.request(`/api/v1/seller/ai-studio/products/${f.product.id}/images`, 'POST', { style }, f.headers);
  const both = [send('studio'), send('hero')];
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  const results = await Promise.all((await Promise.all(both)).map((r) => r.json()));
  assert.equal(new Set(results.map((r) => r.galleryImageId)).size, 2);
  const rows = await f.store.all('SELECT gallery_image_id, style FROM ai_studio_image ORDER BY style');
  assert.deepEqual(rows.map((r) => r.style), ['hero', 'studio']);
  assert.equal(new Set(rows.map((r) => r.gallery_image_id)).size, 2);
  for (const result of results) assert.equal(rows.find((r) => r.gallery_image_id === result.galleryImageId).style, result.style);
});

test('simultaneous requests cannot push past the daily cap', async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let edits = 0;
  const f = await fixture(t, { edit: async () => { edits += 1; await gate; return { mime: 'image/webp', data: webp() }; } });
  await f.request('/api/v1/seller/ai-studio/settings', 'PATCH', { dailyCallCap: 2, expectedRevision: 1 }, f.headers);
  const send = (style) => f.request(`/api/v1/seller/ai-studio/products/${f.product.id}/images`, 'POST', { style }, f.headers);
  const both = [send('studio'), send('hero')];
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  assert.deepEqual((await Promise.all(both)).map((r) => r.status).sort(), [201, 429]);
  assert.equal(edits, 1);
  assert.equal(await used(f.store), 2);
});

test('the daily cap needs room for the image and its review before any call is made', async (t) => {
  const f = await fixture(t);
  await f.request('/api/v1/seller/ai-studio/settings', 'PATCH', { dailyCallCap: 3, expectedRevision: 1 }, f.headers);
  assert.equal((await f.request(`/api/v1/seller/ai-studio/products/${f.product.id}/images`, 'POST', { style: 'studio' }, f.headers)).status, 201);
  const refused = await f.request(`/api/v1/seller/ai-studio/products/${f.product.id}/images`, 'POST', { style: 'hero' }, f.headers);
  assert.equal(refused.status, 429); assert.equal((await refused.json()).error.code, 'AI_STUDIO_CAP');
  assert.equal(f.calls.edit.length, 1);
  assert.equal((await f.request('/api/v1/seller/ai-studio/analyze', 'POST', { imageDataUrl: dataUrl(jpeg()) }, f.headers)).status, 200);
  assert.equal((await f.request('/api/v1/seller/ai-studio/analyze', 'POST', { imageDataUrl: dataUrl(jpeg()) }, f.headers)).status, 429);
});

test('at most two generations run at once on the host', async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { edit: async () => { await gate; return { mime: 'image/webp', data: webp() }; } });
  const send = (style) => f.request(`/api/v1/seller/ai-studio/products/${f.product.id}/images`, 'POST', { style }, f.headers);
  const running = [send('studio'), send('hero')];
  await new Promise((resolve) => setTimeout(resolve, 100));
  const third = await send('macro');
  assert.equal(third.status, 429); assert.equal((await third.json()).error.code, 'AI_STUDIO_BUSY');
  release();
  assert.deepEqual((await Promise.all(running)).map((r) => r.status), [201, 201]);
});
