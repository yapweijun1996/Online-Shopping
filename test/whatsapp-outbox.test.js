import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { setupShop } from '../src/shop-setup.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { decideSellerOrder } from '../src/seller-orders.js';
import { createSecretBox, parseKeyFile } from '../src/secret-box.js';
import { openWhatsAppSecrets, saveWhatsAppConnection, disconnectWhatsAppConnection } from '../src/integration-connections.js';
import { enqueueWhatsAppMessages, sendDueWhatsAppMessages, startWhatsAppWorker, MAX_AGE_MS, LEASE_MS } from '../src/whatsapp-outbox.js';
import { receiveWhatsAppWebhook } from '../src/whatsapp-inbound.js';
import { createWhatsAppTransport } from '../src/whatsapp-transport.js';
import { senderHash } from '../src/whatsapp-webhook.js';

const accessToken = 'fictional-access-token-ABC123456789';
const appSecret = 'fictional-app-secret-0123456789abcdef';
const buyerPhone = '+60123456789', buyerDigits = '60123456789', buyerName = 'Fictional Buyer';
const verifier = { verify: async () => ({ ok: true, displayPhoneNumber: '+15550000000', verifiedName: 'Fictional Shop' }) };
const accepted = (id) => ({ status: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: buyerDigits, wa_id: buyerDigits }], messages: [{ id }] } });

async function fixture(t, { store = null, connect = true, mode = 'production', secretBox = createSecretBox(parseKeyFile(`k1=${randomBytes(32).toString('base64')}`)) } = {}) {
  if (!store) { store = await openDatabase(':memory:'); t.after(() => store.close()); }
  await setupShop(store, mode === 'demo' ? { mode: 'demo' } : { mode: 'production', shopName: 'Fictional Shop' });
  if (mode !== 'demo') {
    await createCategory(store, { code: 'WEAR', label: 'Wear' });
    await createProduct(store, { sku: 'TEE-1', name: 'Tee', description: 'Soft', category: 'WEAR', priceMinor: 1200, currency: 'MYR', active: true });
  }
  const connectNow = () => saveWhatsAppConnection(store, secretBox, verifier, { environment: 'SANDBOX', accessToken, appSecret, phoneNumberId: '123456789', businessAccountId: '987654321' }, 'owner');
  if (connect) await connectNow();
  const product = (await store.get('SELECT id, price_minor, currency FROM product LIMIT 1'));
  let counter = 0;
  const order = async ({ optIn = true, locale = 'en', phone = optIn ? buyerPhone : null } = {}) => {
    counter++;
    const result = await createOrder(store, `outbox-intent-${String(counter).padStart(4, '0')}`, { buyer: { fullName: buyerName, whatsappPhone: phone, ...(phone ? {} : { email: 'fictional@example.test' }) }, whatsappOrderContactOptIn: optIn, locale,
      deliveries: [{ recipient: { fullName: 'Fictional Recipient', phone: '+60123456780' }, address: { line1: 'Fictional Street', postcode: '50000', country: 'MY' },
        items: [{ productId: product.id, quantity: 1, expectedPriceMinor: product.price_minor, expectedCurrency: product.currency }] }] });
    return (await store.get('SELECT id, order_no, revision FROM shop_order WHERE order_no = ?', result.receipt?.orderNo ?? result.orderNo ?? (await store.get('SELECT order_no FROM shop_order ORDER BY submitted_at DESC LIMIT 1')).order_no));
  };
  const rows = () => store.all('SELECT * FROM message_outbox ORDER BY created_at, kind');
  const calls = []; let ids = 0; const nextId = () => `wamid.OUT${++ids}`; let reply = async () => accepted(nextId());
  const transport = { send: async (input) => { calls.push(input); return reply(input); } };
  return { store, secretBox, order, rows, calls, transport, connectNow, nextId, setReply: (fn) => { reply = fn; } };
}

