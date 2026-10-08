import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createSecretBox, parseKeyFile } from '../src/secret-box.js';
import { ApiError } from '../src/http.js';
import { FieldError } from '../src/validation.js';
import { createWhatsAppTransport } from '../src/whatsapp-transport.js';
import { saveWhatsAppConnection, disconnectWhatsAppConnection, getWhatsAppConnection,
  listWhatsAppConnections, openWhatsAppToken, resealWhatsAppConnections } from '../src/integration-connections.js';

const token = 'fictional-access-token-ABC123456789';
const nextToken = 'fictional-replacement-token-XYZ987654321';
const input = { environment: 'SANDBOX', accessToken: token, phoneNumberId: '123456789', businessAccountId: '987654321' };
const actor = 'fictional-admin';
const verified = { ok: true, displayPhoneNumber: '+15550000000', verifiedName: 'Fictional Shop' };
const transport = { verify: async () => verified };
const keyLine = (id) => `${id}=${randomBytes(32).toString('base64')}`;
const box = () => createSecretBox(parseKeyFile(keyLine('old')));

async function fixture(t) {
  const store = await openDatabase(':memory:');
  t.after(() => store.close());
  return { store, secretBox: box() };
}

async function assertNoTokens(store, values = [], tokens = [token]) {
  const rows = [...await store.all('SELECT * FROM integration_connection'), ...await store.all('SELECT * FROM integration_audit')];
  const texts = [...rows.flatMap((row) => Object.values(row).map((value) =>
    value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : String(value))), ...values.map((value) =>
    value instanceof Error ? `${value.message} ${value.stack}` : JSON.stringify(value))];
  for (const secret of tokens) for (const text of texts) assert.ok(!text.includes(secret), 'plaintext must not appear in stored or returned values');
}

const apiError = (status, code) => (error) => error instanceof ApiError && error.status === status && error.code === code;

test('save seals the secret, exposes only status, and isolates environments', async (t) => {
  const { store, secretBox } = await fixture(t);
  assert.equal(await getWhatsAppConnection(store, 'SANDBOX'), null);
  assert.deepEqual(await listWhatsAppConnections(store), []);
  const status = await saveWhatsAppConnection(store, secretBox, transport, input, actor);
  assert.deepEqual(Object.keys(status), ['provider', 'environment', 'status', 'publicConfig', 'secretHint', 'lastCheckedAt', 'lastError', 'updatedAt']);
  assert.equal(status.status, 'CONNECTED');
  assert.equal(status.secretHint, '••••6789');
  assert.equal(status.lastError, null);
  assert.equal(status.lastCheckedAt, status.updatedAt);
  assert.ok(Number.isFinite(Date.parse(status.updatedAt)));
  assert.deepEqual(status.publicConfig, { phoneNumberId: input.phoneNumberId, businessAccountId: input.businessAccountId,
    displayPhoneNumber: verified.displayPhoneNumber, verifiedName: verified.verifiedName });
  assert.deepEqual(await getWhatsAppConnection(store, 'SANDBOX'), status);
  assert.deepEqual(await listWhatsAppConnections(store), [status]);
  const row = await store.get('SELECT * FROM integration_connection');
  assert.ok(row.secret_ciphertext instanceof Uint8Array);
  assert.equal(row.secret_key_id, 'old');
  assert.equal(await openWhatsAppToken(store, secretBox, 'SANDBOX'), token);
  let wrongContextError;
  assert.throws(() => secretBox.open(Buffer.from(row.secret_ciphertext), row.secret_key_id, 'WHATSAPP_CLOUD:PRODUCTION'), (error) => {
    wrongContextError = error;
    return /cannot be decrypted/.test(error.message);
  });
  // SQLite returns Uint8Array; PostgreSQL returns Buffer. Exercise both read shapes.
  const bufferStore = { get: async (...args) => {
    const value = await store.get(...args);
    return value ? { ...value, secret_ciphertext: Buffer.from(value.secret_ciphertext) } : value;
  } };
  assert.equal(await openWhatsAppToken(bufferStore, secretBox, 'SANDBOX'), token);
  await saveWhatsAppConnection(store, secretBox, transport, { ...input, environment: 'PRODUCTION' }, actor);
  assert.equal((await listWhatsAppConnections(store)).length, 2);
  assert.deepEqual((await store.all('SELECT action, detail FROM integration_audit')).map((row) => ({ ...row })),
    [{ action: 'CONNECT', detail: null }, { action: 'CONNECT', detail: null }]);
  await assertNoTokens(store, [status, wrongContextError, await listWhatsAppConnections(store)]);
});

