import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { setupShop } from '../src/shop-setup.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { parseKeyFile } from '../src/secret-box.js';

const origin = 'https://seller.example.test';
const api = `${origin}/api/v1/seller`;
const username = 'fixture_owner', password = 'SyntheticFixtureOnly4920!';
const keys = parseKeyFile(`k1=${randomBytes(32).toString('base64')}`);
const hash = 'a'.repeat(64);
const now = '2026-10-08T01:00:00.000Z';

async function fixture(t, { quick = false } = {}) {
  const store = await openDatabase(':memory:');
  t.after(() => store.close());
  await ensureAdmin(store, username, password);
  await setupShop(store, { mode: 'production', shopName: 'Fictional Shop' });
  await createCategory(store, { code: 'WEAR', label: 'Wear' });
  const product = await createProduct(store, { sku: 'TEE-1', name: 'Tee', description: 'Soft', category: 'WEAR', priceMinor: 1200, currency: 'MYR', active: true });
  const orders = [];
  for (const [index, optIn] of [true, true].entries()) {
    await createOrder(store, `messages-intent-${index}0000000`, { buyer: { fullName: 'Fictional Buyer', whatsappPhone: '+60123456789' }, whatsappOrderContactOptIn: optIn,
      deliveries: [{ recipient: { fullName: 'Fictional Recipient', phone: '+60123456780' }, address: { line1: 'Fictional Street', postcode: '50000', country: 'MY' },
        items: [{ productId: product.id, quantity: 1, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency }] }] });
  }
  for (const row of await store.all('SELECT id, order_no FROM shop_order ORDER BY order_no')) orders.push(row);
  await store.run(`INSERT INTO integration_connection(id, provider, environment, status, created_at, updated_at) VALUES ('c1', 'WHATSAPP_CLOUD', 'SANDBOX', 'CONNECTED', ?, ?)`, now, now);
  const handle = await createApi({ store, config: { shopMode: 'manual', publicOrigin: null, sellerOrigin: origin, appRevision: null, sellerQuickLogin: quick, username, integrationKeys: keys } });
  const call = (method, target, payload, headers = {}) => handle(new Request(target, { method, headers: { origin, 'content-type': 'application/json', ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) }), { clientAddress: '203.0.113.7' });
  const login = await call('POST', `${api}/session`, { username, password });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await login.json();
  const authed = (method, target, payload) => call(method, target, payload, { cookie, 'x-csrf-token': csrfToken });
  const reply = (id, orderId, body, at, kind = 'TEXT') => store.run(`INSERT INTO message_inbound(id, connection_id, order_id, from_hash, provider_message_id, kind, body, received_at, created_at) VALUES (?, 'c1', ?, ?, ?, ?, ?, ?, ?)`,
    id, orderId, hash, `wamid.${id}`, kind, body, at, at);
  const message = (id, orderId, kind, status, error = null, at = now) => store.run(`INSERT INTO message_outbox(id, order_id, connection_id, kind, recipient_hash, template, locale, idempotency_key, status, last_error, created_at, updated_at)
    VALUES (?, ?, 'c1', ?, ?, 't', 'en', ?, ?, ?, ?, ?)`, id, orderId, kind, hash, `${orderId}:${id}`, status, error, at, at);
  return { store, call, authed, orders, reply, message };
}
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('message routes need a signed-in seller, and writes need origin and CSRF', async (t) => {
  const f = await fixture(t);
  await f.reply(uuid(1), f.orders[0].id, 'Hello', now); await f.message(uuid(2), f.orders[0].id, 'ORDER_SUBMITTED', 'RECONCILE');
  for (const [method, path] of [['GET', '/messages/summary'], ['GET', '/messages/replies'], ['GET', '/messages/outbox'], ['GET', `/orders/${f.orders[0].id}/messages`],
    ['POST', `/messages/replies/${uuid(1)}/read`], ['POST', `/messages/outbox/${uuid(2)}/resolve`]]) {
    assert.equal((await f.call(method, api + path, method === 'POST' ? { resolution: 'SENT' } : undefined)).status, 401, `${method} ${path}`);
  }
  const noCsrf = await f.call('POST', `${api}/messages/replies/${uuid(1)}/read`, undefined, { cookie: (await (await f.call('POST', `${api}/session`, { username, password })).headers.get('set-cookie')).split(';')[0] });
  assert.equal(noCsrf.status, 403);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM message_inbound WHERE read_at IS NOT NULL')).n, 0);
});

