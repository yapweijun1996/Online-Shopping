import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readAiConfig, readConfig } from '../src/config.js';

test('AI config is default-off and never reads a disabled key file', () => {
  const env = { get AI_API_KEY_FILE() { throw new Error('disabled key was read'); } };
  assert.deepEqual(readAiConfig(env), { enabled: false, model: 'claude-haiku-5-5' });
  assert.deepEqual(readAiConfig({ AI_ENABLED: '0', AI_API_KEY_FILE: '/missing' }), { enabled: false, model: 'claude-haiku-5-5' });
});

test('AI host configuration validates flags, model, secret and unsafe modes', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'shop-ai-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'key');
  const env = { AI_ENABLED: '1', AI_API_KEY_FILE: file };
  for (const flag of ['', 'true', '2']) assert.throws(() => readAiConfig({ AI_ENABLED: flag }), /AI_ENABLED/);
  for (const model of ['', 'ab', 'A-model', 'a/b', 'x'.repeat(65), 'abc\n']) assert.throws(() => readAiConfig({ AI_MODEL: model }), /AI_MODEL/);
  assert.throws(() => readAiConfig(env), /AI_API_KEY_FILE cannot be read\./);
  for (const key of ['x'.repeat(19), 'x'.repeat(301), 'x'.repeat(20) + '\nsecret', 'x'.repeat(20) + '\tsecret', 'x'.repeat(20) + 'é']) {
    writeFileSync(file, key); assert.throws(() => readAiConfig(env), /Invalid AI_API_KEY_FILE/);
  }
  writeFileSync(file, '  fictional-api-key-123456789\n');
  assert.deepEqual(readAiConfig(env), { enabled: true, apiKey: 'fictional-api-key-123456789', model: 'claude-haiku-5-5' });
  for (const unsafe of [{ SELLER_QUICK_LOGIN: '1' }, { SHOP_MODE: 'public-demo' }]) assert.throws(() => readAiConfig({ ...env, ...unsafe }), /AI refuses/);
  const config = readConfig({ ...env, NODE_ENV: 'test', ADMIN_USERNAME: 'fixture_owner', ADMIN_PASSWORD: 'FictionalPassword123!' });
  assert.equal(config.ai.enabled, true); assert.equal(config.ai.apiKey, 'fictional-api-key-123456789');
});
