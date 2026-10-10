import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopManagement } from '../src/platform/shops.js';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';
import { authenticate, createSession } from '../src/auth.js';

test('shop create concurrency, CAS actions, aliases, deletion and one-time seller reset', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t); let invalidations = 0;
  const shops = createShopManagement({ ...f, registry: { invalidate: () => invalidations++ }, publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test' });
  const input = { code: 'alpha', name: 'Fictional Alpha', currency: 'MYR', sellerUsername: 'alpha.owner' };
  const both = await Promise.allSettled([shops.create(input, 'owner'), shops.create(input, 'owner')]);
  assert.equal(both.filter((x) => x.status === 'fulfilled').length, 1);
  const made = both.find((x) => x.status === 'fulfilled').value;
  assert.match(made.shopUrl, /\/alpha\/$/); assert.match(made.sellerUrl, /\/alpha\/$/);
  let tenant = made.tenant; const row = await f.platform.get('SELECT * FROM tenant WHERE id = ?', tenant.id);
  const store = await f.pool.get(row), account = await authenticate(store, input.sellerUsername, made.sellerPassword);
  assert.equal(account.role, 'OWNER'); assert.equal(account.mustChangePassword, true);
  const sellerSession = await createSession(store, account.id);
  assert.ok(!JSON.stringify(await shops.list()).includes(made.sellerPassword)); assert.ok(!JSON.stringify(await shops.detail(tenant.id)).includes('sealed'));
  const races = await Promise.allSettled([shops.mutate(tenant.id, 'suspend', { expectedRevision: tenant.revision }, 'owner'), shops.mutate(tenant.id, 'suspend', { expectedRevision: tenant.revision }, 'owner')]);
  assert.equal(races.filter((x) => x.status === 'fulfilled').length, 1); tenant = races.find((x) => x.status === 'fulfilled').value.tenant;
  await assert.rejects(shops.mutate(tenant.id, 'request-deletion', { expectedRevision: tenant.revision, code: 'wrong' }, 'owner'), /exactly/);
  tenant = (await shops.mutate(tenant.id, 'request-deletion', { expectedRevision: tenant.revision, code: tenant.code }, 'owner')).tenant;
  assert.equal(tenant.status, 'DELETING'); assert.ok(Date.parse(tenant.deleteAfter) > Date.now() + 29 * 24 * 60 * 60_000);
  tenant = (await shops.mutate(tenant.id, 'cancel-deletion', { expectedRevision: tenant.revision }, 'owner')).tenant; assert.equal(tenant.status, 'SUSPENDED');
  tenant = (await shops.mutate(tenant.id, 'rename', { expectedRevision: tenant.revision, code: 'renamed', name: 'Fictional Renamed' }, 'owner')).tenant;
  assert.equal((await f.platform.get("SELECT tenant_id FROM tenant_code_alias WHERE code='alpha'")).tenant_id, tenant.id);
  await assert.rejects(shops.create(input, 'owner'), /already used/);
  const reset = await shops.mutate(tenant.id, 'reset-seller-password', { expectedRevision: tenant.revision }, 'owner');
  assert.ok(reset.sellerPassword); assert.equal(await authenticate(store, input.sellerUsername, made.sellerPassword), null);
  assert.equal((await authenticate(store, input.sellerUsername, reset.sellerPassword)).mustChangePassword, true);
  assert.equal((await store.get('SELECT COUNT(*) AS n FROM session WHERE token_hash = ?', (await import('node:crypto')).createHash('sha256').update(sellerSession.token).digest('hex'))).n, 0);
  tenant = (await shops.mutate(tenant.id, 'resume', { expectedRevision: reset.tenant.revision }, 'owner')).tenant; assert.equal(tenant.status, 'ACTIVE');
  const audit = await shops.audit(new URLSearchParams('limit=3')); assert.equal(audit.items.length, 3); assert.ok(audit.nextCursor);
  const next = await shops.audit(new URLSearchParams({ limit: '3', cursor: audit.nextCursor })); assert.ok(next.items.every((x) => !audit.items.some((a) => a.id === x.id)));
  const text = JSON.stringify(await f.platform.all('SELECT * FROM platform_audit'));
  assert.ok(!text.includes(reset.sellerPassword)); assert.ok(!text.includes(made.sellerPassword)); assert.ok(invalidations >= 7);
});

test('default shop cannot be changed and all statuses count toward the host limit', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), stamp = new Date().toISOString();
  const shops = createShopManagement({ ...f, registry: { invalidate() {} }, publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test' });
  const id = '00000000-0000-4000-8000-000000000000';
  await f.platform.run("INSERT INTO tenant(id,code,name,status,currency,is_default,created_at,updated_at) VALUES (?,'default','Current','ACTIVE','MYR',1,?,?)", id, stamp, stamp);
  await assert.rejects(shops.mutate(id, 'suspend', { expectedRevision: 0 }, 'owner'), /host/);
  // Limit fixture rows hold sealed synthetic credentials but create no databases.
  for (let i = 0; i < 19; i++) {
    const fixtureId = `capacity-${i}`, database = `t_fixture${i}_12345678`, sealed = f.secretBox.seal('fictional', `TENANT_DB:${fixtureId}`);
    await f.platform.run(`INSERT INTO tenant(id,code,name,status,currency,database_name,database_role,database_password_sealed,database_key_id,created_at,updated_at)
      VALUES (?,?,?,'FAILED','MYR',?,?,?,?,?,?)`, fixtureId, `fixture${i}`, 'Fictional', database, database, sealed.sealed, sealed.keyId, stamp, stamp);
  }
  const error = await shops.create({ code: 'overflow', name: 'Fictional', currency: 'MYR', sellerUsername: 'new.owner' }, 'owner').catch((e) => e);
  assert.equal(error.code, 'TENANT_LIMIT'); assert.equal((await f.platform.get('SELECT COUNT(*) AS n FROM tenant')).n, 20);
});