test('replies are listed newest first, linked to the order, counted and marked read', async (t) => {
  const f = await fixture(t);
  await f.reply(uuid(1), f.orders[0].id, 'First', '2026-10-08T01:00:00.000Z');
  await f.reply(uuid(2), f.orders[1].id, 'Second', '2026-10-08T02:00:00.000Z');
  await f.reply(uuid(3), null, null, '2026-10-08T03:00:00.000Z', 'MEDIA_UNSUPPORTED');
  assert.deepEqual(await (await f.authed('GET', `${api}/messages/summary`)).json(), { unreadReplies: 3, reconcile: 0, failed: 0 });
  const list = await (await f.authed('GET', `${api}/messages/replies`)).json();
  assert.deepEqual(list.items.map((item) => [item.body, item.orderNo, item.kind, item.read]),
    [[null, null, 'MEDIA_UNSUPPORTED', false], ['Second', f.orders[1].order_no, 'TEXT', false], ['First', f.orders[0].order_no, 'TEXT', false]]);
  assert.ok(!JSON.stringify(list).includes(hash), 'the sender hash is never returned');
  const read = await f.authed('POST', `${api}/messages/replies/${uuid(2)}/read`);
  assert.equal(read.status, 200); assert.equal((await read.json()).read, true);
  assert.equal((await (await f.authed('GET', `${api}/messages/summary`)).json()).unreadReplies, 2);
  assert.deepEqual((await (await f.authed('GET', `${api}/messages/replies?unread=1`)).json()).items.map((item) => item.body), [null, 'First']);
  const paged = await (await f.authed('GET', `${api}/messages/replies?limit=2`)).json();
  assert.equal(paged.items.length, 2); assert.equal(paged.nextOffset, 2);
  assert.equal((await f.authed('POST', `${api}/messages/replies/${uuid(99)}/read`)).status, 404);
  for (const bad of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc']) assert.equal((await f.authed('GET', `${api}/messages/replies?${bad}`)).status, 400, bad);
});

test('messages that need attention are listed and the seller can mark them sent or send them again', async (t) => {
  const f = await fixture(t);
  await f.message(uuid(1), f.orders[0].id, 'ORDER_SUBMITTED', 'RECONCILE', 'Outcome unknown (PROVIDER_RECONCILE)');
  await f.message(uuid(2), f.orders[0].id, 'ORDER_CONFIRMED', 'FAILED', 'Rejected by provider (132001)');
  await f.message(uuid(3), f.orders[1].id, 'ORDER_SUBMITTED', 'ACCEPTED');
  assert.deepEqual(await (await f.authed('GET', `${api}/messages/summary`)).json(), { unreadReplies: 0, reconcile: 1, failed: 1 });
  const list = await (await f.authed('GET', `${api}/messages/outbox`)).json();
  assert.equal(list.items.length, 2, 'accepted messages are not "attention"');
  assert.ok(list.items.every((item) => item.orderNo && !('recipientHash' in item) && !JSON.stringify(item).includes(hash)));
  const sent = await f.authed('POST', `${api}/messages/outbox/${uuid(1)}/resolve`, { resolution: 'SENT' });
  assert.equal((await sent.json()).status, 'ACCEPTED');
  assert.equal((await f.authed('POST', `${api}/messages/outbox/${uuid(1)}/resolve`, { resolution: 'SENT' })).status, 409, 'only an unknown outcome can be marked sent');
  assert.equal((await f.authed('POST', `${api}/messages/outbox/${uuid(2)}/resolve`, { resolution: 'SENT' })).status, 409, 'a rejected message was not sent');
  const again = await (await f.authed('POST', `${api}/messages/outbox/${uuid(2)}/resolve`, { resolution: 'RESEND' })).json();
  assert.equal(again.status, 'QUEUED'); assert.equal(again.attempts, 0);
  assert.equal((await f.authed('POST', `${api}/messages/outbox/${uuid(3)}/resolve`, { resolution: 'RESEND' })).status, 409, 'an accepted message is never re-queued');
  assert.equal((await f.authed('POST', `${api}/messages/outbox/${uuid(99)}/resolve`, { resolution: 'SENT' })).status, 404);
  for (const bad of [{ resolution: 'DELETE' }, {}, { resolution: 'SENT', extra: 1 }]) assert.equal((await f.authed('POST', `${api}/messages/outbox/${uuid(1)}/resolve`, bad)).status, 400);
});

test('an order shows its replies and the messages sent about it', async (t) => {
  const f = await fixture(t);
  await f.reply(uuid(1), f.orders[0].id, 'Thanks', now); await f.reply(uuid(2), f.orders[1].id, 'Other order', now);
  await f.message(uuid(3), f.orders[0].id, 'ORDER_SUBMITTED', 'DELIVERED');
  const view = await (await f.authed('GET', `${api}/orders/${f.orders[0].id}/messages`)).json();
  assert.deepEqual(view.replies.map((reply) => reply.body), ['Thanks']);
  assert.deepEqual(view.messages.map((item) => [item.kind, item.status]), [['ORDER_SUBMITTED', 'DELIVERED']]);
  assert.equal((await f.authed('GET', `${api}/orders/${uuid(77)}/messages`)).status, 404);
});

test('a sample site with quick sign-in shows no messages and accepts no changes', async (t) => {
  const f = await fixture(t, { quick: true });
  await f.reply(uuid(1), f.orders[0].id, 'Real reply', now); await f.message(uuid(2), f.orders[0].id, 'ORDER_SUBMITTED', 'RECONCILE');
  assert.deepEqual(await (await f.authed('GET', `${api}/messages/summary`)).json(), { unreadReplies: 0, reconcile: 0, failed: 0 });
  assert.deepEqual(await (await f.authed('GET', `${api}/messages/replies`)).json(), { items: [], nextOffset: null });
  assert.deepEqual(await (await f.authed('GET', `${api}/orders/${f.orders[0].id}/messages`)).json(), { replies: [], messages: [] });
  assert.equal((await f.authed('POST', `${api}/messages/replies/${uuid(1)}/read`)).status, 403);
  assert.equal((await f.authed('POST', `${api}/messages/outbox/${uuid(2)}/resolve`, { resolution: 'RESEND' })).status, 403);
  assert.equal((await f.store.get("SELECT status FROM message_outbox WHERE id = ?", uuid(2))).status, 'RECONCILE');
});
