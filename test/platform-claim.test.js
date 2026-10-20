import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
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

test('claim issuance is hash-only, concurrent-safe, restart-only and maintenance-aware', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), store = await openDatabase(':memory:');
  const config = { integrationKeys: f.integrationKeys, shopMode: 'manual', publicOrigin: 'https://shop.example.test',
    platform: { claimEnabled: true, adminHost: 'admin.example.test', databaseUrl: f.platformUrl, provisionerUrl: f.baseUrl } };
  let now = Date.now(), paused = true;
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args));
  const runtimes = [];
  const start = () => {
    const runtime = createPlatformRuntime({ store, config, clock: () => now, paused: () => paused });
    runtimes.push(runtime); return runtime;
  };
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); await store.close(); });
  const first = start(), second = start();
  await assert.rejects(first.connect(), /unavailable/);
  assert.equal(lines.length, 0);
  paused = false;
  const [connection] = await Promise.all([first.connect(), second.connect()]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 1);
  const event = JSON.parse(lines[0][0]), code = new URL(event.url).hash.slice(1);
  assert.deepEqual(Object.keys(event).sort(), ['event', 'expiresAt', 'generation', 'url']);
  assert.equal(event.event, 'platform.claim.issued');
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  const state = await f.platform.get('SELECT * FROM platform_admin_claim');
  assert.equal(state.token_hash, createHash('sha256').update('PLATFORM_ADMIN_CLAIM\0').update(code).digest('hex'));
  assert.equal(Date.parse(state.expires_at) - Date.parse(state.issued_at), 30 * 60_000);
  assert.equal(state.attempts, 0);
  assert.equal((await f.platform.get("SELECT count(*) AS n FROM platform_admin_claim_generation WHERE outcome='ISSUED'")).n, 1);
  for (const { tablename } of await f.platform.all("SELECT tablename FROM pg_tables WHERE schemaname='public'")) {
    assert.equal(JSON.stringify(await f.platform.all(`SELECT * FROM "${tablename}"`)).includes(code), false);
  }
  const audit = await f.platform.all("SELECT action, detail FROM platform_audit WHERE action='ADMIN_CLAIM_ISSUED'");
  assert.deepEqual(audit, [{ action: 'ADMIN_CLAIM_ISSUED', detail: event.generation }]);
  await connection.close();
  now += 5001;
  await assert.rejects(first.connect(), /unavailable/);
  now += 5001;
  await first.connect();
  assert.equal(lines.length, 1);
  await f.platform.run("UPDATE platform_admin_claim SET issued_at='2000-01-01T00:00:00.000Z', expires_at='2000-01-01T00:30:00.000Z'");
  await first.reconcile();
  assert.equal(lines.length, 1);
  const restart = start();
  await restart.connect();
  assert.equal(lines.length, 2);
  assert.equal((await f.platform.get('SELECT outcome FROM platform_admin_claim_generation WHERE generation=?', event.generation)).outcome, 'SUPERSEDED');
  const live = await f.platform.get('SELECT generation FROM platform_admin_claim');
  now += 5001;
  await start().connect();
  assert.equal(lines.length, 3);
  assert.notEqual((await f.platform.get('SELECT generation FROM platform_admin_claim')).generation, live.generation);
  await f.platform.run("UPDATE platform_admin_claim SET closed_at=expires_at, token_hash=NULL");
  await start().connect();
  assert.equal(lines.length, 3);
  assert.equal((await f.platform.get('SELECT COUNT(*) AS n FROM platform_admin')).n, 0);
});

test('legacy mode and existing admin never issue claims', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), store = await openDatabase(':memory:');
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args));
  const config = { integrationKeys: f.integrationKeys, publicOrigin: 'https://shop.example.test',
    platform: { claimEnabled: false, username: 'owner', password: randomBytes(24).toString('hex'), databaseUrl: f.platformUrl, provisionerUrl: f.baseUrl } };
  const legacy = createPlatformRuntime({ store, config });
  const claim = createPlatformRuntime({ store, config: { ...config, platform: { ...config.platform, claimEnabled: true } } });
  t.after(async () => { await legacy.close(); await claim.close(); await store.close(); });
  await legacy.connect();
  await claim.connect();
  assert.deepEqual(lines, []);
  assert.equal((await f.platform.get('SELECT count(*) AS n FROM platform_admin_claim_generation')).n, 0);
  assert.equal((await f.platform.get('SELECT count(*) AS n FROM platform_admin')).n, 1);
});