for (const reason of ['REJECTED', 'UNAVAILABLE']) {
  test(`verification ${reason} writes only a reason code and never seals`, async (t) => {
    const { store } = await fixture(t);
    let seals = 0, failure;
    await assert.rejects(saveWhatsAppConnection(store, { seal: () => { seals++; } },
      { verify: async () => ({ ok: false, reason, body: token }) }, input, actor), (error) => {
      failure = error;
      return apiError(reason === 'REJECTED' ? 400 : 502, reason === 'REJECTED' ? 'CONNECTION_REJECTED' : 'PROVIDER_UNAVAILABLE')(error);
    });
    assert.equal(seals, 0);
    assert.deepEqual(await store.all('SELECT * FROM integration_connection'), []);
    const audits = await store.all('SELECT * FROM integration_audit');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'CHECK_FAILED');
    assert.equal(audits[0].detail, reason);
    await assertNoTokens(store, [failure]);
  });
}

test('failed rotation preserves the connection and thrown transport errors are sanitized', async (t) => {
  const { store, secretBox } = await fixture(t);
  const original = await saveWhatsAppConnection(store, secretBox, transport, input, actor);
  let failure;
  await assert.rejects(saveWhatsAppConnection(store, secretBox,
    { verify: async () => { throw new Error(nextToken); } }, { ...input, accessToken: nextToken }, actor), (error) => {
    failure = error;
    return apiError(502, 'PROVIDER_UNAVAILABLE')(error);
  });
  assert.deepEqual(await getWhatsAppConnection(store, 'SANDBOX'), original);
  assert.equal(await openWhatsAppToken(store, secretBox, 'SANDBOX'), token);
  await assertNoTokens(store, [failure], [token, nextToken]);
});

test('invalid inputs fail before verification', async (t) => {
  const { store, secretBox } = await fixture(t);
  let calls = 0;
  const fake = { verify: async () => { calls++; return verified; } };
  const invalid = [null, [], {}, { ...input, extra: true }, { ...input, environment: 'sandbox' },
    ...[null, 123, '', 'a'.repeat(19), 'a'.repeat(513), `${token} `, `${token}\n`, `${token}\u0000`, `${token}\u0085`]
      .map((accessToken) => ({ ...input, accessToken })),
    ...['phoneNumberId', 'businessAccountId'].flatMap((field) => [12345, null, '1234', '1'.repeat(33), '12345/path', ' 12345', '１２３４５']
      .map((value) => ({ ...input, [field]: value })))];
  for (const value of invalid) await assert.rejects(saveWhatsAppConnection(store, secretBox, fake, value, actor), FieldError);
  for (const value of [null, 123, '', '   ', 'a'.repeat(121)]) {
    await assert.rejects(saveWhatsAppConnection(store, secretBox, fake, input, value), FieldError);
  }
  assert.equal(calls, 0);
  assert.equal((await store.all('SELECT * FROM integration_audit')).length, 0);
});

test('token rotation replaces the old token and records ROTATE', async (t) => {
  const { store, secretBox } = await fixture(t);
  await saveWhatsAppConnection(store, secretBox, transport, input, actor);
  const before = await store.get('SELECT * FROM integration_connection');
  const status = await saveWhatsAppConnection(store, secretBox, transport, { ...input, accessToken: nextToken }, actor);
  const after = await store.get('SELECT * FROM integration_connection');
  assert.equal(before.id, after.id);
  assert.equal(before.created_at, after.created_at);
  assert.notDeepEqual(before.secret_ciphertext, after.secret_ciphertext);
  assert.equal(await openWhatsAppToken(store, secretBox, 'SANDBOX'), nextToken);
  assert.notEqual(await openWhatsAppToken(store, secretBox, 'SANDBOX'), token);
  assert.deepEqual((await store.all('SELECT action FROM integration_audit')).map((row) => row.action), ['CONNECT', 'ROTATE']);
  await assertNoTokens(store, [status], [token, nextToken]);
});

test('key rotation reseals both environments and allows removing the old key', async (t) => {
  const { store } = await fixture(t);
  const oldLine = keyLine('old'), newLine = keyLine('new');
  const oldBox = createSecretBox(parseKeyFile(oldLine));
  for (const environment of ['SANDBOX', 'PRODUCTION']) await saveWhatsAppConnection(store, oldBox, transport, { ...input, environment }, actor);
  const rotating = createSecretBox(parseKeyFile(`${newLine}\n${oldLine}`));
  assert.equal(await resealWhatsAppConnections(store, rotating), 2);
  assert.equal(await resealWhatsAppConnections(store, rotating), 0);
  const newBox = createSecretBox(parseKeyFile(newLine));
  for (const environment of ['SANDBOX', 'PRODUCTION']) {
    assert.equal(await openWhatsAppToken(store, newBox, environment), token);
    assert.equal((await store.get('SELECT secret_key_id FROM integration_connection WHERE environment = ?', environment)).secret_key_id, 'new');
  }
  assert.equal((await store.all('SELECT * FROM integration_audit')).length, 2);
  await assertNoTokens(store);
});