test('submitted, confirmed and shipped events become one queued template message each, only with consent', async (t) => {
  const f = await fixture(t);
  const withConsent = await f.order({ locale: 'zh-Hans' });
  await f.order({ optIn: false });
  assert.equal(await enqueueWhatsAppMessages(f.store, f.secretBox), 1);
  assert.equal(await enqueueWhatsAppMessages(f.store, f.secretBox), 0, 'running again queues nothing new');
  await decideSellerOrder(f.store, withConsent.id, 'confirm', { expectedRevision: withConsent.revision }, 'seller');
  await decideSellerOrder(f.store, withConsent.id, 'ship', { expectedRevision: withConsent.revision + 1, carrier: 'Fictional Courier', trackingNo: 'FC-123' }, 'seller');
  assert.equal(await enqueueWhatsAppMessages(f.store, f.secretBox), 2);
  const rows = await f.rows();
  assert.deepEqual(rows.map((row) => row.kind).sort(), ['ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_SUBMITTED']);
  assert.ok(rows.every((row) => row.order_id === withConsent.id && row.status === 'QUEUED' && row.locale === 'zh_CN'));
  assert.deepEqual(rows.map((row) => row.template).sort(), ['order_confirmed', 'order_shipped', 'order_submitted']);
  const hashKey = (await openWhatsAppSecrets(f.store, f.secretBox, 'SANDBOX')).hashKey;
  assert.ok(rows.every((row) => row.recipient_hash === senderHash(hashKey, buyerDigits)), 'hash of the digits, the form Meta uses in a reply');
  assert.ok(rows.every((row) => row.idempotency_key.startsWith(`${withConsent.id}:`)));
});

test('nothing is queued without a connection, in a sample shop, for old events or events before the connection', async (t) => {
  const none = await fixture(t, { connect: false });
  await none.order();
  assert.equal(await enqueueWhatsAppMessages(none.store, none.secretBox), 0, 'no connected account');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await none.connectNow();
  assert.equal(await enqueueWhatsAppMessages(none.store, none.secretBox), 0, 'the order was placed before the connection');
  const late = await fixture(t);
  await late.order();
  assert.equal(await enqueueWhatsAppMessages(late.store, late.secretBox, { now: () => new Date(Date.now() + MAX_AGE_MS + 60000) }), 0, 'too old: no backlog');
  const demo = await fixture(t, { mode: 'demo', connect: false });
  await demo.connectNow();
  assert.equal(await enqueueWhatsAppMessages(demo.store, demo.secretBox), 0, 'a sample shop never messages');
  assert.equal(await enqueueWhatsAppMessages(late.store, null), 0, 'no master key');
});

test('a sent message is accepted once, carries the template and parameters, and is not sent again', async (t) => {
  const f = await fixture(t);
  await f.order({ locale: 'ms' });
  await enqueueWhatsAppMessages(f.store, f.secretBox);
  assert.deepEqual(await sendDueWhatsAppMessages(f.store, f.secretBox, f.transport), { sent: 1, failed: 0, reconcile: 0, retry: 0 });
  assert.equal(f.calls.length, 1);
  const [call] = f.calls;
  assert.equal(call.accessToken, accessToken); assert.equal(call.phoneNumberId, '123456789');
  assert.equal(call.message.to, buyerDigits);
  assert.equal(call.message.template.name, 'order_submitted'); assert.equal(call.message.template.language.code, 'ms');
  assert.deepEqual(call.message.template.components[0].parameters.map((p) => p.text).slice(0, 1), [buyerName]);
  const [row] = await f.rows();
  assert.equal(row.status, 'ACCEPTED'); assert.equal(row.provider_message_id, 'wamid.OUT1'); assert.equal(row.attempts, 1);
  await sendDueWhatsAppMessages(f.store, f.secretBox, f.transport);
  assert.equal(f.calls.length, 1, 'an accepted message is never sent again');
});

