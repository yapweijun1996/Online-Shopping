import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/app.js';
import { setupShop } from '../src/shop-setup.js';
import { listProducts } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { createSecretBox, parseKeyFile } from '../src/secret-box.js';
import { openWhatsAppSecrets, saveWhatsAppConnection } from '../src/integration-connections.js';
import { senderHash } from '../src/whatsapp-webhook.js';

const accessToken = 'fictional-access-token-ABC123456789';
const appSecret = 'fictional-app-secret-0123456789abcdef';
const phoneNumberId = '123456789';
const buyer = '60123456789';
const origin = 'https://hooks.example.test';
const url = `${origin}/api/v1/webhooks/whatsapp`;
const keys = parseKeyFile(`k1=${randomBytes(32).toString('base64')}`);
const transport = { verify: async () => ({ ok: true, displayPhoneNumber: '+15550000000', verifiedName: 'Fictional Shop' }) };
const sign = (raw, secret = appSecret) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
const wrap = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, ...value } }] }] });
const status = (id, name, at = 1760000000) => ({ id, status: name, timestamp: String(at), recipient_id: buyer });
const reply = (id, body, from = buyer, type = 'text') => ({ id, from, timestamp: '1760000100', type, ...(type === 'text' ? { text: { body } } : {}) });

async function fixture(t, { connect = true, withKeys = true, store = null } = {}) {
  if (!store) { store = await openDatabase(':memory:'); t.after(() => store.close()); }
  const secretBox = createSecretBox(keys);
  const handle = await createApi({ store, config: { shopMode: 'manual', publicOrigin: null, sellerOrigin: null, appRevision: null, integrationKeys: withKeys ? keys : null } });
  const call = (method, body, headers = {}, target = url) => handle(new Request(target, { method, headers: { 'content-type': 'application/json', ...headers }, body }), { clientAddress: '203.0.113.9' });
  const post = (payload, { secret = appSecret, signature, raw } = {}) => {
    const body = raw ?? JSON.stringify(payload);
    return call('POST', body, { 'x-hub-signature-256': signature ?? sign(body, secret) });
  };
  let connection = null, hashKey = null, orderId = null;
  if (connect) {
    connection = await saveWhatsAppConnection(store, secretBox, transport, { environment: 'SANDBOX', accessToken, appSecret, phoneNumberId, businessAccountId: '987654321' }, 'owner');
    hashKey = (await openWhatsAppSecrets(store, secretBox, 'SANDBOX')).hashKey;
    await setupShop(store, { mode: 'demo' });
    await createOrder(store, 'webhook-intent-0001', { buyer: { fullName: 'Synthetic Buyer', whatsappPhone: '+60123456789' }, whatsappOrderContactOptIn: true,
      deliveries: [{ recipient: { fullName: 'Synthetic Recipient', phone: '+60123456789' }, address: { line1: 'Synthetic Street', postcode: '50000', country: 'MY' },
        items: [{ productId: (await listProducts(store, new URLSearchParams('limit=1'))).items[0].id, quantity: 1, expectedPriceMinor: (await listProducts(store, new URLSearchParams('limit=1'))).items[0].priceMinor, expectedCurrency: (await listProducts(store, new URLSearchParams('limit=1'))).items[0].currency }] }] });
    orderId = (await store.get('SELECT id FROM shop_order LIMIT 1')).id;
  }
  const queue = async (id, providerMessageId, number = buyer, state = 'ACCEPTED', createdAt = '2026-10-08T00:00:00.000Z') => store.run(
    `INSERT INTO message_outbox(id, order_id, connection_id, kind, recipient_hash, template, locale, idempotency_key, status, provider_message_id, created_at, updated_at)
     VALUES (?, ?, (SELECT id FROM integration_connection LIMIT 1), 'ORDER_SUBMITTED', ?, 'order_submitted', 'en', ?, ?, ?, ?, ?)`,
    id, orderId, senderHash(hashKey, number), `${orderId}:${id}`, state, providerMessageId, createdAt, createdAt);
  const counts = async () => ({ receipts: (await store.get('SELECT COUNT(*) AS n FROM webhook_receipt')).n, inbound: (await store.get('SELECT COUNT(*) AS n FROM message_inbound')).n });
  return { store, call, post, connection, queue, counts, orderId, hashKey };
}