test('disconnect clears secrets, is idempotent, and reconnect records CONNECT', async (t) => {
  const { store, secretBox } = await fixture(t);
  await assert.rejects(disconnectWhatsAppConnection(store, 'SANDBOX', actor), apiError(404, 'NOT_FOUND'));
  await assert.rejects(openWhatsAppToken(store, secretBox, 'SANDBOX'), apiError(409, 'NOT_CONNECTED'));
  await saveWhatsAppConnection(store, secretBox, transport, input, actor);
  const status = await disconnectWhatsAppConnection(store, 'SANDBOX', actor);
  assert.equal(status.status, 'NOT_CONFIGURED');
  assert.equal(status.secretHint, null);
  const row = await store.get('SELECT * FROM integration_connection');
  for (const field of ['secret_ciphertext', 'secret_key_id', 'secret_hint']) assert.equal(row[field], null);
  assert.deepEqual(await disconnectWhatsAppConnection(store, 'SANDBOX', actor), status);
  let failure;
  await assert.rejects(openWhatsAppToken(store, secretBox, 'SANDBOX'), (error) => {
    failure = error;
    return apiError(409, 'NOT_CONNECTED')(error);
  });
  assert.deepEqual((await store.all('SELECT action FROM integration_audit')).map((value) => value.action), ['CONNECT', 'DISCONNECT']);
  await assertNoTokens(store, [status, failure]);
  await saveWhatsAppConnection(store, secretBox, transport, input, actor);
  assert.deepEqual((await store.all('SELECT action FROM integration_audit')).map((value) => value.action), ['CONNECT', 'DISCONNECT', 'CONNECT']);
});

test('connection and audit roll back together when audit insertion fails', async (t) => {
  const { store, secretBox } = await fixture(t);
  const broken = { ...store, run: async (sql, ...args) => {
    if (sql.includes('INSERT INTO integration_audit')) throw new Error('Synthetic audit failure.');
    return store.run(sql, ...args);
  } };
  await assert.rejects(saveWhatsAppConnection(broken, secretBox, transport, input, actor), /Synthetic audit failure/);
  assert.equal(await getWhatsAppConnection(store, 'SANDBOX'), null);
  await saveWhatsAppConnection(store, secretBox, transport, input, actor);
  await assert.rejects(disconnectWhatsAppConnection(broken, 'SANDBOX', actor), /Synthetic audit failure/);
  assert.equal(await openWhatsAppToken(store, secretBox, 'SANDBOX'), token);
});

test('transport sends one authenticated GET to the exact fixed host', async () => {
  let calls = 0;
  const fake = createWhatsAppTransport({ fetchImpl: async (url, options) => {
    calls++;
    const requested = new URL(url);
    assert.equal(requested.host, 'graph.facebook.com');
    assert.equal(requested.protocol, 'https:');
    assert.equal(requested.pathname, '/v21.0/123456789');
    assert.equal(requested.search, '?fields=display_phone_number,verified_name');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ display_phone_number: verified.displayPhoneNumber, verified_name: verified.verifiedName });
  } });
  assert.deepEqual(await fake.verify(input), verified);
  assert.equal(calls, 1);
  assert.deepEqual(await fake.verify({ ...input, phoneNumberId: '12345@evil.example' }), { ok: false, reason: 'UNAVAILABLE' });
  assert.equal(calls, 1);
});

for (const [name, response, reason] of [
  ['400', () => new Response(token, { status: 400 }), 'REJECTED'],
  ['401', () => new Response(token, { status: 401 }), 'REJECTED'],
  ['403', () => new Response(token, { status: 403 }), 'REJECTED'],
  ['500', () => new Response(token, { status: 500 }), 'UNAVAILABLE'],
  ['redirect', () => new Response(token, { status: 302, headers: { Location: 'https://evil.example' } }), 'UNAVAILABLE'],
  ['oversized', () => new Response('x'.repeat(16385)), 'UNAVAILABLE'],
  ['non-JSON', () => new Response(token), 'UNAVAILABLE'],
  ['array', () => Response.json([]), 'UNAVAILABLE'],
  ['null', () => Response.json(null), 'UNAVAILABLE'],
  ['network error', () => { throw new Error(token); }, 'UNAVAILABLE'],
]) {
  test(`transport sanitizes ${name}`, async () => {
    let calls = 0;
    const fake = createWhatsAppTransport({ fetchImpl: async () => { calls++; return response(); } });
    const result = await fake.verify(input);
    assert.deepEqual(result, { ok: false, reason });
    assert.ok(!JSON.stringify(result).includes(token));
    assert.equal(calls, 1);
  });
}

