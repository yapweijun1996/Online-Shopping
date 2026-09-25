import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';
import { LoginLimiter } from '../src/auth.js';
import { createApp } from '../src/server.js';

const username = 'local_owner';
const password = 'PrivateExamplePass123!';
const productionPassword = 'Q7z!rK8mP4vN2tL6';

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'online-shopping-test-'));
  const config = { username, password, dbPath: path.join(directory, 'private.db'), production: false, publicOrigin: null };
  const app = createApp(config);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  return {
    origin,
    config,
    app,
    async request(method, route, body, headers = {}) {
      const response = await fetch(`${origin}${route}`, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), origin, ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { response, data: await response.json() };
    },
    async close() {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('configuration rejects missing, weak, and unsafe production values', () => {
  assert.throws(() => readConfig({}), /ADMIN_USERNAME/);
  assert.throws(() => readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD: 'password123' }), /ADMIN_PASSWORD/);
  assert.throws(() => readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD: password, NODE_ENV: 'production', DB_PATH: '/tmp/private.db', PUBLIC_ORIGIN: 'https://shop.example' }), /placeholder/);
  assert.throws(() => readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD: 'passwordpassword123', NODE_ENV: 'production', DB_PATH: '/tmp/private.db', PUBLIC_ORIGIN: 'https://shop.example' }), /placeholder/);
  assert.throws(() => readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD: `Strong${username}123!`, NODE_ENV: 'production', DB_PATH: '/tmp/private.db', PUBLIC_ORIGIN: 'https://shop.example' }), /username/);
  assert.throws(() => readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD: productionPassword, NODE_ENV: 'production', DB_PATH: '/tmp/private.db' }), /PUBLIC_ORIGIN/);
  assert.throws(() => readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD: productionPassword, NODE_ENV: 'production', DB_PATH: '/tmp/private.db', PUBLIC_ORIGIN: 'https://shop.example/path' }), /PUBLIC_ORIGIN/);
  assert.equal(readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD: productionPassword, NODE_ENV: 'production', DB_PATH: '/tmp/private.db', PUBLIC_ORIGIN: 'https://shop.example' }).production, true);
  assert.throws(() => readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD: password, DB_PATH: 'public/leak.db' }), /outside the public/);
  assert.throws(() => readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD: password, ADMIN_PASSWORD_FILE: '/tmp/secret' }), /only one/);
  assert.throws(() => readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD_FILE: '/not/a/real/secret' }), /cannot be read/);
  assert.throws(() => readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD: password, TRUST_PROXY: 'true' }), /TRUST_PROXY/);
});

test('file-backed credentials are read without a trailing newline', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'online-shopping-secret-test-'));
  try {
    const secretPath = path.join(directory, 'password');
    writeFileSync(secretPath, `${productionPassword}\n`, { mode: 0o600 });
    assert.equal(readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD_FILE: secretPath }).password, productionPassword);
    writeFileSync(secretPath, 'password123\n');
    assert.throws(() => readConfig({ ADMIN_USERNAME: username, ADMIN_PASSWORD_FILE: secretPath }), /ADMIN_PASSWORD must/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('readiness fails closed when schema version changes while liveness stays up', async () => {
  const f = await fixture();
  try {
    f.app.database.setSchemaVersion(4);
    assert.equal((await f.request('GET', '/health')).response.status, 200);
    assert.equal((await f.request('GET', '/ready')).response.status, 503);
  } finally {
    await f.close();
  }
});

test('production startup refuses missing and weak credentials', () => {
  for (const overrides of [{ ADMIN_USERNAME: '', ADMIN_PASSWORD: '' }, { ADMIN_USERNAME: username, ADMIN_PASSWORD: 'password123' }]) {
    const result = spawnSync(process.execPath, ['src/server.js'], {
      cwd: path.resolve('.'),
      env: { ...process.env, NODE_ENV: 'production', DB_PATH: path.join(tmpdir(), 'unused-online-shopping.db'), PUBLIC_ORIGIN: 'https://shop.example', ...overrides },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Startup failed:/);
  }
});

test('health, authorization, session, CSRF, and logout', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('GET', '/health')).response.status, 200);
    assert.equal((await f.request('GET', '/ready')).response.status, 200);
    assert.equal(statSync(f.config.dbPath).mode & 0o777, 0o600);
    assert.equal((await f.request('GET', '/api/v1/seller/session')).response.status, 401);
    const crossOrigin = await f.request('POST', '/api/v1/seller/session', { username, password }, { origin: 'https://evil.example' });
    assert.equal(crossOrigin.response.status, 403);
    const wrong = await f.request('POST', '/api/v1/seller/session', { username, password: 'wrong' });
    assert.equal(wrong.response.status, 401);
    assert.equal(wrong.data.error.message, 'Invalid credentials.');
    const login = await f.request('POST', '/api/v1/seller/session', { username, password });
    assert.equal(login.response.status, 200);
    assert.equal(login.data.role, 'SUPER_ADMIN');
    assert.equal(login.response.headers.get('cache-control'), 'no-store');
    assert.match(login.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    const me = await f.request('GET', '/api/v1/seller/session', null, { cookie });
    assert.equal(me.response.status, 200);
    assert.equal(me.data.username, username);
    assert.equal((await f.request('DELETE', '/api/v1/seller/session', null, { cookie })).response.status, 403);
    assert.equal((await f.request('DELETE', '/api/v1/seller/session', null, { cookie, 'x-csrf-token': login.data.csrfToken })).response.status, 200);
    assert.equal((await f.request('GET', '/api/v1/seller/session', null, { cookie })).response.status, 401);
  } finally {
    await f.close();
  }
});

