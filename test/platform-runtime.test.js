import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import net from 'node:net';
import { createApi } from '../src/app.js';
import { createApp } from '../src/server.js';
import { openDatabase } from '../src/db.js';
import { ensureAdmin } from '../src/auth.js';
import { createPlatformRuntime } from '../src/platform/runtime.js';
import { openPlatformDatabase } from '../src/platform/platform-db.js';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';

test('platform database refuses a different version without modifying it', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t); await f.platform.setSchemaVersion(2);
  await assert.rejects(openPlatformDatabase(f.platformUrl), /Unsupported platform schema version/);
  assert.equal(await f.platform.schemaVersion(), 2);
});

test('platform outage leaves legacy health, readiness and catalog up and retries with backoff', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), store = await openDatabase(':memory:'); t.after(() => store.close());
  await ensureAdmin(store, 'fixture_owner', randomBytes(24).toString('hex'));
  let clock = Date.now();
  const config = { shopMode: 'manual', publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test', integrationKeys: f.integrationKeys,
    platform: { adminHost: 'admin.example.test', username: 'owner', password: randomBytes(24).toString('hex'), databaseUrl: f.platformUrl, provisionerUrl: f.baseUrl } };
  const runtime = createPlatformRuntime({ store, config, clock: () => clock }); t.after(() => runtime.close());
  await runtime.connect(); assert.equal((await f.platform.get('SELECT COUNT(*) AS n FROM platform_admin')).n, 1);
  assert.equal((await f.platform.get('SELECT COUNT(*) AS n FROM tenant WHERE is_default=1')).n, 1);
  const handle = await createApi({ store, config, registry: runtime.registry, platformHandler: runtime.handle });
  const name = new URL(f.platformUrl).pathname.slice(1), control = new pg.Client({ connectionString: f.baseUrl }); await control.connect();
  try {
    await control.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`);
    await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
    const requests = await Promise.all(Array.from({ length: 6 }, () => handle(new Request('https://admin.example.test/api/v1/platform/session'))));
    for (const unavailable of requests) { assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error.code, 'PLATFORM_UNAVAILABLE'); }
    for (const path of ['/health', '/ready', '/api/v1/products']) assert.equal((await handle(new Request('https://shop.example.test' + path))).status, 200, path);
    assert.equal((await handle(new Request('https://shop.example.test/missing/api/v1/products'))).status, 503);
  } finally { await control.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS true`); await control.end(); }
  clock += 5001; await runtime.connect();
  assert.equal((await handle(new Request('https://admin.example.test/api/v1/platform/session'))).status, 401);
});

test('raw HTTP encoded traversal is refused before Fetch URL normalization', async (t) => {
  const config = { dbPath: ':memory:', username: 'owner', password: randomBytes(24).toString('hex'), shopMode: 'manual',
    publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test', integrationKeys: { activeId: 'k1', keys: new Map([['k1', randomBytes(32)]]) },
    platform: { adminHost: 'admin.example.test', username: 'owner', password: randomBytes(24).toString('hex'), databaseUrl: 'postgres://nobody@127.0.0.1:1/platform_test', provisionerUrl: 'postgres://nobody@127.0.0.1:1/postgres' } };
  const app = await createApp(config); await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const socket = net.connect(app.server.address().port, '127.0.0.1');
  let response = ''; socket.on('data', (chunk) => response += chunk);
  const ended = new Promise((resolve) => socket.on('end', resolve));
  socket.write('GET /%2e%2e/api/v1/products HTTP/1.1\r\nHost: shop.example.test\r\nConnection: close\r\n\r\n');
  await ended; assert.match(response, /^HTTP\/1\.1 404/);
});
