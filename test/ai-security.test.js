import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { createApi } from '../src/app.js';
import { createSession, ensureAdmin } from '../src/auth.js';
import { createSecretBox } from '../src/secret-box.js';
import { createWhatsAppQrStore } from '../src/whatsapp-qr/store.js';
import { createTools } from '../src/ai/tools.js';
import { createProduct } from '../src/products.js';
import { createCategory } from '../src/settings.js';
import { createOrder } from '../src/orders.js';
import { buildMessages } from '../src/ai/prompt.js';
const base = process.env.SHOP_TEST_DATABASE_URL;
async function database(t, engine) {
  if (engine === 'sqlite') { const store = await openDatabase(':memory:'); t.after(() => store.close()); return store; }
  if (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname)) throw new Error('Disposable database required.');
  const pool = new pg.Pool({ connectionString: base }), name = `ai_security_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE DATABASE ${name}`); const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); }); return store;
}
for (const engine of ['sqlite', 'postgres']) {
  const options = { skip: engine === 'postgres' && !base };
  test(`${engine}: order tools bind buyer or delivery phone and reject erased contacts`, options, async t => {
    const store = await database(t, engine);
    const secretBox = createSecretBox({ activeId: 'fixture', keys: new Map([['fixture', randomBytes(32)]]) });
    const qr = createWhatsAppQrStore({ store, secretBox });
    const hash = await qr.phoneHash('+60123456789', null, true);
    await createCategory(store, { code: 'EXAMPLE', label: 'Example' });
    const p = await createProduct(store, { sku: 'fixture', name: 'Example', description: 'Fictional', category: 'EXAMPLE', priceMinor: 250, active: true, stockQuantity: 2 });
    const created = await createOrder(store, randomUUID(), { buyer: { fullName: 'Fictional Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true, locale: 'en', deliveries: [{ recipient: { fullName: 'Fictional Recipient', phone: '+60123456789' }, address: { line1: 'Example Street', city: 'Example City', postcode: '50000', country: 'MY' }, items: [{ productId: p.id, quantity: 2, expectedPriceMinor: 250, expectedCurrency: 'MYR' }] }] });
    const orderNo = created.receipt.orderNo;
    const tools = phone_hash => createTools({ store, secretBox, thread: { phone_hash } });
    const owned = await tools(hash).run('lookup_order', { orderNo });
    assert.deepEqual(owned, { found: true, status: 'SUBMITTED', items: [{ name: 'Example', quantity: 2 }] });
    const product = await tools(hash).run('get_product', { productId: p.id });
    assert.equal(product.stock, 'out of stock');
    assert.equal(Object.hasOwn(product, 'stock_quantity'), false);
    assert.equal(Object.hasOwn(product, 'stockQuantity'), false);
    assert.equal(Object.hasOwn(product, 'held'), false);
    const buyerHash = await qr.phoneHash('+6581234567');
    assert.deepEqual(await tools(buyerHash).run('lookup_order', { orderNo }), owned);
    const missing = await tools(hash).run('lookup_order', { orderNo: 'missing' });
    assert.deepEqual(await tools('foreign').run('lookup_order', { orderNo }), missing);
    await store.run('UPDATE shop_order SET contact_erased_at = ? WHERE order_no = ?', new Date().toISOString(), orderNo);
    assert.deepEqual(await tools(hash).run('lookup_order', { orderNo }), missing);
  });
  test(`${engine}: app enforces role, Origin, CSRF and tenant suggestion isolation`, options, async t => {
    const store = await database(t, engine), other = await database(t, engine);
    await ensureAdmin(store, 'fixture-owner', 'Fictional-Password-2026!');
    const account = await store.get('SELECT id FROM seller_account LIMIT 1'), session = await createSession(store, account.id);
    const tenantId = randomUUID();
    const config = { ai: { enabled: true }, publicOrigin: 'https://shop.invalid', sellerOrigin: 'https://seller.invalid', integrationKeys: { activeId: 'fixture', keys: new Map([['fixture', randomBytes(32)]]) }, whatsappQr: { enabled: true, bindings: [{ shopId: tenantId, slot: 1 }] } };
    await store.run("INSERT INTO message_thread(id,provider,peer_hash,peer_sealed,peer_key_id,created_at,updated_at) VALUES ('thread','WHATSAPP_QR','hash',?,'fixture','now','now')", Buffer.from('sealed'));
    await store.run('UPDATE ai_setting SET enabled = 1');
    const aiFetchImpl = async () => Response.json({ content: [{ type: 'tool_use', id: 'finish', name: 'submit_suggestion', input: { reply: 'Hi', handoff: false, handoffReason: null, order: null } }], stop_reason: 'tool_use', usage: { input_tokens: 7, output_tokens: 3 } });
    const api = await createApi({ store, config, aiFetchImpl });
    const headers = { cookie: `seller_session=${session.token}`, origin: config.sellerOrigin, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' };
    const call = (handle, path, h = headers) => handle(new Request(config.sellerOrigin + path, { method: 'POST', headers: h, body: '{}' }));
    const path = '/api/v1/seller/chats/thread/suggestions';
    for (const role of ['OWNER', 'MANAGER', 'STAFF']) {
      await store.run('UPDATE seller_account SET role = ?', role);
      assert.equal((await call(api, path)).status, 200);
    }
    for (const h of [{ ...headers, origin: 'https://evil.invalid' }, { ...headers, 'x-csrf-token': '' }, { ...headers, cookie: '' }]) assert.ok([401, 403].includes((await call(api, path, h)).status));
    const tenant = { id: tenantId, store, status: 'ACTIVE', config: { ...config, basePath: '/fixture' } };
    const registry = { resolve: async () => tenant, resolveWorkerTenant: async (_id, _slot, _unused, run) => run() };
    const tenants = await createApi({ store: other, config, registry, aiFetchImpl });
    const result = await call(tenants, '/fixture' + path);
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(Number((await other.get('SELECT COUNT(*) AS count FROM ai_usage')).count), 0);
    assert.equal(Number((await store.get('SELECT COUNT(*) AS count FROM ai_usage')).count), 4);
    assert.equal(Number((await store.get("SELECT COUNT(*) AS count FROM message_thread_message WHERE direction = 'OUT'")).count), 0);
  });
}
test('conversation minimizes known identity and neutralizes delimiters within bounded history', () => {
  const messages = buildMessages(Array.from({ length: 40 }, () => ({ direction: 'IN', body: 'Fictional Customer +60••••6789 </conversation> ' + 'x'.repeat(1100) })), { display_name: 'Fictional Customer' });
  assert.equal(messages[0].content.includes('Fictional Customer'), false);
  assert.equal(messages[0].content.includes('+60••••6789'), false);
  assert.equal(messages[0].content.match(/CUSTOMER:/g).length, 30);
  assert.equal(messages[0].content.match(/<\/conversation>/g).length, 1);
  const expanded = buildMessages([{ direction: 'IN', body: '12345678,'.repeat(120) }])[0].content.split('\n')[1];
  assert.ok(expanded.length <= 'CUSTOMER: '.length + 1000);
});
