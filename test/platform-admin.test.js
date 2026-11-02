import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createAdminAuth, platformCookie, requirePlatformCsrf } from '../src/platform/admin-auth.js';
import { encodeBase32, totpCode, matchingTotpStep } from '../src/platform/totp.js';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';

test('RFC 6238 SHA1 vectors and bounded, replay-safe TOTP window', () => {
  const key = encodeBase32(Buffer.from('12345678901234567890'));
  for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(totpCode(key, Math.floor(seconds / 30), 8), expected);
  }
  const clock = 1_700_000_000_000, step = Math.floor(clock / 30_000);
  for (const offset of [-1, 0, 1]) assert.equal(matchingTotpStep(key, totpCode(key, step + offset), clock), step + offset);
  assert.equal(matchingTotpStep(key, totpCode(key, step), clock, step), null);
  assert.equal(matchingTotpStep(key, totpCode(key, step - 2), clock), null);
  assert.equal(matchingTotpStep(key, '12345', clock), null);
});

test('platform cookies and CSRF fail closed', () => {
  assert.match(platformCookie('fictional', 300), /HttpOnly; SameSite=Strict; Secure; Path=\/api\/v1\/platform; Max-Age=300/);
  const csrf = randomBytes(32).toString('base64url');
  assert.throws(() => requirePlatformCsrf(new Request('https://admin.example.test'), csrf), /CSRF/);
  assert.throws(() => requirePlatformCsrf(new Request('https://admin.example.test', { headers: { 'x-csrf-token': 'wrong' } }), csrf), /CSRF/);
  requirePlatformCsrf(new Request('https://admin.example.test', { headers: { 'x-csrf-token': csrf } }), csrf);
});

test('bootstrap, restricted sessions, enrolment, rotation, replay and recovery single use', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t); let clock = 1_700_000_000_000;
  const auth = createAdminAuth({ ...f, clock: () => clock });
  const password = randomBytes(24).toString('base64url');
  await Promise.all([auth.bootstrap('owner', password), auth.bootstrap('owner', password)]);
  await auth.bootstrap('other', randomBytes(24).toString('base64url'));
  assert.equal((await f.platform.get('SELECT COUNT(*) AS n FROM platform_admin')).n, 1);
  assert.equal((await f.platform.get('SELECT username FROM platform_admin')).username, 'owner');
  const unknown = await auth.password('missing', password).catch((error) => error);
  const wrong = await auth.password('owner', 'incorrect').catch((error) => error);
  assert.equal(unknown.message, wrong.message);
  const restricted = await auth.password('owner', password);
  assert.equal(restricted.stage, 'PASSWORD');
  await assert.rejects(auth.session(restricted.token, true), /authenticator/);
  const setup = await auth.enrol(restricted.token);
  assert.equal((await auth.enrol(restricted.token)).setupKey, setup.setupKey);
  const complete = await auth.confirm(restricted.token, { code: totpCode(setup.setupKey, Math.floor(clock / 30_000)) });
  assert.equal(complete.stage, 'FULL'); assert.notEqual(complete.token, restricted.token);
  assert.equal(complete.recoveryCodes.length, 10);
  await assert.rejects(auth.session(restricted.token), /failed/);
  await auth.session(complete.token, true);
  const next = await auth.password('owner', password);
  await assert.rejects(auth.confirm(next.token, { code: totpCode(setup.setupKey, Math.floor(clock / 30_000)) }), /failed/);
  const recovery = await auth.confirm(next.token, { recoveryCode: complete.recoveryCodes[0] });
  assert.equal(recovery.recoveryCodes, undefined);
  const again = await auth.password('owner', password);
  await assert.rejects(auth.confirm(again.token, { recoveryCode: complete.recoveryCodes[0] }), /failed/);
  const audit = JSON.stringify(await f.platform.all('SELECT * FROM platform_audit'));
  assert.ok(!audit.includes(password)); assert.ok(!audit.includes(setup.setupKey)); assert.ok(!audit.includes(complete.token));
  for (const code of complete.recoveryCodes) assert.ok(!audit.includes(code));
  clock += 301_000; await assert.rejects(auth.session(again.token), /failed/);
  clock += 31 * 60_000; await assert.rejects(auth.session(complete.token), /failed/);
});

test('lockout commits, expires by time, and password step cannot reset TOTP failures', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t); let clock = 1_700_000_000_000;
  const auth = createAdminAuth({ ...f, clock: () => clock }); const password = randomBytes(24).toString('base64url');
  await auth.bootstrap('owner', password);
  for (let i = 0; i < 5; i++) await assert.rejects(auth.password('owner', 'incorrect'), /failed/);
  assert.equal((await f.platform.get('SELECT failed_attempts FROM platform_admin')).failed_attempts, 5);
  await assert.rejects(auth.password('owner', password), /failed/);
  clock += 15 * 60_000 + 1;
  const restricted = await auth.password('owner', password), setup = await auth.enrol(restricted.token);
  await auth.confirm(restricted.token, { code: totpCode(setup.setupKey, Math.floor(clock / 30_000)) });
  for (let i = 0; i < 5; i++) {
    const s = await auth.password('owner', password);
    await assert.rejects(auth.confirm(s.token, { code: 'invalid' }), /failed/);
  }
  await assert.rejects(auth.password('owner', password), /failed/);
  assert.equal((await f.platform.get('SELECT failed_attempts FROM platform_admin')).failed_attempts, 5);
});

test('account change, recovery regeneration, absolute expiry and host reset', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t); let clock = 1_700_000_000_000;
  const auth = createAdminAuth({ ...f, clock: () => clock }); const password = randomBytes(24).toString('base64url');
  await auth.bootstrap('owner', password);
  const s = await auth.password('owner', password), setup = await auth.enrol(s.token);
  const full = await auth.confirm(s.token, { code: totpCode(setup.setupKey, Math.floor(clock / 30_000)) });
  const pending = await auth.password('owner', password), replacement = randomBytes(24).toString('base64url');
  await auth.changePassword(full.token, { currentPassword: password, newPassword: replacement });
  await assert.rejects(auth.session(pending.token), /failed/);
  await assert.rejects(auth.password('owner', password), /failed/);
  const codes = await auth.regenerateRecovery(full.token, replacement); assert.equal(codes.recoveryCodes.length, 10);
  assert.equal((await f.platform.get('SELECT COUNT(*) AS n FROM platform_recovery_code')).n, 10);
  for (let i = 0; i < 8; i++) { clock += 29 * 60_000; await auth.session(full.token, true); }
  clock += 9 * 60_000; await assert.rejects(auth.session(full.token, true), /failed/);
  await auth.reset(randomBytes(24).toString('base64url'));
  const admin = await f.platform.get('SELECT totp_enabled, failed_attempts, totp_secret_sealed, locked_until FROM platform_admin');
  assert.deepEqual(admin, { totp_enabled: 0, failed_attempts: 0, totp_secret_sealed: null, locked_until: null });
  assert.equal((await f.platform.get('SELECT COUNT(*) AS n FROM platform_session')).n, 0);
  assert.equal((await f.platform.get('SELECT COUNT(*) AS n FROM platform_recovery_code')).n, 0);
  assert.equal((await f.platform.get("SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'ADMIN_RESET' AND actor = 'host'")).n, 1);
});