test('the subscribe handshake answers only with the right verify token', async (t) => {
  const f = await fixture(t);
  const token = f.connection.publicConfig.verifyToken;
  const ok = await f.call('GET', undefined, {}, `${url}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`);
  assert.equal(ok.status, 200); assert.equal(await ok.text(), '1158201444');
  for (const query of [`hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`, `hub.mode=unsubscribe&hub.verify_token=${token}&hub.challenge=1`,
    `hub.mode=subscribe&hub.verify_token=${token}`, `hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=%3Cscript%3E`, 'hub.mode=subscribe']) {
    assert.equal((await f.call('GET', undefined, {}, `${url}?${query}`)).status, 403, query);
  }
});

test('unsigned, wrongly signed and tampered deliveries are refused and store nothing', async (t) => {
  const f = await fixture(t);
  const payload = wrap({ messages: [reply('wamid.IN1', 'hello')] });
  const raw = JSON.stringify(payload);
  assert.equal((await f.call('POST', raw)).status, 401, 'no signature');
  assert.equal((await f.post(payload, { secret: 'another-fictional-secret-0123456789' })).status, 401, 'wrong secret');
  assert.equal((await f.post(payload, { signature: sign(raw).replace(/.$/, '0') })).status, 401, 'altered signature');
  assert.equal((await f.post(payload, { signature: 'sha256=zz' })).status, 401, 'malformed signature');
  assert.equal((await f.call('POST', raw.replace('hello', 'hellp'), { 'x-hub-signature-256': sign(raw) })).status, 401, 'tampered body');
  assert.deepEqual(await f.counts(), { receipts: 0, inbound: 0 });
  const body = await (await f.post(payload, { secret: 'x'.repeat(20) })).text();
  assert.ok(!body.includes(appSecret) && !body.includes(accessToken));
});

test('delivery receipts advance the outbox, never backwards, and a replay changes nothing', async (t) => {
  const f = await fixture(t);
  await f.queue('m1', 'wamid.OUT1');
  const stateOf = async () => (await f.store.get("SELECT status FROM message_outbox WHERE id = 'm1'")).status;
  assert.equal((await f.post(wrap({ statuses: [status('wamid.OUT1', 'delivered')] }))).status, 200);
  assert.equal(await stateOf(), 'DELIVERED');
  assert.equal((await f.post(wrap({ statuses: [status('wamid.OUT1', 'read')] }))).status, 200);
  assert.equal(await stateOf(), 'READ');
  assert.equal((await f.post(wrap({ statuses: [status('wamid.OUT1', 'delivered', 1760000500)] }))).status, 200, 'late receipt');
  assert.equal(await stateOf(), 'READ', 'a late delivered receipt does not move READ backwards');
  const same = wrap({ statuses: [status('wamid.OUT1', 'read')] });
  assert.equal((await f.post(same)).status, 200);
  const before = await f.counts();
  assert.equal((await f.post(same)).status, 200, 'a replay is acknowledged');
  assert.deepEqual(await f.counts(), before, 'but stores nothing new');
  // The duplicate must not even run the work again: make the stored row differ, replay once more, and it stays untouched.
  await f.store.run("UPDATE message_outbox SET status = 'ACCEPTED' WHERE id = 'm1'");
  assert.equal((await f.post(same)).status, 200);
  assert.equal(await stateOf(), 'ACCEPTED', 'a replayed delivery is not processed a second time');
  await f.queue('m2', 'wamid.OUT2', buyer, 'SENDING');
  await f.post(wrap({ statuses: [{ ...status('wamid.OUT2', 'failed'), errors: [{ code: 131026 }] }] }));
  const failed = await f.store.get("SELECT status, last_error FROM message_outbox WHERE id = 'm2'");
  assert.deepEqual({ ...failed }, { status: 'FAILED', last_error: 'Provider error 131026' });
});

