import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';
import { upgradePlatformSchema } from '../src/platform/migrations.js';
import { openPlatformDatabase } from '../src/platform/platform-db.js';
import { createQrPolicy } from '../src/platform/whatsapp-qr.js';
import { createShopManagement } from '../src/platform/shops.js';
import { createPlatformRuntime } from '../src/platform/runtime.js';
import { openDatabase } from '../src/db.js';

async function tenant(f, code, isDefault = false) {
  const id = randomUUID(), now = new Date().toISOString();
  const db = `t_${code}_${id.replaceAll('-', '').slice(0, 8)}`;
  await f.platform.run(`INSERT INTO tenant(id,code,name,status,currency,is_default,database_name,database_role,database_password_sealed,database_key_id,created_at,updated_at)
    VALUES (?,?,?,'ACTIVE','MYR',?,?,?,?,?,?,?)`, id, code, code, isDefault ? 1 : 0, isDefault ? null : db, isDefault ? null : db, isDefault ? null : Buffer.from('fixture'), isDefault ? null : 'k1', now, now);
  return id;
}
for (const start of [1, 2]) test(`QR explicit ${start}->3 preserves startup target and claims`, { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t, { claimEnabled: start === 2 });
  const reopened = await openPlatformDatabase(f.platformUrl);
  assert.equal(await reopened.schemaVersion(), start);
  await reopened.close();
  if (start === 1) assert.equal(await upgradePlatformSchema(f.platform), 1);
  await upgradePlatformSchema(f.platform, { targetVersion: 3 });
  const next = await openPlatformDatabase(f.platformUrl);
  assert.equal(await next.schemaVersion(), 3);
  assert.equal((await next.get('SELECT token_hash FROM platform_admin_claim')).token_hash, null);
  await next.close();
  for (const action of ['QR_ENABLE', 'QR_DISABLE', 'QR_CLEANUP', 'QR_BINDING_RETIRED']) await f.platform.run('INSERT INTO platform_audit(id,actor,action,created_at) VALUES (?,?,?,?)', randomUUID(), 'host', action, new Date().toISOString());
  await assert.rejects(f.platform.run('INSERT INTO platform_audit(id,actor,action,created_at) VALUES (?,?,?,?)', randomUUID(), 'host', 'QR_UNKNOWN', new Date().toISOString()), /check constraint/);
});

test('QR reservations serialize capacity, revocation, lifecycle and retirement', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t);
  await upgradePlatformSchema(f.platform, { targetVersion: 3 });
  const a = await tenant(f, 'alpha'), b = await tenant(f, 'bravo'), defaultId = await tenant(f, 'default', true), c = await tenant(f, 'charlie');
  const policy = createQrPolicy({ platform: f.platform, provisionedTenantIds: [a, b] });
  await assert.rejects(policy.mutate(c, true, { expectedRevision: 0 }, 'admin'), { code: 'QR_WORKER_NOT_PROVISIONED' });
  const outcomes = await Promise.allSettled([a, b].map((id) => policy.mutate(id, true, { expectedRevision: 0 }, 'admin')));
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((item) => item.status === 'rejected').reason.code, 'QR_CAPACITY');
  const winner = outcomes[0].status === 'fulfilled' ? a : b, loser = winner === a ? b : a;
  await policy.mutate(defaultId, true, { expectedRevision: 0 }, 'admin');
  assert.equal((await policy.view(defaultId)).binding.slot_id, 0);
  const binding = (await policy.view(winner)).binding;
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const authorized = policy.withAuthorizedBinding(winner, binding.slot_id, binding.epoch, async () => { entered(); await gate; return 'claimed'; });
  await started;
  const shops = createShopManagement({ ...f, registry: { invalidate() {} }, publicOrigin: 'https://shop.test', sellerOrigin: 'https://seller.test' });
  const suspension = shops.mutate(winner, 'suspend', { expectedRevision: 1 }, 'admin');
  release();
  assert.equal(await authorized, 'claimed');
  await suspension;
  const revoked = (await policy.view(winner)).binding;
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.cleanup_pending, true);
  assert.equal(revoked.epoch, binding.epoch + 1);
  await assert.rejects(policy.withAuthorizedBinding(winner, binding.slot_id, binding.epoch, () => assert.fail()), { code: 'QR_REVOKED' });
  await shops.mutate(winner, 'resume', { expectedRevision: 2 }, 'admin');
  assert.equal((await policy.view(winner)).binding.enabled, false);
  await assert.rejects(policy.mutate(loser, true, { expectedRevision: 0 }, 'admin'), { code: 'QR_CAPACITY' });
  await assert.rejects(policy.reconcile(winner, revoked.epoch, async () => { throw new Error('DB unavailable'); }), /DB unavailable/);
  const restarted = createQrPolicy({ platform: f.platform, provisionedTenantIds: [a, b] });
  assert.equal((await restarted.view(winner)).binding.cleanup_pending, true);
  await restarted.reconcile(winner, revoked.epoch, async () => true);
  await restarted.mutate(loser, true, { expectedRevision: 0 }, 'admin');
  assert.equal((await restarted.view(loser)).binding.slot_id, 1);
  const race = await Promise.allSettled([restarted.mutate(loser, false, { expectedRevision: 1 }, 'admin'), restarted.mutate(loser, true, { expectedRevision: 1 }, 'admin')]);
  assert.equal(race.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal((await restarted.view(loser)).binding.enabled, false);
  const disabledLoser = (await restarted.view(loser)).binding;
  await restarted.reconcile(loser, disabledLoser.epoch, async () => true);
  await restarted.mutate(winner, true, { expectedRevision: 3 }, 'admin');
  assert.ok((await restarted.view(winner)).binding.epoch > revoked.epoch);
  await assert.rejects(restarted.withAuthorizedBinding(winner, binding.slot_id, binding.epoch, () => assert.fail()), { code: 'QR_REVOKED' });
});

test('runtime maintenance retains failed cleanup across restart and retires only after acknowledgement', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t);
  await upgradePlatformSchema(f.platform, { targetVersion: 3 });
  const id = await tenant(f, 'pending');
  const policy = createQrPolicy({ platform: f.platform, provisionedTenantIds: [id] });
  await policy.mutate(id, true, { expectedRevision: 0 }, 'admin');
  await policy.mutate(id, false, { expectedRevision: 1 }, 'admin');
  const store = await openDatabase(':memory:');
  t.after(() => store.close());
  const config = { integrationKeys: f.integrationKeys, platform: {
    databaseUrl: f.platformUrl, provisionerUrl: f.baseUrl, username: 'owner', password: randomUUID(),
    qrProvisionedTenantIds: [id],
  } };
  const first = createPlatformRuntime({ store, config, qrCleanupAndStop: async () => { throw new Error('Shop DB unavailable'); } });
  await first.connect();
  assert.equal((await policy.view(id)).binding.cleanup_pending, true);
  await first.close();
  let stopped = false;
  const restarted = createPlatformRuntime({ store, config, qrCleanupAndStop: async (binding) => {
    assert.equal(binding.tenant_id, id);
    return stopped;
  } });
  t.after(() => restarted.close());
  await restarted.connect();
  assert.equal((await policy.view(id)).binding.cleanup_pending, true);
  stopped = true;
  await restarted.reconcile();
  assert.equal((await policy.view(id)).binding, null);
});