test('transport aborts on timeout, including a stalled response body', async () => {
  let aborted = false;
  const fake = createWhatsAppTransport({ timeoutMs: 10, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error(token)); }, { once: true });
  }) });
  assert.deepEqual(await fake.verify(input), { ok: false, reason: 'UNAVAILABLE' });
  assert.equal(aborted, true);
  let cancelled = false;
  const stalled = createWhatsAppTransport({ timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })) });
  assert.deepEqual(await stalled.verify(input), { ok: false, reason: 'UNAVAILABLE' });
  assert.equal(cancelled, true);
});

test('transport accepts exactly 16 KB and cancels oversized streams before further reads', async () => {
  const body = JSON.stringify({ verified_name: 'Fictional Shop' }).padEnd(16384, ' ');
  const fake = createWhatsAppTransport({ fetchImpl: async () => new Response(body) });
  assert.deepEqual(await fake.verify(input), { ok: true, displayPhoneNumber: null, verifiedName: 'Fictional Shop' });
  let reads = 0, cancelled = false;
  const oversized = createWhatsAppTransport({ fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(8193)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })) });
  assert.deepEqual(await oversized.verify(input), { ok: false, reason: 'UNAVAILABLE' });
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
});

test('provider metadata cannot echo the token into status or storage', async (t) => {
  const { store, secretBox } = await fixture(t);
  const fake = createWhatsAppTransport({ fetchImpl: async () => Response.json({ display_phone_number: token, verified_name: token }) });
  const status = await saveWhatsAppConnection(store, secretBox, fake, input, actor);
  assert.equal(status.publicConfig.displayPhoneNumber, null);
  assert.equal(status.publicConfig.verifiedName, null);
  await assertNoTokens(store, [status]);
});

test('provider text that is long or contains control characters is not stored', async (t) => {
  const { store, secretBox } = await fixture(t);
  const odd = { verify: async () => ({ ok: true, displayPhoneNumber: 'x'.repeat(101), verifiedName: 'Name\u0000Injected' }) };
  const status = await saveWhatsAppConnection(store, secretBox, odd, input, actor);
  assert.equal(status.publicConfig.displayPhoneNumber, null);
  assert.equal(status.publicConfig.verifiedName, null);
});

const pgBase = process.env.SHOP_TEST_DATABASE_URL;
test('on PostgreSQL the connection store seals, rotates, reseals and disconnects', { skip: !pgBase }, async (t) => {
  const { default: pg } = await import('pg');
  const { randomUUID } = await import('node:crypto');
  const { openPostgresDatabase } = await import('../src/postgres-db.js');
  const name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: pgBase });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(pgBase); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  const oldLine = keyLine('old'), newLine = keyLine('new');
  const secretBox = createSecretBox(parseKeyFile(oldLine));
  const status = await saveWhatsAppConnection(store, secretBox, transport, input, actor);
  assert.equal(status.status, 'CONNECTED');
  assert.equal(await openWhatsAppToken(store, secretBox, 'SANDBOX'), token);
  await saveWhatsAppConnection(store, secretBox, transport, { ...input, accessToken: nextToken }, actor);   // upsert path: same row, ROTATE
  assert.equal(await openWhatsAppToken(store, secretBox, 'SANDBOX'), nextToken);
  assert.deepEqual((await store.all('SELECT action FROM integration_audit')).map((row) => row.action).sort(), ['CONNECT', 'ROTATE']);
  assert.equal((await store.get('SELECT COUNT(*)::int AS n FROM integration_connection')).n, 1);
  const rotating = createSecretBox(parseKeyFile(`${newLine}\n${oldLine}`));
  assert.equal(await resealWhatsAppConnections(store, rotating), 1);
  assert.equal(await openWhatsAppToken(store, createSecretBox(parseKeyFile(newLine)), 'SANDBOX'), nextToken);
  const disconnected = await disconnectWhatsAppConnection(store, 'SANDBOX', actor);
  assert.equal(disconnected.status, 'NOT_CONFIGURED');
  await assert.rejects(openWhatsAppToken(store, rotating, 'SANDBOX'), apiError(409, 'NOT_CONNECTED'));
  await assertNoTokens(store, [], [token, nextToken]);
});