test('a rejected message fails once and is not retried', async (t) => {
  const f = await fixture(t);
  await f.order(); await enqueueWhatsAppMessages(f.store, f.secretBox);
  f.setReply(async () => ({ status: 400, body: { error: { code: 132001, message: 'Template does not exist', fbtrace_id: 'x' } } }));
  assert.equal((await sendDueWhatsAppMessages(f.store, f.secretBox, f.transport)).failed, 1);
  await sendDueWhatsAppMessages(f.store, f.secretBox, f.transport);
  assert.equal(f.calls.length, 1);
  const [row] = await f.rows();
  assert.equal(row.status, 'FAILED'); assert.equal(row.last_error, 'Rejected by provider (132001)');
});

test('an unknown outcome goes to RECONCILE and is never retried automatically', async (t) => {
  for (const [label, reply] of [['no answer', async () => ({ status: 0, body: null })], ['server error', async () => ({ status: 500, body: { error: { code: 2 } } })],
    ['throttled', async () => ({ status: 429, body: { error: { code: 130429 } } })], ['unparsable success', async () => ({ status: 200, body: { hello: 'world' } })],
    ['transport crash', async () => { throw new Error('socket hang up'); }]]) {
    const f = await fixture(t);
    await f.order(); await enqueueWhatsAppMessages(f.store, f.secretBox);
    f.setReply(reply);
    assert.equal((await sendDueWhatsAppMessages(f.store, f.secretBox, f.transport)).reconcile, 1, label);
    await sendDueWhatsAppMessages(f.store, f.secretBox, f.transport, { now: () => new Date(Date.now() + 3600000) });
    assert.equal(f.calls.length, 1, `${label}: no second send`);
    assert.equal((await f.rows())[0].status, 'RECONCILE', label);
  }
});

test('a claim whose lease expired becomes RECONCILE without sending', async (t) => {
  const f = await fixture(t);
  await f.order(); await enqueueWhatsAppMessages(f.store, f.secretBox);
  await f.store.run("UPDATE message_outbox SET status = 'SENDING', attempts = 1, next_attempt_at = ?", new Date(Date.now() - 1000).toISOString());
  await sendDueWhatsAppMessages(f.store, f.secretBox, f.transport);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.rows())[0].status, 'RECONCILE');
  // a live lease is left alone
  await f.store.run("UPDATE message_outbox SET status = 'SENDING', next_attempt_at = ?", new Date(Date.now() + LEASE_MS).toISOString());
  await sendDueWhatsAppMessages(f.store, f.secretBox, f.transport);
  assert.equal((await f.rows())[0].status, 'SENDING');
});

test('failures before the network are retried with backoff, then fail; nothing is sent', async (t) => {
  const f = await fixture(t);
  await f.order(); await enqueueWhatsAppMessages(f.store, f.secretBox);
  await disconnectWhatsAppConnection(f.store, 'SANDBOX', 'owner');
  let clock = Date.now();
  const seen = [];
  for (let i = 0; i < 6; i++) {
    await sendDueWhatsAppMessages(f.store, f.secretBox, f.transport, { now: () => new Date(clock) });
    const [row] = await f.rows(); seen.push([row.status, row.attempts]);
    clock += 24 * 3600 * 1000;
  }
  assert.deepEqual(seen.map(([status]) => status), ['QUEUED', 'QUEUED', 'QUEUED', 'QUEUED', 'FAILED', 'FAILED']);
  assert.equal(seen[4][1], 5, 'bounded attempts');
  assert.equal(f.calls.length, 0);
});

test('consent withdrawn or number removed after queueing means the message is never sent', async (t) => {
  const f = await fixture(t);
  await f.order(); await enqueueWhatsAppMessages(f.store, f.secretBox);
  await f.store.run('UPDATE shop_order SET whatsapp_opt_in = 0, whatsapp_consent_at = NULL, whatsapp_consent_version = NULL');
  await sendDueWhatsAppMessages(f.store, f.secretBox, f.transport);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.rows())[0].status, 'FAILED');
});

