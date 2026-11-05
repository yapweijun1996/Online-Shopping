import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinatorFixture, png, stubDecode } from './helpers/mcp-media-coordinator-fixture.js';
import { createMediaCoordinator } from '../src/mcp/media-coordinator.js';
import { createOperationEngine } from '../src/mcp/operation-engine.js';
import { verifyMediaAuthority } from '../src/mcp/operation-authorization.js';
import { readMediaFrame } from '../src/mcp/media-frame-storage.js';
import { maintainMedia } from '../src/mcp/media-maintenance.js';
import { hash } from '../src/mcp/credentials.js';
import { reviewPassword } from './helpers/mcp-review-fixture.js';
import { readMediaSnapshot } from '../src/mcp/media-resources.js';
import { updateProduct, getProduct } from '../src/products.js';

const source = Buffer.concat([png, Buffer.from('synthetic new pixels packet fixture')]);
const parts = bytes => Array.from({ length: Math.ceil(bytes.length / 3072) }, (_, n) => bytes.subarray(n * 3072, (n + 1) * 3072).toString('base64'));
async function upload(f, c, slot = 'MAIN') {
  const stage = await c.begin(f.bearer, await f.input(source, { targetSlot: slot }));
  for (let offset = 0; offset < source.length; offset += 36864) await c.append(f.bearer, { stageId: stage.stageId, offset,
    dataParts: parts(source.subarray(offset, offset + 36864)) });
  return stage;
}
const engineFor = (f, c) => createOperationEngine({ ...f.options, adapters: { 'media.prepare_upload': c.uploadAdapter } });
const prepare = (f, engine, stage) => engine.prepare({ bearer: f.bearer, toolName: 'media.prepare_upload',
  args: { stageId: stage.stageId }, idempotencyKey: 'synthetic-coordinator-seal-0001' });
