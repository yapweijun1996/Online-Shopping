import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSecretBox, maskSecret, parseKeyFile } from '../src/secret-box.js';

const keyLine = (id) => `${id}=${randomBytes(32).toString('base64')}`;
const box = (ids = ['k1']) => createSecretBox(parseKeyFile(ids.map(keyLine).join('\n')));

test('a secret round-trips, and the stored bytes never contain it', () => {
  const b = box();
  const { keyId, sealed } = b.seal('client-secret-ABC123456789', 'NINJAVAN:SANDBOX');
  assert.equal(keyId, 'k1');
  assert.ok(!sealed.toString('latin1').includes('client-secret'));
  assert.equal(b.open(sealed, keyId, 'NINJAVAN:SANDBOX'), 'client-secret-ABC123456789');
});

test('every seal uses a fresh IV, so equal secrets give different ciphertexts', () => {
  const b = box();
  assert.notDeepEqual(b.seal('same-value-123456', 'c').sealed, b.seal('same-value-123456', 'c').sealed);
});

test('a sealed value only opens in its own context, with its own key, untampered', () => {
  const b = box();
  const { keyId, sealed } = b.seal('token-123456789012', 'WHATSAPP_CLOUD:PRODUCTION');
  assert.throws(() => b.open(sealed, keyId, 'WHATSAPP_CLOUD:SANDBOX'), /cannot be decrypted/, 'moved to another connection');
  assert.throws(() => b.open(sealed, 'other', 'WHATSAPP_CLOUD:PRODUCTION'), /cannot be decrypted/, 'unknown key id');
  assert.throws(() => b.open(box().seal('token-123456789012', 'WHATSAPP_CLOUD:PRODUCTION').sealed, 'k1', 'WHATSAPP_CLOUD:PRODUCTION'), /cannot be decrypted/, 'another installation');
  for (const index of [0, 1, 13, sealed.length - 1]) {
    const bad = Buffer.from(sealed); bad[index] ^= 1;
    assert.throws(() => b.open(bad, keyId, 'WHATSAPP_CLOUD:PRODUCTION'), /cannot be decrypted/, `byte ${index}`);
  }
  assert.throws(() => b.open(sealed.subarray(0, 20), keyId, 'WHATSAPP_CLOUD:PRODUCTION'), /cannot be decrypted/);
  assert.throws(() => b.open('not bytes', keyId, 'x'), /cannot be decrypted/);
});

test('key rotation: a new first key seals new values, old rows reseal, then the old key can go', () => {
  const oldLine = keyLine('old'), newLine = keyLine('new');
  const before = createSecretBox(parseKeyFile(oldLine));
  const stored = before.seal('secret-value-123456', 'NINJAVAN:PRODUCTION');
  const during = createSecretBox(parseKeyFile(`${newLine}\n${oldLine}`));
  assert.equal(during.activeId, 'new');
  assert.equal(during.open(stored.sealed, stored.keyId, 'NINJAVAN:PRODUCTION'), 'secret-value-123456', 'old rows still open');
  assert.ok(during.needsRotation(stored.keyId));
  const moved = during.reseal(stored.sealed, stored.keyId, 'NINJAVAN:PRODUCTION');
  assert.equal(moved.keyId, 'new');
  const after = createSecretBox(parseKeyFile(newLine));
  assert.equal(after.open(moved.sealed, moved.keyId, 'NINJAVAN:PRODUCTION'), 'secret-value-123456');
  assert.throws(() => after.open(stored.sealed, 'old', 'NINJAVAN:PRODUCTION'), /cannot be decrypted/);
});

test('the key file is validated: 32 random bytes, safe unique ids, comments allowed, first key active', () => {
  const parsed = parseKeyFile(`# master keys\n${keyLine('a')}\n\n${keyLine('b')}\n`);
  assert.equal(parsed.activeId, 'a'); assert.deepEqual([...parsed.keys.keys()], ['a', 'b']);
  assert.throws(() => parseKeyFile(''), /no key/);
  assert.throws(() => parseKeyFile('a=' + randomBytes(16).toString('base64')), /32 random bytes/);
  assert.throws(() => parseKeyFile('a=not base64!!'), /32 random bytes/);
  assert.throws(() => parseKeyFile(`${keyLine('a')}\n${keyLine('a')}`), /repeated/);
  assert.throws(() => parseKeyFile('bad id=' + randomBytes(32).toString('base64')), /invalid/);
  assert.throws(() => parseKeyFile(randomBytes(32).toString('base64')), /invalid/, 'a bare key has no id');
  assert.throws(() => createSecretBox({ activeId: 'x', keys: new Map() }), /active integration key/);
});

test('empty or oversized secrets are refused and the seller page only ever sees a mask', () => {
  const b = box();
  assert.throws(() => b.seal('', 'c'), /1 to 8192/);
  assert.throws(() => b.seal('x'.repeat(8193), 'c'), /1 to 8192/);
  assert.equal(maskSecret('abcdefghijklmnop'), '••••mnop');
  assert.equal(maskSecret('short'), '••••', 'a short secret reveals nothing');
  assert.equal(maskSecret(undefined), '••••');
});
