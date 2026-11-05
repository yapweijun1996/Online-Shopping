import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaHooksFixture } from './helpers/mcp-media-hooks-fixture.js';
import { seedSyntheticMediaApproval } from './helpers/mcp-media-engine-fixture.js';
import { withMediaWriter } from '../src/mcp/media-storage.js';
import { updateProduct } from '../src/products.js';
import { createOperationReview, createOperationApproval } from '../src/mcp/operation-approval.js';
import { maintainOperations } from '../src/mcp/operation-maintenance.js';

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: internal media engine binds and commits one reviewed immutable resource atomically`, async t => {
    const f = await mediaHooksFixture(t, dialect), stage = await f.startStage(), operation = await f.prepare(stage);
    const row = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?', operation.operationId);
    assert.equal(row.media_policy_id, 'media-upload-v1'); assert.equal(row.risk, 'HIGH');
    assert.equal(row.correlation_id, stage.correlationId);
    assert.equal((await withMediaWriter(f.store, f.context, w => w.inspect(stage.stageId))).state, 'BOUND');
    await assert.rejects(f.commit(operation), { status: 403 });
    await seedSyntheticMediaApproval(f, operation);
    const results = await Promise.all([f.commit(operation), f.commit(operation)]);
    assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
    assert.equal(f.counters.apply, 1); assert.equal(f.counters.consume, 1);
    assert.deepEqual(Object.keys(results[0].result).sort(), ['id', 'revision']);
    assert.equal((await f.store.get('SELECT image_mime FROM product WHERE id=?', f.productId)).image_mime, 'image/png');
    assert.equal((await withMediaWriter(f.store, f.context, w => w.inspect(stage.stageId))).state, 'CONSUMED');
    assert.equal(Number((await f.store.get("SELECT COUNT(*) n FROM product_event WHERE product_id=? AND action='UPDATED'", f.productId)).n), 1);
    const before = { ...f.counters };
    assert.equal((await f.prepare(stage)).replayed, true);
    assert.deepEqual(f.counters, before);
  });
  test(`${dialect}: bearer arguments and ordinary human routes cannot create media approval`, async t => {
    const f = await mediaHooksFixture(t, dialect), stage = await f.startStage();
    for (const field of ['approved', 'mediaReviewed', 'requiredScopes', 'mediaPolicyId']) await assert.rejects(f.engine.prepare({
      bearer: f.bearer, toolName: 'media.prepare_upload', args: { stageId: stage.stageId, [field]: true }, idempotencyKey: 'synthetic-forged-media-0001' }), { status: 400 });
    assert.equal(f.counters.capture, 0);
    const operation = await f.prepare(stage), options = { ...f.options, sellerOrigin: f.binding.issuer };
    const request = new Request(f.binding.issuer + '/api/v1/seller/mcp/operations/' + operation.operationId,
      { headers: { cookie: `seller_session=${f.session.token}` } });
    await assert.rejects(createOperationReview(options)(request, operation.operationId), { status: 403 });
    const post = new Request(f.binding.issuer + '/api/v1/seller/mcp/approval', { method: 'POST',
      headers: { origin: f.binding.issuer, cookie: `seller_session=${f.session.token}`, 'x-csrf-token': f.session.csrfToken } });
    await assert.rejects(createOperationApproval(options)(post, { operationId: operation.operationId, previewHash: operation.previewHash,
      decision: 'approve', password: 'Synthetic-media-engine-password-2026!', challenge: 'synthetic-forged-challenge' }, 'synthetic'), { status: 403 });
    assert.equal(await f.store.get('SELECT * FROM mcp_v2_approval WHERE operation_id=?', operation.operationId), undefined);
  });
  test(`${dialect}: final fence rejects a portal revision or revoked consent during lock-free resolution`, async t => {
    const f = await mediaHooksFixture(t, dialect), stage = await f.startStage();
    const engine = f.makeEngine({ media: { ...f.adapter.media, resolve: async (...args) => {
      const result = await f.adapter.media.resolve(...args);
      await updateProduct(f.store, f.productId, { name: 'Concurrent synthetic portal edit' }); return result;
    } } });
    await assert.rejects(f.prepare(stage, 'synthetic-stale-media-0001', engine), { status: 409, code: 'STALE_REVISION' });
    assert.equal(Number((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_operation')).n), 0);
    const second = await f.startStage('synthetic-media-stage-0002');
    const revoked = f.makeEngine({ media: { ...f.adapter.media, resolve: async (...args) => {
      const result = await f.adapter.media.resolve(...args);
      await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.context.grantId); return result;
    } } });
    await assert.rejects(f.prepare(second, 'synthetic-revoked-media-0001', revoked), { status: 403 });
    assert.equal(f.counters.apply, 0);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_operation')).n), 0);
  });
  test(`${dialect}: incomplete or mismatched media evidence and retained metadata never authorize apply`, async t => {
    const f = await mediaHooksFixture(t, dialect), operation = await f.prepare(await f.startStage());
    await seedSyntheticMediaApproval(f, operation);
    const corruptions = [
      "DELETE FROM mcp_v2_media_approval_evidence WHERE operation_id=?",
      "DELETE FROM mcp_v2_media_delivery WHERE operation_id=? AND kind='ASSET'",
      "UPDATE mcp_v2_media_delivery SET ack_at=NULL WHERE operation_id=?",
      "UPDATE mcp_v2_media_delivery SET expected_hash='" + 'e'.repeat(64) + "' WHERE operation_id=?",
      "UPDATE mcp_v2_media_approval_evidence SET descriptor_hash='" + 'e'.repeat(64) + "' WHERE operation_id=?",
      "UPDATE mcp_v2_media_approval_evidence SET epoch_hash='" + 'e'.repeat(64) + "' WHERE operation_id=?",
      "UPDATE mcp_v2_approval_challenge SET account_auth_version=account_auth_version+1 WHERE operation_id=?",
      "DELETE FROM mcp_v2_event WHERE operation_id=? AND event='APPROVE'",
      "UPDATE mcp_v2_operation_media_policy SET codec_digest='" + 'e'.repeat(64) + "' WHERE operation_id=?",
      "UPDATE mcp_v2_media_manifest_page SET page_hash='" + 'e'.repeat(64) + "' WHERE operation_id=?",
    ];
    for (const sql of corruptions) {
      const rollback = new Error('Synthetic rollback');
      await assert.rejects(f.store.transaction(async () => {
        await f.store.run(sql, operation.operationId); await assert.rejects(f.commit(operation)); throw rollback;
      }), error => error === rollback);
      assert.equal(f.counters.apply, 0);
      assert.equal((await f.store.get('SELECT image_data FROM product WHERE id=?', f.productId)).image_data, null);
    }
    assert.equal((await f.commit(operation)).status, 'COMMITTED');
  });
  test(`${dialect}: audit failure after business apply rolls back image, history and stage consumption`, async t => {
    const f = await mediaHooksFixture(t, dialect), stage = await f.startStage(), operation = await f.prepare(stage);
    await seedSyntheticMediaApproval(f, operation);
    const run = f.store.run;
    f.store.run = (sql, ...args) => {
      if (/INSERT INTO mcp_v2_event/.test(sql) && args.includes('COMMIT')) throw new Error('Synthetic commit audit failure');
      return run(sql, ...args);
    };
    await assert.rejects(f.commit(operation), /Synthetic commit audit failure/); f.store.run = run;
    assert.equal((await f.store.get('SELECT image_data FROM product WHERE id=?', f.productId)).image_data, null);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) n FROM product_event WHERE product_id=?', f.productId)).n), 0);
    assert.equal((await withMediaWriter(f.store, f.context, w => w.inspect(stage.stageId))).state, 'BOUND');
    assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval WHERE operation_id=?', operation.operationId)).consumed_at, null);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', operation.operationId)).state, 'FAILED');
  });
  test(`${dialect}: redacted media replay needs retained policy and live grant but no source, frame or codec`, async t => {
    const f = await mediaHooksFixture(t, dialect), stage = await f.startStage(), operation = await f.prepare(stage);
    await seedSyntheticMediaApproval(f, operation); const first = await f.commit(operation);
    const before = { ...f.counters };
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(operation.expiresAt) + 1 });
    const maintain = () => maintainOperations(f.store, { enabled: true, tenantGuard: f.options.tenantGuard, tenantId: f.context.tenantId });
    await maintain(); await maintain();
    assert.equal((await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id=?', operation.operationId)).envelope_json, null);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_media_manifest_page WHERE operation_id=?', operation.operationId)).n), 0);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_media_pin WHERE operation_id=?', operation.operationId)).n), 0);
    assert.ok(await f.store.get('SELECT * FROM mcp_v2_operation_media_policy WHERE operation_id=?', operation.operationId));
    assert.deepEqual((await f.commit(operation)).result, first.result);
    assert.equal((await f.prepare(stage)).replayed, true); assert.deepEqual(f.counters, before);
    await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.context.grantId);
    await assert.rejects(f.commit(operation), { status: 403 });
    t.mock.timers.setTime(Date.parse(f.context.grantExpiresAt) + 1);
    await assert.rejects(f.commit(operation), { status: 403 });
    t.mock.timers.setTime(Date.parse(f.context.grantExpiresAt) + 90 * 86400000 + 1);
    await maintain(); await maintain();
    assert.equal(await f.store.get('SELECT id FROM mcp_v2_operation WHERE id=?', operation.operationId), undefined);
    await assert.rejects(f.prepare(stage), { status: 403 }); assert.equal(f.counters.apply, 1);
  });
  test(`${dialect}: bounded resolution deadline aborts before any operation is persisted`, async t => {
    const f = await mediaHooksFixture(t, dialect), stage = await f.startStage();
    let entered, signal;
    const started = new Promise(resolve => { entered = resolve; });
    const engine = f.makeEngine({ media: { ...f.adapter.media, resolve: (_resources, options) => {
      signal = options.signal; entered(); return new Promise(() => {});
    } } });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const preparing = f.prepare(stage, 'synthetic-deadline-media-0001', engine);
    const rejected = assert.rejects(preparing, { status: 503, code: 'MEDIA_DEADLINE' });
    await started; t.mock.timers.tick(30000); await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_operation')).n), 0);
  });
  test(`${dialect}: proposal time starts after resolution and consume is mandatory`, async t => {
    const f = await mediaHooksFixture(t, dialect), stage = await f.startStage();
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const engine = f.makeEngine({ media: { ...f.adapter.media, resolve: async (...args) => {
      const result = await f.adapter.media.resolve(...args); t.mock.timers.tick(20000); return result;
    }, consumeResources: async () => {} } });
    const operation = await f.prepare(stage, 'synthetic-created-media-0001', engine);
    const row = await f.store.get('SELECT created_at,expires_at FROM mcp_v2_operation WHERE id=?', operation.operationId);
    assert.equal(row.created_at, new Date().toISOString()); assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 600000);
    await seedSyntheticMediaApproval(f, operation);
    await assert.rejects(f.commit(operation, engine), { status: 403 });
    assert.equal((await f.store.get('SELECT image_data FROM product WHERE id=?', f.productId)).image_data, null);
    assert.equal((await withMediaWriter(f.store, f.context, w => w.inspect(stage.stageId))).state, 'BOUND');
  });
  test(`${dialect}: closed server hook contract and private packets reject authority substitution`, async t => {
    const f = await mediaHooksFixture(t, dialect);
    assert.throws(() => f.makeEngine({ resourceType: 'tenant' }), /Invalid trusted media hooks/);
    assert.throws(() => f.makeEngine({ media: { ...f.adapter.media, approved: true } }), /Invalid trusted media hooks/);
    assert.throws(() => f.makeEngine({ media: { ...f.adapter.media, policyId: 'catalog-media-v1' } }), /Invalid trusted media hooks/);
    const stage = await f.startStage();
    const engine = f.makeEngine({ media: { ...f.adapter.media, capture: async (...args) => ({
      ...await f.adapter.media.capture(...args), resources: { reader: args[0] } }) } });
    await assert.rejects(f.prepare(stage, 'synthetic-private-media-0001', engine), /Invalid private media packet/);
    assert.equal((await withMediaWriter(f.store, f.context, w => w.inspect(stage.stageId))).state, 'UPLOADING');
    assert.equal(f.counters.resolve, 0);
  });
  test(`${dialect}: stage byte corruption and approval identity substitution fail before apply`, async t => {
    const f = await mediaHooksFixture(t, dialect), stage = await f.startStage(), operation = await f.prepare(stage);
    await seedSyntheticMediaApproval(f, operation);
    const edits = [
      ["UPDATE mcp_v2_media_stage SET canonical_sha256=? WHERE id=?", 'f'.repeat(64), stage.stageId],
      ["UPDATE mcp_v2_media_stage SET correlation_id=? WHERE id=?", '11111111-1111-1111-1111-111111111111', stage.stageId],
      ["UPDATE mcp_v2_media_approval_evidence SET session_hash=? WHERE operation_id=?", 'f'.repeat(64), operation.operationId],
      ["UPDATE mcp_v2_media_approval_evidence SET tenant_revision=? WHERE operation_id=?", f.context.tenantRevision + 1, operation.operationId],
    ];
    for (const [sql, ...args] of edits) {
      const rollback = new Error('Synthetic rollback');
      await assert.rejects(f.store.transaction(async () => {
        await f.store.run(sql, ...args); await assert.rejects(f.commit(operation)); throw rollback;
      }), error => error === rollback);
      assert.equal(f.counters.apply, 0);
    }
  });
  test(`${dialect}: final prepare authority check rolls back atomic policy, frame and pin installation`, async t => {
    const f = await mediaHooksFixture(t, dialect), stage = await f.startStage();
    const engine = f.makeEngine({ media: { ...f.adapter.media, persistResources: async (...args) => {
      await f.adapter.media.persistResources(...args);
      await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.context.grantId);
    } } });
    await assert.rejects(f.prepare(stage, 'synthetic-final-auth-media-0001', engine), { status: 403 });
    for (const table of ['mcp_v2_operation', 'mcp_v2_operation_media_policy', 'mcp_v2_media_pin', 'mcp_v2_media_manifest_page', 'mcp_v2_media_asset_ref']) {
      assert.equal(Number((await f.store.get(`SELECT COUNT(*) n FROM ${table}`)).n), 0);
    }
    assert.equal((await withMediaWriter(f.store, f.context, w => w.inspect(stage.stageId))).state, 'VALIDATING');
    assert.ok(await f.store.get("SELECT * FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.context.grantId));
  });
}
