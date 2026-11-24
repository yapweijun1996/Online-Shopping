import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApi } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { openDatabase, migrateStore, SCHEMA_VERSION } from '../src/db.js';
import { restoreSchema39AuditFixture } from './helpers/legacy-audit-fixture.js';
import { logoType } from '../src/shop-logo.js';

const png = await readFile(new URL('../public/shop/icons/icon-192.png', import.meta.url));
test('logo signatures reject unsupported content', () => {
  assert.equal(logoType(png), 'image/png');
  assert.equal(logoType(Uint8Array.from([255,216,255])), 'image/jpeg');
  assert.equal(logoType(Buffer.from('RIFFxxxxWEBP')), 'image/webp');
  for (const value of ['<svg/>', 'GIF89a', '', 'RIFFxxxxNOPE']) assert.throws(() => logoType(Buffer.from(value)), { status: 415 });
});
test('schema 37 migrates to the current schema preserving existing settings', async t => {
  const store = await openDatabase(':memory:'); t.after(() => store.close());
  await restoreSchema39AuditFixture(store);
  await store.exec('DROP TABLE shop_logo_event; DROP TABLE shop_logo;'); await store.setSchemaVersion(37);
  await migrateStore(store); assert.equal(await store.schemaVersion(), SCHEMA_VERSION);
  assert.ok(await store.get('SELECT id FROM company_setting WHERE id=1'));
  assert.equal(await store.get('SELECT * FROM shop_logo'), undefined);
});
test('schema 37 migration preserves already-created logo tables', async t => {
  const store = await openDatabase(':memory:'); t.after(() => store.close());
  await store.run("INSERT INTO shop_logo_event (id, action, actor, created_at) VALUES ('existing', 'UPLOAD', 'seller', '2026-01-01')");
  await restoreSchema39AuditFixture(store);
  await store.setSchemaVersion(37);
  await migrateStore(store);
  assert.equal(await store.schemaVersion(), SCHEMA_VERSION);
  assert.equal((await store.get("SELECT actor FROM shop_logo_event WHERE id='existing'")).actor, 'seller');
});
test('logo routes enforce session, origin, CSRF and isolation, with revalidation and audit', async t => {
  const origin = 'https://seller.example.test', username = 'owner', password = 'SyntheticFixtureOnly4920!';
  async function fixture() {
    const store = await openDatabase(':memory:'); t.after(() => store.close()); await ensureAdmin(store, username, password);
    const handle = await createApi({ store, config: { shopMode: 'manual', publicOrigin: origin, sellerOrigin: origin, username } });
    const call = (method, path, body, headers = {}) => handle(new Request(origin + path, { method, headers, body }), { clientAddress: '203.0.113.1' });
    const login = await call('POST', '/api/v1/seller/session', JSON.stringify({username,password}), { origin, 'content-type': 'application/json' });
    const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrfToken;
    return {store, call, cookie, headers: {origin, cookie, 'x-csrf-token': csrf}};
  }
  const a = await fixture(), b = await fixture(), endpoint = '/api/v1/seller/shop-logo', publicPath = '/api/v1/shop/logo';
  const put = (headers, body = png) => a.call('PUT', endpoint, body, headers);
  assert.equal((await a.call('GET', publicPath)).status, 404);
  assert.equal((await put({ origin })).status, 401);
  assert.equal((await put({ cookie: a.cookie, origin })).status, 403);
  assert.equal((await put({ ...a.headers, origin: 'https://example.invalid' })).status, 403);
  await a.store.run("UPDATE seller_account SET role = 'STAFF' WHERE username = ?", username);
  assert.equal((await put(a.headers)).status, 403);
  await a.store.run("UPDATE seller_account SET role = 'OWNER' WHERE username = ?", username);
  assert.equal((await put(a.headers, Buffer.from('<svg/>'))).status, 415);
  assert.equal((await put(a.headers, Buffer.alloc(262145))).status, 413);
  assert.equal((await put({ ...a.headers, 'content-type': 'image/svg+xml' })).status, 200);
  const result = await a.call('GET', publicPath); assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-type'), 'image/png'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), png);
  assert.equal((await a.call('GET', publicPath, undefined, { 'if-none-match': result.headers.get('etag') })).status, 304);
  assert.equal((await b.call('GET', publicPath)).status, 404);
  assert.equal((await a.call('DELETE', endpoint, undefined, a.headers)).status, 200);
  assert.equal((await a.call('GET', publicPath)).status, 404);
  assert.deepEqual((await a.store.all('SELECT action FROM shop_logo_event ORDER BY created_at')).map(x => x.action), ['UPLOAD','DELETE']);
});
