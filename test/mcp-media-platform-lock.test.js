import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { coordinatorFixture, png, stubDecode } from './helpers/mcp-media-coordinator-fixture.js';
import { createMediaCoordinator } from '../src/mcp/media-coordinator.js';
import { createOperationEngine } from '../src/mcp/operation-engine.js';
import { openPlatformDatabase } from '../src/platform/platform-db.js';
import { createPlatformRegistry } from '../src/platform/registry.js';
import { createPlatformTenantOperationGuard } from '../src/platform/tenant-operation-guard.js';

async function fixture(t, decode = stubDecode) {
  const base = process.env.SHOP_TEST_DATABASE_URL;
  assert.equal(process.env.NODE_ENV, 'test'); assert.match(new URL(base).pathname, /test/i);
  const admin = new pg.Pool({ connectionString: base }), name = 'shopping_test_media_platform_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const platform = await openPlatformDatabase(url.href), other = new pg.Client({ connectionString: url.href }); await other.connect();
  t.after(async () => { await other.end(); await platform.close(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  const tenantId = randomUUID(), now = new Date().toISOString();
  await platform.run(`INSERT INTO tenant(id,code,name,status,currency,database_name,database_role,database_password_sealed,database_key_id,created_at,updated_at)
    VALUES(?,'alpha','Synthetic media shop','ACTIVE','MYR','t_alpha_12345678','t_alpha_12345678',?,'k1',?,?)`, tenantId, Buffer.from('synthetic'), now, now);
  const guard = createPlatformTenantOperationGuard(platform);
  const f = await coordinatorFixture(t, 'postgres', { fixtureOptions: { tenantId,
    config: { basePath: '/alpha', platform: { adminHost: 'admin.example.test' } },
    registry: (store, config) => createPlatformRegistry({ store, config, platform, pool: { get: async () => store } }) }, tenantGuard: guard, decode });
  const c = createMediaCoordinator(f.options), stage = await c.begin(f.bearer, await f.input());
  const dataParts = Array.from({ length: Math.ceil(png.length / 3072) }, (_, n) => png.subarray(n * 3072, (n + 1) * 3072).toString('base64'));
  await c.append(f.bearer, { stageId: stage.stageId, offset: 0, dataParts });
  const engine = createOperationEngine({ ...f.options, adapters: { 'media.prepare_upload': c.uploadAdapter } });
  const prepare = () => engine.prepare({ bearer: f.bearer, toolName: 'media.prepare_upload', args: { stageId: stage.stageId }, idempotencyKey: 'synthetic-platform-media-seal' });
  return { ...f, platform, admin, other, name, tenantId, stage, prepare };
}
test('PostgreSQL media waiting on platform fence leaves actual v1 tenant writer available', { skip: !process.env.SHOP_TEST_DATABASE_URL }, async t => {
  const f = await fixture(t);
  for (const table of ['oauth_grant','oauth_token']) await f.store.run(`UPDATE ${table} SET scopes='catalog.read catalog.write media.write'`);
  await f.other.query('BEGIN'); await f.other.query('SELECT id FROM tenant WHERE id=$1 FOR UPDATE', [f.tenantId]);
  const preparing = f.prepare(); const outcome = preparing.then(value => ({ value }), error => ({ error }));
  let result;
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const observed = await f.admin.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id, code, status, revision FROM tenant%'", [f.name]);
      if (observed.rowCount) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(blocked, true);
    let timer;
    try {
      const read = await Promise.race([f.call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'catalog.categories', arguments: {} } }, { authorization: 'Bearer ' + f.bearer,
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Actual v1 read blocked behind media platform wait.')), 1500); })]);
      assert.equal(read.response.status, 200, JSON.stringify(read.data));
      assert.deepEqual(read.data.result.structuredContent.items, [{ code: 'SYNTHETIC', label: 'Synthetic media', active: true }]);
    } finally { clearTimeout(timer); }
  } finally { await f.other.query('COMMIT'); result = await outcome; }
  assert.ifError(result.error); assert.equal(result.value.status, 'PENDING_APPROVAL');
});
test('PostgreSQL real platform suspension and tenant writer progress while media decoder is outside both locks', { skip: !process.env.SHOP_TEST_DATABASE_URL }, async t => {
  let enter, release;
  const arrived = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  let first = true;
  const f = await fixture(t, async args => { if (first) { first = false; enter(); await held; } return stubDecode(args); });
  const outcome = f.prepare().then(value => ({ value }), error => ({ error })); await arrived;
  let timer;
  try {
    await Promise.race([Promise.all([
      f.platform.run("UPDATE tenant SET status='SUSPENDED',revision=revision+1 WHERE id=?", f.tenantId),
      f.store.transaction(() => f.store.get('SELECT id FROM product WHERE id=?', f.product.id)),
    ]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Decoder retained platform or tenant writer lock.')), 1500); })]);
  } finally { clearTimeout(timer); release(); }
  const result = await outcome;
  assert.equal(result.error?.status, 503); assert.equal(result.error?.code, 'SHOP_UNAVAILABLE');
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_pin')).n, 0);
  assert.equal((await f.platform.get('SELECT status FROM tenant WHERE id=?', f.tenantId)).status, 'SUSPENDED');
});
