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
import { createApi } from '../src/app.js';
import { createWhatsAppQrServer } from '../src/server.js';
import { ensureAdmin, createSession } from '../src/auth.js';

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
  assert.equal((await policy.view(defaultId)).occupiedTenantSlots, 1, 'default reservation does not consume tenant capacity');
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
  assert.equal((await policy.view(winner)).occupiedTenantSlots, 1, 'pending cleanup retains capacity');
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
  const shops = createShopManagement({ ...f, registry: { invalidate() {} }, publicOrigin: 'https://shop.test', sellerOrigin: 'https://seller.test' });
  const made = await shops.create({ code: 'pending', name: 'Fictional Pending', currency: 'MYR', sellerUsername: 'pending.owner' }, 'admin');
  const id = made.tenant.id;
  const shop = await f.pool.get(await f.platform.get('SELECT * FROM tenant WHERE id = ?', id));
  await shop.run("UPDATE whatsapp_qr_session SET desired = 'RUN', state = 'CONNECTED', generation = 4 WHERE id = 1");
  const policy = createQrPolicy({ platform: f.platform, provisionedTenantIds: [id] });
  await policy.mutate(id, true, { expectedRevision: made.tenant.revision }, 'admin');
  await policy.mutate(id, false, { expectedRevision: made.tenant.revision + 1 }, 'admin');
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
  const cleaned = await shop.get('SELECT * FROM whatsapp_qr_session WHERE id = 1');
  assert.equal(cleaned.desired, 'OFF');
  assert.ok(cleaned.generation > 4);
  assert.equal(cleaned.state, 'IDLE');
  stopped = true;
  await restarted.reconcile();
  assert.equal((await policy.view(id)).binding, null);
});