async function context(f) {
  return f.guard.withActiveTenant(f.binding.tenantId, tenant => f.store.transaction(() => verifyMediaAuthority(f.store,
    { bearer: f.bearer, binding: f.binding, epochHash: f.epochHash, buildDigest: f.options.buildDigest, tenantRevision: tenant.revision })));
}
async function syntheticApproval(f, operation) {
  // Internal synthetic reviewed-evidence fixture only. This is NOT actual human/UI approval.
  const { seedSyntheticMediaApproval } = await import('./helpers/mcp-media-engine-fixture.js');
  const sessionHash = hash(f.cookie.slice(f.cookie.indexOf('=') + 1));
  await seedSyntheticMediaApproval({ store: f.store, context: await context(f), sessionHash }, operation);
}
for (const dialect of ['sqlite','postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: actual upload engine seals after lock-free decode and HTTP approval stays unavailable`, options, async t => {
    const f = await coordinatorFixture(t, dialect); let decodes = 0;
    const c = createMediaCoordinator({ ...f.options, decode: async input => {
      assert.equal(f.depth(), 0); decodes++;
      await f.store.transaction(() => f.store.get('SELECT id FROM product WHERE id=?', f.product.id));
      return stubDecode(input);
    } }), engine = engineFor(f, c), stage = await upload(f, c);
    const operation = await prepare(f, engine, stage);
    assert.equal(operation.status, 'PENDING_APPROVAL'); assert.equal(decodes, 2);
    assert.equal((await prepare(f, engine, stage)).operationId, operation.operationId); assert.equal(decodes, 2);
    const manifest = await readMediaFrame(f.store, await context(f), operation.operationId);
    assert.equal(manifest.stages.length, 1); assert.equal(manifest.stages[0].stage_id, stage.stageId);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_media_stage WHERE id=?', stage.stageId)).state, 'BOUND');
    const path = '/api/v1/seller/mcp/operations/' + operation.operationId;
    assert.equal((await f.call(path, 'GET', undefined, f.headers)).response.status, 403);
    assert.equal((await f.call(path + '/approval', 'POST', { operationId: operation.operationId, previewHash: operation.previewHash,
      decision: 'approve', password: reviewPassword, challenge: 'A'.repeat(43) }, f.headers)).response.status, 403);
    await assert.rejects(engine.commit({ bearer: f.bearer, toolName: 'media.commit_upload', operationId: operation.operationId }), { status: 403 });
    assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?', f.product.id)).stock_quantity, 7);
  });
  test(`${dialect}: SYNTHETIC reviewed evidence permits real gallery service once and receipt replay after byte cleanup`, options, async t => {
    const f = await coordinatorFixture(t, dialect), c = f.coordinator, engine = engineFor(f, c), stage = await upload(f, c, 'GALLERY');
    const operation = await prepare(f, engine, stage); await syntheticApproval(f, operation);
    const commit = () => engine.commit({ bearer: f.bearer, toolName: 'media.commit_upload', operationId: operation.operationId });
    const committed = await Promise.all([commit(), commit()]);
    assert.deepEqual(committed.map(value => value.replayed).sort(), [false,true]);
    assert.deepEqual(Object.keys(committed[0].result).sort(), ['listingId','productId','revision']);
    const product = await getProduct(f.store, f.product.id, true); assert.equal(product.images.length, 2);
    assert.equal(product.stockQuantity, 7); assert.equal(product.priceMinor, 100);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM product_event WHERE product_id=? AND action='UPDATED'", f.product.id)).n, 1);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id=? AND event='COMMIT'", operation.operationId)).n, 1);
    const row = await f.store.get('SELECT * FROM mcp_v2_media_stage WHERE id=?', stage.stageId);
    assert.equal(row.state, 'CONSUMED'); assert.equal(row.canonical_data, null); assert.equal(row.thumbnail_data, null);
    const op = await f.store.get('SELECT expires_at,result_json FROM mcp_v2_operation WHERE id=?', operation.operationId);
    await maintainMedia(f.store, { enabled: true, tenantGuard: f.guard, tenantId: f.binding.tenantId,
      now: new Date(Date.parse(op.expires_at) + 1).toISOString() });
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_chunk WHERE stage_id=?', stage.stageId)).n, 0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_pin WHERE stage_id=?', stage.stageId)).n, 0);
    assert.deepEqual((await commit()).result, JSON.parse(op.result_json));
  });
  test(`${dialect}: SYNTHETIC reviewed commit audit failure rolls back actual service history and consume`, options, async t => {
    const f = await coordinatorFixture(t, dialect), c = f.coordinator, engine = engineFor(f, c), stage = await upload(f, c, 'GALLERY');
    const operation = await prepare(f, engine, stage); await syntheticApproval(f, operation);
    const original = f.store.run;
    f.store.run = (sql, ...args) => {
      if (sql.startsWith('INSERT INTO mcp_v2_event') && args.includes('COMMIT')) throw new Error('Synthetic final commit audit failure');
      return original(sql, ...args);
    };
    try { await assert.rejects(engine.commit({ bearer: f.bearer, toolName: 'media.commit_upload', operationId: operation.operationId }), /Synthetic final commit audit failure/); }
    finally { f.store.run = original; }
    assert.equal((await getProduct(f.store, f.product.id, true)).images.length, 1);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event WHERE product_id=?', f.product.id)).n, 0);
    const row = await f.store.get('SELECT state,canonical_data FROM mcp_v2_media_stage WHERE id=?', stage.stageId);
    assert.equal(row.state, 'BOUND'); assert.ok(row.canonical_data.byteLength > 0);
    assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?', operation.operationId)).consumed_at, null);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', operation.operationId)).state, 'FAILED');
  });
  test(`${dialect}: revocation, suspension and concurrent portal edits during decode cannot seal`, options, async t => {
    for (const change of ['revoke','suspend','portal','discard','demo']) {
      const f = await coordinatorFixture(t, dialect); let entered, release;
      const arrived = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
      let first = true;
      const c = createMediaCoordinator({ ...f.options, decode: async input => {
        assert.equal(f.depth(), 0);
        if (first) { first = false; entered(); await held; }
        return stubDecode(input);
      } }), engine = engineFor(f, c), stage = await upload(f, c);
      const pending = prepare(f, engine, stage);
      // Install rejection handling before deliberately invalidating the in-flight work.
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      await arrived;
      if (change === 'revoke') await f.store.run('UPDATE oauth_grant SET revoked_at=? WHERE id=?', new Date().toISOString(), f.grantId);
      if (change === 'suspend') f.suspend();
      if (change === 'portal') await updateProduct(f.store, f.product.id, { name: 'Concurrent portal update' });
      if (change === 'discard') await c.discard(f.bearer, { stageId: stage.stageId });
      if (change === 'demo') await f.store.run("UPDATE shop_setup SET mode='demo' WHERE id=1");
      release(); const result = await outcome;
      assert.ok(result.error, change);
      assert.equal(result.error.status, change === 'suspend' ? 503 : change === 'portal' ? 409 : 403, change);
      if (change !== 'suspend') assert.equal(result.error.code, change === 'portal' ? 'MEDIA_RESOURCE_CHANGED' : 'FORBIDDEN', change);
      assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0, change);
      assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_pin')).n, 0, change);
      assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM product_event WHERE product_id=?', f.product.id)).n, 0, change);
      assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?', f.product.id)).stock_quantity, 7);
    }
  });
}
