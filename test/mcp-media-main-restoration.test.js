import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinatorFixture, png } from './helpers/mcp-media-coordinator-fixture.js';
import { addGalleryImage, getProduct, updateProduct } from '../src/products.js';
import { createOperationEngine } from '../src/mcp/operation-engine.js';
import { verifyMediaAuthority } from '../src/mcp/operation-authorization.js';
import { seedSyntheticMediaApproval } from './helpers/mcp-media-engine-fixture.js';
import { readMediaSnapshot } from '../src/mcp/media-resources.js';
import { readMediaFrame } from '../src/mcp/media-frame-storage.js';
import { hash } from '../src/mcp/credentials.js';
import { operationPreviewHash } from '../src/mcp/operation-envelope.js';
import { uploadThumbnail } from '../src/mcp/media-upload-policy.js';
const photo = data => 'data:image/png;base64,' + data.toString('base64');
const bytes = label => Buffer.concat([png, Buffer.from(label)]);
async function hideMain(f, galleries = 1) {
  for (let index = 0; index < galleries; index++) await addGalleryImage(f.store, f.product.id, photo(bytes('gallery-' + index)));
  const current = await getProduct(f.store, f.product.id, true);
  const selected = current.galleryItems.filter(item => item.id !== 'main').map(({ id }) => ({ id }));
  await updateProduct(f.store, f.product.id, { gallery: selected, expectedUpdatedAt: current.updatedAt });
  return selected.map(item => item.id);
}
async function pending(f) {
  const source = bytes('replacement-main'), stage = await f.coordinator.begin(f.bearer, await f.input(source));
  const dataParts = Array.from({ length: Math.ceil(source.length / 3072) }, (_, n) => source.subarray(n * 3072, (n + 1) * 3072).toString('base64'));
  await f.coordinator.append(f.bearer, { stageId: stage.stageId, offset: 0, dataParts });
  const engine = createOperationEngine({ ...f.options, adapters: { 'media.prepare_upload': f.coordinator.uploadAdapter } });
  const operation = await engine.prepare({ bearer: f.bearer, toolName: 'media.prepare_upload', args: { stageId: stage.stageId }, idempotencyKey: 'synthetic-restoration-seal' });
  return { engine, operation, stage };
}
for (const dialect of ['sqlite','postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: hidden-main upload uses portal restoration order and real commit succeeds`, options, async t => {
    const f = await coordinatorFixture(t, dialect), selected = await hideMain(f);
    const before = await readMediaSnapshot(f.store, f.product.id), oldPrimary = before.before.listings[0].galleryAssetKeys[0];
    const { engine, operation, stage } = await pending(f);
    const context = await verifyMediaAuthority(f.store, { bearer: f.bearer, binding: f.binding, epochHash: f.epochHash,
      buildDigest: f.options.buildDigest, tenantRevision: 0 });
    const manifest = await readMediaFrame(f.store, context, operation.operationId);
    const bound = await f.store.get('SELECT canonical_bytes,thumbnail_bytes,thumbnail_data FROM mcp_v2_media_stage WHERE id=?', stage.stageId);
    assert.equal(JSON.parse(manifest.pages[0].page_json).graphBytes.newBytes, bound.canonical_bytes + bound.thumbnail_bytes);
    const row = await f.store.get('SELECT envelope_json FROM mcp_v2_operation WHERE id=?', operation.operationId);
    const envelope = JSON.parse(row.envelope_json);
    assert.deepEqual(envelope.proposal.thumbnail, uploadThumbnail(bound.thumbnail_data));
    for (const patch of [{ sha256: '0'.repeat(64) }, { byteLength: bound.thumbnail_bytes + 1 }]) {
      const altered = structuredClone(envelope); Object.assign(altered.proposal.thumbnail, patch);
      assert.notEqual(operationPreviewHash(altered), operation.previewHash);
    }
    const listing = manifest.effects.find(effect => effect.kind === 'LISTING');
    const product = manifest.effects.find(effect => effect.kind === 'PRODUCT');
    assert.deepEqual(listing.after.galleryAssetKeys, [oldPrimary, product.after.mainAssetKey]);
    // Internal SYNTHETIC reviewed evidence, not real human/UI proof.
    await seedSyntheticMediaApproval({ store: f.store, context, sessionHash: hash(f.cookie.split('=')[1]) }, operation);
    const result = await engine.commit({ bearer: f.bearer, toolName: 'media.commit_upload', operationId: operation.operationId });
    assert.equal(result.status, 'COMMITTED');
    assert.deepEqual((await getProduct(f.store, f.product.id, true)).galleryItems.map(item => item.id), [...selected,'main']);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_media_stage WHERE id=?', stage.stageId)).state, 'CONSUMED');
    assert.equal((await f.store.get('SELECT stock_quantity FROM product WHERE id=?', f.product.id)).stock_quantity, 7);
  });
  test(`${dialect}: portal and preview preserve primary and reject restored-main overflow atomically`, options, async t => {
    const f = await coordinatorFixture(t, dialect), selected = await hideMain(f);
    await updateProduct(f.store, f.product.id, { imageDataUrl: photo(bytes('portal-main')) });
    assert.deepEqual((await getProduct(f.store, f.product.id, true)).galleryItems.map(item => item.id), [...selected,'main']);
    const overflow = await coordinatorFixture(t, dialect); await hideMain(overflow, 9);
    await addGalleryImage(overflow.store, overflow.product.id, photo(bytes('tenth-gallery')));
    const before = await readMediaSnapshot(overflow.store, overflow.product.id);
    await assert.rejects(updateProduct(overflow.store, overflow.product.id, { imageDataUrl: photo(bytes('overflow-main')) }), { field: 'gallery' });
    assert.equal((await readMediaSnapshot(overflow.store, overflow.product.id)).revision, before.revision);
    await assert.rejects(pending(overflow), { status: 400, code: 'MEDIA_LAYOUT_INPUT' });
    assert.equal((await overflow.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
    assert.equal((await overflow.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_pin')).n, 0);
    assert.equal((await readMediaSnapshot(overflow.store, overflow.product.id)).revision, before.revision);
  });
}
