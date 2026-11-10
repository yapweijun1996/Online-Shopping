import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { generateTemporaryPassword, validTemporaryPassword, sellerLoginUrl, PASSWORD_GENERATION_ATTEMPTS } from '../public/seller/team-password.js';

test('secure generator uses real Web Crypto and meets bounded existing policy without statistical claims', () => {
  for (let i = 0; i < 16; i++) {
    const password = generateTemporaryPassword('fictional.member', webcrypto);
    assert.ok(password.length === 24 && /^[A-Za-z0-9_-]+$/.test(password), 'generated length and alphabet');
    assert.ok(validTemporaryPassword(password, 'fictional.member') && /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password), 'generated policy and character classes');
  }
});
test('missing/throwing random source fails closed and repeated rejected values have an exact attempt bound', () => {
  assert.throws(() => generateTemporaryPassword('', null), /SECURE_RANDOM_UNAVAILABLE/);
  assert.throws(() => generateTemporaryPassword('', { getRandomValues() { throw new Error('unavailable'); } }), /SECURE_RANDOM_UNAVAILABLE/);
  let calls = 0;
  assert.throws(() => generateTemporaryPassword('', { getRandomValues(bytes) { calls++; bytes.fill(0); return bytes; } }), /SECURE_RANDOM_RETRY_LIMIT/);
  assert.equal(calls, PASSWORD_GENERATION_ATTEMPTS);
});
test('six-bit alphabet indices and username rejection use a bounded retry without changing manual-password policy', () => {
  let calls = 0;
  const source = { getRandomValues(bytes) { const pattern = calls++ === 0 ? [0, 27, 52, 62] : [25, 26, 61, 63]; for (let i = 0; i < bytes.length; i++) bytes[i] = pattern[i % pattern.length] + 128; return bytes; } };
  const password = generateTemporaryPassword('Ab0', source); assert.equal(calls, 2); assert.ok(!password.toLowerCase().includes('ab0'));
  assert.ok(validTemporaryPassword('Manual password phrase!', 'fixture.member')); assert.ok(!validTemporaryPassword('FIXTURE.Member-password', 'fixture.member')); assert.ok(!validTemporaryPassword('x'.repeat(24), 'fixture.member'));
});
test('seller handoff URL stays on current origin and validated tenant path, without draft or return parameters', () => {
  assert.equal(sellerLoginUrl({ origin: 'https://seller.example.test', pathname: '/seller/' }), 'https://seller.example.test/seller/');
  assert.equal(sellerLoginUrl({ origin: 'https://seller.example.test', pathname: '/acme123/seller/' }), 'https://seller.example.test/acme123/seller/');
  assert.equal(sellerLoginUrl({ origin: 'http://127.0.0.1:1234', pathname: '/seller/' }), 'http://127.0.0.1:1234/seller/');
  assert.equal(sellerLoginUrl({ origin: 'https://seller.example.test', pathname: '//untrusted.test/path' }), 'https://seller.example.test/seller/');
});
