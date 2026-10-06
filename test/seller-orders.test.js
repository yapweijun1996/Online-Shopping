import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { createProduct } from '../src/products.js';
import { createCategory } from '../src/settings.js';

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'online-shopping-review-'));
  const config = {
    username: 'review_owner', password: 'LocalReviewPass123!',
    dbPath: path.join(directory, 'private.db'), production: false, publicOrigin: null,
  };
  const app = await createApp(config);
  await createCategory(app.database, { code: 'EXAMPLES', label: 'Examples' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const product = await createProduct(app.database, {
    sku: 'REVIEW-ITEM', name: 'Example review item', description: 'Fictional item',
    category: 'EXAMPLES', priceMinor: 1250, currency: 'MYR', active: true,
  });
  let orderKey = 0;

  async function request(method, url, body, headers = {}) {
    const response = await fetch(`${origin}${url}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { response, data: await response.json() };
  }

  return {
    app, config, directory, origin, product, request,
    async submit({ buyerName = 'Example Buyer', accessKey } = {}) {
      const body = {
        buyer: { fullName: buyerName, whatsappPhone: '+6581234567', email: 'example@example.invalid' },
        whatsappOrderContactOptIn: true,
        locale: 'en',
        deliveries: [{
          recipient: { fullName: 'Example Recipient', phone: '+60123456789' },
          address: { line1: 'Example Street', line2: 'Unit 1', city: 'Example City', postcode: '50000', country: 'MY' },
          items: [{ productId: product.id, quantity: 2, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency }],
        }],
      };
      return request('POST', '/api/v1/orders', body, {
        origin, 'idempotency-key': accessKey || `seller-review-intent-${++orderKey}`,
      });
    },
    async login() {
      const result = await request('POST', '/api/v1/seller/session', {
        username: config.username, password: config.password,
      }, { origin });
      assert.equal(result.response.status, 200);
      return {
        cookie: result.response.headers.get('set-cookie').split(';')[0],
        csrf: result.data.csrfToken,
      };
    },
    async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('customer status credentials reveal only own 90-day seller decision', async () => {
  const f = await fixture();
  try {
    const firstKey = randomUUID();
    const secondKey = randomUUID();
    const first = await f.submit({ accessKey: firstKey });
    const second = await f.submit({ buyerName: 'Another Buyer', accessKey: secondKey });
    assert.equal(first.response.status, 201);
    const lookup = (orders, headers = { origin: f.origin }) =>
      f.request('POST', '/api/v1/orders/statuses', { orders }, headers);
    const firstCredential = { orderNo: first.data.orderNo, accessKey: firstKey };
    const secondCredential = { orderNo: second.data.orderNo, accessKey: secondKey };
    assert.equal((await lookup([firstCredential], {})).response.status, 403);
    assert.equal((await f.request('GET', `/api/v1/orders/${first.data.orderNo}`)).response.status, 404);
    const initial = await lookup([firstCredential, secondCredential]);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(initial.data.items.map(({ orderNo, status }) => [orderNo, status]), [
      [first.data.orderNo, 'SUBMITTED'], [second.data.orderNo, 'SUBMITTED'],
    ]);
    assert.deepEqual(Object.keys(initial.data.items[0]).sort(), ['orderNo', 'status', 'updatedAt']);
    assert.ok(!JSON.stringify(initial.data).includes('Example Buyer'));
    assert.ok(!JSON.stringify(initial.data).includes('+6581234567'));
    assert.deepEqual((await lookup([{ orderNo: first.data.orderNo, accessKey: secondKey }])).data.items, []);
    assert.deepEqual((await lookup([{ orderNo: second.data.orderNo, accessKey: firstKey }])).data.items, []);
    assert.equal((await lookup([firstCredential, firstCredential])).response.status, 400);
    assert.equal((await lookup([{ orderNo: first.data.orderNo, accessKey: 'guess' }])).response.status, 400);
    const { cookie, csrf } = await f.login();
    const ids = (await f.app.database.all('SELECT id FROM shop_order ORDER BY order_no')).map(({ id }) => id);
    const headers = { origin: f.origin, cookie, 'x-csrf-token': csrf };
    assert.equal((await f.request('POST', `/api/v1/seller/orders/${ids[0]}/confirm`, { expectedRevision: 1 }, headers)).response.status, 200);
    assert.equal((await f.request('POST', `/api/v1/seller/orders/${ids[1]}/reject`, { expectedRevision: 1, reason: 'Unavailable.' }, headers)).response.status, 200);
    const reviewed = await lookup([firstCredential, secondCredential]);
    assert.deepEqual(reviewed.data.items.map(({ status }) => status), ['CONFIRMED', 'REJECTED']);
    assert.ok(!JSON.stringify(reviewed.data).includes('Unavailable.'));
    await f.app.database.run('UPDATE shop_order SET submitted_at = ? WHERE order_no = ?',
      new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), first.data.orderNo);
    assert.deepEqual((await lookup([firstCredential])).data.items, []);
    let limited = false;
    for (let attempt = 0; attempt < 31; attempt++) {
      if ((await lookup([secondCredential])).response.status === 429) { limited = true; break; }
    }
    assert.equal(limited, true);
  } finally { await f.close(); }
});

test('seller queue and detail expose one authorized order snapshot with no public lookup', async () => {
  const f = await fixture();
  try {
    const first = await f.submit();
    const second = await f.submit({ buyerName: 'Another Buyer' });
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    await f.app.database.run(`UPDATE shop_order SET whatsapp_opt_in = 0,
      whatsapp_consent_at = NULL, whatsapp_consent_version = NULL WHERE order_no = ?`, second.data.orderNo);
    const id = (await f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', first.data.orderNo)).id;
    for (const url of ['/api/v1/seller/orders', `/api/v1/seller/orders/${id}`]) {
      const denied = await f.request('GET', url);
      assert.equal(denied.response.status, 401);
      assert.equal(denied.response.headers.get('cache-control'), 'no-store');
      assert.ok(!JSON.stringify(denied.data).includes('Example Buyer'));
    }
    assert.equal((await f.request('GET', `/api/v1/orders/${id}`)).response.status, 404);
    const { cookie } = await f.login();
    const queue = await f.request('GET', '/api/v1/seller/orders?status=SUBMITTED&limit=1', null, { cookie });
    assert.equal(queue.response.status, 200);
    assert.equal(queue.data.items.length, 1);
    assert.equal(queue.data.nextOffset, 1);
    assert.ok(!Object.hasOwn(queue.data.items[0], 'buyerPhone'));
    const next = await f.request('GET', `/api/v1/seller/orders?limit=1&offset=${queue.data.nextOffset}`, null, { cookie });
    assert.equal(next.data.items.length, 1);
    assert.equal(next.data.nextOffset, null);
    const searched = await f.request('GET', `/api/v1/seller/orders?search=${first.data.orderNo}`, null, { cookie });
    assert.deepEqual(searched.data.items.map(({ orderNo }) => orderNo), [first.data.orderNo]);
    // List rows say what was bought: first item name, cover (null without an image) and the line count.
    assert.deepEqual(searched.data.items[0].preview, { itemCount: 1, name: 'Example review item', imageUrl: null });
    const invalid = await f.request('GET', '/api/v1/seller/orders?status=UNKNOWN', null, { cookie });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.data.error.field, 'status');
    const detail = await f.request('GET', `/api/v1/seller/orders/${id}`, null, { cookie });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.response.headers.get('cache-control'), 'no-store');
    assert.equal(detail.data.buyer.whatsappPhone, '+6581234567');
    assert.equal(detail.data.buyer.whatsappOrderContactOptIn, true);
    const historical = await f.request('GET', `/api/v1/seller/orders/${(await f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', second.data.orderNo)).id}`, null, { cookie });
    assert.equal(historical.data.buyer.whatsappOrderContactOptIn, false);
    assert.equal(detail.data.deliveries[0].recipient.phone, '+60123456789');
    assert.equal(detail.data.deliveries[0].address.line2, 'Unit 1');
    assert.equal(detail.data.deliveries[0].items[0].priceMinor, 1250);
    // Staff can recognise the item: the product page opens on the shop origin and the cover is the seller image path (null without an image).
    assert.equal(detail.data.deliveries[0].items[0].productUrl, `${f.origin}/shop/#product/${f.product.id.toLowerCase()}`);
    assert.equal(detail.data.deliveries[0].items[0].imageUrl, null);
    assert.equal(detail.data.deliveries[0].items[0].lineTotalMinor, 2500);
    assert.equal(detail.data.events[0].type, 'SUBMITTED');
    assert.equal(detail.data.events.length, 1);
  } finally { await f.close(); }
});

test('submitted orders have no deletion endpoint and remain readable', async () => {
  const f = await fixture();
  try {
    const submitted = await f.submit();
    assert.equal(submitted.response.status, 201);
    const id = (await f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', submitted.data.orderNo)).id;
    const { cookie, csrf } = await f.login();
    const deleted = await f.request('DELETE', `/api/v1/seller/orders/${id}`, null, {
      origin: f.origin, cookie, 'x-csrf-token': csrf,
    });
    assert.equal(deleted.response.status, 404);
    for (const table of ['shop_order', 'delivery', 'order_item', 'order_event', 'checkout_idempotency']) {
      assert.equal((await f.app.database.get(`SELECT COUNT(*) AS count FROM ${table}`)).count, 1, table);
    }
    assert.equal((await f.request('GET', `/api/v1/seller/orders/${id}`, null, { cookie })).response.status, 200);
  } finally { await f.close(); }
});

test('seller decisions require origin, CSRF, current revision, and append audit once', async () => {
  const f = await fixture();
  try {
    await f.submit();
    await f.submit({ buyerName: 'Another Buyer' });
    const ids = (await f.app.database.all('SELECT id FROM shop_order ORDER BY order_no')).map((row) => row.id);
    const { cookie, csrf } = await f.login();
    const url = `/api/v1/seller/orders/${ids[0]}/confirm`;
    assert.equal((await f.request('POST', url, { expectedRevision: 1 }, { origin: f.origin })).response.status, 401);
    assert.equal((await f.request('POST', url, { expectedRevision: 1 }, { origin: f.origin, cookie })).response.status, 403);
    assert.equal((await f.request('POST', url, { expectedRevision: 1 }, { origin: 'https://other.invalid', cookie, 'x-csrf-token': csrf })).response.status, 403);
    assert.equal((await f.request('POST', url, { expectedRevision: 0 }, { origin: f.origin, cookie, 'x-csrf-token': csrf })).response.status, 400);
    assert.equal((await f.request('POST', url, { expectedRevision: 1, reason: 'unexpected' }, { origin: f.origin, cookie, 'x-csrf-token': csrf })).response.status, 400);
    const approved = await f.request('POST', url, { expectedRevision: 1 }, { origin: f.origin, cookie, 'x-csrf-token': csrf });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.data.status, 'CONFIRMED');
    assert.equal(approved.data.revision, 2);
    assert.deepEqual(approved.data.events.map(({ type }) => type), ['SUBMITTED', 'CONFIRMED']);
    assert.equal(approved.data.events[1].actorId, f.config.username);
    assert.equal(approved.data.events[1].previousStatus, 'SUBMITTED');
    const stale = await f.request('POST', url, { expectedRevision: 1 }, { origin: f.origin, cookie, 'x-csrf-token': csrf });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.data.error.code, 'STALE_REVISION');
    const rejectUrl = `/api/v1/seller/orders/${ids[1]}/reject`;
    for (const reason of ['', 'x'.repeat(501)]) {
      const invalid = await f.request('POST', rejectUrl, { expectedRevision: 1, reason }, { origin: f.origin, cookie, 'x-csrf-token': csrf });
      assert.equal(invalid.response.status, 400);
      assert.equal(invalid.data.error.field, 'reason');
    }
    const rejected = await f.request('POST', rejectUrl, { expectedRevision: 1, reason: 'Cannot fulfill this order.' },
      { origin: f.origin, cookie, 'x-csrf-token': csrf });
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.data.status, 'REJECTED');
    assert.equal(rejected.data.revision, 2);
    assert.equal(rejected.data.events[1].reason, 'Cannot fulfill this order.');
    assert.equal((await f.app.database.get('SELECT COUNT(*) AS count FROM order_event')).count, 4);
  } finally { await f.close(); }
});

test('simultaneous decisions cannot overwrite one another and audit failure rolls back', async () => {
  const f = await fixture();
  try {
    await f.submit();
    const id = (await f.app.database.get('SELECT id FROM shop_order')).id;
    const { cookie, csrf } = await f.login();
    const headers = { origin: f.origin, cookie, 'x-csrf-token': csrf };
    const url = `/api/v1/seller/orders/${id}`;
    await f.app.database.exec(`CREATE TRIGGER fail_review BEFORE INSERT ON order_event
      WHEN NEW.event_type = 'CONFIRMED' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const failed = await f.request('POST', `${url}/confirm`, { expectedRevision: 1 }, headers);
    assert.equal(failed.response.status, 500);
    assert.equal((await f.app.database.get('SELECT status, revision FROM shop_order WHERE id = ?', id)).status, 'SUBMITTED');
    assert.equal((await f.app.database.get('SELECT status, revision FROM shop_order WHERE id = ?', id)).revision, 1);
    await f.app.database.exec('DROP TRIGGER fail_review');
    const results = await Promise.all([
      f.request('POST', `${url}/confirm`, { expectedRevision: 1 }, headers),
      f.request('POST', `${url}/reject`, { expectedRevision: 1, reason: 'Cannot fulfill.' }, headers),
    ]);
    assert.deepEqual(results.map(({ response }) => response.status).sort(), [200, 409]);
    const detail = await f.request('GET', url, null, { cookie });
    assert.equal(detail.data.revision, 2);
    assert.equal(detail.data.events.length, 2);
    assert.ok(['CONFIRMED', 'REJECTED'].includes(detail.data.status));
  } finally { await f.close(); }
});

test('tracked stock blocks oversell at checkout and is deducted only when the seller confirms', async () => {
  const f = await fixture();
  try {
    const session = await f.login();
    const decide = (id, action, body) => f.request('POST', `/api/v1/seller/orders/${id}/${action}`, body,
      { origin: f.origin, cookie: session.cookie, 'x-csrf-token': session.csrf });
    const stock = async () => (await f.app.database.get('SELECT stock_quantity AS n FROM product WHERE id = ?', f.product.id)).n;
    // Unlimited by default: stock is null and the public API reports it in stock.
    assert.equal(await stock(), null);
    assert.equal((await f.request('GET', `/api/v1/products/${f.product.id}`)).data.inStock, true);
    // Turn tracking on with 3 units; each test order buys 2.
    const patch = await f.request('PATCH', `/api/v1/seller/products/${f.product.id}`, { stockQuantity: 3 },
      { origin: f.origin, cookie: session.cookie, 'x-csrf-token': session.csrf });
    assert.equal(patch.response.status, 200);
    assert.equal(patch.data.stockQuantity, 3);
    assert.equal((await f.request('PATCH', `/api/v1/seller/products/${f.product.id}`, { stockQuantity: -1 },
      { origin: f.origin, cookie: session.cookie, 'x-csrf-token': session.csrf })).response.status, 400);
    const first = await f.submit();
    assert.equal(first.response.status, 201);
    // The pending order holds its 2 units: stock is untouched, but only 1 is left to sell.
    assert.equal(await stock(), 3);
    const held = await f.submit();
    assert.equal(held.response.status, 409, 'pending orders hold stock');
    assert.equal(held.data.error.code, 'OUT_OF_STOCK');
    assert.equal((await f.request('GET', `/api/v1/products/${f.product.id}`)).data.inStock, true);
    const [{ id: firstId }] = await f.app.database.all('SELECT id FROM shop_order ORDER BY order_no');
    assert.equal((await decide(firstId, 'confirm', { expectedRevision: 1 })).response.status, 200);
    assert.equal(await stock(), 1);
    // Not enough left for another 2-unit order at checkout.
    const refused = await f.submit();
    assert.equal(refused.response.status, 409);
    assert.equal(refused.data.error.code, 'OUT_OF_STOCK');
    // Rejecting releases the hold and never touches stock; an unattended order stops holding after the window.
    await f.app.database.run('UPDATE product SET stock_quantity = 2 WHERE id = ?', f.product.id);
    const third = await f.submit();
    assert.equal(third.response.status, 201);
    assert.equal((await f.request('GET', `/api/v1/products/${f.product.id}`)).data.inStock, false, 'fully held reads as out of stock');
    assert.equal((await f.submit()).response.status, 409);
    const thirdId = (await f.app.database.get("SELECT id FROM shop_order WHERE status = 'SUBMITTED'")).id;
    await f.app.database.run("UPDATE shop_order SET submitted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", thirdId);
    assert.equal((await f.submit()).response.status, 201, 'a hold older than the window is released');
    const pendingIds = (await f.app.database.all("SELECT id FROM shop_order WHERE status = 'SUBMITTED' ORDER BY order_no")).map(row => row.id);
    assert.equal((await decide(pendingIds.at(-1), 'reject', { expectedRevision: 1, reason: 'Short stock' })).response.status, 200);
    assert.equal(await stock(), 2);
    assert.equal((await f.submit()).response.status, 201, 'a rejected order releases its hold');
    await f.app.database.run('UPDATE product SET stock_quantity = 0 WHERE id = ?', f.product.id);
    assert.equal((await f.request('GET', `/api/v1/products/${f.product.id}`)).data.inStock, false);
    // Seller view exposes the count; clearing it returns to unlimited.
    assert.equal((await f.request('PATCH', `/api/v1/seller/products/${f.product.id}`, { stockQuantity: null },
      { origin: f.origin, cookie: session.cookie, 'x-csrf-token': session.csrf })).data.stockQuantity, null);
  } finally { await f.close(); }
});

test('fulfilment moves confirmed orders to shipped and delivered, cancelling restocks, and buyers see tracking', async () => {
  const f = await fixture();
  try {
    const session = await f.login();
    const headers = { origin: f.origin, cookie: session.cookie, 'x-csrf-token': session.csrf };
    const act = (id, action, body) => f.request('POST', `/api/v1/seller/orders/${id}/${action}`, body, headers);
    const stock = async () => (await f.app.database.get('SELECT stock_quantity AS n FROM product WHERE id = ?', f.product.id)).n;
    await f.app.database.run('UPDATE product SET stock_quantity = 10 WHERE id = ?', f.product.id);
    const key = randomUUID();
    const submitted = await f.submit({ accessKey: key });
    const id = (await f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', submitted.data.orderNo)).id;
    const buyerStatus = async () => (await f.request('POST', '/api/v1/orders/statuses',
      { orders: [{ orderNo: submitted.data.orderNo, accessKey: key }] }, { origin: f.origin })).data.items[0];
    assert.equal((await f.request('GET', '/api/v1/seller/orders/summary', null, headers)).data.pending, 1);
    // Order of steps is enforced.
    assert.equal((await act(id, 'ship', { expectedRevision: 1, carrier: 'Ninja Van' })).response.status, 409);
    assert.equal((await act(id, 'confirm', { expectedRevision: 1 })).response.status, 200);
    assert.equal(await stock(), 8);
    assert.equal((await f.request('GET', '/api/v1/seller/orders/summary', null, headers)).data.pending, 0);
    assert.equal((await act(id, 'deliver', { expectedRevision: 2 })).response.status, 409);
    assert.equal((await act(id, 'ship', { expectedRevision: 2 })).response.status, 400, 'carrier is required');
    assert.equal((await act(id, 'ship', { expectedRevision: 2, carrier: 'Ninja Van', extra: 1 })).response.status, 400);
    const shipped = await act(id, 'ship', { expectedRevision: 2, carrier: 'Ninja Van', trackingNo: 'NV123456' });
    assert.equal(shipped.response.status, 200);
    assert.equal(shipped.data.status, 'SHIPPED');
    assert.equal(shipped.data.trackingCarrier, 'Ninja Van');
    assert.equal(shipped.data.trackingNo, 'NV123456');
    assert.deepEqual(await buyerStatus(), { orderNo: submitted.data.orderNo, status: 'SHIPPED',
      updatedAt: shipped.data.updatedAt, trackingCarrier: 'Ninja Van', trackingNo: 'NV123456' });
    // A shipped order can no longer be cancelled; it can be delivered.
    assert.equal((await act(id, 'cancel', { expectedRevision: 3, reason: 'Too late' })).response.status, 409);
    const delivered = await act(id, 'deliver', { expectedRevision: 3 });
    assert.equal(delivered.data.status, 'DELIVERED');
    assert.equal((await act(id, 'deliver', { expectedRevision: 4 })).response.status, 409);
    assert.deepEqual(delivered.data.events.map(event => event.status), ['SUBMITTED', 'CONFIRMED', 'SHIPPED', 'DELIVERED']);
    // Cancelling a confirmed order restores its stock and needs a reason.
    const second = await f.submit();
    const secondId = (await f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', second.data.orderNo)).id;
    await act(secondId, 'confirm', { expectedRevision: 1 });
    assert.equal(await stock(), 6);
    assert.equal((await act(secondId, 'cancel', { expectedRevision: 2 })).response.status, 400);
    const cancelled = await act(secondId, 'cancel', { expectedRevision: 2, reason: 'Buyer asked to cancel' });
    assert.equal(cancelled.data.status, 'CANCELLED');
    assert.equal(await stock(), 8);
    assert.equal((await act(secondId, 'cancel', { expectedRevision: 3, reason: 'Again' })).response.status, 409);
    assert.equal(await stock(), 8, 'a repeated cancel does not restock twice');
    // Status filter accepts the new states.
    assert.equal((await f.request('GET', '/api/v1/seller/orders?status=DELIVERED', null, headers)).data.items.length, 1);
    assert.equal((await f.request('GET', '/api/v1/seller/orders?status=CANCELLED', null, headers)).data.items.length, 1);
  } finally { await f.close(); }
});
