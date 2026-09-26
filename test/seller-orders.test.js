import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { createProduct } from '../src/products.js';
import { createCategory } from '../src/settings.js';

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'online-shopping-review-'));
  const config = {
    username: 'review_owner', password: 'LocalReviewPass123!',
    dbPath: path.join(directory, 'private.db'), production: false, publicOrigin: null,
  };
  const app = createApp(config);
  createCategory(app.database, { code: 'EXAMPLES', label: 'Examples' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const product = createProduct(app.database, {
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
    async submit({ buyerName = 'Example Buyer' } = {}) {
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
        origin, 'idempotency-key': `seller-review-intent-${++orderKey}`,
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

test('seller queue and detail expose one authorized order snapshot with no public lookup', async () => {
  const f = await fixture();
  try {
    const first = await f.submit();
    const second = await f.submit({ buyerName: 'Another Buyer' });
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    f.app.database.run(`UPDATE shop_order SET whatsapp_opt_in = 0,
      whatsapp_consent_at = NULL, whatsapp_consent_version = NULL WHERE order_no = ?`, second.data.orderNo);
    const id = f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', first.data.orderNo).id;
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
    const invalid = await f.request('GET', '/api/v1/seller/orders?status=UNKNOWN', null, { cookie });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.data.error.field, 'status');
    const detail = await f.request('GET', `/api/v1/seller/orders/${id}`, null, { cookie });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.response.headers.get('cache-control'), 'no-store');
    assert.equal(detail.data.buyer.whatsappPhone, '+6581234567');
    assert.equal(detail.data.buyer.whatsappOrderContactOptIn, true);
    const historical = await f.request('GET', `/api/v1/seller/orders/${f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', second.data.orderNo).id}`, null, { cookie });
    assert.equal(historical.data.buyer.whatsappOrderContactOptIn, false);
    assert.equal(detail.data.deliveries[0].recipient.phone, '+60123456789');
    assert.equal(detail.data.deliveries[0].address.line2, 'Unit 1');
    assert.equal(detail.data.deliveries[0].items[0].priceMinor, 1250);
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
    const id = f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', submitted.data.orderNo).id;
    const { cookie, csrf } = await f.login();
    const deleted = await f.request('DELETE', `/api/v1/seller/orders/${id}`, null, {
      origin: f.origin, cookie, 'x-csrf-token': csrf,
    });
    assert.equal(deleted.response.status, 404);
    for (const table of ['shop_order', 'delivery', 'order_item', 'order_event', 'checkout_idempotency']) {
      assert.equal(f.app.database.get(`SELECT COUNT(*) AS count FROM ${table}`).count, 1, table);
    }
    assert.equal((await f.request('GET', `/api/v1/seller/orders/${id}`, null, { cookie })).response.status, 200);
  } finally { await f.close(); }
});

test('seller decisions require origin, CSRF, current revision, and append audit once', async () => {
  const f = await fixture();
  try {
    await f.submit();
    await f.submit({ buyerName: 'Another Buyer' });
    const ids = f.app.database.all('SELECT id FROM shop_order ORDER BY order_no').map((row) => row.id);
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
    assert.equal(f.app.database.get('SELECT COUNT(*) AS count FROM order_event').count, 4);
  } finally { await f.close(); }
});

test('simultaneous decisions cannot overwrite one another and audit failure rolls back', async () => {
  const f = await fixture();
  try {
    await f.submit();
    const id = f.app.database.get('SELECT id FROM shop_order').id;
    const { cookie, csrf } = await f.login();
    const headers = { origin: f.origin, cookie, 'x-csrf-token': csrf };
    const url = `/api/v1/seller/orders/${id}`;
    f.app.database.exec(`CREATE TRIGGER fail_review BEFORE INSERT ON order_event
      WHEN NEW.event_type = 'CONFIRMED' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const failed = await f.request('POST', `${url}/confirm`, { expectedRevision: 1 }, headers);
    assert.equal(failed.response.status, 500);
    assert.equal(f.app.database.get('SELECT status, revision FROM shop_order WHERE id = ?', id).status, 'SUBMITTED');
    assert.equal(f.app.database.get('SELECT status, revision FROM shop_order WHERE id = ?', id).revision, 1);
    f.app.database.exec('DROP TRIGGER fail_review');
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
