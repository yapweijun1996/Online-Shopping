import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../src/worker.js';
import { createApi } from '../src/app.js';
import { createSession } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { initializeShop, shopObjectName } from '../src/shop-setup.js';
import { createProduct, getProduct } from '../src/products.js';

const origin = 'https://worker-fixture.invalid';
const PRODUCT_BYTES = 7_500_000, DEFAULT_BYTES = 1024 * 1024, IMAGE_BYTES = 512 * 1024;
const png = readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// A valid ancillary PNG text chunk gives each decodable image distinct bytes
// at exactly 512 KiB, instead of relying on arbitrary trailing garbage.
const maximumImages = Array.from({ length: 10 }, (_, index) => {
  assert.equal(png.subarray(-8, -4).toString(), 'IEND');
  const text = Buffer.alloc(IMAGE_BYTES - png.length - 12, 65 + index);
  Buffer.from('Synthetic QA\0').copy(text);
  const chunk = Buffer.alloc(text.length + 12);
  chunk.writeUInt32BE(text.length); chunk.write('tEXt', 4); text.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const bytes = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  assert.equal(bytes.length, IMAGE_BYTES);
  return { bytes, imageDataUrl: 'data:image/png;base64,' + bytes.toString('base64') };
});

function fixture(t) {
  const store = openDatabase(':memory:'); t.after(() => store.close());
  const config = { shopMode: 'public-demo', demoRevision: 'worker-ingress-qa', production: false };
  initializeShop(store, config);
  const api = createApi({ store, config }), session = createSession(store);
  const product = createProduct(store, { sku: 'QA-WORKER-ONLY', name: 'Fictional Worker fixture',
    description: 'Synthetic ingress verification', category: 'TRAVEL', priceMinor: 900, active: true,
    imageDataUrl: 'data:image/png;base64,' + png.toString('base64') });
  const path = '/api/v1/seller/products/' + product.id;
  const forwarded = [], objectNames = [];
  const env = { SHOP_MODE: config.shopMode, SHOP_DEMO_REVISION: config.demoRevision,
    ASSETS: { fetch() { throw new Error('API request incorrectly reached assets'); } },
    SHOP: { idFromName(name) { objectNames.push(name); return name; }, get(id, options) {
      assert.equal(id, shopObjectName(config.shopMode, config.demoRevision));
      assert.equal(options.locationHint, 'apac');
      return { async fetch(request) {
        const bytes = new Uint8Array(await request.clone().arrayBuffer());
        const record = { method: request.method, url: request.url, bytes: bytes.length, sha256: digest(bytes),
          contentLength: request.headers.get('content-length'), clientAddress: request.headers.get('x-real-ip') };
        forwarded.push(record);
        const response = await api(request, { clientAddress: record.clientAddress });
        record.status = response.status; return response;
      } };
    } },
  };
  const request = (body, { route = path, method = 'PATCH', auth = true, headers = {} } = {}) => new Request(origin + route, {
    method, headers: { origin, 'content-type': 'application/json',
      ...(auth ? { cookie: 'seller_session=' + session.token, 'x-csrf-token': session.csrfToken } : {}),
      'cf-connecting-ip': '203.0.113.7', 'x-real-ip': 'untrusted-client-value', ...headers },
    body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
  const call = (body, options) => worker.fetch(request(body, options), env);
  const current = () => getProduct(store, product.id, true, config.shopMode);
  const snapshot = () => ({ product: store.get('SELECT * FROM product WHERE id = ?', product.id),
    images: store.all('SELECT * FROM product_gallery_image WHERE product_id = ? ORDER BY position', product.id) });
  return { store, env, path, product, forwarded, objectNames, request, call, current, snapshot };
}

function paddedJSON(value, bytes) {
  const prefix = JSON.stringify(value);
  assert.ok(Buffer.byteLength(prefix) <= bytes);
  return prefix + ' '.repeat(bytes - Buffer.byteLength(prefix));
}

function streamedJSON(value, bytes) {
  const prefix = Buffer.from(JSON.stringify(value)), stats = { emitted: 0, pulls: 0, cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      stats.pulls++;
      if (stats.emitted === bytes) { controller.close(); return; }
      const chunk = Buffer.alloc(Math.min(64 * 1024, bytes - stats.emitted), 32);
      if (stats.emitted < prefix.length) prefix.copy(chunk, 0, stats.emitted, stats.emitted + chunk.length);
      stats.emitted += chunk.length; controller.enqueue(chunk);
    },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, stats };
}

for (const count of [2, 10]) test(`Worker forwards ${count} maximum-size PNGs to the real API and persists exact gallery bytes`, async t => {
  const f = fixture(t), before = f.current();
  const body = JSON.stringify({ gallery: maximumImages.slice(0, count).map(x => ({ imageDataUrl: x.imageDataUrl })), expectedUpdatedAt: before.updatedAt });
  assert.ok(Buffer.byteLength(body) > DEFAULT_BYTES && Buffer.byteLength(body) < PRODUCT_BYTES);
  const response = await f.call(body, { route: f.path + '?synthetic=1', headers: { 'content-length': String(Buffer.byteLength(body)) } });
  t.diagnostic(JSON.stringify({ images: count, imageBytes: IMAGE_BYTES, bodyBytes: Buffer.byteLength(body), status: response.status, forwarded: f.forwarded.length }));
  assert.equal(response.status, 200);
  const saved = await response.json(); assert.equal(saved.images.length, count);
  const rows = f.store.all('SELECT data FROM product_gallery_image WHERE product_id = ? ORDER BY position', f.product.id);
  assert.equal(rows.length, count);
  rows.forEach((row, index) => {
    assert.equal(row.data.byteLength, IMAGE_BYTES);
    assert.deepEqual(Buffer.from(row.data), maximumImages[index].bytes);
  });
  assert.equal(f.forwarded.length, 1); assert.equal(f.forwarded[0].bytes, Buffer.byteLength(body));
  assert.equal(f.forwarded[0].sha256, digest(Buffer.from(body))); assert.equal(f.forwarded[0].contentLength, null);
  assert.equal(f.forwarded[0].clientAddress, '203.0.113.7'); assert.equal(f.forwarded[0].status, 200);
  assert.deepEqual(f.objectNames, [shopObjectName('public-demo', 'worker-ingress-qa')]);
});

test('declared gallery body exactly at budget reaches API; one byte over is rejected before reading or forwarding', async t => {
  const f = fixture(t), body = paddedJSON({ name: 'Fictional exact budget', gallery: [{ id: 'main' }], expectedUpdatedAt: f.current().updatedAt }, PRODUCT_BYTES);
  assert.equal((await f.call(body, { headers: { 'content-length': String(PRODUCT_BYTES) } })).status, 200);
  assert.equal(f.current().name, 'Fictional exact budget'); assert.equal(f.forwarded[0].bytes, PRODUCT_BYTES);
  const before = f.snapshot(), stream = streamedJSON({}, PRODUCT_BYTES + 1), request = f.request(stream.body, { headers: { 'content-length': String(PRODUCT_BYTES + 1) } });
  const response = await worker.fetch(request, f.env);
  assert.equal(response.status, 413); assert.equal(stream.stats.pulls, 0); assert.equal(f.forwarded.length, 1);
  assert.deepEqual(f.snapshot(), before); await request.body.cancel();
});

test('actual streamed bytes enforce exact budget despite missing or dishonest Content-Length; overflow cancels without forwarding', async t => {
  const f = fixture(t);
  for (const headers of [{}, { 'content-length': '1' }]) {
    const value = { name: 'Fictional streamed budget', gallery: [{ id: 'main' }], expectedUpdatedAt: f.current().updatedAt };
    const exact = streamedJSON(value, PRODUCT_BYTES), count = f.forwarded.length;
    assert.equal((await f.call(exact.body, { headers })).status, 200);
    assert.equal(exact.stats.emitted, PRODUCT_BYTES); assert.equal(exact.stats.cancelled, false);
    assert.equal(f.forwarded.length, count + 1); assert.equal(f.forwarded.at(-1).bytes, PRODUCT_BYTES);
    const before = f.snapshot(), over = streamedJSON(value, PRODUCT_BYTES + 1 + 5 * 64 * 1024);
    assert.equal((await f.call(over.body, { headers })).status, 413);
    assert.equal(over.stats.cancelled, true); assert.ok(over.stats.emitted < PRODUCT_BYTES + 1 + 5 * 64 * 1024);
    assert.equal(f.forwarded.length, count + 1); assert.deepEqual(f.snapshot(), before);
  }
});

test('unrelated paths and methods keep one-MiB ingress; existing single-gallery API budget remains stricter', async t => {
  const f = fixture(t), body = paddedJSON({}, DEFAULT_BYTES + 1), before = f.snapshot();
  for (const [method, route] of [
    ['POST', '/api/v1/seller/products'], ['POST', f.path], ['PUT', f.path], ['PATCH', f.path + '/image'],
    ['PATCH', f.path + '/gallery'], ['POST', f.path + '/gallery'], ['PATCH', f.path + '/extra'],
    ['PATCH', '/api/v1/products/' + f.product.id], ['PATCH', '/api/v1/seller/products/not-a-product-id'],
    ['PATCH', '/api/v1/seller/products/' + f.product.id.toUpperCase()], ['PATCH', '/api/v1/seller/company-settings'],
    ['POST', '/api/v1/orders'], ['POST', '/api/v1/seller/session'],
  ]) assert.equal((await f.call(body, { method, route })).status, 413, `${method} ${route}`);
  assert.equal(f.forwarded.length, 0); assert.deepEqual(f.snapshot(), before);
  assert.equal((await f.call(paddedJSON({}, DEFAULT_BYTES), { route: '/health', method: 'POST' })).status, 404);
  assert.equal(f.forwarded.length, 1); assert.equal(f.forwarded[0].bytes, DEFAULT_BYTES);
  assert.equal((await f.call(paddedJSON({}, 750_001), { route: f.path + '/gallery', method: 'POST' })).status, 413);
  assert.equal(f.forwarded.length, 2); assert.equal(f.forwarded[1].bytes, 750_001);
});

test('larger product ingress preserves API authentication, origin, CSRF, JSON and image ownership rejection without writes', async t => {
  const f = fixture(t), before = f.snapshot();
  const body = paddedJSON({ name: 'Must not be persisted', gallery: [{ id: 'main' }], expectedUpdatedAt: f.current().updatedAt }, DEFAULT_BYTES + 100);
  for (const [options, text, status] of [
    [{ auth: false }, body, 401],
    [{ headers: { 'x-csrf-token': '' } }, body, 403],
    [{ headers: { origin: 'https://other-fixture.invalid' } }, body, 403],
    [{}, '{' + ' '.repeat(DEFAULT_BYTES + 100), 400],
    [{ headers: { 'content-type': 'text/plain' } }, body, 415],
    [{}, paddedJSON({ gallery: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], expectedUpdatedAt: f.current().updatedAt }, DEFAULT_BYTES + 100), 400],
  ]) {
    const count = f.forwarded.length, response = await f.call(text, options);
    assert.equal(response.status, status); assert.equal(f.forwarded.length, count + 1);
    assert.equal(f.forwarded.at(-1).status, status); assert.deepEqual(f.snapshot(), before);
  }
});

test('interrupted input stream never reaches the object or mutates data', async t => {
  const f = fixture(t), before = f.snapshot(), errors = [], originalError = console.error;
  console.error = (...values) => errors.push(values.join(' ')); t.after(() => { console.error = originalError; });
  let sent = false;
  const body = new ReadableStream({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(Buffer.from('{"gallery":')); }
    else controller.error(Object.assign(new Error('Synthetic interrupted stream'), { code: 'SYNTHETIC_STREAM_ERROR' }));
  } }, { highWaterMark: 0 });
  assert.equal((await f.call(body)).status, 500); assert.equal(f.forwarded.length, 0);
  assert.deepEqual(f.snapshot(), before); assert.ok(errors.some(value => value.includes('SYNTHETIC_STREAM_ERROR')));
});
