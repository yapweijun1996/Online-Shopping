import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createCategory } from '../../src/settings.js';
import { createProduct, updateProduct } from '../../src/products.js';
import { trackUpdate } from '../../src/product-history.js';
import { readMediaSnapshot } from '../../src/mcp/media-resources.js';
import { buildMediaManifest, mediaAssetKey } from '../../src/mcp/media-manifest.js';
import { mediaHash } from '../../src/mcp/media-policy.js';
import { uploadThumbnail } from '../../src/mcp/media-upload-policy.js';
import { withMediaWriter } from '../../src/mcp/media-storage.js';
import { createOperationEngine } from '../../src/mcp/operation-engine.js';
import { mediaEngineFixture } from './mcp-media-engine-fixture.js';

// Generated one-pixel PNG, no customer images or native codec/provider calls.
export function syntheticMediaPng(color = 7) {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, color, 60, 90, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
export async function mediaHooksFixture(t, dialect) {
  const f = await mediaEngineFixture(t, dialect);
  await createCategory(f.store, { code: 'SYNTHETIC', label: 'Synthetic media category' });
  const product = await createProduct(f.store, { sku: 'SYNTHETIC-MEDIA', name: 'Synthetic media product', description: 'Synthetic media fixture',
    category: 'SYNTHETIC', priceMinor: 100, stockQuantity: 1, active: false });
  f.productId = product.id;
  const codecDigest = 'd'.repeat(64), counters = { capture: 0, resolve: 0, apply: 0, consume: 0 };
  let savedReader, savedWriter;
  const adapter = {
    resourceType: 'product',
    media: { policyId: 'media-upload-v1', codecDigest,
      capture: async (read, args, context, writer) => {
        counters.capture++; assert.equal(f.depth(), 1); savedReader = read; savedWriter = writer;
        const stage = await writer.inspect(args.stageId), snapshot = await readMediaSnapshot(read, stage.productId);
        if (snapshot.revision !== stage.expectedRevision) throw new Error('Synthetic stale capture.');
        return { resourceId: stage.productId, expectedRevision: snapshot.revision,
          resources: { stage, snapshot, lease: await writer.claimValidation(stage.stageId) } };
      },
      resolve: async (resources, { signal, deadline }) => {
        counters.resolve++; assert.equal(f.depth(), 0); assert.equal(signal.aborted, false); assert.ok(deadline > performance.now());
        assert.throws(() => savedReader.get('SELECT 1'), /no longer active/);
        await assert.rejects(savedWriter.get(resources.stage.stageId), /no longer active/);
        // SYNTHETIC trusted decoder result only; actual codec has separate container acceptance.
        return { ...resources, result: { image: resources.lease.source, thumbnail: resources.lease.source,
          sourceSha256: resources.lease.sourceSha256, mime: 'image/png', width: 1, height: 1, codecDigest } };
      },
      persistResources: (writer, envelope, resources) => writer.bind(resources.lease.stageId,
        resources.lease.leaseToken, resources.lease.version, resources.result, envelope.operationId),
      consumeResources: async (writer, envelope) => { counters.consume++; await writer.consume(envelope.proposal.stageId, envelope.operationId); },
    },
    preview: async (read, args, resources) => {
      const snapshot = await readMediaSnapshot(read, resources.stage.productId), result = resources.result;
      const key = mediaAssetKey(result.mime, mediaHash(result.image));
      const asset = { source_kind: 'STAGE', source_id: resources.stage.stageId, source_product_id: resources.stage.productId,
        stage_id: resources.stage.stageId, byte_sha256: mediaHash(result.image), mime: result.mime, byte_length: result.image.length };
      // This fixture models one synthetic single product only; production uses the shared gallery planner.
      const effects = [...snapshot.before.products.map(p => ({ kind: 'PRODUCT', productId: p.productId,
        before: { listingId: p.listingId, role: p.role, mainAssetKey: p.mainAssetKey },
        after: { listingId: p.listingId, role: p.role, mainAssetKey: key } })),
      ...snapshot.before.listings.map(l => ({ kind: 'LISTING', listingId: l.listingId,
        before: { holderId: l.holderId, galleryAssetKeys: l.galleryAssetKeys }, after: { holderId: l.holderId, galleryAssetKeys: [key] } }))];
      return { resourceId: resources.stage.productId, expectedRevision: snapshot.revision,
        proposal: { id: resources.stage.productId, stageId: args.stageId, thumbnail: uploadThumbnail(result.thumbnail) },
        mediaManifest: buildMediaManifest({ toolName: 'media.prepare_upload', graphRevision: snapshot.revision, codecDigest,
          graphBytes: { oldBytes: snapshot.graphReadBytes.oldBytes, newBytes: result.image.length + result.thumbnail.length },
          assets: [...snapshot.assets, asset], effects }) };
    },
    currentRevision: async (read, envelope) => ({ exists: true, revision: (await readMediaSnapshot(read, envelope.resourceId)).revision }),
    apply: async (store, proposal, context) => {
      counters.apply++;
      const bytes = await withMediaWriter(store, context.mediaContext, writer => writer.boundBytes(proposal.stageId, context.operationId));
      await trackUpdate(store, proposal.id, 'synthetic_media_owner', () => updateProduct(store, proposal.id, {
        imageDataUrl: `data:${bytes.mime};base64,${bytes.image.toString('base64')}`,
        thumbDataUrl: `data:image/png;base64,${bytes.thumbnail.toString('base64')}` }));
      return { id: proposal.id, revision: (await readMediaSnapshot(store, proposal.id)).revision };
    },
    validResult: value => Object.keys(value).sort().join(',') === 'id,revision' && value.id === product.id && /^[a-f0-9]{64}$/.test(value.revision),
    toReceipt: value => ({ id: value.id, revision: value.revision }),
    validReceipt: value => Object.keys(value).sort().join(',') === 'id,revision' && value.id === product.id && /^[a-f0-9]{64}$/.test(value.revision),
  };
  const makeEngine = (override = {}) => createOperationEngine({ ...f.options,
    adapters: { 'media.prepare_upload': { ...adapter, ...override } } });
  const engine = makeEngine();
  const startStage = async (key = 'synthetic-media-stage-0001', bytes = syntheticMediaPng()) => {
    const snapshot = await readMediaSnapshot(f.store, product.id);
    return withMediaWriter(f.store, f.context, async writer => {
      const stage = await writer.begin({ productId: product.id, targetSlot: 'MAIN', expectedRevision: snapshot.revision,
        sourceSha256: mediaHash(bytes), sourceMime: 'image/png', declaredBytes: bytes.length, codecDigest, idempotencyKey: key });
      await writer.append(stage.stageId, 0, bytes); return stage;
    });
  };
  const prepare = (stage, key = 'synthetic-media-operation-0001', selected = engine) => selected.prepare({ bearer: f.bearer,
    toolName: 'media.prepare_upload', args: { stageId: stage.stageId }, idempotencyKey: key });
  const commit = (operation, selected = engine) => selected.commit({ bearer: f.bearer,
    toolName: 'media.commit_upload', operationId: operation.operationId });
  return { ...f, adapter, engine, makeEngine, counters, startStage, prepare, commit };
}