test('replies are stored once, indexed by a hash, and linked to the order of the latest message sent to that buyer', async (t) => {
  const f = await fixture(t);
  await f.queue('m1', 'wamid.OUT1', buyer, 'READ', '2026-10-08T00:00:00.000Z');
  const payload = wrap({ messages: [reply('wamid.IN1', 'Thank you!'), reply('wamid.IN2', 'x', '60199999999'), reply('wamid.IN3', '', buyer, 'image')] });
  assert.equal((await f.post(payload)).status, 200);
  const rows = await f.store.all('SELECT provider_message_id, order_id, kind, body, from_hash FROM message_inbound ORDER BY provider_message_id');
  assert.deepEqual(rows.map((row) => [row.provider_message_id, row.order_id, row.kind, row.body]),
    [['wamid.IN1', f.orderId, 'TEXT', 'Thank you!'], ['wamid.IN2', null, 'TEXT', 'x'], ['wamid.IN3', f.orderId, 'MEDIA_UNSUPPORTED', null]]);
  assert.equal(rows[0].from_hash, senderHash(f.hashKey, buyer));
  assert.ok(rows.every((row) => !row.from_hash.includes(buyer)), 'the phone number itself is never indexed');
  // The same reply arriving again in a different delivery is still stored once.
  assert.equal((await f.post(wrap({ messages: [reply('wamid.IN1', 'Thank you!')], statuses: [] }), {})).status, 200);
  assert.equal((await f.counts()).inbound, 3);
});

test('items for another phone number, oversized bodies and malformed signed bodies are not processed', async (t) => {
  const f = await fixture(t);
  const other = wrap({ messages: [reply('wamid.IN9', 'hi')] });
  other.entry[0].changes[0].value.metadata.phone_number_id = '555555555';
  assert.equal((await f.post(other)).status, 200);
  assert.equal((await f.counts()).inbound, 0);
  const big = JSON.stringify({ pad: 'x'.repeat(300 * 1024) });
  assert.equal((await f.post(null, { raw: big })).status, 413);
  assert.equal((await f.post(null, { raw: 'not json' })).status, 400, 'a correctly signed but malformed body');
  assert.equal((await f.call('PUT', '{}')).status, 404, 'only GET and POST are routed');
});

test('without a connected account or master keys the webhook accepts nothing', async (t) => {
  const none = await fixture(t, { connect: false });
  assert.equal((await none.post(wrap({ messages: [reply('wamid.IN1', 'hi')] }))).status, 401);
  assert.equal((await none.call('GET', undefined, {}, `${url}?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`)).status, 403);
  const unkeyed = await fixture(t, { connect: false, withKeys: false });
  assert.equal((await unkeyed.post(wrap({}))).status, 503);
});

const pgBase = process.env.SHOP_TEST_DATABASE_URL;
test('on PostgreSQL receipts, replies, dedupe and order matching work the same', { skip: !pgBase }, async (t) => {
  const { default: pg } = await import('pg');
  const { randomUUID } = await import('node:crypto');
  const { openPostgresDatabase } = await import('../src/postgres-db.js');
  const name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: pgBase });
  await admin.query(`CREATE DATABASE ${name}`);
  const dbUrl = new URL(pgBase); dbUrl.pathname = '/' + name;
  const store = await openPostgresDatabase(dbUrl.href);
  t.after(async () => { await store.close(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  const f = await fixture(t, { store });
  await f.queue('m1', 'wamid.OUT1', buyer, 'ACCEPTED');
  const same = wrap({ statuses: [status('wamid.OUT1', 'delivered')], messages: [reply('wamid.IN1', 'Thanks')] });
  assert.equal((await f.post(same)).status, 200);
  assert.equal((await f.post(same)).status, 200);
  assert.equal((await store.get("SELECT status FROM message_outbox WHERE id = 'm1'")).status, 'DELIVERED');
  assert.deepEqual(await f.counts(), { receipts: 1, inbound: 1 });
  assert.equal((await store.get('SELECT order_id FROM message_inbound')).order_id, f.orderId);
  assert.equal((await f.post(same, { secret: 'x'.repeat(20) })).status, 401);
});
