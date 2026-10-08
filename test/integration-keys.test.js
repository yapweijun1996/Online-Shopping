import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';

const admin = { ADMIN_USERNAME: 'owner_account', ADMIN_PASSWORD: 'Strong-Local-Pass-9482!' };
const withKeyFile = (text, run) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'keys-'));
  const file = path.join(directory, 'integration-keys');
  try { if (text !== null) writeFileSync(file, text, { mode: 0o600 }); return run(file); }
  finally { rmSync(directory, { recursive: true, force: true }); }
};

test('without a key file the app starts and has no integration keys', () => {
  assert.equal(readConfig({ ...admin }).integrationKeys, null);
});

test('a valid key file is loaded; the first line is the active key', () => withKeyFile(
  `k2=${randomBytes(32).toString('base64')}\nk1=${randomBytes(32).toString('base64')}\n`,
  (file) => {
    const { integrationKeys } = readConfig({ ...admin, INTEGRATION_KEY_FILE: file });
    assert.equal(integrationKeys.activeId, 'k2');
    assert.deepEqual([...integrationKeys.keys.keys()], ['k2', 'k1']);
  }));

test('a configured key file that is missing, empty or malformed stops startup without echoing its content', () => {
  withKeyFile(null, (file) => assert.throws(() => readConfig({ ...admin, INTEGRATION_KEY_FILE: file }), /INTEGRATION_KEY_FILE cannot be read/));
  withKeyFile('\n# nothing\n', (file) => assert.throws(() => readConfig({ ...admin, INTEGRATION_KEY_FILE: file }), /no key/));
  const secret = 'c2hvcnQ=';
  withKeyFile(`k1=${secret}\n`, (file) => {
    assert.throws(() => readConfig({ ...admin, INTEGRATION_KEY_FILE: file }), (error) => /32 random bytes/.test(error.message) && !error.message.includes(secret));
  });
});
