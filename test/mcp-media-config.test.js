import test from 'node:test';
import assert from 'node:assert/strict';
import { readMcpMediaConfig, readMediaCodecToken } from '../src/mcp/media-config.js';
const safe = { production: false, mcpEnabled: true, mcpV2: { enabled: true }, shopMode: 'manual', sellerQuickLogin: false, dbPath: ':memory:' };
const env = { NODE_ENV: 'development', MCP_V2_MEDIA_ENABLED: '1', MCP_V2_MEDIA_CODEC_IDENTITY: 'sha256:' + 'a'.repeat(64),
  MCP_V2_MEDIA_SOCKET_PATH: '/synthetic/no-worker.sock', MCP_V2_MEDIA_TOKEN_FILE: '/synthetic/no-token' };
test('media feature is independently off and never inspects inactive credential paths', () => {
  assert.deepEqual(readMcpMediaConfig({}), { enabled: false });
  assert.deepEqual(readMcpMediaConfig({ MCP_V2_MEDIA_ENABLED: '0', MCP_V2_MEDIA_TOKEN_FILE: '/missing/private-token' }, safe), { enabled: false });
  assert.ok(Object.isFrozen(readMcpMediaConfig({})));
  assert.throws(() => readMcpMediaConfig({ MCP_V2_MEDIA_ENABLED: 'true' }, safe), /must be 0 or 1/);
});
test('media activation fails before filesystem work outside explicit safe development context', () => {
  for (const production of [true]) assert.throws(() => readMcpMediaConfig(env, { ...safe, production }), /production activation is blocked/);
  for (const NODE_ENV of [undefined,'production','staging']) assert.throws(() => readMcpMediaConfig({ ...env, NODE_ENV }, safe), /explicit development or test mode/);
  for (const patch of [{ mcpEnabled: false }, { mcpV2: { enabled: false } }, { shopMode: 'public-demo' }, { sellerQuickLogin: true }]) {
    assert.throws(() => readMcpMediaConfig(env, { ...safe, ...patch }), /safe MCP v2/);
  }
  for (const identity of [undefined,'a'.repeat(64),'sha256:' + 'A'.repeat(64),'sha256:bad']) {
    assert.throws(() => readMcpMediaConfig({ ...env, MCP_V2_MEDIA_CODEC_IDENTITY: identity }, safe), /trusted configured sha256/);
  }
});
test('missing worker or malformed private configuration fails closed without secret/path disclosure', () => {
  assert.throws(() => readMcpMediaConfig(env, safe), { message: 'MCP media requires a trusted sealed local codec configuration.' });
  for (const value of [{ enabled: false }, { enabled: true, codecDigest: 'bad' }, { enabled: true, codecDigest: 'a'.repeat(64),
    socketPath: '/synthetic/no-worker.sock', tokenFile: '/synthetic/secret-never-log' }]) {
    assert.throws(() => readMediaCodecToken(value), { message: 'MCP media requires a trusted sealed local codec configuration.' });
  }
});
