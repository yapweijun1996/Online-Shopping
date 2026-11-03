import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createAdminAuth, platformCookie } from '../src/platform/admin-auth.js';
import { totpCode } from '../src/platform/totp.js';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';

test('trusted device defaults to one week, survives inactivity and expires at its fixed deadline', { skip: !platformTestUrl }, async t => {
  const f = await platformFixture(t), started = 1_700_000_000_000; let now = started;
  const auth = createAdminAuth({ ...f, clock: () => now });
  const password = randomBytes(24).toString('base64url');
  await auth.bootstrap('owner', password);
  const restricted = await auth.password('owner', password);
  const setup = await auth.enrol(restricted.token);
  const full = await auth.confirm(restricted.token, { code: totpCode(setup.setupKey, Math.floor(now / 30_000)), trustedDevice: true });
  assert.equal(full.maxAge, 7 * 24 * 60 * 60);
  assert.match(platformCookie(full.token, full.maxAge), /HttpOnly; SameSite=Strict; Secure; Path=\/api\/v1\/platform; Max-Age=604800$/);
  await assert.rejects(auth.session(restricted.token), /failed/);
  const tokenHash = createHash('sha256').update(full.token).digest('hex');
  const row = await f.platform.get('SELECT * FROM platform_session WHERE token_hash = ?', tokenHash);
  assert.notEqual(row.token_hash, full.token);
  assert.equal(row.expires_at, new Date(started + 7 * 24 * 60 * 60_000).toISOString());
  now += 31 * 60_000;
  await auth.session(full.token, true);
  now = started + 7 * 24 * 60 * 60_000 - 1;
  await auth.session(full.token, true);
  now += 1;
  await assert.rejects(auth.session(full.token, true), /failed/);
});

for (const [duration, days] of [['1d', 1], ['1w', 7], ['1m', 30], ['1y', 365]]) {
  test(`trusted device ${duration} lasts exactly ${days} days without sliding expiry`, { skip: !platformTestUrl }, async t => {
    const f = await platformFixture(t), started = 1_700_000_000_000; let now = started;
    const auth = createAdminAuth({ ...f, clock: () => now });
    const password = randomBytes(24).toString('base64url'); await auth.bootstrap('owner', password);
    const restricted = await auth.password('owner', password), setup = await auth.enrol(restricted.token);
    const full = await auth.confirm(restricted.token, { code: totpCode(setup.setupKey, Math.floor(now / 30_000)), trustedDevice: true, trustedDeviceDuration: duration });
    const lifetime = days * 24 * 60 * 60_000;
    assert.equal(full.maxAge, lifetime / 1000);
    const row = await f.platform.get('SELECT expires_at, absolute_expires_at FROM platform_session WHERE stage = ?', 'FULL');
    assert.equal(row.expires_at, new Date(started + lifetime).toISOString());
    assert.equal(row.absolute_expires_at, row.expires_at);
    now += 5 * 60 * 60_000; await auth.session(full.token, true);
    now = started + lifetime - 1; await auth.session(full.token, true);
    const after = await f.platform.get('SELECT expires_at, absolute_expires_at FROM platform_session WHERE stage = ?', 'FULL');
    assert.deepEqual(after, row);
    now += 1; await assert.rejects(auth.session(full.token, true), /failed/);
  });
}

test('invalid trust selections are rejected before consuming a valid authenticator code', { skip: !platformTestUrl }, async t => {
  const f = await platformFixture(t), now = 1_700_000_000_000;
  const auth = createAdminAuth({ ...f, clock: () => now });
  const password = randomBytes(24).toString('base64url'); await auth.bootstrap('owner', password);
  const restricted = await auth.password('owner', password), setup = await auth.enrol(restricted.token);
  const code = totpCode(setup.setupKey, Math.floor(now / 30_000));
  for (const selection of [
    { trustedDevice: 'true' }, { trustedDevice: 1 }, { trustedDevice: null },
    { trustedDevice: true, trustedDeviceDuration: 'forever' },
    { trustedDevice: true, trustedDeviceDuration: '__proto__' },
    { trustedDevice: true, trustedDeviceDuration: 'constructor' },
    { trustedDevice: true, trustedDeviceDuration: 365 },
    { trustedDevice: true, trustedDeviceDuration: null },
    { trustedDeviceDuration: '1y' },
  ]) {
    await assert.rejects(auth.confirm(restricted.token, { code, ...selection }), { status: 400, code: 'INVALID_INPUT' });
    assert.equal((await f.platform.get("SELECT COUNT(*) AS n FROM platform_session WHERE stage = 'FULL'")).n, 0);
  }
  const full = await auth.confirm(restricted.token, { code, trustedDevice: true });
  assert.equal(full.maxAge, 604800);
});

test('trusted sessions still require MFA and remain revocable by logout, password change and host reset', { skip: !platformTestUrl }, async t => {
  const f = await platformFixture(t); let now = 1_700_000_000_000;
  const auth = createAdminAuth({ ...f, clock: () => now });
  const password = randomBytes(24).toString('base64url'); await auth.bootstrap('owner', password);
  const restricted = await auth.password('owner', password), setup = await auth.enrol(restricted.token);
  await assert.rejects(auth.confirm(restricted.token, { code: 'invalid', trustedDevice: true, trustedDeviceDuration: '1y' }), /failed/);
  await assert.rejects(auth.session(restricted.token, true), /authenticator/);
  const first = await auth.confirm(restricted.token, { code: totpCode(setup.setupKey, Math.floor(now / 30_000)), trustedDevice: true, trustedDeviceDuration: '1y' });
  now += 10 * 24 * 60 * 60_000; await auth.session(first.token, true);
  const pending = await auth.password('owner', password);
  const second = await auth.confirm(pending.token, { recoveryCode: first.recoveryCodes[0], trustedDevice: true });
  const replacement = randomBytes(24).toString('base64url');
  await auth.changePassword(second.token, { currentPassword: password, newPassword: replacement });
  await assert.rejects(auth.session(first.token, true), /failed/);
  await auth.session(second.token, true);
  await auth.logout(second.token); await assert.rejects(auth.session(second.token, true), /failed/);
  const next = await auth.password('owner', replacement);
  const last = await auth.confirm(next.token, { code: totpCode(setup.setupKey, Math.floor(now / 30_000)), trustedDevice: true });
  await auth.reset(randomBytes(24).toString('base64url'));
  await assert.rejects(auth.session(last.token, true), /failed/);
  assert.equal((await f.platform.get('SELECT COUNT(*) AS n FROM platform_session')).n, 0);
});

test('explicitly untrusted sessions retain their existing idle and absolute limits', { skip: !platformTestUrl }, async t => {
  const f = await platformFixture(t); let now = 1_700_000_000_000;
  const auth = createAdminAuth({ ...f, clock: () => now });
  const password = randomBytes(24).toString('base64url'); await auth.bootstrap('owner', password);
  const restricted = await auth.password('owner', password), setup = await auth.enrol(restricted.token);
  assert.equal(restricted.maxAge, 300);
  const full = await auth.confirm(restricted.token, { code: totpCode(setup.setupKey, Math.floor(now / 30_000)), trustedDevice: false });
  assert.equal(full.maxAge, 14400);
  now += 31 * 60_000; await assert.rejects(auth.session(full.token, true), /failed/);
});
