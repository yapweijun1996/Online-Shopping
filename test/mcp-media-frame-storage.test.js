import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mediaFixture } from './helpers/mcp-media-storage-fixture.js';
import { mediaHash } from '../src/mcp/media-storage.js';
import { buildMediaManifest, mediaAssetKey, mediaManifestRows } from '../src/mcp/media-manifest.js';
import { persistMediaFrame, readMediaFrame } from '../src/mcp/media-frame-storage.js';

// Synthetic codec packets exercise storage contracts, not native image validation.
async function prepared(t, dialect) {
  const f = await mediaFixture(t, dialect), source = Buffer.from('synthetic source bytes');
  const upload = await f.upload(source), { args, stage, lease } = upload;
  const result = { sourceSha256: lease.sourceSha256, image: Buffer.from('synthetic canonical bytes'),
    thumbnail: Buffer.from('synthetic thumbnail'), mime: 'image/png', width: 10, height: 10, codecDigest: args.codecDigest };
  const asset = { source_kind: 'STAGE', source_id: stage.stageId, source_product_id: args.productId, stage_id: stage.stageId,
    byte_sha256: mediaHash(result.image), mime: result.mime, byte_length: result.image.length };
  const listingId = randomUUID(), before = { listingId, role: 'single', mainAssetKey: null };
  const manifest = buildMediaManifest({ toolName: 'media.prepare_upload', graphRevision: args.expectedRevision,
    codecDigest: args.codecDigest, graphBytes: { oldBytes: 0, newBytes: result.image.length }, assets: [asset], effects: [
      { kind: 'PRODUCT', productId: args.productId, before, after: { ...before, mainAssetKey: mediaAssetKey(asset.mime, asset.byte_sha256) } },
      { kind: 'LISTING', listingId, before: { holderId: null, galleryAssetKeys: [] }, after: { holderId: null, galleryAssetKeys: [] } },
    ] });
  const op = await f.operation(args.codecDigest, f.now, lease.correlationId);
  const row = mediaManifestRows(manifest, { operationId: op, toolName: 'media.prepare_upload', createdAt: f.now,
    expiresAt: new Date(Date.parse(f.now) + 600000).toISOString() }).policy;
  // Replace only the synthetic fixture's placeholder descriptor, before any pin.
  await f.store.run('UPDATE mcp_v2_operation_media_policy SET descriptor_hash=?,manifest_root=?,graph_revision=?,page_count=?,asset_count=?,effect_count=? WHERE operation_id=?',
    row.descriptor_hash, row.manifest_root, row.graph_revision, row.page_count, row.asset_count, row.effect_count, op);
  const bind = () => f.writer(w => w.bind(stage.stageId, lease.leaseToken, lease.version, result, op));
  return { ...f, ...upload, result, manifest, op, bind };
}
for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: frame persists exact canonical rows after real pin and returns frozen metadata`, options, async t => {
    const f = await prepared(t, dialect);
    let escaped;
    const inspected = await f.writer(async w => { escaped = w; return w.inspect(f.stage.stageId); });
    assert.ok(Object.isFrozen(inspected)); assert.equal(inspected.productId, f.args.productId);
    assert.equal(inspected.expectedRevision, f.args.expectedRevision); assert.equal(inspected.receiptExpiresAt,
      new Date(Date.parse(f.context.grantExpiresAt) + 90 * 86400000).toISOString());
    assert.ok(Object.values(inspected).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value)));
    assert.ok(!Object.keys(inspected).some(key => /token|leasehash|data/i.test(key)));
    await assert.rejects(escaped.inspect(f.stage.stageId), TypeError);
    await f.bind();
    assert.deepEqual(await persistMediaFrame(f.store, f.context, f.op, f.manifest), f.manifest);
    assert.deepEqual(await readMediaFrame(f.store, f.context, f.op, f.manifest.descriptor), f.manifest);
    await assert.rejects(persistMediaFrame(f.store, f.context, f.op, f.manifest), { code: 'MEDIA_FRAME_CONFLICT' });
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_manifest_page')).n, f.manifest.pages.length);
    await assert.rejects(readMediaFrame(f.store, { ...f.context, tenantId: 'forged' }, f.op), { status: 409 });
    await assert.rejects(f.writer(w => w.inspect(f.stage.stageId), f.now, { ...f.context, grantId: randomUUID() }), { status: 409 });
  });
  test(`${dialect}: no missing/mismatched pin or descriptor can persist a frame`, options, async t => {
    const f = await prepared(t, dialect);
    await assert.rejects(persistMediaFrame(f.store, f.context, f.op, f.manifest), { code: 'MEDIA_FRAME_INTEGRITY' });
    await f.bind();
    const corrupt = structuredClone(f.manifest); corrupt.descriptor.manifestRoot = '0'.repeat(64);
    await assert.rejects(persistMediaFrame(f.store, f.context, f.op, corrupt), TypeError);
    await f.store.run('UPDATE mcp_v2_media_pin SET canonical_sha256=? WHERE stage_id=?', '0'.repeat(64), f.stage.stageId);
    await assert.rejects(persistMediaFrame(f.store, f.context, f.op, f.manifest), { code: 'MEDIA_FRAME_INTEGRITY' });
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_manifest_page')).n, 0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref')).n, 0);
  });
  test(`${dialect}: frame write failure and outer rollback leave no partial pages/assets/pin`, options, async t => {
    const f = await prepared(t, dialect), original = f.store.run;
    await assert.rejects(f.store.transaction(async () => {
      await f.bind();
      f.store.run = (sql, ...values) => {
        if (sql.startsWith('INSERT INTO mcp_v2_media_asset_ref')) throw new Error('Synthetic frame write failure');
        return original(sql, ...values);
      };
      try { await persistMediaFrame(f.store, f.context, f.op, f.manifest); } finally { f.store.run = original; }
    }), /Synthetic frame write failure/);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_pin')).n, 0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_manifest_page')).n, 0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref')).n, 0);
    assert.equal((await f.writer(w => w.inspect(f.stage.stageId))).state, 'VALIDATING');
    await f.bind();
    await persistMediaFrame(f.store, f.context, f.op, f.manifest);
    await f.store.run("UPDATE mcp_v2_media_manifest_page SET page_json='{}' WHERE operation_id=?", f.op);
    await assert.rejects(readMediaFrame(f.store, f.context, f.op), { code: 'MEDIA_FRAME_INTEGRITY' });
  });
}
