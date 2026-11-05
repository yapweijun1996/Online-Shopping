import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { coordinatorFixture, png } from './helpers/mcp-media-coordinator-fixture.js';
import { createMediaCoordinator } from '../src/mcp/media-coordinator.js';
import { verifyMediaAuthority } from '../src/mcp/operation-authorization.js';
import { createOperationEngine } from '../src/mcp/operation-engine.js';
import { readMediaFrame } from '../src/mcp/media-frame-storage.js';
import { hash } from '../src/mcp/credentials.js';
import { seedSyntheticMediaApproval } from './helpers/mcp-media-engine-fixture.js';
import { reviewPassword } from './helpers/mcp-review-fixture.js';
import { startContainer } from '../media-codec/scripts/dev-container.js';

const enabled = process.env.MEDIA_COORDINATOR_CONTAINER_TEST === '1';
test('actual isolated codec seals uploads and SYNTHETIC reviewed evidence exercises real service commit/replay', { skip: !enabled }, async t => {
  assert.ok(process.env.SHOP_TEST_DATABASE_URL, 'Both stores required for explicit native run.');
  const imageId = (await readFile(new URL('../.local/media-codec-image-id', import.meta.url), 'utf8')).trim();
  const worker = await startContainer(imageId); t.after(worker.stop);
  const { image } = await import('../media-codec/test/fixtures.js');
  const cases = [
    ...['sqlite','postgres'].flatMap(dialect => ['MAIN','GALLERY'].map(slot => ({ dialect, slot, mime: 'image/png', bytes: png, width: 192, height: 192 }))),
    ...await Promise.all(['jpeg','webp'].map(async format => ({ dialect: 'sqlite', slot: 'MAIN', mime: 'image/' + format,
      bytes: await image(format), width: 24, height: 16 }))),
  ];
  for (const entry of cases) await t.test(entry.dialect + ':' + entry.slot + ':' + entry.mime, async child => {
    const f = await coordinatorFixture(child, entry.dialect), { decode: _syntheticDecode, ...trusted } = f.options;
    const c = createMediaCoordinator({ ...trusted, codec: { socketPath: worker.socketPath, token: worker.token, digest: imageId.slice(7) } });
    const engine = createOperationEngine({ ...trusted, adapters: { 'media.prepare_upload': c.uploadAdapter } });
    const input = await f.input(entry.bytes, { targetSlot: entry.slot, sourceMime: entry.mime });
    const stage = await c.begin(f.bearer, input);
    for (let offset = 0; offset < entry.bytes.length; offset += 36864) {
      const chunk = entry.bytes.subarray(offset, offset + 36864);
      const dataParts = Array.from({ length: Math.ceil(chunk.length / 3072) }, (_, n) => chunk.subarray(n * 3072, (n + 1) * 3072).toString('base64'));
      await c.append(f.bearer, { stageId: stage.stageId, offset, dataParts });
    }
    const operation = await engine.prepare({ bearer: f.bearer, toolName: 'media.prepare_upload', args: { stageId: stage.stageId }, idempotencyKey: 'synthetic-native-seal-0001' });
    assert.equal(operation.status, 'PENDING_APPROVAL');
    const context = await f.guard.withActiveTenant(f.binding.tenantId, tenant => f.store.transaction(() => verifyMediaAuthority(f.store,
      { bearer: f.bearer, binding: f.binding, epochHash: f.epochHash, buildDigest: trusted.buildDigest, tenantRevision: tenant.revision })));
    const manifest = await readMediaFrame(f.store, context, operation.operationId);
    assert.equal(manifest.stages.length, 1); assert.equal(manifest.stages[0].stage_id, stage.stageId);
    const bound = await f.store.get('SELECT state,width,height,canonical_sha256,canonical_mime,canonical_bytes,thumbnail_bytes FROM mcp_v2_media_stage WHERE id=?', stage.stageId);
    assert.equal(bound.state, 'BOUND'); assert.equal(bound.width, entry.width); assert.equal(bound.height, entry.height);
    assert.equal(bound.canonical_mime, entry.mime);
    const path = '/api/v1/seller/mcp/operations/' + operation.operationId;
    assert.equal((await f.call(path, 'GET', undefined, f.headers)).response.status, 403);
    assert.equal((await f.call(path + '/approval', 'POST', { operationId: operation.operationId, previewHash: operation.previewHash,
      decision: 'approve', password: reviewPassword, challenge: 'A'.repeat(43) }, f.headers)).response.status, 403);
    // Internal synthetic evidence only. No actual human image-review/ACK proof is claimed.
    await seedSyntheticMediaApproval({ store: f.store, context, sessionHash: hash(f.cookie.slice(f.cookie.indexOf('=') + 1)) }, operation);
    const commit = () => engine.commit({ bearer: f.bearer, toolName: 'media.commit_upload', operationId: operation.operationId });
    const committed = await Promise.all([commit(), commit()]);
    assert.deepEqual(committed.map(value => value.replayed).sort(), [false,true]);
    assert.deepEqual(Object.keys(committed[0].result).sort(), ['listingId','productId','revision']);
    const payload = await f.store.get('SELECT state,canonical_data,thumbnail_data FROM mcp_v2_media_stage WHERE id=?', stage.stageId);
    assert.equal(payload.state, 'CONSUMED'); assert.equal(payload.canonical_data, null); assert.equal(payload.thumbnail_data, null);
    const stored = entry.slot === 'MAIN'
      ? await f.store.get('SELECT image_data AS data,image_mime AS mime FROM product WHERE id=?', f.product.id)
      : await f.store.get('SELECT data,mime FROM product_gallery_image WHERE product_id=?', f.product.id);
    assert.equal(stored.mime, entry.mime); assert.equal(hash(stored.data), bound.canonical_sha256);
    assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?', f.product.id)).stock_quantity, 7);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id=? AND event='COMMIT'", operation.operationId)).n, 1);
    assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM product_event WHERE product_id=? AND action='UPDATED'", f.product.id)).n,
      entry.slot === 'GALLERY' ? 1 : 0);
    child.diagnostic(JSON.stringify({ nativeImage: imageId, mime: entry.mime, width: bound.width, height: bound.height,
      canonicalBytes: bound.canonical_bytes, thumbnailBytes: bound.thumbnail_bytes, syntheticReviewOnly: true }));
  });
});
