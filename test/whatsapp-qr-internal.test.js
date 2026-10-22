import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
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
import { createWhatsAppQrStore } from '../src/whatsapp-qr/store.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Disposable test database required.');
const token = 'synthetic-worker-token-'.repeat(3);
const integrationKeys = { activeId: 'test', keys: new Map([['test', randomBytes(32)]]) };
const tables = ['message_thread_message','message_thread','message_peer_suppression','whatsapp_qr_auth','whatsapp_qr_session'];
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

test('static binding manifest rejects duplicate credentials and inconsistent identities', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shopping-qr-bindings-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const manifest = path.join(dir, 'bindings.json'), first = path.join(dir, 'first'), second = path.join(dir, 'second');
  writeFileSync(first, randomBytes(32).toString('base64url'));
  writeFileSync(second, randomBytes(32).toString('base64url'));
  const rows = [{ slot: 0, shopId: 'default', tokenFile: first, workerLabel: 'default' },
    { slot: 1, shopId: randomUUID(), tokenFile: second, workerLabel: 'tenant' }];
  const env = { WHATSAPP_QR_ENABLED: '1', PLATFORM_ENABLED: '1', WHATSAPP_QR_BINDINGS_FILE: manifest };
  const read = value => { writeFileSync(manifest, JSON.stringify(value)); return readWhatsAppQrConfig(env, integrationKeys); };
  assert.equal(read(rows).bindings[1].shopId, rows[1].shopId);
  for (const change of [{ slot: 0 }, { slot: 2 }, { shopId: 'default' }, { tokenFile: first }, { shopId: 'mutable-code' }]) {
    assert.throws(() => read([rows[0], { ...rows[1], ...change }]), /Invalid WHATSAPP_QR_BINDINGS_FILE/);
  }
});

