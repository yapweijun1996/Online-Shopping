import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';

test('file credentials preserve selected PostgreSQL ports for shop, platform and provisioning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-port-'));
  try {
    const file = join(directory, 'credential'); await writeFile(file, 'aStrongFixtureSecret123456', { mode: 0o600 });
    const keyFile = join(directory, 'keys'); await writeFile(keyFile, `primary=${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
    const env = { ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_FILE: file, DATABASE_PASSWORD_FILE: file, DATABASE_HOST: '127.0.0.1', DATABASE_PORT: '54329', PLATFORM_ENABLED: '1', PLATFORM_ADMIN_CLAIM_ENABLED: '1', PLATFORM_ADMIN_HOST: 'localhost:3000', INTEGRATION_KEY_FILE: keyFile, PLATFORM_DATABASE_HOST: '127.0.0.1', PLATFORM_DATABASE_PORT: '54329', PLATFORM_DATABASE_PASSWORD_FILE: file, PLATFORM_PROVISIONER_PASSWORD_FILE: file };
    const config = readConfig(env);
    for (const value of [config.databaseUrl, config.platform.databaseUrl, config.platform.provisionerUrl]) assert.equal(new URL(value).port, '54329');
    const defaults = readConfig({ ...env, DATABASE_PORT: undefined, PLATFORM_DATABASE_PORT: undefined });
    for (const value of [defaults.databaseUrl, defaults.platform.databaseUrl, defaults.platform.provisionerUrl]) assert.equal(new URL(value).port, '5432');
    for (const key of ['DATABASE_PORT', 'PLATFORM_DATABASE_PORT']) for (const value of ['0', '65536', '-1', '5432/x', '', '1.5']) assert.throws(() => readConfig({ ...env, [key]: value }), /Invalid database port/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
