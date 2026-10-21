import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { openDatabase, migrateStore, SCHEMA_VERSION } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { createSecretBox } from '../src/secret-box.js';
import { readWhatsAppQrConfig } from '../src/config.js';
import { createWhatsAppQrInternalApi } from '../src/whatsapp-qr/internal-api.js';
import { createWhatsAppQrServer } from '../src/server.js';
import { importSqlite } from '../src/sqlite-import.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Disposable test database required.');
const token = 'synthetic-worker-token-'.repeat(3);
const integrationKeys = { activeId: 'test', keys: new Map([['test', randomBytes(32)]]) };
const tables = ['message_thread_message','message_thread','whatsapp_qr_auth','whatsapp_qr_session'];
async function fixture(t, engine) {
  let store;
  if (engine === 'postgres') {
    const pool = new pg.Pool({ connectionString: base }), name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE DATABASE ${name}`);
    const url = new URL(base); url.pathname = `/${name}`;
    store = await openPostgresDatabase(url.href);
    t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  } else { store = await openDatabase(':memory:'); t.after(() => store.close()); }
  let time = Date.parse('2026-10-21T12:00:00.000Z');
  const worker = randomUUID(), secretBox = createSecretBox(integrationKeys);
  const handle = createWhatsAppQrInternalApi({ store, secretBox, token, now: () => time });
  async function call(route, body, options = {}) {
    const method = options.method ?? (body === undefined ? 'GET' : 'POST');
    const headers = { authorization: `Bearer ${token}`, 'x-worker-id': worker, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers };
    const response = await handle(new Request(`http://internal/internal/whatsapp-qr/v1/${route}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.has('access-control-allow-origin'), false);
    const text = await response.text(); return { status: response.status, data: text ? JSON.parse(text) : null };
  }
  async function queue(extra = {}) {
    const thread = await store.get('SELECT id FROM message_thread LIMIT 1'), id = randomUUID(), at = new Date(time).toISOString();
    await store.run(`INSERT INTO message_thread_message (id,thread_id,direction,body,status,generation,created_at,updated_at) VALUES (?,?,'OUT',?,'QUEUED',?,?,?)`, id, thread.id, extra.body ?? 'Fictional human reply', extra.generation ?? 1, extra.at ?? at, at);
    return id;
  }
  const inbound = (id = 'provider-1', extra = {}) => ({ generation: 1, messages: [{ id, peer: '60123456789@s.whatsapp.net', name: 'Fictional buyer', at: new Date(time).toISOString(), text: 'Fictional inbound', ...extra }] });
  return { store, call, queue, inbound, worker, handle, now: () => time, advance: ms => { time += ms; } };
}

test('QR configuration defaults, strict flag/port/token and activation gates', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shopping-qr-')); t.after(() => rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'token'); writeFileSync(file, `${token}\nignored second line`);
  assert.deepEqual(readWhatsAppQrConfig({}, null), { enabled: false, token: null, port: 3001 });
  const enabled = { WHATSAPP_QR_ENABLED: '1', WHATSAPP_QR_TOKEN_FILE: file };
  assert.deepEqual(readWhatsAppQrConfig(enabled, integrationKeys), { enabled: true, token, port: 3001 });
  for (const flag of ['', 'true', '2']) assert.throws(() => readWhatsAppQrConfig({ WHATSAPP_QR_ENABLED: flag }, null), /ENABLED/);
  for (const port of ['0','1023','65536','3001.5','abc','']) assert.throws(() => readWhatsAppQrConfig({ WHATSAPP_QR_PORT: port }, null), /PORT/);
  for (const port of ['1024','65535']) assert.equal(readWhatsAppQrConfig({ WHATSAPP_QR_PORT: port }, null).port, Number(port));
  assert.throws(() => readWhatsAppQrConfig(enabled, null), /integration keys/);
  for (const extra of [{ SELLER_QUICK_LOGIN: '1' }, { SHOP_MODE: 'public-demo' }, { WHATSAPP_QR_SHOP: 'other' }, { WHATSAPP_QR_TOKEN_FILE: '/nonexistent/synthetic' }]) assert.throws(() => readWhatsAppQrConfig({ ...enabled, ...extra }, integrationKeys));
  for (const value of ['x'.repeat(31), 'x'.repeat(32) + '!', '']) { writeFileSync(file, value); assert.throws(() => readWhatsAppQrConfig(enabled, integrationKeys), /TOKEN_FILE/); }
});