for (const engine of ['sqlite', 'postgres']) {
  test(`${engine}: HTTP broker binds credentials, ignores selectors and isolates platform outage`, { skip: engine === 'postgres' && !base }, async t => {
    const a = await fixture(t, engine), b = await fixture(t, engine), tenantId = randomUUID(), tenantToken = randomBytes(32).toString('base64url');
    let lookups = 0, down = false;
    const registry = { async resolveWorkerTenant(id, slot, epoch, work) {
      lookups++;
      assert.equal(id, tenantId); assert.equal(slot, 1);
      if (down) throw new Error('unavailable');
      return work({ store: b.store, epoch: 7 });
    } };
    const server = createWhatsAppQrServer({ store: a.store, config: { integrationKeys, whatsappQr: {
      bindings: [{ slot: 0, shopId: 'default', token }, { slot: 1, shopId: tenantId, token: tenantToken }],
    } }, registry });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const call = credential => fetch(`http://127.0.0.1:${server.address().port}/internal/whatsapp-qr/v1/control?tenant=default`, {
      headers: { authorization: `Bearer ${credential}`, 'x-worker-id': a.worker, 'x-tenant-id': 'default' },
    });
    assert.equal((await call('wrong')).status, 401); assert.equal(lookups, 0);
    assert.equal((await call(tenantToken)).status, 200);
    assert.equal((await b.store.get('SELECT lease_owner FROM whatsapp_qr_session WHERE id = 1')).lease_owner, a.worker);
    assert.equal((await a.store.get('SELECT lease_owner FROM whatsapp_qr_session WHERE id = 1')).lease_owner, null);
    down = true;
    assert.equal((await call(tenantToken)).status, 503);
    assert.equal((await call(token)).status, 200);
  });
}

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
  test(`${engine}: imported history, the phone's own messages and names behave like WhatsApp Web`, options, async t => {
    const f = await fixture(t, engine); await f.call('control');
    const row = (id, extra = {}) => ({ ...f.inbound(id).messages[0], ...extra });
    const batch = messages => ({ generation: 1, messages });
    const old = new Date(f.now() - 3 * 86400000).toISOString();
    // History: stored, named, no unread badge; the phone's own message is a sent outgoing message that never renames the thread.
    assert.deepEqual((await f.call('inbound', batch([row('h-in', { at: old, name: 'Ali Shop', history: true }), row('h-out', { at: new Date(Date.parse(old) + 1000).toISOString(), name: 'Owner Name', out: true, history: true })]))).data, { accepted: 2, duplicates: 0 });
    const thread = await f.store.get('SELECT * FROM message_thread');
    assert.equal(thread.display_name, 'Ali Shop'); assert.equal(thread.unread_count, 0);
    const rows = await f.store.all('SELECT direction,status,actor,body FROM message_thread_message ORDER BY created_at,id');
    assert.deepEqual(rows.map(r => [r.direction, r.status, r.actor]), [['IN', 'RECEIVED', null], ['OUT', 'SENT', 'phone:device']]);
    // A live customer message counts as unread; a later message without a name keeps the stored name.
    await f.call('inbound', batch([row('live-1', { name: '' })]));
    assert.equal((await f.store.get('SELECT unread_count, display_name FROM message_thread')).unread_count, 1);
    assert.equal((await f.store.get('SELECT display_name FROM message_thread')).display_name, 'Ali Shop');
    // A live message sent from the phone adds no unread; a first-ever own message creates a thread without the owner's name.
    await f.call('inbound', batch([row('live-out', { out: true, name: 'Owner Name' }), row('first-out', { peer: '60199999999@s.whatsapp.net', out: true, name: 'Owner Name' })]));
    assert.equal((await f.store.get('SELECT unread_count FROM message_thread WHERE peer_hash <> ?', thread.peer_hash)).unread_count, 0);
    assert.equal((await f.store.get('SELECT display_name FROM message_thread WHERE peer_hash <> ?', thread.peer_hash)).display_name, null);
    assert.equal((await f.store.get('SELECT unread_count FROM message_thread WHERE id = ?', thread.id)).unread_count, 1);
    // Duplicates are ignored in either direction.
    assert.deepEqual((await f.call('inbound', batch([row('h-out', { out: true }), row('h-in')]))).data, { accepted: 0, duplicates: 2 });
    // Invalid markers are refused.
    assert.equal((await f.call('inbound', batch([row('bad-flag', { out: 'yes' })]))).status, 400);
    assert.equal((await f.call('inbound', batch([row('bad-flag2', { history: false })]))).status, 400);
  });
  test(`${engine}: a LID chat with a known phone follows erasure, and the owner's own number is never a customer thread`, options, async t => {
    const f = await fixture(t, engine); await f.call('control');
    const row = (id, extra = {}) => ({ ...f.inbound(id).messages[0], ...extra });
    const batch = messages => ({ generation: 1, messages });
    // Learn the hash of a phone through an ordinary thread, then erase it (suppression marker) and drop the thread.
    await f.call('inbound', batch([row('seed', { peer: '60155555555@s.whatsapp.net' })]));
    const erasedHash = (await f.store.get('SELECT phone_hash FROM message_thread')).phone_hash;
    await f.store.run('DELETE FROM message_thread_message'); await f.store.run('DELETE FROM message_thread');
    await f.store.run("INSERT INTO message_peer_suppression (phone_hash, reason, created_at) VALUES (?, 'ERASED', ?)", erasedHash, new Date(f.now()).toISOString());
    assert.equal((await f.call('inbound', batch([row('lid-erased', { peer: '777@lid', phone: '60155555555', name: 'Must not keep', text: 'Must not keep' })]))).status, 200);
    const erased = await f.store.get('SELECT * FROM message_thread');
    assert.ok(erased.suppressed_at); assert.equal(erased.display_name, null); assert.equal(erased.peer_sealed, null);
    assert.equal((await f.store.get('SELECT body FROM message_thread_message')).body, null);
    // A LID chat without a known phone still works but cannot be matched to an erasure (documented residual risk).
    assert.deepEqual((await f.call('inbound', batch([row('lid-plain', { peer: '888@lid' })]))).data, { accepted: 1, duplicates: 0 });
    // The phone is validated.
    assert.equal((await f.call('inbound', batch([row('bad-phone', { peer: '999@lid', phone: '12ab' })]))).status, 400);
    // The account's own number (reported by the worker when it connects) is ignored, directly and through a LID alternate.
    await f.call('state', { generation: 1, state: 'CONNECTED', phone: '60100000000' });
    const before = (await f.store.get('SELECT COUNT(*) AS n FROM message_thread')).n;
    assert.deepEqual((await f.call('inbound', batch([row('self-1', { peer: '60100000000@s.whatsapp.net', out: true }), row('self-2', { peer: '555@lid', phone: '60100000000' })]))).data, { accepted: 0, duplicates: 2 });
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM message_thread')).n, before);
  });
  test(`${engine}: the phone's echo of a reply sent from the panel is not shown twice`, options, async t => {
    const f = await fixture(t, engine); await f.call('control'); await f.call('inbound', f.inbound());
    await f.call('state', { generation: 1, state: 'CONNECTED' });
    const id = await f.queue();
    assert.equal((await f.call('replies/claim', { generation: 1 })).data.reply.id, id);
    // The echo arrives before the send result is recorded.
    await f.call('inbound', { generation: 1, messages: [{ ...f.inbound('echo-1').messages[0], out: true, text: 'Fictional human reply' }] });
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM message_thread_message WHERE direction = 'OUT'")).n, 2);
    assert.equal((await f.call(`replies/${id}/result`, { generation: 1, status: 'SENT', providerMessageId: 'echo-1' })).status, 204);
    const outgoing = await f.store.all("SELECT id,actor,provider_message_id FROM message_thread_message WHERE direction = 'OUT'");
    assert.deepEqual(outgoing.map(r => [r.id, r.provider_message_id]), [[id, 'echo-1']]);
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
    // No reply window: a thread whose last customer message is days old is still eligible.
    await f.store.run('UPDATE message_thread SET suppressed_at = NULL, last_inbound_at = ?', new Date(f.now() - 5 * 86400000).toISOString());
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
    await f.call('state', { generation: 1, state: 'CONNECTED', phone: '60100000000' });
    const session = await f.store.get('SELECT * FROM whatsapp_qr_session');
    assert.equal(session.desired, 'RUN'); assert.equal(session.phone_masked, '+60•••••0000'); assert.match(session.phone_hash, /^[a-f0-9]{64}$/);
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
  for (const late of [
    { state: 'CONNECTED' },
    { state: 'PAIRING', qr: 'late-fictional-qr' },
    { state: 'RECONNECTING', reason: 'RECONNECT_LIMIT' },
  ]) {
    test(`${engine}: pairing timeout survives late ${late.state} then IDLE`, options, async t => {
      const f = await fixture(t, engine);
      await f.store.run("UPDATE whatsapp_qr_session SET desired = 'PAIR', pair_started_at = ?", new Date(f.now()).toISOString());
      await f.call('control');
      await f.call('state', { generation: 1, state: 'PAIRING', qr: 'original-fictional-qr' });
      f.advance(120001);
      assert.equal((await f.call('control')).data.desired, 'OFF');
      for (const report of [late, { state: 'IDLE' }]) {
        assert.equal((await f.call('state', { generation: 1, ...report })).status, 204);
        assert.deepEqual({ ...await f.store.get('SELECT desired,state,last_error,qr_text,qr_expires_at FROM whatsapp_qr_session') },
          { desired: 'OFF', state: report.state, last_error: 'PAIRING_TIMEOUT', qr_text: null, qr_expires_at: null });
      }
    });
  }
  test(`${engine}: CONNECTED before timeout control remains running through IDLE`, options, async t => {
    const f = await fixture(t, engine);
    await f.store.run("UPDATE whatsapp_qr_session SET desired = 'PAIR', pair_started_at = ?", new Date(f.now()).toISOString());
    await f.call('control');
    f.advance(120001);
    // Renew the lease without triggering timeout before the serialized CONNECTED report.
    await f.store.run('UPDATE whatsapp_qr_session SET lease_expires_at = ?', new Date(f.now() + 60000).toISOString());
    assert.equal((await f.call('state', { generation: 1, state: 'CONNECTED' })).status, 204);
    assert.equal((await f.call('control')).data.desired, 'RUN');
    assert.equal((await f.call('state', { generation: 1, state: 'IDLE' })).status, 204);
    assert.deepEqual({ ...await f.store.get('SELECT desired,state,last_error FROM whatsapp_qr_session') },
      { desired: 'RUN', state: 'IDLE', last_error: null });
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
    await f.store.run("INSERT INTO message_peer_suppression (phone_hash,reason,created_at) VALUES ('synthetic-hash','ERASED',?)", new Date(f.now()).toISOString());
    await assert.rejects(f.store.run("INSERT INTO message_peer_suppression (phone_hash,reason,created_at) VALUES ('synthetic-hash','ERASED',?)", new Date(f.now()).toISOString()));
    await assert.rejects(f.store.run("UPDATE message_peer_suppression SET reason = 'INVALID'"));
    await assert.rejects(f.store.run("UPDATE message_peer_suppression SET created_at = NULL"));
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
    assert.equal(session.pair_started_at, null);
    await f.store.run('UPDATE whatsapp_qr_session SET pair_started_at = ?', '2026-10-21T00:00:00.000Z');
    assert.equal((await f.store.get('SELECT pair_started_at FROM whatsapp_qr_session')).pair_started_at, '2026-10-21T00:00:00.000Z');
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

for (const engine of ['sqlite', 'postgres']) {
  test(`${engine}: immutable shop contexts reject transplanted material and preserve default ciphertext`, { skip: engine === 'postgres' && !base }, async t => {
    const a = await fixture(t, engine), b = await fixture(t, engine);
    const secretBox = createSecretBox(integrationKeys);
    const qa = createWhatsAppQrStore({ store: a.store, secretBox, shopId: randomUUID(), now: a.now });
    const qb = createWhatsAppQrStore({ store: b.store, secretBox, shopId: randomUUID(), now: b.now });
    await qa.control(a.worker); await qb.control(b.worker);
    await qa.putAuth(a.worker, { generation: 1, version: 0, creds: 'shop A' });
    await qb.putAuth(b.worker, { generation: 1, version: 0, creds: 'shop B' });
    assert.equal((await qa.getAuth(a.worker, 1)).creds, 'shop A');
    assert.equal((await qb.getAuth(b.worker, 1)).creds, 'shop B');
    const auth = await a.store.get('SELECT * FROM whatsapp_qr_auth LIMIT 1');
    await b.store.run('UPDATE whatsapp_qr_auth SET ciphertext = ?, key_id = ?, digest = ?', auth.ciphertext, auth.key_id, auth.digest);
    assert.equal((await qb.getAuth(b.worker, 1)).creds, null);
    for (const [f, qr] of [[a, qa], [b, qb]]) {
      await qr.state(f.worker, { generation: 1, state: 'CONNECTED' });
      assert.deepEqual(await qr.inbound(f.worker, f.inbound('identical-message')), { accepted: 1, duplicates: 0 });
    }
    const ta = await a.store.get('SELECT * FROM message_thread LIMIT 1');
    const tb = await b.store.get('SELECT * FROM message_thread LIMIT 1');
    assert.notEqual(ta.peer_hash, tb.peer_hash);
    assert.equal(qa.maskPeer(ta), '+••••6789');
    assert.equal(qb.maskPeer(tb), '+••••6789');
    assert.throws(() => qb.maskPeer(ta));
    const sessionA = await a.store.get('SELECT * FROM whatsapp_qr_session WHERE id = 1');
    const sessionB = await b.store.get('SELECT * FROM whatsapp_qr_session WHERE id = 1');
    await b.store.run('UPDATE whatsapp_qr_session SET peer_key_sealed = ?, peer_key_id = ? WHERE id = 1', sessionA.peer_key_sealed, sessionA.peer_key_id);
    await assert.rejects(qb.phoneHash('60123456789'));
    await b.store.run('UPDATE whatsapp_qr_session SET peer_key_sealed = ?, peer_key_id = ? WHERE id = 1', sessionB.peer_key_sealed, sessionB.peer_key_id);
    // Exercise ingress -> durable reply claim -> erasure suppression in both stores.
    for (const [f, qr, thread] of [[a, qa, ta], [b, qb, tb]]) {
      const id = await f.queue();
      assert.equal((await qr.claim(f.worker, { generation: 1 })).reply.id, id);
      await qr.sellerTransaction(async session => {
        const hash = await qr.phoneHash('60123456789', session, true);
        await f.store.run("INSERT INTO message_peer_suppression (phone_hash,reason,created_at) VALUES (?,'ERASED',?)", hash, new Date(f.now()).toISOString());
        await f.store.run('UPDATE message_thread SET suppressed_at = ?, peer_sealed = NULL, display_name = NULL WHERE id = ?', new Date(f.now()).toISOString(), thread.id);
        await f.store.run('UPDATE message_thread_message SET body = NULL WHERE thread_id = ?', thread.id);
      });
      await qr.inbound(f.worker, f.inbound('after-erasure'));
      assert.deepEqual((await f.store.all('SELECT body FROM message_thread_message')).map(row => row.body), [null, null, null]);
    }
    const legacy = await fixture(t, engine);
    const old = secretBox.seal('legacy creds', 'WHATSAPP_QR:default:1:creds:creds:0');
    await legacy.store.run('INSERT INTO whatsapp_qr_auth (generation,record_type,record_id,chunk_index,chunk_count,ciphertext,key_id,digest,updated_at) VALUES (1,?,?,0,1,?,?,?,?)', 'creds', 'creds', old.sealed, old.keyId, createHash('sha256').update('legacy creds').digest('hex'), new Date(legacy.now()).toISOString());
    const oldKey = secretBox.seal(Buffer.alloc(32, 7).toString('base64'), 'WHATSAPP_QR:default:peer-key');
    await legacy.store.run('UPDATE whatsapp_qr_session SET peer_key_sealed = ?, peer_key_id = ? WHERE id = 1', oldKey.sealed, oldKey.keyId);
    const defaults = createWhatsAppQrStore({ store: legacy.store, secretBox, shopId: 'default', now: legacy.now });
    await defaults.control(legacy.worker);
    assert.equal((await defaults.getAuth(legacy.worker, 1)).creds, 'legacy creds');
    assert.equal(await defaults.phoneHash('60123456789'), createHmac('sha256', Buffer.alloc(32, 7)).update('60123456789').digest('hex'));
    const oldPeer = secretBox.seal('60123456789@s.whatsapp.net', `WHATSAPP_QR:default:peer:${ta.id}`);
    assert.equal(defaults.maskPeer({ id: ta.id, peer_sealed: oldPeer.sealed, peer_key_id: oldPeer.keyId }), '+••••6789');
  });
}
