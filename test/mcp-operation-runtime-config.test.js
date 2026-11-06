import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { operationBuildDigest, readMcpV2Config } from '../src/mcp/operation-runtime.js';

const context = { mcpEnabled: true, sellerOrigin: 'https://seller.example.test', dbPath: '/tmp/synthetic-db/shop.db' };
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'shop-mcp-v2-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'epoch');
  writeFileSync(file, Buffer.alloc(32, 7).toString('base64url') + '\n', { mode: 0o600 });
  return { directory, file, env: { MCP_V2_ENABLED: '1', MCP_V2_EPOCH_FILE: file } };
}

test('v2 config defaults off and does not inspect epoch/build inputs', () => {
  const env = { get MCP_V2_EPOCH_FILE() { throw new Error('Disabled epoch read'); } };
  assert.deepEqual(readMcpV2Config(env, {}), { enabled: false });
  assert.deepEqual(readMcpV2Config({ MCP_V2_ENABLED: '0', MCP_V2_EPOCH_FILE: '/missing' }, {}), { enabled: false });
  const config = readConfig({ ADMIN_USERNAME: 'synthetic_owner', ADMIN_PASSWORD: 'Synthetic-owner-password-2026!' });
  assert.deepEqual(config.mcpV2, { enabled: false });
  assert.ok(Object.isFrozen(config.mcpV2));
});

test('v2 config fails closed on unspecified security inputs, unsafe modes and production', (t) => {
  const f = fixture(t);
  for (const flag of ['', 'true', '2', 1, false]) assert.throws(() => readMcpV2Config({ MCP_V2_ENABLED: flag }, context), /MCP_V2_ENABLED/);
  for (const extra of [{ mcpEnabled: false }, { mcpEnabled: undefined }, { sellerOrigin: undefined }, { sellerOrigin: 'http://seller.example.test' }]) {
    assert.throws(() => readMcpV2Config(f.env, { ...context, ...extra }), /requires MCP_ENABLED/);
  }
  for (const extra of [{ SHOP_MODE: 'demo' }, { SHOP_MODE: 'public-demo' }, { SELLER_QUICK_LOGIN: '1' }, { SELLER_QUICK_LOGIN: 'true' }, { SELLER_QUICK_LOGIN: '' }]) {
    assert.throws(() => readMcpV2Config({ ...f.env, ...extra }, context), /manual shop/);
  }
  assert.throws(() => readMcpV2Config({ ...f.env, NODE_ENV: 'production' }, context), /reviewed release/);
  for (const file of [undefined, '', 'relative-epoch', '/missing-synthetic-epoch', f.directory]) {
    assert.throws(() => readMcpV2Config({ ...f.env, MCP_V2_EPOCH_FILE: file }, context), /MCP_V2_EPOCH_FILE/);
  }
  for (const value of ['', 'x'.repeat(43), Buffer.alloc(32).toString('base64'), ' ' + Buffer.alloc(32).toString('base64url'), Buffer.alloc(32).toString('base64url') + '\n\n']) {
    writeFileSync(f.file, value);
    assert.throws(() => readMcpV2Config(f.env, context), /MCP_V2_EPOCH_FILE/);
  }
  writeFileSync(f.file, Buffer.alloc(32, 7).toString('base64url'));
  assert.throws(() => readMcpV2Config(f.env, { ...context, dbPath: path.join(f.directory, 'shop.db') }), /outside the database/);
  const config = readMcpV2Config({ ...f.env, MCP_V2_BUILD_DIGEST: 'a'.repeat(64), APP_REVISION: 'local', SELLER_QUICK_LOGIN: '0' }, context);
  assert.equal(config.enabled, true);
  assert.equal(config.epochFile, f.file);
  assert.equal(config.epoch, Buffer.alloc(32, 7).toString('base64url'));
  assert.equal(config.buildDigest, operationBuildDigest());
  assert.notEqual(config.buildDigest, 'a'.repeat(64));
  assert.ok(Object.isFrozen(config));
  const complete = readConfig({ ...f.env, ADMIN_USERNAME: 'synthetic_owner', ADMIN_PASSWORD: 'Synthetic-owner-password-2026!',
    MCP_ENABLED: '1', SELLER_ORIGIN: context.sellerOrigin, DB_PATH: context.dbPath });
  assert.equal(complete.mcpV2.buildDigest, config.buildDigest);
});

test('build digest covers source, SQL, public approval assets and package content independently of checkout location', (t) => {
  const { directory } = fixture(t);
  const first = path.join(directory, 'one'), second = path.join(directory, 'two');
  for (const dir of ['src', 'src/mcp', 'src/postgres', 'public']) mkdirSync(path.join(first, dir), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'src/roles.js', 'src/mcp/operation-policy.js', 'src/postgres/schema.sql', 'public/approval.js']) {
    writeFileSync(path.join(first, file), file);
  }
  cpSync(first, second, { recursive: true });
  const digest = operationBuildDigest(first);
  assert.equal(operationBuildDigest(second), digest);
  for (const file of ['package-lock.json', 'src/roles.js', 'src/mcp/operation-policy.js', 'src/postgres/schema.sql', 'public/approval.js']) {
    writeFileSync(path.join(second, file), file + 'changed');
    assert.notEqual(operationBuildDigest(second), digest, file);
    writeFileSync(path.join(second, file), file);
  }
  writeFileSync(path.join(second, 'src/new-service.js'), 'new behavior');
  assert.notEqual(operationBuildDigest(second), digest);
  rmSync(path.join(second, 'src/new-service.js'));
  symlinkSync(path.join(first, 'src/roles.js'), path.join(second, 'src/linked.js'));
  assert.throws(() => operationBuildDigest(second), /regular files/);
  assert.throws(() => operationBuildDigest('/missing-synthetic-source'));
});