test('static tenant HTTP broker and prefixed seller complete synthetic dispatch and revoke cleanup', { skip: !platformTestUrl }, async t => {
  const f = await platformFixture(t);
  await upgradePlatformSchema(f.platform, { targetVersion: 3 });
  const shops = createShopManagement({ ...f, registry: { invalidate() {} }, publicOrigin: 'https://shop.test', sellerOrigin: 'https://seller.test' });
  const made = await shops.create({ code: 'broker', name: 'Fictional Broker', currency: 'MYR', sellerUsername: 'broker.owner' }, 'admin');
  const id = made.tenant.id, tenantStore = await f.pool.get(await f.platform.get('SELECT * FROM tenant WHERE id = ?', id));
  const store = await openDatabase(':memory:');
  await ensureAdmin(store, 'default.owner', 'Fictional-Password-2026!');
  t.after(() => store.close());
  const bindings = [{ slot: 0, shopId: 'default', token: randomUUID().replaceAll('-', '').repeat(2) },
    { slot: 1, shopId: id, token: randomUUID().replaceAll('-', '').repeat(2) }];
  const config = { publicOrigin: 'https://shop.test', sellerOrigin: 'https://seller.test', integrationKeys: f.integrationKeys,
    whatsappQr: { enabled: true, bindings }, platform: { adminHost: 'admin.test', databaseUrl: f.platformUrl, provisionerUrl: f.baseUrl,
      username: 'owner', password: randomUUID(), qrProvisionedTenantIds: [id], qrTenantSlots: 1 } };
  const runtime = createPlatformRuntime({ store, config });
  t.after(() => runtime.close());
  await runtime.connect();
  const policy = await runtime.qrPolicy();
  await policy.mutate(id, true, { expectedRevision: made.tenant.revision }, 'admin');
  const api = await createApi({ store, config, registry: runtime.registry });
  const server = createWhatsAppQrServer({ store, config, registry: runtime.registry });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const workerId = randomUUID();
  const client = binding => {
    let epoch;
    return async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/internal/whatsapp-qr/v1/${route}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${binding.token}`, 'x-worker-id': workerId,
          'content-type': 'application/json', ...(epoch ? { 'x-binding-epoch': epoch } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      epoch = response.headers.get('x-binding-epoch') || epoch;
      return { status: response.status, data: response.status === 204 ? null : await response.json() };
    };
  };
  const defaultWorker = client(bindings[0]), tenantWorker = client(bindings[1]);
  for (const [shop, prefix, worker] of [[store, '', defaultWorker], [tenantStore, '/broker', tenantWorker]]) {
    await shop.run('UPDATE seller_account SET must_change_password = 0');
    const account = await shop.get('SELECT id FROM seller_account LIMIT 1'), session = await createSession(shop, account.id);
    const seller = async (route, body) => {
      const response = await api(new Request(`https://seller.test${prefix}/api/v1/seller/${route}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { cookie: `seller_session=${session.token}`, origin: config.sellerOrigin,
          'x-csrf-token': session.csrfToken, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
      assert.ok(response.status < 300, `${route}: ${response.status} ${await response.clone().text()}`);
      return response.json();
    };
    await seller('integrations/whatsapp-qr/acknowledge', { noticeVersion: 1 });
    await seller('integrations/whatsapp-qr/pair', {});
    const generation = (await worker('control')).data.generation;
    assert.equal((await worker('state', { generation, state: 'CONNECTED' })).status, 204);
    assert.equal((await worker('inbound', { generation, messages: [{ id: 'synthetic-inbound', peer: '60123456789@s.whatsapp.net',
      name: 'Fictional Buyer', at: new Date().toISOString(), text: 'Synthetic inbound' }] })).status, 200);
    const thread = (await seller('chats'))[0];
    await seller(`chats/${thread.id}/replies`, { text: 'Synthetic human reply' });
    const claim = await worker('replies/claim', { generation });
    assert.equal(claim.status, 200);
    assert.equal((await worker(`replies/${claim.data.reply.id}/result`, { generation, status: 'SENT', providerMessageId: 'synthetic-sent' })).status, 204);
    assert.equal((await shop.get('SELECT status FROM message_thread_message WHERE id = ?', claim.data.reply.id)).status, 'SENT');
    await seller('integrations/whatsapp-qr/disconnect', {});
    assert.equal((await worker('state', { generation, state: 'CONNECTED' })).data.error, 'STALE_GENERATION');
  }
  const before = await policy.view(id);
  await assert.rejects(runtime.registry.resolveWorkerTenant(id, 1, before.binding.epoch + 1, () => assert.fail()), { code: 'QR_REVOKED' });
  const renamed = await shops.mutate(id, 'rename', { expectedRevision: made.tenant.revision + 1, code: 'renamedbroker', name: 'Fictional Renamed' }, 'admin');
  assert.equal((await tenantWorker('control')).status, 200);
  const thread = await tenantStore.get('SELECT id FROM message_thread LIMIT 1');
  const queued = randomUUID(), sending = randomUUID(), at = new Date().toISOString();
  for (const [messageId, status] of [[queued, 'QUEUED'], [sending, 'SENDING']]) {
    await tenantStore.run("INSERT INTO message_thread_message(id,thread_id,direction,body,status,generation,created_at,updated_at) VALUES (?,?,'OUT','Synthetic pending',?,1,?,?)", messageId, thread.id, status, at, at);
  }
  const suspended = await shops.mutate(id, 'suspend', { expectedRevision: renamed.tenant.revision }, 'admin');
  assert.equal((await tenantWorker('control')).data.error, 'QR_REVOKED');
  await shops.mutate(id, 'request-deletion', { expectedRevision: suspended.tenant.revision, code: 'renamedbroker' }, 'admin');
  assert.equal((await tenantWorker('control')).data.error, 'QR_REVOKED');
  assert.equal((await tenantWorker('stopped', {})).status, 200);
  await runtime.reconcile();
  assert.equal((await policy.view(id)).binding, null);
  assert.equal((await tenantStore.get('SELECT status FROM message_thread_message WHERE id = ?', queued)).status, 'CANCELLED');
  assert.equal((await tenantStore.get('SELECT status FROM message_thread_message WHERE id = ?', sending)).status, 'RECONCILE');
  assert.equal((await defaultWorker('control')).status, 200);
});
