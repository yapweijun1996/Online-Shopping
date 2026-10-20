import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';

test('HTTPS gateway setup uses exact Host and public Origin through the real HTTP adapter', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), events = [];
  t.mock.method(console, 'log', (line) => events.push(JSON.parse(line)));
  const config = { dbPath: ':memory:', username: 'seller', password: randomBytes(24).toString('hex'), shopMode: 'manual',
    publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test', trustProxy: true,
    integrationKeys: f.integrationKeys, platform: { claimEnabled: true, adminHost: 'admin.example.test', databaseUrl: f.platformUrl, provisionerUrl: f.baseUrl } };
  const app = await createApp(config);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  await app.platform.connect();
  const body = { code: new URL(events[0].url).hash.slice(1), username: 'claim.owner', email: 'owner@example.test', password: randomBytes(24).toString('hex') };
  const call = (path, host = 'shop.example.test', origin = config.publicOrigin) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: app.server.address().port, path, method: path.endsWith('/claim') ? 'POST' : 'GET',
      headers: { host, origin, 'content-type': 'application/json', forwarded: 'host=shop.example.test;proto=https', 'x-forwarded-host': 'shop.example.test', 'x-forwarded-proto': 'https' } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    }); req.on('error', reject); req.end(path.endsWith('/claim') ? JSON.stringify(body) : undefined);
  });
  const paths = ['/api/v1/setup/status', '/setup/', '/api/v1/setup/claim'];
  const absent = await call('/unknown', 'wrong.example.test');
  for (const path of paths) for (const host of ['wrong.example.test', 'shop.example.test:443', 'shop.example.test.evil']) assert.deepEqual(await call(path, host), absent);
  assert.deepEqual(await call(paths[2], undefined, 'http://shop.example.test'), absent);
  assert.equal((await call(paths[0])).status, 200);
  assert.equal((await call(paths[1])).status, 200);
  assert.equal((await call(paths[2])).status, 200);
  for (const path of paths) assert.deepEqual(await call(path), absent);
});
