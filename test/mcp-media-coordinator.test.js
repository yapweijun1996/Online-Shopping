import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { coordinatorFixture, png } from './helpers/mcp-media-coordinator-fixture.js';
import { createMediaCoordinator, decodeMediaParts } from '../src/mcp/media-coordinator.js';
import { readMediaSnapshot } from '../src/mcp/media-resources.js';
import { updateProduct } from '../src/products.js';
import { MEDIA_LIMITS } from '../src/mcp/media-schema.js';

const parts = bytes => Array.from({ length: Math.ceil(bytes.length / 3072) }, (_, n) => bytes.subarray(n * 3072, (n + 1) * 3072).toString('base64'));
test('media chunks retain canonical base64, string4096 and36KiB total limits', () => {
  const bytes = Buffer.alloc(36864, 7);
  assert.deepEqual(decodeMediaParts(parts(bytes)), bytes);
  const bad = [[], Array(13).fill('AAAA'), ['A'], ['AAAA\n'], ['AB=='], ['AAAA='], ['-___'], [''], ['A'.repeat(4100)], [undefined]];
  for (const input of bad) assert.throws(() => decodeMediaParts(input), { code: 'MEDIA_INPUT' });
  let touched = false; const accessor = []; Object.defineProperty(accessor, 0, { get() { touched = true; return 'AAAA'; }, enumerable: true });
  assert.throws(() => decodeMediaParts(accessor), { code: 'MEDIA_INPUT' }); assert.equal(touched, false);
  assert.equal(MEDIA_LIMITS.appendCalls * MEDIA_LIMITS.chunkBytes, 8847360);
  assert.ok(MEDIA_LIMITS.appendCalls * MEDIA_LIMITS.chunkBytes <= MEDIA_LIMITS.appendWindowBytes);
});
for (const dialect of ['sqlite','postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: guarded existing-product upload begin/append/discard is strict and duplicate-safe`, options, async t => {
    const f = await coordinatorFixture(t, dialect), input = await f.input(), c = f.coordinator;
    for (const patch of [{ enabled: false }, { quickLogin: true }, { production: true }, { tenantGuard: undefined },
      { binding: { ...f.binding, issuer: 'http://seller.example.test' } }]) assert.throws(() => createMediaCoordinator({ ...f.options, ...patch }), TypeError);
    const a = await c.begin(f.bearer, input), b = await c.begin(f.bearer, input);
    assert.equal(a.stageId, b.stageId); assert.equal(b.replayed, true);
    const append = { stageId: a.stageId, offset: 0, dataParts: parts(png) };
    await c.append(f.bearer, append); assert.equal((await c.append(f.bearer, append)).replayed, true);
    await assert.rejects(c.append(f.bearer, { ...append, dataParts: ['AB=='] }), { status: 400 });
    await assert.rejects(c.append(f.bearer, { ...append, approved: true }), { status: 400 });
    await assert.rejects(c.begin(f.bearer, { ...input, tenantId: 'other' }), { status: 400 });
    await c.discard(f.bearer, { stageId: a.stageId });
    assert.equal((await c.discard(f.bearer, { stageId: a.stageId })).replayed, true);
    await assert.rejects(c.append(f.bearer, append), { status: 409 });
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
    assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?', f.product.id)).stock_quantity, 7);
  });
  test(`${dialect}: storage failure rolls back stage bytes while its committed attempt remains charged`, options, async t => {
    const f = await coordinatorFixture(t, dialect), original = f.store.run;
    f.store.run = (sql, ...args) => {
      if (sql.startsWith('INSERT INTO mcp_v2_media_event')) throw new Error('Synthetic media audit failure');
      return original(sql, ...args);
    };
    try { await assert.rejects(f.coordinator.begin(f.bearer, await f.input()), /Synthetic media audit failure/); }
    finally { f.store.run = original; }
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_quota')).n, 0);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp:v2:media-stage'")).n, 1);
    const stage = await f.coordinator.begin(f.bearer, await f.input()); f.bump();
    await assert.rejects(f.coordinator.append(f.bearer, { stageId: stage.stageId, offset: 0, dataParts: parts(png) }), { status: 409 });
    assert.equal((await f.store.get('SELECT next_offset FROM mcp_v2_media_stage WHERE id=?', stage.stageId)).next_offset, 0);
  });
  test(`${dialect}: immutable begin replay survives portal image changes without new quota or audit`, options, async t => {
    const f = await coordinatorFixture(t, dialect), input = await f.input(), stage = await f.coordinator.begin(f.bearer, input);
    const quotas = await f.store.all('SELECT * FROM mcp_v2_media_quota ORDER BY kind,owner_key');
    const events = await f.store.all('SELECT * FROM mcp_v2_media_event ORDER BY id');
    await updateProduct(f.store, f.product.id, { imageDataUrl: 'data:image/png;base64,' + Buffer.concat([png, Buffer.from('portal replacement')]).toString('base64') });
    const replay = await f.coordinator.begin(f.bearer, input);
    assert.equal(replay.stageId, stage.stageId); assert.equal(replay.replayed, true);
    assert.deepEqual(await f.store.all('SELECT * FROM mcp_v2_media_quota ORDER BY kind,owner_key'), quotas);
    assert.deepEqual(await f.store.all('SELECT * FROM mcp_v2_media_event ORDER BY id'), events);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 1);
    await assert.rejects(f.coordinator.begin(f.bearer, { ...input, sourceSha256: '0'.repeat(64) }), { code: 'MEDIA_CONFLICT' });
  });
  test(`${dialect}: expired begin retry returns its original immutable stage without renewing bytes`, options, async t => {
    const f = await coordinatorFixture(t, dialect), later = new Date(Date.now() + 3600000).toISOString();
    await f.store.run('UPDATE oauth_client SET expires_at=? WHERE id=?', later, f.clientId);
    await f.store.run('UPDATE oauth_grant SET absolute_expires_at=? WHERE id=?', later, f.grantId);
    await f.store.run('UPDATE oauth_token SET expires_at=? WHERE grant_id=?', later, f.grantId);
    const input = await f.input(), stage = await f.coordinator.begin(f.bearer, input);
    const before = await f.store.get('SELECT * FROM mcp_v2_media_stage WHERE id=?', stage.stageId);
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(stage.uploadExpiresAt) + 1 });
    const replay = await f.coordinator.begin(f.bearer, input);
    assert.equal(replay.stageId, stage.stageId); assert.equal(replay.uploadExpiresAt, stage.uploadExpiresAt); assert.equal(replay.replayed, true);
    assert.deepEqual(await f.store.get('SELECT * FROM mcp_v2_media_stage WHERE id=?', stage.stageId), before);
    await assert.rejects(f.coordinator.append(f.bearer, { stageId: stage.stageId, offset: 0, dataParts: parts(png) }), { code: 'MEDIA_CONFLICT' });
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_media_event WHERE stage_id=? AND event='BEGIN'", stage.stageId)).n, 1);
  });
  test(`${dialect}: current consent, revocation, persisted mode and tenant lifecycle guard every SQL phase`, options, async t => {
    const f = await coordinatorFixture(t, dialect), input = await f.input(), stage = await f.coordinator.begin(f.bearer, input);
    const append = { stageId: stage.stageId, offset: 0, dataParts: parts(png) };
    await f.store.run('UPDATE oauth_grant SET revoked_at=? WHERE id=?', new Date().toISOString(), f.grantId);
    await assert.rejects(f.coordinator.append(f.bearer, append), { status: 403 });
    assert.equal((await f.store.get('SELECT next_offset FROM mcp_v2_media_stage WHERE id=?', stage.stageId)).next_offset, 0);
    await f.store.run('UPDATE oauth_grant SET revoked_at=NULL WHERE id=?', f.grantId);
    await f.store.run("UPDATE shop_setup SET mode='demo' WHERE id=1");
    await assert.rejects(f.coordinator.discard(f.bearer, { stageId: stage.stageId }), { status: 403 });
    await f.store.run("UPDATE shop_setup SET mode='production' WHERE id=1");
    await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.grantId);
    await assert.rejects(f.coordinator.append(f.bearer, append), { status: 403 });
    const before = (await f.store.get('SELECT COUNT(*) AS n FROM rate_limit_attempt')).n;
    f.suspend();
    await assert.rejects(f.coordinator.begin(f.bearer, input), { status: 503 });
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM rate_limit_attempt')).n, before);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_media_stage WHERE id=?', stage.stageId)).state, 'UPLOADING');
  });
  test(`${dialect}: slots use current holder rules and full graph revision before reserving bytes`, options, async t => {
    const f = await coordinatorFixture(t, dialect), input = await f.input();
    await updateProduct(f.store, f.product.id, { name: 'Concurrent portal change' });
    await assert.rejects(f.coordinator.begin(f.bearer, input), { code: 'MEDIA_RESOURCE_CHANGED' });
    const holder = await f.make('HOLDER', png, { variantGroup: 'SYNTHETIC-GROUP', variantLabel: 'A' });
    const variant = await f.make('VARIANT', png, { variantGroup: 'SYNTHETIC-GROUP', variantLabel: 'B' });
    const snapshot = await readMediaSnapshot(f.store, variant.id);
    await assert.rejects(f.coordinator.begin(f.bearer, { ...input, productId: variant.id, targetSlot: 'GALLERY',
      expectedRevision: snapshot.revision }), { code: 'GALLERY_SHARED' });
    const empty = await f.make('NO-MAIN', null);
    await assert.rejects(f.coordinator.begin(f.bearer, { ...input, productId: empty.id, targetSlot: 'GALLERY',
      expectedRevision: (await readMediaSnapshot(f.store, empty.id)).revision }), { code: 'MEDIA_MAIN_REQUIRED' });
    await assert.rejects(f.coordinator.begin(f.bearer, { ...input, productId: randomUUID() }), { status: 404 });
    assert.ok(holder.id); assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_quota')).n, 0);
  });
  test(`${dialect}: persistent separate APPEND class counts failures across restart and concurrent calls`, options, async t => {
    const f = await coordinatorFixture(t, dialect), input = await f.input(), stage = await f.coordinator.begin(f.bearer, input);
    const bad = { stageId: stage.stageId, offset: 0, dataParts: ['AB=='] };
    for (let n = 0; n < 220; n++) await assert.rejects(f.coordinator.append(f.bearer, bad), { status: 400 });
    const restarted = createMediaCoordinator(f.options);
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => restarted.append(f.bearer, bad)));
    assert.equal(results.filter(value => value.status === 'rejected' && value.reason.status === 400).length, 20);
    assert.equal(results.filter(value => value.status === 'rejected' && value.reason.status === 429).length, 5);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp:v2:media-append'")).n, 240);
    assert.equal((await f.store.get('SELECT next_offset FROM mcp_v2_media_stage WHERE id=?', stage.stageId)).next_offset, 0);
    await restarted.discard(f.bearer, { stageId: stage.stageId });
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM rate_limit_attempt WHERE bucket='mcp:v2:media-stage'")).n, 2);
  });
  test(`${dialect}: concurrent authenticated begin enforces quota CAS without extra stage or commerce writes`, options, async t => {
    const f = await coordinatorFixture(t, dialect), input = await f.input();
    const results = await Promise.allSettled(Array.from({ length: 13 }, (_, index) => f.coordinator.begin(f.bearer,
      { ...input, idempotencyKey: 'synthetic-authenticated-quota-' + index })));
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 12);
    const rejected = results.filter(value => value.status === 'rejected');
    assert.equal(rejected.length, 1); assert.equal(rejected[0].reason.code, 'MEDIA_QUOTA'); assert.equal(rejected[0].reason.status, 429);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 12);
    assert.deepEqual((await f.store.all('SELECT active_slots FROM mcp_v2_media_quota')).map(row => row.active_slots), [12,12]);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
    assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?', f.product.id)).stock_quantity, 7);
  });
}