test('stored errors never contain the number, the buyer name or a secret', async (t) => {
  const f = await fixture(t);
  await f.order(); await enqueueWhatsAppMessages(f.store, f.secretBox);
  f.setReply(async () => ({ status: 400, body: { error: { code: 131026, message: `Message to ${buyerDigits} for ${buyerName} failed ${accessToken}` } } }));
  await sendDueWhatsAppMessages(f.store, f.secretBox, f.transport);
  const dump = JSON.stringify(await f.rows());
  for (const secret of [buyerDigits, buyerName, accessToken, appSecret]) assert.ok(!dump.includes(secret), `outbox must not contain ${secret.slice(0, 6)}…`);
});

test('a reply from the buyer links to the order, and the stored provider id matches delivery receipts', async (t) => {
  const f = await fixture(t);
  const order = await f.order(); await enqueueWhatsAppMessages(f.store, f.secretBox);
  await sendDueWhatsAppMessages(f.store, f.secretBox, f.transport);
  const deliver = (payload) => { const raw = new TextEncoder().encode(JSON.stringify(payload)); return receiveWhatsAppWebhook(f.store, f.secretBox, { rawBody: raw, signature: 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex') }); };
  const wrap = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '123456789' }, ...value } }] }] });
  await deliver(wrap({ statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: '1760000000', recipient_id: buyerDigits }] }));
  assert.equal((await f.rows())[0].status, 'DELIVERED');
  await deliver(wrap({ messages: [{ id: 'wamid.IN1', from: buyerDigits, timestamp: '1760000100', type: 'text', text: { body: 'Thanks' } }] }));
  assert.equal((await f.store.get('SELECT order_id FROM message_inbound')).order_id, order.id);
});

test('two workers sending at the same time call the provider exactly once per message', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) await f.order();
  await enqueueWhatsAppMessages(f.store, f.secretBox);
  f.setReply(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); return accepted(f.nextId()); });
  const totals = await Promise.all([sendDueWhatsAppMessages(f.store, f.secretBox, f.transport), sendDueWhatsAppMessages(f.store, f.secretBox, f.transport)]);
  assert.equal(f.calls.length, 3);
  assert.equal(totals.reduce((sum, item) => sum + item.sent, 0), 3);
  assert.ok((await f.rows()).every((row) => row.status === 'ACCEPTED' && row.attempts === 1));
});

test('the worker runs enqueue and send on a tick and overlapping ticks do not stack', async (t) => {
  const f = await fixture(t);
  await f.order();
  let release; f.setReply(() => new Promise((resolve) => { release = () => resolve(accepted('wamid.OUT1')); }));
  const worker = startWhatsAppWorker({ store: f.store, secretBox: f.secretBox, transport: f.transport, intervalMs: 3600000 });
  t.after(() => worker.stop());
  const first = worker.tick(); const second = worker.tick();
  await new Promise((resolve) => setTimeout(resolve, 50));
  release(); await Promise.all([first, second]);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.rows())[0].status, 'ACCEPTED');
});

test('the transport sends one authenticated POST to the fixed host and never throws', async () => {
  const seen = [];
  const make = (impl) => createWhatsAppTransport({ fetchImpl: async (url, init) => { seen.push({ url, init }); return impl(); } });
  const json = (status, body) => () => new Response(JSON.stringify(body), { status });
  const message = { type: 'template' };
  const ok = await make(json(200, { messages: [{ id: 'wamid.X' }] })).send({ accessToken, phoneNumberId: '123456789', message });
  assert.deepEqual(ok, { status: 200, body: { messages: [{ id: 'wamid.X' }] } });
  assert.equal(seen[0].url, 'https://graph.facebook.com/v21.0/123456789/messages');
  assert.equal(seen[0].init.method, 'POST'); assert.equal(seen[0].init.headers.Authorization, `Bearer ${accessToken}`); assert.equal(seen[0].init.redirect, 'manual');
  assert.deepEqual(await make(() => new Response('', { status: 302, headers: { location: 'https://evil.example' } })).send({ accessToken, phoneNumberId: '123456789', message }), { status: 0, body: null });
  assert.deepEqual(await make(() => new Response('x'.repeat(20000), { status: 200 })).send({ accessToken, phoneNumberId: '123456789', message }), { status: 0, body: null });
  assert.deepEqual(await make(() => { throw new Error('boom'); }).send({ accessToken, phoneNumberId: '123456789', message }), { status: 0, body: null });
  assert.deepEqual(await make(json(200, [])).send({ accessToken, phoneNumberId: '123456789', message }), { status: 200, body: null });
  assert.deepEqual(await make(json(200, {})).send({ accessToken, phoneNumberId: '../evil', message }), { status: 0, body: null });
  assert.equal(seen.length, 5, 'an invalid phone number id never reaches the network');
});

