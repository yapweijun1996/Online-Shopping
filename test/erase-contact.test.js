import assert from 'node:assert/strict';
import test from 'node:test';
import { sellerFixture } from './helpers/seller-app.js';

const orderId = (f, orderNo) => f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', orderNo).then((row) => row.id);

async function rejected(f, headers) {
  const order = await f.submit();
  const id = await orderId(f, order.data.orderNo);
  const done = await f.request('POST', `/api/v1/seller/orders/${id}/reject`, { expectedRevision: 1, reason: 'Unavailable.' }, headers);
  assert.equal(done.response.status, 200);
  return { id, orderNo: order.data.orderNo, revision: done.data.revision };
}

test('erasing contact data changes only personal fields and records who and when', async () => {
  const f = await sellerFixture();
  try {
    const { headers } = await f.login();
    const { id, orderNo, revision } = await rejected(f, headers);
    const before = await f.request('GET', `/api/v1/seller/orders/${id}`, null, headers);
    const url = `/api/v1/seller/orders/${id}/erase-contact`;
    // Wrong confirmation text, missing revision and stale revision change nothing.
    assert.equal((await f.request('POST', url, { expectedRevision: revision, confirmOrderNo: 'WRONG' }, headers)).response.status, 400);
    assert.equal((await f.request('POST', url, { confirmOrderNo: orderNo }, headers)).response.status, 400);
    assert.equal((await f.request('POST', url, { expectedRevision: revision + 5, confirmOrderNo: orderNo }, headers)).data.error.code, 'STALE_REVISION');
    assert.equal((await f.request('GET', `/api/v1/seller/orders/${id}`, null, headers)).data.buyer.fullName, 'Example Buyer');

    const erased = await f.request('POST', url, { expectedRevision: revision, confirmOrderNo: orderNo.toLowerCase() }, headers);
    assert.equal(erased.response.status, 200);
    const after = erased.data;
    assert.equal(after.contactErased, true);
    assert.equal(after.contactErasedBy, 'review_owner');
    assert.ok(after.contactErasedAt);
    assert.equal(after.revision, revision + 1);
    const text = JSON.stringify(after);
    for (const personal of ['Example Buyer', '+6581234567', 'example@example.invalid', 'Example Recipient', '+60123456789', 'Example Street', 'Unit 1', 'Example City', '50000']) {
      assert.ok(!text.includes(personal), `${personal} must be gone`);
    }
    assert.equal(after.buyer.whatsappOrderContactOptIn, false);
    // Everything else about the order is untouched, including the full event history.
    assert.equal(after.orderNo, before.data.orderNo);
    assert.equal(after.status, before.data.status);
    assert.equal(after.totalMinor, before.data.totalMinor);
    assert.deepEqual(after.deliveries.map((d) => d.items), before.data.deliveries.map((d) => d.items));
    assert.deepEqual(after.events, before.data.events);
    assert.equal(after.deliveries[0].address.country, 'MY');
    // The queue marks it, and a second erase is refused.
    const queue = await f.request('GET', '/api/v1/seller/orders?status=REJECTED', null, headers);
    assert.equal(queue.data.items[0].contactErased, true);
    assert.equal((await f.request('POST', url, { expectedRevision: revision + 1, confirmOrderNo: orderNo }, headers)).data.error.code, 'ALREADY_ERASED');
  } finally { await f.close(); }
});

test('only finished orders can be erased, and sign-in, CSRF and quick sign-in are enforced', async () => {
  const f = await sellerFixture();
  try {
    const order = await f.submit();
    const id = await orderId(f, order.data.orderNo);
    const url = `/api/v1/seller/orders/${id}/erase-contact`;
    const body = { expectedRevision: 1, confirmOrderNo: order.data.orderNo };
    assert.equal((await f.request('POST', url, body, { origin: f.origin })).response.status, 401);
    const { headers } = await f.login();
    assert.equal((await f.request('POST', url, body, { ...headers, 'x-csrf-token': 'wrong' })).response.status, 403);
    assert.equal((await f.request('POST', url, body, headers)).data.error.code, 'ORDER_NOT_FINISHED');   // SUBMITTED
    const confirmed = await f.request('POST', `/api/v1/seller/orders/${id}/confirm`, { expectedRevision: 1 }, headers);
    assert.equal((await f.request('POST', url, { ...body, expectedRevision: confirmed.data.revision }, headers)).data.error.code, 'ORDER_NOT_FINISHED');
    assert.equal((await f.request('POST', `/api/v1/seller/orders/${id}/erase-contact`, body, { ...headers, origin: 'https://evil.invalid' })).response.status, 403);
    assert.equal((await f.app.database.get('SELECT buyer_name FROM shop_order WHERE id = ?', id)).buyer_name, 'Example Buyer');
  } finally { await f.close(); }
});

test('a sample site with quick sign-in refuses to erase anything', async () => {
  const f = await sellerFixture({ sellerQuickLogin: true });
  try {
    const { headers } = await f.login();
    const { id, orderNo, revision } = await rejected(f, headers);
    const result = await f.request('POST', `/api/v1/seller/orders/${id}/erase-contact`, { expectedRevision: revision, confirmOrderNo: orderNo }, headers);
    assert.equal(result.response.status, 403);
    assert.equal((await f.app.database.get('SELECT buyer_name FROM shop_order WHERE id = ?', id)).buyer_name, 'Example Buyer');
  } finally { await f.close(); }
});

test('erasing removes buyer reply text and stops queued messages for that order', async () => {
  const f = await sellerFixture();
  try {
    const { headers } = await f.login();
    const { id, orderNo, revision } = await rejected(f, headers);
    const db = f.app.database, now = new Date().toISOString();
    await db.run(`INSERT INTO integration_connection(id, provider, environment, status, created_at, updated_at) VALUES ('c1', 'WHATSAPP_CLOUD', 'SANDBOX', 'CONNECTED', ?, ?)`, now, now);
    await db.run(`INSERT INTO message_inbound(id, connection_id, order_id, from_hash, provider_message_id, kind, body, received_at, created_at)
      VALUES ('m1', 'c1', ?, ?, 'wamid.1', 'TEXT', 'My home is at Example Street', ?, ?)`, id, 'a'.repeat(32), now, now);
    await db.run(`INSERT INTO message_outbox(id, order_id, connection_id, kind, recipient_hash, template, locale, idempotency_key, status, next_attempt_at, created_at, updated_at)
      VALUES ('o1', ?, 'c1', 'ORDER_REJECTED', ?, 'order_rejected', 'en', 'k1', 'QUEUED', ?, ?, ?)`, id, 'b'.repeat(32), now, now, now);
    assert.equal((await f.request('POST', `/api/v1/seller/orders/${id}/erase-contact`, { expectedRevision: revision, confirmOrderNo: orderNo }, headers)).response.status, 200);
    assert.equal((await db.get("SELECT body FROM message_inbound WHERE id = 'm1'")).body, null);
    const outbox = await db.get("SELECT status, last_error FROM message_outbox WHERE id = 'o1'");
    assert.equal(outbox.status, 'FAILED');
    assert.match(outbox.last_error, /erased/);
  } finally { await f.close(); }
});