for (const engine of ['sqlite','postgres']) {
  const options = { skip: engine === 'postgres' && !base };
  test(`${engine}: authentication, route isolation, lease ownership and generation fencing`, options, async t => {
    const f = await fixture(t, engine);
    for (const authorization of ['', 'Bearer wrong', `Bearer ${'x'.repeat(token.length)}`]) assert.equal((await f.call('control', undefined, { headers: { authorization } })).status, 401);
    assert.equal((await f.call('unknown')).status, 404);
    assert.equal((await f.call('control', undefined, { headers: { 'x-worker-id': 'bad' } })).status, 400);
    assert.equal((await f.call('state', { generation: 1, state: 'IDLE' })).data.error, 'LEASE_HELD');
    assert.equal((await f.call('control')).status, 200);
    const other = { headers: { 'x-worker-id': randomUUID() } };
    assert.equal((await f.call('control', undefined, other)).data.error, 'LEASE_HELD');
    assert.equal((await f.call('state', { generation: 2, state: 'CONNECTED' })).data.error, 'STALE_GENERATION');
    assert.equal((await f.call('auth?generation=2')).data.error, 'STALE_GENERATION');
    assert.equal((await f.call('state', { generation: 1, state: 'CONNECTED' }, other)).data.error, 'LEASE_HELD');
    f.advance(60001); assert.equal((await f.call('control', undefined, other)).status, 200);
    assert.equal((await f.call('state', { generation: 1, state: 'CONNECTED' })).data.error, 'LEASE_HELD');
  });
  test(`${engine}: JSON caps, atomic chunked auth, version conflicts and corrupt-record exclusion`, options, async t => {
    const f = await fixture(t, engine); await f.call('control');
    assert.equal((await f.call('state', { generation: 1 }, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await f.call('state', '{broken')).status, 400);
    assert.equal((await f.call('state', { generation: 1, state: 'ERROR', padding: 'x'.repeat(65536) })).status, 413);
    assert.equal((await f.call('auth', { generation: 1, version: 0, creds: 'x'.repeat(262144) }, { method: 'PUT' })).status, 413);
    const creds = JSON.stringify({ data: 'c'.repeat(9000) }), value = JSON.stringify({ data: 'k'.repeat(13000) });
    const body = { generation: 1, version: 0, creds, set: [{ type: 'pre-key', id: '1', value }] };
    assert.deepEqual((await f.call('auth', body, { method: 'PUT' })).data, { version: 1 });
    assert.deepEqual((await f.call('auth?generation=1')).data, { version: 1, creds, keys: [{ type: 'pre-key', id: '1', value }] });
    const rows = await f.store.all('SELECT * FROM whatsapp_qr_auth');
    assert.equal(rows.filter(row => row.record_type === 'pre-key').length, 4);
    assert.equal(rows.some(row => Buffer.from(row.ciphertext).includes(Buffer.from('kkkkkkkk'))), false);
    assert.equal((await f.call('auth', body, { method: 'PUT' })).data.error, 'AUTH_VERSION');
    await f.store.run("UPDATE whatsapp_qr_auth SET ciphertext = ? WHERE record_type = 'pre-key' AND chunk_index = 1", Buffer.from('tampered'));
    assert.deepEqual((await f.call('auth?generation=1')).data, { version: 1, creds, keys: [] });
    const invalid = { generation: 1, version: 1, set: [{ type: 'pre-key', id: '2', value: 'ok' }, { type: 'BAD', id: '3', value: 'bad' }] };
    assert.equal((await f.call('auth', invalid, { method: 'PUT' })).status, 400);
    assert.equal((await f.call('auth?generation=1')).data.version, 1);
    assert.equal((await f.call('auth', { generation: 1, version: 1, delete: [{ type: 'pre-key', id: '1' }] }, { method: 'PUT' })).status, 200);
    assert.equal((await f.store.all("SELECT * FROM whatsapp_qr_auth WHERE record_type = 'pre-key'")).length, 0);
  });
  test(`${engine}: auth Unicode chunk boundaries and missing record types`, options, async t => {
    const f = await fixture(t, engine); await f.call('control');
    const value = 'a'.repeat(4095) + '😀' + 'b'.repeat(4096);
    assert.equal((await f.call('auth', { generation: 1, version: 0, creds: value }, { method: 'PUT' })).status, 200);
    assert.equal((await f.call('auth?generation=1')).data.creds, value);
    assert.equal((await f.call('auth', { generation: 1, version: 1, set: [{ id: '1', value: 'value' }] }, { method: 'PUT' })).status, 400);
  });
  test(`${engine}: inbound validation, atomic batches, direct-peer sealing and dedupe`, options, async t => {
    const f = await fixture(t, engine); await f.call('control');
    for (const peer of ['1@g.us','status@broadcast','1@broadcast','1@newsletter','abc@s.whatsapp.net']) assert.equal((await f.call('inbound', f.inbound('bad', { peer }))).status, 400);
    for (const text of ['', 'x'.repeat(4097)]) assert.equal((await f.call('inbound', f.inbound('bad', { text }))).status, 400);
    const mixed = f.inbound(); mixed.messages.push({ ...mixed.messages[0], id: 'bad', peer: '1@g.us' });
    assert.equal((await f.call('inbound', mixed)).status, 400);
    assert.equal((await f.store.all('SELECT * FROM message_thread')).length, 0);
    assert.deepEqual((await f.call('inbound', f.inbound())).data, { accepted: 1, duplicates: 0 });
    assert.deepEqual((await f.call('inbound', f.inbound())).data, { accepted: 0, duplicates: 1 });
    assert.equal((await f.call('inbound', f.inbound('lid', { peer: '12345@lid', text: 'x'.repeat(4096) }))).status, 200);
    const thread = await f.store.get('SELECT * FROM message_thread WHERE phone_hash IS NOT NULL');
    assert.equal(thread.unread_count, 1); assert.match(thread.peer_hash, /^[a-f0-9]{64}$/);
    assert.equal(Buffer.from(thread.peer_sealed).includes(Buffer.from('60123456789')), false);
    assert.equal((await f.store.get('SELECT phone_hash FROM message_thread WHERE phone_hash IS NULL')).phone_hash, null);
  });
  test(`${engine}: claim eligibility, one in-flight, spacing and result transitions`, options, async t => {
    const f = await fixture(t, engine); await f.call('control'); await f.call('inbound', f.inbound());
    const disconnected = await f.queue(); assert.deepEqual((await f.call('replies/claim', { generation: 1 })).data, { reply: null });
    assert.equal((await f.store.get('SELECT status FROM message_thread_message WHERE id = ?', disconnected)).status, 'FAILED');
    await f.call('state', { generation: 1, state: 'CONNECTED' });
    const stale = await f.queue({ generation: 2 }); await f.call('replies/claim', { generation: 1 });
    assert.equal((await f.store.get('SELECT error_code FROM message_thread_message WHERE id = ?', stale)).error_code, 'NOT_ELIGIBLE');
    await f.store.run('UPDATE message_thread SET suppressed_at = ?', new Date(f.now()).toISOString());
    const suppressed = await f.queue(); await f.call('replies/claim', { generation: 1 });
    assert.equal((await f.store.get('SELECT status FROM message_thread_message WHERE id = ?', suppressed)).status, 'FAILED');
    await f.store.run('UPDATE message_thread SET suppressed_at = NULL, last_inbound_at = ?', new Date(f.now() - 86400001).toISOString());
    const expired = await f.queue(); await f.call('replies/claim', { generation: 1 });
    assert.equal((await f.store.get('SELECT status FROM message_thread_message WHERE id = ?', expired)).status, 'FAILED');
    await f.store.run('UPDATE message_thread SET last_inbound_at = ?', new Date(f.now() - 86400000).toISOString());
    const first = await f.queue(), second = await f.queue({ at: new Date(f.now() + 1).toISOString() });
    assert.deepEqual((await f.call('replies/claim', { generation: 1 })).data.reply, { id: first, peer: '60123456789@s.whatsapp.net', text: 'Fictional human reply' });
    assert.equal((await f.call('replies/claim', { generation: 1 })).data.reply, null);
    assert.equal((await f.call(`replies/${first}/result`, { generation: 1, status: 'SENT', providerMessageId: 'sent-1' })).status, 204);
    assert.equal((await f.call(`replies/${first}/result`, { generation: 1, status: 'UNKNOWN' })).data.error, 'REPLY_STATUS');
    assert.equal((await f.call('replies/claim', { generation: 1 })).data.reply, null);
    // Keep the thread eligible while advancing the claim clock.
    await f.store.run('UPDATE message_thread SET last_inbound_at = ?', new Date(f.now()).toISOString());
    f.advance(5000);
    assert.equal((await f.call('replies/claim', { generation: 1 })).data.reply.id, second);
    assert.equal((await f.call(`replies/${second}/result`, { generation: 1, status: 'UNKNOWN' })).status, 204);
    assert.equal((await f.store.get('SELECT status FROM message_thread_message WHERE id = ?', second)).status, 'RECONCILE');
    f.advance(5000); const third = await f.queue(); await f.call('replies/claim', { generation: 1 });
    assert.equal((await f.call(`replies/${third}/result`, { generation: 1, status: 'FAILED', code: 'PRE_DISPATCH' })).status, 204);
    assert.equal((await f.store.get('SELECT status FROM message_thread_message WHERE id = ?', third)).status, 'FAILED');
  });
  test(`${engine}: QR lifecycle, logout cleanup and bounded retention/reconcile housekeeping`, options, async t => {
    const f = await fixture(t, engine); await f.call('control');
    await f.store.run("UPDATE whatsapp_qr_session SET desired = 'PAIR'");
    assert.equal((await f.call('state', { generation: 1, state: 'PAIRING', qr: 'fictional-qr' })).status, 204);
    f.advance(60001); await f.call('control');
    assert.equal((await f.store.get('SELECT qr_text FROM whatsapp_qr_session')).qr_text, null);
    await f.call('state', { generation: 1, state: 'CONNECTED', phone: '60123456789' });
    const session = await f.store.get('SELECT * FROM whatsapp_qr_session');
    assert.equal(session.desired, 'RUN'); assert.equal(session.phone_masked, '+60•••••6789'); assert.match(session.phone_hash, /^[a-f0-9]{64}$/);
    await f.call('auth', { generation: 1, version: 0, creds: 'fictional credentials' }, { method: 'PUT' });
    await f.call('inbound', f.inbound()); const sending = await f.queue(); await f.call('replies/claim', { generation: 1 });
    await f.store.run('UPDATE message_thread_message SET created_at = ? WHERE direction = ?', new Date(f.now() - 31 * 86400000).toISOString(), 'IN');
    f.advance(60001); await f.call('control');
    assert.equal((await f.store.get('SELECT body FROM message_thread_message WHERE direction = ?', 'IN')).body, null);
    assert.equal((await f.store.get('SELECT status FROM message_thread_message WHERE id = ?', sending)).status, 'RECONCILE');
    assert.equal((await f.call(`replies/${sending}/result`, { generation: 1, status: 'SENT', providerMessageId: 'late' })).status, 409);
    await f.call('state', { generation: 1, state: 'LOGGED_OUT' });
    assert.equal((await f.store.get('SELECT desired FROM whatsapp_qr_session')).desired, 'OFF');
    assert.deepEqual((await f.call('auth?generation=1')).data, { version: 2, creds: null, keys: [] });
    assert.equal((await f.call('auth', { generation: 1, version: 1, creds: 'late stale credentials' }, { method: 'PUT' })).data.error, 'AUTH_VERSION');
  });
  test(`${engine}: concurrent auth writes fence one snapshot and retention is bounded`, options, async t => {
    const f = await fixture(t, engine); await f.call('control');
    const writes = await Promise.all(['first', 'second'].map(creds => f.call('auth', { generation: 1, version: 0, creds }, { method: 'PUT' })));
    assert.deepEqual(writes.map(row => row.status).sort(), [200, 409]);
    assert.equal(writes.find(row => row.status === 409).data.error, 'AUTH_VERSION');
    assert.equal((await f.call('auth?generation=1')).data.creds, ['first', 'second'][writes.findIndex(row => row.status === 200)]);
    await f.call('inbound', f.inbound());
    const old = new Date(f.now() - 31 * 86400000).toISOString();
    await f.store.transaction(async () => {
      for (let index = 0; index < 201; index++) await f.queue({ at: old });
    });
    await f.call('control');
    assert.equal(Number((await f.store.get("SELECT COUNT(*) AS count FROM message_thread_message WHERE direction = 'OUT' AND body IS NOT NULL")).count), 1);
    await f.call('control');
    assert.equal(Number((await f.store.get("SELECT COUNT(*) AS count FROM message_thread_message WHERE direction = 'OUT' AND body IS NOT NULL")).count), 0);
    assert.equal(Number((await f.store.get("SELECT COUNT(*) AS count FROM message_thread_message WHERE direction = 'OUT'")).count), 201);
  });
  test(`${engine}: schema protects inbound dedupe, intent uniqueness, text and peer integrity`, options, async t => {
    const f = await fixture(t, engine); await f.call('control'); await f.call('inbound', f.inbound());
    const first = await f.queue(), second = await f.queue();
    await f.store.run("UPDATE message_thread_message SET provider_message_id = 'provider-1' WHERE direction = 'OUT'");
    await assert.rejects(f.store.run("INSERT INTO message_thread_message (id,thread_id,direction,provider_message_id,body,status,generation,created_at,updated_at) SELECT ?,thread_id,direction,provider_message_id,body,status,generation,created_at,updated_at FROM message_thread_message WHERE direction = 'IN'", randomUUID()));
    await f.store.run("UPDATE message_thread_message SET idempotency_key = 'same-intent' WHERE id = ?", first);
    await assert.rejects(f.store.run("UPDATE message_thread_message SET idempotency_key = 'same-intent' WHERE id = ?", second));
    for (const [column, value] of [['body', 'x'.repeat(4097)], ['direction', 'BOTH'], ['status', 'INVALID'], ['thread_id', randomUUID()]]) {
      await assert.rejects(f.store.run(`UPDATE message_thread_message SET ${column} = ? WHERE id = ?`, value, first));
    }
    await assert.rejects(f.store.run("UPDATE message_thread SET provider = 'WHATSAPP_CLOUD'"));
    assert.equal((await f.store.get('SELECT body FROM message_thread_message WHERE id = ?', first)).body, 'Fictional human reply');
  });
  test(`${engine}: 26 to 27 migration installs constrained fresh session`, options, async t => {
    const f = await fixture(t, engine);
    const catalog = async () => {
      const rows = [];
      for (const table of tables) {
        rows.push(engine === 'postgres'
          ? await f.store.all("SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position", table)
          : await f.store.all(`PRAGMA table_info(${table})`));
        if (engine === 'postgres') rows.push(await f.store.all('SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = ?::regclass ORDER BY definition', table));
      }
      return rows;
    };
    const baseline = await catalog();
    for (const table of tables) await f.store.exec(`DROP TABLE ${table}`);
    await f.store.setSchemaVersion(26);
    if (engine === 'postgres') await f.store.transaction(() => upgradePostgres(f.store, 26));
    else await migrateStore(f.store);
    assert.equal(await f.store.schemaVersion(), SCHEMA_VERSION);
    assert.deepEqual(await catalog(), baseline);
    const session = await f.store.get('SELECT * FROM whatsapp_qr_session');
    assert.deepEqual([session.id,session.desired,session.state,session.generation,session.auth_version], [1,'OFF','IDLE',1,0]);
    await assert.rejects(f.store.run("UPDATE whatsapp_qr_session SET state = 'INVALID'"));
    await assert.rejects(f.store.run("UPDATE whatsapp_qr_session SET desired = 'INVALID'"));
    assert.equal((await f.call('control')).status, 200);
  });
}

test('private HTTP listener exercises actual request/response path on an ephemeral port', async t => {
  const store = await openDatabase(':memory:');
  const server = createWhatsAppQrServer({ store, config: { integrationKeys, whatsappQr: { token } } });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/internal/whatsapp-qr/v1/control`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, 'x-worker-id': randomUUID() } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { generation: 1, desired: 'OFF', leaseSeconds: 60, pollMs: 2000 });
});

test('SQLite import excludes QR device state and reply intents and refuses active targets', { skip: !base }, async t => {
  const source = await fixture(t, 'sqlite'), target = await fixture(t, 'postgres');
  await source.call('control');
  await source.call('state', { generation: 1, state: 'PAIRING', qr: 'fictional-qr' });
  await source.call('auth', { generation: 1, version: 0, creds: 'fictional credentials' }, { method: 'PUT' });
  await source.call('inbound', source.inbound()); await source.queue();
  await importSqlite(source.store, target.store);
  const session = await target.store.get('SELECT * FROM whatsapp_qr_session');
  assert.deepEqual([session.desired,session.state,session.qr_text,session.peer_key_sealed], ['OFF','IDLE',null,null]);
  for (const table of tables.filter(table => table !== 'whatsapp_qr_session')) assert.deepEqual(await target.store.all(`SELECT * FROM ${table}`), []);
  await target.call('control');
  await assert.rejects(importSqlite(source.store, target.store), /fresh QR session/);
});
