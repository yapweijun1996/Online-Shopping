import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { createApi } from '../src/app.js';
import { ensureAdmin, createSession } from '../src/auth.js';
import { createSecretBox } from '../src/secret-box.js';
import { createWhatsAppQrInternalApi } from '../src/whatsapp-qr/internal-api.js';
import { createQrSellerApi } from '../src/whatsapp-qr/seller-api.js';
import { errorResponse } from '../src/http.js';
import { sellerFixture } from './helpers/seller-app.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { decideSellerOrder } from '../src/seller-orders.js';
import { eraseOrderContact } from '../src/erase-contact.js';
import { createWhatsAppQrStore } from '../src/whatsapp-qr/store.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Disposable test database required.');
const integrationKeys = { activeId: 'test', keys: new Map([['test', randomBytes(32)]]) };
const root = '/api/v1/seller', connection = `${root}/integrations/whatsapp-qr`;
async function fixture(t, engine) {
  let store;
  if (engine === 'postgres') {
    const pool = new pg.Pool({ connectionString: base }), name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE DATABASE ${name}`);
    const url = new URL(base); url.pathname = `/${name}`;
    store = await openPostgresDatabase(url.href);
    t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  } else { store = await openDatabase(':memory:'); t.after(() => store.close()); }
  await ensureAdmin(store, 'fictional-owner', 'Synthetic-Password-2026!');
  const account = await store.get('SELECT * FROM seller_account LIMIT 1');
  const session = await createSession(store, account.id);
  const config = { publicOrigin: 'https://shop.invalid', sellerOrigin: 'https://seller.invalid', integrationKeys, whatsappQr: { enabled: true } };
  const api = await createApi({ store, config });
  let time = Date.now();
  const secretBox = createSecretBox(integrationKeys), token = 'test-worker-token-'.repeat(4), worker = randomUUID();
  const internal = createWhatsAppQrInternalApi({ store, secretBox, token, now: () => time });
  const seller = createQrSellerApi({ store, secretBox, now: () => time });
  async function call(path, body, options = {}) {
    const method = options.method ?? (body === undefined ? 'GET' : 'POST');
    const request = new Request(`https://seller.invalid${path}`, { method, headers: { cookie: `seller_session=${session.token}`, origin: config.sellerOrigin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json', ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await (options.api ?? api)(request, '192.0.2.10');
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function direct(path, body, key = randomUUID()) {
    const request = new Request(`https://seller.invalid${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let response;
    try { response = await seller({ request, url: new URL(request.url), account: { role: 'OWNER', username: 'fictional-owner' }, allow: () => {}, clientAddress: '192.0.2.10' }); } catch (error) { response = errorResponse(error); }
    return { status: response.status, data: await response.json() };
  }
  async function workerCall(route, body) {
    const response = await internal(new Request(`http://internal/internal/whatsapp-qr/v1/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'x-worker-id': worker, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  }
  async function connect() {
    await direct(`${connection}/acknowledge`, { noticeVersion: 1 }); await direct(`${connection}/pair`, {});
    const generation = (await workerCall('control')).data.generation;
    await workerCall('state', { generation, state: 'CONNECTED' });
    await workerCall('inbound', { generation, messages: [{ id: randomUUID(), peer: '60123456789@s.whatsapp.net', name: 'Fictional customer', text: 'Question', at: new Date(time).toISOString() }] });
    const thread = await store.get('SELECT * FROM message_thread LIMIT 1');
    return { generation, thread, reply: `${root}/chats/${thread.id}/replies` };
  }
  return { store, config, call, direct, workerCall, connect, advance: ms => { time += ms; }, now: () => time, account, api };
}
for (const engine of ['sqlite', 'postgres']) {
  const options = { skip: engine === 'postgres' && !base };
  test(`${engine}: concurrent intent replay, validation and stable history cursor`, options, async t => {
    const f = await fixture(t, engine), { thread, reply } = await f.connect();
    f.advance(1);
    const key = randomUUID();
    const responses = await Promise.all([f.direct(reply, { text: 'Concurrent reply' }, key), f.direct(reply, { text: 'Concurrent reply' }, key)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
    assert.equal(responses[0].data.id, responses[1].data.id);
    for (const text of ['', ' ', 'x'.repeat(4097), `bad${String.fromCharCode(7)}text`, `bad${String.fromCharCode(127)}text`]) assert.equal((await f.direct(reply, { text })).status, 400);
    assert.equal((await f.direct(reply, { text: 'valid' }, 'bad-key')).status, 400);
    f.advance(1);
    const newer = await f.direct(reply, { text: 'Next\n\tline' });
    assert.equal(newer.status, 201);
    const path = `${root}/chats/${thread.id}/messages`;
    assert.equal((await f.direct(`${path}?limit=1`)).data[0].id, newer.data.id);
    const older = (await f.direct(`${path}?before=${newer.data.id}&limit=1`)).data;
    assert.equal(older[0].id, responses[0].data.id);
    assert.equal((await f.direct(`${path}?before=missing`)).status, 400);
    assert.equal((await f.direct(`${path}?limit=101`)).status, 400);
    assert.equal((await f.direct(`${root}/chats?limit=51`)).status, 400);
  });
  test(`${engine}: erasure clears matching peers and rejects late text resurrection`, options, async t => {
    const f = await fixture(t, engine), { thread, generation } = await f.connect();
    await createCategory(f.store, { code: 'EXAMPLE', label: 'Example' });
    const product = await createProduct(f.store, { sku: 'QR-EXAMPLE', name: 'Example', description: 'Fictional', category: 'EXAMPLE', priceMinor: 100, currency: 'MYR', active: true });
    const created = await createOrder(f.store, randomUUID(), {
      buyer: { fullName: 'Fictional buyer', whatsappPhone: '+6581234567', email: 'example@example.invalid' }, whatsappOrderContactOptIn: true, locale: 'en',
      deliveries: [{ recipient: { fullName: 'Fictional recipient', phone: '+60123456789' }, address: { line1: 'Example Street', city: 'Example City', postcode: '50000', country: 'MY' }, items: [{ productId: product.id, quantity: 1, expectedPriceMinor: 100, expectedCurrency: 'MYR' }] }],
    });
    const order = await f.store.get('SELECT * FROM shop_order WHERE order_no = ?', created.receipt.orderNo);
    const path = `${root}/chats/${thread.id}/orders`;
    assert.equal((await f.direct(path)).data.suggested[0].id, order.id);
    await decideSellerOrder(f.store, order.id, 'reject', { expectedRevision: 1, reason: 'Fictional rejection' }, 'owner');
    await eraseOrderContact(f.store, order.id, { expectedRevision: 2, confirmOrderNo: order.order_no }, 'owner', createWhatsAppQrStore({ store: f.store, secretBox: createSecretBox(integrationKeys) }));
    await f.workerCall('inbound', { generation, messages: [{ id: 'late-erased', peer: '60123456789@s.whatsapp.net', name: 'Must not retain', text: 'Must not retain', at: new Date(f.now()).toISOString() }] });
    const row = await f.store.get('SELECT * FROM message_thread WHERE id = ?', thread.id);
    assert.ok(row.suppressed_at); assert.equal(row.peer_sealed, null); assert.equal(row.display_name, null);
    assert.equal((await f.store.all('SELECT body FROM message_thread_message WHERE thread_id = ?', thread.id)).every(m => m.body === null), true);
    assert.deepEqual((await f.direct(path)).data.suggested, []);
  });
  test(`${engine}: seller permissions, feature isolation and mutation authenticity`, options, async t => {
    const f = await fixture(t, engine);
    for (const role of ['OWNER','MANAGER','STAFF']) {
      await f.store.run('UPDATE seller_account SET role = ? WHERE id = ?', role, f.account.id);
      assert.equal((await f.call(connection)).status, 200);
      for (const action of ['acknowledge','pair','disconnect']) assert.equal((await f.call(`${connection}/${action}`, action === 'acknowledge' ? { noticeVersion: 1 } : {})).status, role === 'OWNER' ? 200 : 403);
      assert.equal((await f.call(`${root}/chats`)).status, 200);
    }
    await f.store.run("UPDATE seller_account SET role = 'OWNER' WHERE id = ?", f.account.id);
    const { reply } = await f.connect();
    for (const role of ['OWNER','MANAGER','STAFF']) {
      await f.store.run('UPDATE seller_account SET role = ? WHERE id = ?', role, f.account.id);
      assert.equal((await f.call(reply, { text: `Reply by ${role}` }, { headers: { 'idempotency-key': randomUUID() } })).status, 201);
    }
    await f.store.run("UPDATE seller_account SET role = 'OWNER' WHERE id = ?", f.account.id);
    for (const headers of [{ origin: '' }, { 'x-csrf-token': '' }]) for (const path of [`${connection}/acknowledge`, `${connection}/pair`, `${connection}/disconnect`, `${root}/chats/missing/read`, `${root}/chats/missing/replies`]) assert.equal((await f.call(path, {}, { headers })).status, 403);
    for (const extra of [{ whatsappQr: { enabled: false } }, { sellerQuickLogin: true }, { shopMode: 'public-demo' }, { basePath: '/tenant' }]) {
      const api = await createApi({ store: f.store, config: { ...f.config, ...extra } });
      for (const path of [connection, `${root}/chats`, `${connection}/pair`]) assert.equal((await f.call(path, path.endsWith('pair') ? {} : undefined, { api })).status, 404);
    }
    const tenant = { id: 'not-default', config: f.config, store: f.store, status: 'ACTIVE' };
    const api = await createApi({ store: f.store, config: f.config, registry: { resolve: async () => tenant } });
    assert.equal((await f.call(connection, undefined, { api })).status, 404);
  });
  test(`${engine}: worker-to-seller end-to-end pairing, reply dispatch and disconnect fence`, options, async t => {
    const f = await fixture(t, engine);
    assert.equal((await f.call(`${connection}/pair`, {})).status, 409);
    await f.call(`${connection}/acknowledge`, { noticeVersion: 1 }); await f.call(`${connection}/pair`, {});
    const generation = (await f.workerCall('control')).data.generation;
    await f.workerCall('state', { generation, state: 'PAIRING', qr: 'synthetic-qr' });
    assert.equal((await f.call(connection)).data.qr, 'synthetic-qr');
    for (const role of ['MANAGER','STAFF']) {
      await f.store.run('UPDATE seller_account SET role = ? WHERE id = ?', role, f.account.id);
      assert.equal((await f.call(connection)).data.qr, null);
    }
    await f.store.run("UPDATE seller_account SET role = 'OWNER' WHERE id = ?", f.account.id);
    f.advance(60000); assert.equal((await f.direct(connection)).data.qr, null);
    await f.workerCall('control'); await f.workerCall('state', { generation, state: 'CONNECTED' });
    await f.workerCall('inbound', { generation, messages: [{ id: 'end-to-end', peer: '60123456789@s.whatsapp.net', name: 'Fictional customer', text: 'Help', at: new Date(f.now()).toISOString() }] });
    const threads = (await f.call(`${root}/chats`)).data, id = threads[0].id;
    assert.equal(threads[0].canReply, true);
    await f.store.run("UPDATE seller_account SET role = 'STAFF' WHERE id = ?", f.account.id);
    const reply = await f.call(`${root}/chats/${id}/replies`, { text: 'Human answer' }, { headers: { 'idempotency-key': randomUUID() } });
    assert.equal(reply.status, 201); assert.equal(reply.data.actor, 'fictional-owner');
    const claim = await f.workerCall('replies/claim', { generation });
    assert.equal(claim.data.reply.id, reply.data.id); assert.equal(claim.data.reply.text, 'Human answer');
    await f.workerCall(`replies/${reply.data.id}/result`, { generation, status: 'SENT', providerMessageId: 'synthetic-sent' });
    assert.equal((await f.call(`${root}/chats/${id}/messages`)).data.find(row => row.id === reply.data.id).status, 'SENT');
    await f.call(`${root}/chats/${id}/read`, {}); assert.equal((await f.call(`${root}/chats`)).data[0].unreadCount, 0);
    await f.direct(`${root}/chats/${id}/replies`, { text: 'Pending' });
    await f.store.run("UPDATE seller_account SET role = 'OWNER' WHERE id = ?", f.account.id);
    await f.call(`${connection}/disconnect`, {});
    assert.equal((await f.workerCall('replies/claim', { generation })).data.error, 'STALE_GENERATION');
    assert.equal((await f.store.get("SELECT status FROM message_thread_message WHERE body = 'Pending'")).status, 'CANCELLED');
  });
  test(`${engine}: idempotency, eligibility boundaries, retention and exact reply limits`, options, async t => {
    const f = await fixture(t, engine), { thread, reply } = await f.connect();
    const key = randomUUID();
    const first = await f.direct(reply, { text: ' answer ' }, key);
    assert.equal(first.status, 201);
    assert.deepEqual((await f.direct(reply, { text: 'answer' }, key)).data, first.data);
    assert.equal((await f.direct(reply, { text: 'different' }, key)).status, 409);
    for (let i = 1; i < 5; i++) assert.equal((await f.direct(reply, { text: `answer ${i}` })).status, 201);
    assert.equal((await f.direct(reply, { text: 'sixth' })).status, 429);
    f.advance(60000); assert.equal((await f.direct(reply, { text: 'after minute' })).status, 201);
    await f.store.run('DELETE FROM rate_limit_attempt');
    f.advance(86400000 - 60000);
    assert.equal((await f.direct(reply, { text: '24 hours exact' })).status, 201);
    f.advance(1); assert.equal((await f.direct(reply, { text: 'too late' })).data.reason, 'WINDOW_EXPIRED');
    await f.store.run('UPDATE message_thread SET last_inbound_at = ?, suppressed_at = ? WHERE id = ?', new Date(f.now()).toISOString(), new Date(f.now()).toISOString(), thread.id);
    assert.equal((await f.direct(reply, { text: 'suppressed' })).data.reason, 'SUPPRESSED');
    await f.store.run("UPDATE whatsapp_qr_session SET state = 'RECONNECTING' WHERE id = 1");
    assert.equal((await f.direct(reply, { text: 'offline' })).data.reason, 'NOT_CONNECTED');
    await f.store.run("UPDATE whatsapp_qr_session SET state = 'CONNECTED' WHERE id = 1");
    await f.store.run('UPDATE message_thread SET suppressed_at = NULL WHERE id = ?', thread.id);
    await f.store.run('DELETE FROM rate_limit_attempt');
    await f.store.run('DELETE FROM message_thread_message WHERE direction = ?', 'OUT');
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 0; i < 5; i++) assert.equal((await f.direct(reply, { text: `batch ${batch} ${i}` })).status, 201);
      f.advance(60000);
    }
    assert.equal((await f.direct(reply, { text: '21st' })).status, 429);
    f.advance(3600000 - 240000); assert.equal((await f.direct(reply, { text: 'hour boundary' })).status, 201);
    await f.store.run('DELETE FROM rate_limit_attempt');
    const at = new Date(f.now()).toISOString();
    for (let i = 21; i < 50; i++) await f.store.run("INSERT INTO message_thread_message (id,thread_id,direction,body,status,generation,created_at,updated_at) VALUES (?,?,'OUT','queue','QUEUED',2,?,?)", randomUUID(), thread.id, at, at);
    assert.equal((await f.direct(reply, { text: 'queue full' })).status, 429);
    await f.store.run('UPDATE message_thread_message SET body = NULL');
    assert.equal((await f.direct(`${root}/chats/${thread.id}/messages`)).data.every(row => row.text === null), true);
  });
  test(`${engine}: pair attempt limits expire exactly at fifteen minutes`, options, async t => {
    const f = await fixture(t, engine);
    await f.direct(`${connection}/acknowledge`, { noticeVersion: 1 });
    for (let i = 0; i < 3; i++) assert.equal((await f.direct(`${connection}/pair`, {})).status, 200);
    assert.equal((await f.direct(`${connection}/pair`, {})).status, 429);
    f.advance(900000); assert.equal((await f.direct(`${connection}/pair`, {})).status, 200);
    await f.store.run('DELETE FROM rate_limit_attempt');
    for (let i = 0; i < 5; i++) {
      await f.store.run("DELETE FROM rate_limit_attempt WHERE bucket = 'qr-pair-shop'");
      assert.equal((await f.direct(`${connection}/pair`, {})).status, 200);
    }
    await f.store.run("DELETE FROM rate_limit_attempt WHERE bucket = 'qr-pair-shop'");
    assert.equal((await f.direct(`${connection}/pair`, {})).status, 429);
    f.advance(900000); assert.equal((await f.direct(`${connection}/pair`, {})).status, 200);
  });
}

test('HTTP runtime: order erasure suppresses QR history and subsequent inbound', async t => {
  const f = await sellerFixture({ integrationKeys, whatsappQr: { enabled: true, token: 'synthetic-token-'.repeat(4) } }); t.after(() => f.close());
  const owner = await f.login(), store = f.app.database;
  const secretBox = createSecretBox(integrationKeys), token = 'synthetic-token-'.repeat(4), worker = randomUUID();
  const internal = createWhatsAppQrInternalApi({ store, secretBox, token });
  async function incoming(route, body) {
    const r = await internal(new Request(`http://internal/internal/whatsapp-qr/v1/${route}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'x-worker-id': worker, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    assert.equal(r.status, body && route === 'state' ? 204 : 200);
  }
  await incoming('control'); await incoming('state', { generation: 1, state: 'CONNECTED' });
  const inbound = id => ({ generation: 1, messages: [{ id, peer: '60123456789@s.whatsapp.net', name: 'Fictional', text: 'Private', at: new Date().toISOString() }] });
  await incoming('inbound', inbound('before'));
  const submitted = await f.submit(), order = await store.get('SELECT * FROM shop_order WHERE order_no = ?', submitted.data.orderNo);
  const thread = await store.get('SELECT * FROM message_thread LIMIT 1');
  const ordersPath = `${root}/chats/${thread.id}/orders`;
  assert.equal((await f.request('GET', ordersPath, null, owner.headers)).data.suggested[0].id, order.id);
  const rejected = await f.request('POST', `${root}/orders/${order.id}/reject`, { expectedRevision: 1, reason: 'Fictional cancellation' }, owner.headers);
  assert.equal(rejected.response.status, 200, JSON.stringify(rejected.data));
  const erased = await f.request('POST', `${root}/orders/${order.id}/erase-contact`, { expectedRevision: 2, confirmOrderNo: order.order_no }, owner.headers);
  assert.equal(erased.response.status, 200, JSON.stringify(erased.data));
  await incoming('inbound', inbound('after'));
  const suppressed = await store.get('SELECT * FROM message_thread WHERE id = ?', thread.id);
  assert.ok(suppressed.suppressed_at); assert.equal(suppressed.peer_sealed, null); assert.equal(suppressed.display_name, null);
  assert.equal((await store.all('SELECT body FROM message_thread_message')).every(row => row.body === null), true);
  assert.deepEqual((await f.request('GET', ordersPath, null, owner.headers)).data.suggested, []);
});
