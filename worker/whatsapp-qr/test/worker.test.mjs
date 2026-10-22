import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BufferJSON, proto, DisconnectReason } from '@whiskeysockets/baileys';
import { Session, backoff } from '../src/session.js';
import { ApiError } from '../src/client.js';
import { loadAuth } from '../src/auth-state.js';
import { filterHistory, filterMessages } from '../src/filters.js';
import { backend, fakeSocket, emit, token } from './fixtures.mjs';
async function setup(t) {
  const { db, client } = await backend(t); const sockets = []; const logs = []; let clock = 0;
  const session = new Session({ client, makeSocket: () => { const socket = fakeSocket(); sockets.push(socket); return socket; }, log: line => logs.push(line), now: () => clock });
  t.after(() => session.stop());
  await session.tick();
  return { db, client, session, sockets, logs, advance: value => { clock += value; } };
}
test('pairing, binary persistence, restart and privacy', async t => {
  const { db, client, session, logs } = await setup(t);
  await emit(session, { 'connection.update': { qr: 'fictional-private-qr' } });
  assert.equal(db.states.at(-1).qr, 'fictional-private-qr');
  await emit(session, { 'creds.update': { registered: true } });
  const original = JSON.parse(JSON.stringify(session.auth.state.creds, BufferJSON.replacer), BufferJSON.reviver);
  const appKey = proto.Message.AppStateSyncKeyData.fromObject({ keyData: Buffer.from([1, 2, 255]) });
  await Promise.all([session.auth.state.keys.set({ 'app-state-sync-key': { sample: appKey } }), session.auth.saveCreds({ registered: true })]);
  const restored = await loadAuth(client, 1, assert.fail);
  assert.deepEqual(restored.state.creds, original);
  assert.deepEqual((await restored.state.keys.get('app-state-sync-key', ['sample'])).sample, appKey);
  await emit(session, { 'connection.update': { connection: 'open' } });
  assert.equal(db.states.at(-1).state, 'CONNECTED');
  await emit(session, { 'messages.upsert': { type: 'notify', messages: [{ key: { id: 'in-1', remoteJid: '60123456789@s.whatsapp.net' }, messageTimestamp: 1, message: { conversation: 'fictional-private-text' } }] } });
  assert.equal(db.inbound[0].text, 'fictional-private-text');
  assert.ok(logs.some(line => line === '{"inbound":{"type":"notify","received":1,"accepted":1}}'));
  for (const secret of ['60123456789', 'fictional-private-qr', 'fictional-private-text', token]) assert.ok(!logs.join('').includes(secret));
  const items = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [String(i), { data: Buffer.from([i % 256]) }]));
  await session.auth.state.keys.set({ 'pre-key': items });
  assert.deepEqual(db.batches.slice(-2), [500, 1]);
  await session.auth.state.keys.set({ 'pre-key': { 0: null } });
  assert.deepEqual(await session.auth.state.keys.get('pre-key', ['0']), {});
});
test('control loss closes only the affected live session before any further claim', async t => {
  const a = await setup(t), b = await setup(t);
  const original = a.client.request.bind(a.client);
  a.client.request = async (path, ...args) => {
    if (path === '/v1/control') throw Object.assign(new Error('revoked'), { code: 'QR_REVOKED' });
    return original(path, ...args);
  };
  await assert.rejects(a.session.tick(), { code: 'QR_REVOKED' });
  assert.equal(a.sockets[0].ended, 1);
  assert.equal(a.session.socket, null);
  assert.equal(b.sockets[0].ended, 0);
});
test('AUTH_VERSION stops socket then reloads fresh snapshot before reconnect', async t => {
  const { db, session, sockets, advance } = await setup(t);
  db.version++;
  await assert.rejects(session.auth.saveCreds({ registered: true }), { code: 'AUTH_VERSION' });
  assert.equal(sockets[0].ended, 1);
  await session.tick(); assert.equal(session.state, 'ERROR'); assert.equal(sockets.length, 1);
  advance(1000); await session.tick(); assert.equal(sockets.length, 2);
  await session.auth.saveCreds({ registered: true });
  assert.equal(db.version, 2);
});
test('lost lease during auth persistence halts the generation', async t => {
  const { db, session, sockets } = await setup(t);
  db.owner = 'different-worker';
  await assert.rejects(session.auth.saveCreds({ registered: true }), { code: 'LEASE_HELD' });
  assert.equal(sockets[0].ended, 1);
  assert.equal(session.halted, true);
});
test('old generation auth failures cannot close replacement socket', async t => {
  const { db, session, sockets } = await setup(t);
  const oldAuth = session.auth;
  db.generation++;
  await session.tick();
  await assert.rejects(oldAuth.saveCreds({ registered: true }), { code: 'STALE_GENERATION' });
  assert.equal(sockets[1].ended, 0);
  assert.equal(session.socket, sockets[1]);
});
test('graceful shutdown ends connected socket without unlinking device', async t => {
  const { session, sockets } = await setup(t);
  await emit(session, { 'connection.update': { connection: 'open' } });
  await session.stop();
  assert.equal(sockets[0].ended, 1);
  assert.equal(sockets[0].loggedOut, 0);
});
test('reply SENT, proven closed FAILED, ambiguous dispatch UNKNOWN; no retry', async t => {
  const { db, session, sockets, advance } = await setup(t);
  await emit(session, { 'connection.update': { connection: 'open' } });
  const reply = { id: 'reply-1', peer: '60123456789@lid', text: 'fictional reply' };
  db.replies.push(reply); await session.tick();
  assert.deepEqual(db.results.at(-1), { generation: 1, status: 'SENT', providerMessageId: 'sent-id' });
  advance(5000); sockets[0].sendMessage = async (peer, body) => { sockets[0].sent.push({ peer, body }); throw new Error('dispatch ambiguous'); };
  db.replies.push(reply); await session.tick(); assert.equal(db.results.at(-1).status, 'UNKNOWN');
  advance(5000); db.onClaim = () => session.end(); db.replies.push(reply); await session.reply();
  assert.deepEqual(db.results.at(-1), { generation: 1, status: 'FAILED', code: 'SOCKET_CLOSED' });
  assert.equal(db.results.length, 3);
});
test('logout stops reconnect and generation change logs out and ends', async t => {
  const { db, session, sockets } = await setup(t);
  await emit(session, { 'connection.update': { connection: 'open' } });
  db.generation++; db.desired = 'OFF'; await session.tick();
  assert.equal(sockets[0].loggedOut, 1); assert.equal(sockets[0].ended, 1); assert.equal(session.state, 'IDLE');
  db.generation++; db.desired = 'PAIR'; await session.tick();
  await emit(session, { 'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } } });
  assert.equal(session.state, 'LOGGED_OUT'); await session.tick(); assert.equal(sockets.length, 2);
});
test('backoff schedule and five minute circuit breaker', async t => {
  const { session, advance } = await setup(t);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => backoff(i)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  await emit(session, { 'connection.update': { connection: 'close' } });
  assert.equal(session.nextConnect, 1000); advance(999); await session.tick(); assert.equal(session.socket, null);
  advance(1); await session.tick(); assert.ok(session.socket);
  advance(300000); await emit(session, { 'connection.update': { connection: 'close' } });
  assert.equal(session.state, 'ERROR'); assert.equal(session.halted, true);
});
test('client enforces lease, generation and authorization', async t => {
  const { client, db } = await backend(t); await client.request('/v1/control');
  await assert.rejects(client.request('/v1/state', { generation: 99, state: 'IDLE' }), { code: 'STALE_GENERATION' });
  const id = client.workerId; client.workerId = 'other-worker';
  await assert.rejects(client.request('/v1/control'), { code: 'LEASE_HELD' });
  client.workerId = id; client.token = 'wrong'; await assert.rejects(client.request('/v1/control'), { code: 'UNAUTHORIZED' });
  assert.equal(db.states.length, 0);
});
test('filter keeps direct text only, marks the phone\'s own messages and normalizes the peer', () => {
  const message = { key: { id: 'id', remoteJid: '60123456789@s.whatsapp.net' }, messageTimestamp: 1, pushName: 'Customer', message: { conversation: 'hello' } };
  const run = value => filterMessages({ type: 'notify', messages: [value] });
  assert.deepEqual(run(message), [{ id: 'id', peer: '60123456789@s.whatsapp.net', name: 'Customer', at: '1970-01-01T00:00:01.000Z', text: 'hello' }]);
  assert.equal(run({ ...message, key: { ...message.key, remoteJid: '123@lid' }, message: { extendedTextMessage: { text: 'lid text' } } })[0].text, 'lid text');
  assert.equal(run({ ...message, key: { ...message.key, remoteJid: '60123456789:12@s.whatsapp.net' } })[0].peer, '60123456789@s.whatsapp.net');
  for (const peer of ['123@g.us', 'status@broadcast', '123@broadcast', '123@newsletter']) assert.deepEqual(run({ ...message, key: { ...message.key, remoteJid: peer } }), []);
  // Sent from the phone: kept as outgoing, and the owner's own push name is never used as the customer's name.
  assert.deepEqual(run({ ...message, key: { ...message.key, fromMe: true }, pushName: 'Owner Name' }), [{ id: 'id', peer: '60123456789@s.whatsapp.net', name: '', at: '1970-01-01T00:00:01.000Z', text: 'hello', out: true }]);
  for (const body of [{ imageMessage: { caption: 'caption' } }, { reactionMessage: {} }, { protocolMessage: {} }]) assert.deepEqual(run({ ...message, message: body }), []);
  assert.equal(filterMessages({ type: 'append', messages: [message] }).length, 1);
  assert.deepEqual(filterMessages({ type: 'prepend', messages: [message] }), []);
});
test('history is imported only while linking: every chunk counts, the cap is cumulative, the window closes by time', async t => {
  const { db, session, logs, advance } = await setup(t);
  const chunk = (id, text = 'old-private-text', extra = {}) => ({ isLatest: false, chats: [{ id: '60123456789@s.whatsapp.net', name: 'Ali' }], contacts: [], messages: [{ key: { id, remoteJid: '60123456789@s.whatsapp.net', ...extra }, messageTimestamp: 0, message: { conversation: text } }] });
  await emit(session, { 'messaging-history.set': chunk('h-0') });
  assert.equal(db.inbound.length, 0, 'ignored while no device was linked');
  await emit(session, { 'connection.update': { qr: 'fictional-private-qr' } });
  // WhatsApp flags only the FIRST chunk isLatest; later chunks must still be imported.
  await emit(session, { 'messaging-history.set': { ...chunk('h-1'), isLatest: true } });
  await emit(session, { 'messaging-history.set': chunk('h-2', 'my-private-text', { fromMe: true }) });
  assert.deepEqual(db.inbound.map(row => [row.id, row.name, Boolean(row.out), row.history]), [['h-1', 'Ali', false, true], ['h-2', '', true, true]]);
  assert.ok(logs.some(line => line === '{"history":{"received":1,"accepted":1,"total":2}}'));
  advance(21 * 60000);
  await emit(session, { 'messaging-history.set': chunk('h-3') });
  assert.equal(db.inbound.length, 2, 'the window closes after 20 minutes');
  for (const secret of ['old-private-text', 'my-private-text', '60123456789', 'Ali']) assert.ok(!logs.join('').includes(secret));
});
test('one refused row never halts the worker: the batch is retried row by row', async t => {
  const { db, client, session } = await setup(t);
  await emit(session, { 'connection.update': { connection: 'open' } });
  const original = client.request.bind(client);
  client.request = async (path, body, ...rest) => {
    if (path === '/v1/inbound' && body.messages.some(row => row.text === 'poison')) throw new ApiError('BACKEND_ERROR', 400);
    return original(path, body, ...rest);
  };
  const live = (id, text) => ({ key: { id, remoteJid: '60123456789@s.whatsapp.net' }, messageTimestamp: 1, message: { conversation: text } });
  await emit(session, { 'messages.upsert': { type: 'notify', messages: [live('ok-1', 'fine'), live('bad-1', 'poison'), live('ok-2', 'also fine')] } });
  assert.deepEqual(db.inbound.map(row => row.id), ['ok-1', 'ok-2']);
  assert.equal(session.halted, false);
});
test('the account\'s own self-chat is never imported', async t => {
  const { db, session } = await setup(t);
  session.socket.user = { id: '60199990000:7@s.whatsapp.net', lid: '98765432:7@lid' };
  await emit(session, { 'connection.update': { connection: 'open' } });
  const msg = (id, jid, extra = {}) => ({ key: { id, remoteJid: jid, ...extra }, messageTimestamp: 1, message: { conversation: 'private note' } });
  await emit(session, { 'messages.upsert': { type: 'notify', messages: [msg('self-1', '60199990000@s.whatsapp.net', { fromMe: true }), msg('self-2', '98765432@lid'), msg('cust-1', '60123456789@s.whatsapp.net')] } });
  assert.deepEqual(db.inbound.map(row => row.id), ['cust-1']);
});
test('filter rows always satisfy the backend rules: ids, well-formed text, code-point name clipping, peer length, future clock, LID phone', () => {
  const base = { key: { id: 'id', remoteJid: '60123456789@s.whatsapp.net' }, messageTimestamp: 1, pushName: 'N', message: { conversation: 'hello' } };
  const run = (value, options) => filterMessages({ type: 'notify', messages: [value] }, options);
  for (const bad of [{ message: { conversation: 'a\0b' } }, { message: { conversation: 'lone \ud800 surrogate' } }, { key: { ...base.key, id: 'caf\u00e9' } }, { key: { ...base.key, id: 'x'.repeat(129) } }, { key: { ...base.key, remoteJid: `${'1'.repeat(31)}@s.whatsapp.net` } }]) assert.deepEqual(run({ ...base, ...bad }), []);
  const emoji = '\u{1F600}'.repeat(150), clipped = run({ ...base, pushName: emoji })[0].name;
  assert.equal([...clipped].length, 150); assert.ok(clipped.isWellFormed());
  assert.equal(run({ ...base, pushName: 'x'.repeat(250) })[0].name.length, 200);
  assert.equal(run({ ...base, messageTimestamp: 4102444800 }, { now: Date.UTC(2026, 9, 22) })[0].at, '2026-10-22T00:00:00.000Z');
  const lid = { ...base, key: { ...base.key, remoteJid: '555@lid', remoteJidAlt: '60123456789@s.whatsapp.net' } };
  assert.equal(run(lid)[0].phone, '60123456789'); assert.equal(run({ ...lid, key: { ...lid.key, remoteJidAlt: undefined } })[0].phone, undefined);
  assert.deepEqual(run(lid, { self: new Set(['60123456789']) }), []);
});
test('history filter keeps the last 30 days of direct text, newest first-capped, with names from chats and contacts', () => {
  const now = Date.UTC(2026, 9, 22), second = ms => Math.floor(ms / 1000);
  const text = (id, jid, age, extra = {}) => ({ key: { id, remoteJid: jid, ...extra.key }, messageTimestamp: { toNumber: () => second(now - age * 86400000) }, message: { conversation: `t-${id}` }, ...extra.rest });
  const event = {
    chats: [{ id: '60111111111@s.whatsapp.net', name: 'Ali Shop' }], contacts: [{ id: '60122222222@s.whatsapp.net', notify: 'Siti' }],
    messages: [text('a', '60111111111@s.whatsapp.net', 1), text('b', '60111111111@s.whatsapp.net', 31), text('c', '60122222222@s.whatsapp.net', 2, { key: { fromMe: true } }), text('d', '120363@g.us', 1), text('e', '60122222222@s.whatsapp.net', 3, { rest: { pushName: 'Push Siti' } })]
  };
  const rows = filterHistory(event, { now });
  assert.deepEqual(rows.map(row => [row.id, row.name, Boolean(row.out), row.history]), [['e', 'Push Siti', false, true], ['c', '', true, true], ['a', 'Ali Shop', false, true]]);
  assert.ok(rows.every((row, index) => index === 0 || rows[index - 1].at <= row.at));
});
for (const [label, text] of [['ASCII', 'a'.repeat(4096)], ['multibyte', '界'.repeat(4096)], ['escaped', '\u0001'.repeat(4096)]]) {
  test(`inbound ${label} batches preserve every message without halting`, async t => {
    const { db, session, sockets } = await setup(t);
    const messages = Array.from({ length: 101 }, (_, i) => ({
      key: { id: `long-${i}`, remoteJid: '60123456789@s.whatsapp.net' },
      messageTimestamp: 1, message: { conversation: text }
    }));
    await emit(session, { 'messages.upsert': { type: 'notify', messages } });
    assert.equal(session.halted, false);
    assert.equal(sockets[0].ended, 0);
    assert.deepEqual(db.inbound.map(message => [message.id, message.text]), messages.map(message => [message.key.id, text]));
    assert.ok(db.inboundRequests.every(request => request.bytes <= 60 * 1024 && request.count <= 50));
  });
}
