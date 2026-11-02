import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';
import { PLATFORM_SCHEMA_VERSION, openPlatformDatabase } from '../src/platform/platform-db.js';
import { upgradePlatformSchema } from '../src/platform/migrations.js';
import { createPlatformRuntime } from '../src/platform/runtime.js';
import { openDatabase } from '../src/db.js';
import { upgradePlatform } from '../scripts/upgrade-platform.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('OrbStack candidate v1 comparison performs no migration and legacy runtime remains v1-compatible', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t, { claimEnabled: false });
  assert.equal(await f.platform.schemaVersion(), 1);
  const before = await f.platform.all("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name");
  let migrations = 0;
  if (PLATFORM_SCHEMA_VERSION !== await f.platform.schemaVersion()) { migrations++; await upgradePlatformSchema(f.platform); }
  assert.equal(migrations, 0);
  const store = await openDatabase(':memory:');
  const directory = await mkdtemp(join(tmpdir(), 'claim-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, 'report.json');
  const result = await upgradePlatform({ platformUrl: f.platformUrl, secretBox: f.secretBox, reportPath,
    backup: { format: 1, restoreVerified: true, databases: [] } });
  assert.equal(result.platformVersion, 1);
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')).attempted, []);
  const runtime = createPlatformRuntime({ store, config: { integrationKeys: f.integrationKeys, platform: { databaseUrl: f.platformUrl, provisionerUrl: f.baseUrl, adminHost: 'admin.example.test', username: 'legacy.owner', password: randomBytes(24).toString('hex') } } });
  t.after(async () => { await runtime.close(); await store.close(); });
  await runtime.connect();
  assert.equal(await f.platform.schemaVersion(), 1);
  assert.deepEqual(await f.platform.all("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name"), before);
  assert.equal((await f.platform.get('SELECT username FROM platform_admin')).username, 'legacy.owner');
  await assert.rejects(openPlatformDatabase(f.platformUrl, { claimEnabled: true }), /Unsupported/);
  await upgradePlatformSchema(f.platform, { targetVersion: 2 });
  const claimed = await openPlatformDatabase(f.platformUrl, { claimEnabled: true });
  await claimed.close();
  assert.equal((await f.platform.get('SELECT claimed_admin_id FROM platform_admin_claim')).claimed_admin_id !== null, true);
});

test('QR upgrade option targets 3 without activating claims', { skip: !platformTestUrl }, async (t) => {
  for (const claimEnabled of [false, true]) {
    const f = await platformFixture(t, { claimEnabled });
    const directory = await mkdtemp(join(tmpdir(), 'qr-upgrade-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const result = await upgradePlatform({ platformUrl: f.platformUrl, secretBox: f.secretBox,
      reportPath: join(directory, 'report.json'), withQr: true,
      backup: { format: 1, restoreVerified: true, databases: [{ database: 'platform' }] } });
    assert.equal(result.platformVersion, 3);
    assert.equal(await f.platform.schemaVersion(), 3);
    assert.equal((await f.platform.get('SELECT token_hash FROM platform_admin_claim')).token_hash, null);
    assert.deepEqual(result.upgraded, ['platform']);
  }
});