const pgBase = process.env.SHOP_TEST_DATABASE_URL;
test('on PostgreSQL concurrent senders call the provider exactly once per message', { skip: !pgBase }, async (t) => {
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
  for (let i = 0; i < 4; i++) await f.order();
  assert.equal(await enqueueWhatsAppMessages(store, f.secretBox), 4);
  f.setReply(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); return accepted(f.nextId()); });
  await Promise.all([1, 2, 3].map(() => sendDueWhatsAppMessages(store, f.secretBox, f.transport)));
  assert.equal(f.calls.length, 4);
  assert.ok((await f.rows()).every((row) => row.status === 'ACCEPTED' && row.attempts === 1));
  assert.equal(await enqueueWhatsAppMessages(store, f.secretBox), 0);
});


test('one worker visits active shops serially, skips suspended/deleting, and isolates failures', async (t) => {
  const first = await fixture(t), second = await fixture(t, { secretBox: first.secretBox });
  await first.order(); await second.order();
  const opened = [], sent = [];
  const transport = { send: async (request) => { sent.push(request); return accepted('wamid.SERIAL' + sent.length); } };
  const worker = startWhatsAppWorker({ store: first.store, secretBox: first.secretBox, transport, intervalMs: 3600000,
    tenants: { list: async () => [{ id: 'bad', status: 'ACTIVE' }, { id: 'suspended', status: 'SUSPENDED' }, { id: 'deleting', status: 'DELETING' }, { id: 'second', status: 'ACTIVE' }],
      get: async (row) => { opened.push(row.id); if (row.id === 'bad') throw new Error('fixture outage'); return second.store; } } });
  t.after(() => worker.stop()); await Promise.all([worker.tick(),worker.tick()]);
  assert.deepEqual(opened,['bad','second']); assert.equal(sent.length,2);
  assert.equal((await first.rows())[0].status,'ACCEPTED'); assert.equal((await second.rows())[0].status,'ACCEPTED');
  await worker.stop(); await worker.tick(); assert.equal(sent.length,2);
});

test('maintenance waits for an existing worker send and prevents the next shop and tick', async (t) => {
  const f = await fixture(t); await f.order();
  let paused = false, entered, release, listed = 0;
  const started = new Promise((resolve) => { entered = resolve; });
  f.setReply(() => { entered(); return new Promise((resolve) => { release = () => resolve(accepted('wamid.DRAIN')); }); });
  const worker = startWhatsAppWorker({ store: f.store, secretBox: f.secretBox, transport: f.transport, paused: () => paused, intervalMs: 3600000,
    tenants: { list: async () => { listed++; return []; }, get: async () => { throw new Error('Unexpected shop open'); } } });
  t.after(() => worker.stop());
  const active = worker.tick(); await started; assert.equal(worker.isBusy(), true);
  paused = true; await worker.tick(); assert.equal(f.calls.length, 1);
  release(); await active;
  assert.equal(worker.isBusy(), false); assert.equal(listed, 0);
  await worker.tick(); assert.equal(f.calls.length, 1);
  paused = false; await worker.tick(); assert.equal(listed, 1);
});
