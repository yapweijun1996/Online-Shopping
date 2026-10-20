import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';
import { upgradePlatformSchema } from '../src/platform/migrations.js';
import { createAdminAuth } from '../src/platform/admin-auth.js';
import { readPlatformConfig } from '../src/config.js';
import { createPlatformRuntime } from '../src/platform/runtime.js';
import { openDatabase } from '../src/db.js';

 test('claim configuration is exclusive and legacy requirements remain', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'claim-config-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const secret = join(folder, 'secret'); await writeFile(secret, randomBytes(24).toString('hex'));
  const env = { PLATFORM_ENABLED: '1', PLATFORM_ADMIN_HOST: 'admin.example.test', PLATFORM_DATABASE_PASSWORD_FILE: secret, PLATFORM_PROVISIONER_PASSWORD_FILE: secret };
  assert.throws(() => readPlatformConfig(env, {}), /Invalid PLATFORM_ADMIN_USERNAME/);
  assert.throws(() => readPlatformConfig({ ...env, PLATFORM_ADMIN_USERNAME: 'owner' }, {}), /PLATFORM_ADMIN_PASSWORD_FILE cannot be read/);
  const claim = { ...env, PLATFORM_ADMIN_CLAIM_ENABLED: '1' };
  assert.equal(readPlatformConfig(claim, {}).claimEnabled, true);
  for (const key of ['PLATFORM_ADMIN_USERNAME', 'PLATFORM_ADMIN_PASSWORD_FILE']) assert.throws(() => readPlatformConfig({ ...claim, [key]: '/missing' }, {}), /Claim mode cannot/);
  assert.throws(() => readPlatformConfig({ ...env, PLATFORM_ADMIN_CLAIM_ENABLED: 'yes' }, {}), /must be 1 or 0/);
  assert.equal(readPlatformConfig({ ...env, PLATFORM_ADMIN_USERNAME: 'owner', PLATFORM_ADMIN_PASSWORD_FILE: secret }, {}).claimEnabled, false);
  assert.throws(() => readPlatformConfig({ ...claim, PLATFORM_DATABASE_PASSWORD_FILE: '/missing' }, {}), /cannot be read/);
});

const catalog = (store) => store.all(`SELECT c.relname, pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname, definition`);

test('fresh and v1 upgrade converge; bootstrap permanently closes claim without replacing credentials', { skip: !platformTestUrl }, async (t) => {
  const fresh = await platformFixture(t), upgraded = await platformFixture(t);
  await upgraded.platform.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await upgraded.platform.exec(await readFile(new URL('../src/platform/schema.sql', import.meta.url), 'utf8'));
  const password = randomBytes(24).toString('hex');
  await upgraded.platform.run("INSERT INTO platform_admin(id,username,username_key,password_hash,failed_attempts,created_at,updated_at) VALUES ('legacy','owner','owner','unchanged',3,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
  await upgradePlatformSchema(upgraded.platform);
  assert.deepEqual(await catalog(fresh.platform), await catalog(upgraded.platform));
  assert.deepEqual(await fresh.platform.all("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position"),
    await upgraded.platform.all("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position"));
  assert.deepEqual(await upgraded.platform.get('SELECT password_hash, failed_attempts, email FROM platform_admin'), { password_hash: 'unchanged', failed_attempts: 3, email: null });
  assert.equal((await upgraded.platform.get('SELECT claimed_admin_id FROM platform_admin_claim')).claimed_admin_id, 'legacy');
  const auth = createAdminAuth(fresh);
  await auth.bootstrap('owner', password);
  await auth.bootstrap('other', randomBytes(24).toString('hex'));
  assert.equal((await auth.password('owner', password)).stage, 'PASSWORD');
  await auth.reset(randomBytes(24).toString('hex'));
  for (const sql of ['UPDATE platform_admin_claim SET closed_at = NULL', 'DELETE FROM platform_admin_claim', 'TRUNCATE platform_admin_claim']) await assert.rejects(fresh.platform.exec(sql), /closed|removed/);
  await assert.rejects(fresh.platform.exec("UPDATE platform_admin SET email='Mixed@example.test', email_key='mixed@example.test'"), /check/);
  for (const email of ['a..b@example.test', '.a@example.test', 'a@bad..test', 'a@-bad.test', 'a@' + 'x'.repeat(64) + '.test']) {
    await assert.rejects(fresh.platform.run('UPDATE platform_admin SET email=?, email_key=?', email, email), /check/);
  }
  await fresh.platform.run('UPDATE platform_admin SET email=?, email_key=?', 'owner+contact@example.test', 'owner+contact@example.test');
  assert.equal((await fresh.platform.get('SELECT email FROM platform_admin')).email, 'owner+contact@example.test');
  await assert.rejects(upgraded.platform.exec("UPDATE platform_admin_claim SET attempts=-1"));
});

test('unissued claim rejects partial tokens and invalid lifetimes', { skip: !platformTestUrl }, async (t) => {
  const { platform } = await platformFixture(t);
  for (const sql of ["UPDATE platform_admin_claim SET token_hash='bad'", "UPDATE platform_admin_claim SET used_at='2026-01-01'", "UPDATE platform_admin_claim SET generation=gen_random_uuid(),issued_at='2026-02-01',expires_at='2026-01-01',token_hash=repeat('a',64)", 'UPDATE platform_admin_claim SET attempts=-1']) await assert.rejects(platform.exec(sql), /check/);
  for (const action of ['ADMIN_CLAIM_ISSUED', 'ADMIN_CLAIMED', 'ADMIN_CLAIM_DENIED', 'ADMIN_CLAIM_RATE_LIMITED']) await platform.run("INSERT INTO platform_audit(id,actor,action,created_at) VALUES (?, 'host', ?, '2026-01-01')", action, action);
  await assert.rejects(platform.exec('DELETE FROM platform_audit'), /append-only/);
});

test('claim-mode runtime connects without credentials and creates no admin or generation', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), store = await openDatabase(':memory:');
  const config = { integrationKeys: f.integrationKeys, shopMode: 'manual', publicOrigin: 'https://shop.example.test',
    platform: { claimEnabled: true, adminHost: 'admin.example.test', databaseUrl: f.platformUrl, provisionerUrl: f.baseUrl } };
  const runtime = createPlatformRuntime({ store, config });
  t.after(async () => { await runtime.close(); await store.close(); });
  await runtime.connect(); await runtime.connect();
  assert.equal((await f.platform.get('SELECT COUNT(*) AS n FROM platform_admin')).n, 0);
  assert.deepEqual(await f.platform.get('SELECT generation, token_hash, closed_at FROM platform_admin_claim'),
    { generation: null, token_hash: null, closed_at: null });
});