test('session persists across restart and configured identity cannot silently change', async () => {
  const f = await fixture();
  let restarted;
  try {
    const login = await f.request('POST', '/api/v1/seller/session', { username, password });
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    await f.app.close();
    assert.throws(() => createApp({ ...f.config, password: 'DifferentPrivatePass123!' }), /do not match/);
    restarted = createApp(f.config);
    await new Promise((resolve) => restarted.server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/v1/seller/session`, { headers: { cookie } });
    assert.equal(response.status, 200);
  } finally {
    if (restarted) await restarted.close();
    rmSync(path.dirname(f.config.dbPath), { recursive: true, force: true });
  }
});

test('login attempts are rate limited', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 5; index++) {
      assert.equal((await f.request('POST', '/api/v1/seller/session', { username, password: 'wrong' })).response.status, 401);
    }
    assert.equal((await f.request('POST', '/api/v1/seller/session', { username, password })).response.status, 429);
  } finally {
    await f.close();
  }
});

test('concurrent login attempts cannot bypass the rate limit', async () => {
  const f = await fixture();
  const sockets = [];
  try {
    const { port } = f.app.server.address();
    const body = JSON.stringify({ username, password: 'wrong' });
    for (let index = 0; index < 12; index++) {
      const socket = net.connect(port, '127.0.0.1');
      await new Promise((resolve) => socket.once('connect', resolve));
      let received = '';
      socket.on('data', (chunk) => { received += chunk; });
      socket.status = new Promise((resolve) => socket.once('end', () => resolve(Number(received.split(' ')[1]))));
      socket.write(`POST /api/v1/seller/session HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${f.origin}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
      sockets.push(socket);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const socket of sockets) socket.write(body);
    const statuses = await Promise.all(sockets.map((socket) => socket.status));
    assert.equal(statuses.filter((status) => status === 401).length, 5);
    assert.equal(statuses.filter((status) => status === 429).length, 7);
  } finally {
    for (const socket of sockets) socket.destroy();
    await f.close();
  }
});

test('login limiter bounds the number of tracked clients', () => {
  const limiter = new LoginLimiter();
  for (let index = 0; index < 5; index++) assert.equal(limiter.attempt('first'), true);
  assert.equal(limiter.attempt('first'), false);
  for (let index = 0; index < 5000; index++) limiter.attempt(`client-${index}`);
  assert.equal(limiter.attempt('first'), true);
});

test('public shell is served without exposing private files', async () => {
  const f = await fixture();
  try {
    const shop = await fetch(`${f.origin}/shop/`);
    const seller = await fetch(`${f.origin}/seller/`);
    assert.equal(shop.status, 200);
    assert.equal(seller.status, 200);
    assert.match(await seller.text(), /Seller portal/);
    assert.equal(seller.headers.get('content-security-policy')?.includes("script-src 'self'"), true);
    assert.equal((await fetch(`${f.origin}/src/server.js`)).status, 404);
    assert.equal((await fetch(`${f.origin}/.env`)).status, 404);
    assert.equal((await fetch(`${f.origin}/shared/i18n.js`)).status, 200);
  } finally {
    await f.close();
  }
});
