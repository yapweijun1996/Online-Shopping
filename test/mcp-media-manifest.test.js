import test from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_LIMITS } from '../src/mcp/media-schema.js';
import { buildMediaManifest, mediaAssetKey, mediaManifestRows, readMediaManifest } from '../src/mcp/media-manifest.js';
import { mediaHash, mediaJson, mediaPolicyForTool } from '../src/mcp/media-policy.js';
const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const clone = value => structuredClone(value);
const product = uuid(1), listing = uuid(2), stage = uuid(3);
function source(n, owner = product, kind = 'GALLERY', bytes = 100) {
  return { source_kind: kind, source_id: kind === 'PRODUCT_MAIN' ? owner : uuid(n), source_product_id: owner,
    stage_id: kind === 'STAGE' ? uuid(n) : null, byte_sha256: mediaHash(`synthetic-metadata-${n}`), mime: 'image/png', byte_length: bytes };
}
const key = value => mediaAssetKey(value.mime, value.byte_sha256);
function fixture() {
  const old = source(11, product, 'PRODUCT_MAIN'), next = source(3, product, 'STAGE', 200);
  return { toolName: 'media.prepare_upload', graphRevision: mediaHash('graph'), codecDigest: mediaHash('codec'),
    graphBytes: { oldBytes: 100, newBytes: 200 }, assets: [old, next], effects: [
      { kind: 'PRODUCT', productId: product, before: { listingId: listing, role: 'single', mainAssetKey: key(old) },
        after: { listingId: listing, role: 'single', mainAssetKey: key(next) } },
      { kind: 'LISTING', listingId: listing, before: { holderId: null, galleryAssetKeys: [key(old)] },
        after: { holderId: null, galleryAssetKeys: [key(next)] } },
    ] };
}
function context(toolName = 'media.prepare_upload') {
  return { operationId: uuid(99), toolName, createdAt: '2026-11-05T00:00:00.000Z', expiresAt: '2026-11-05T00:10:00.000Z' };
}
function operation(ctx = context()) {
  const policy = mediaPolicyForTool(ctx.toolName);
  return { id: ctx.operationId, tool_name: ctx.toolName, media_policy_id: policy.policyId, required_scope: policy.requiredScopes[0],
    required_capability: policy.capability, risk: policy.risk, created_at: ctx.createdAt, expires_at: ctx.expiresAt };
}
test('canonical ordered manifest is stable across input order and roundtrips exact schema31 metadata', () => {
  const input = fixture(), manifest = buildMediaManifest(input);
  assert.equal(manifest.descriptor.assetCount, 2); assert.equal(manifest.descriptor.effectCount, 2);
  assert.equal(manifest.stages.length, 1); assert.equal(manifest.stages[0].stage_id, stage);
  assert.equal(manifest.assets.find(row => row.source_kind === 'STAGE').before_needed, 0);
  const reversed = { ...input, assets: [...input.assets].reverse(), effects: [...input.effects].reverse() };
  assert.deepEqual(buildMediaManifest(reversed), manifest);
  const frame = mediaManifestRows(manifest, context());
  assert.deepEqual(readMediaManifest(frame, operation(), manifest.descriptor), manifest);
  assert.ok(Object.isFrozen(manifest.pages));
  assert.deepEqual(Object.keys(frame.assets[0]).sort(), ['operation_id', 'asset_key', 'source_kind', 'source_id', 'source_product_id',
    'stage_id', 'byte_sha256', 'mime', 'byte_length', 'before_needed', 'after_needed'].sort());
});
test('one stage can appear in main and gallery effects, and identical asset candidates deduplicate', () => {
  const input = fixture(); input.assets.push(clone(input.assets[1]));
  const manifest = buildMediaManifest(input);
  assert.equal(manifest.stages.length, 1); assert.equal(manifest.assets.length, 2);
  const pages = manifest.pages.map(page => JSON.parse(page.page_json));
  const record = pages.flatMap(page => page.records).find(record => record.kind === 'ASSET' && record.stage_id === stage);
  assert.equal(record.stage_refs.length, 1);
  assert.deepEqual(readMediaManifest(mediaManifestRows(manifest, context()), operation()), manifest);
});
test('rejects unbound/cross-product stages, inconsistent membership/roles and arbitrary metadata', () => {
  const changes = [
    value => { value.assets[1].stage_id = uuid(9); },
    value => { value.assets[1].source_product_id = uuid(9); },
    value => { value.effects[0].after.role = 'holder'; },
    value => { value.effects[1].after.holderId = product; },
    value => { value.effects[0].after.listingId = uuid(9); },
    value => { value.effects[1].after.galleryAssetKeys.push(mediaHash('unknown')); },
    value => { value.effects.push(clone(value.effects[0])); },
    value => { value.assets[0].url = 'https://invalid.example/image'; },
    value => { value.assets[0].thumbnail = 'untrusted'; },
    value => { value.assets[0].source_kind = 'REMOTE'; },
    value => { value.effects[0].before.accountId = uuid(8); },
    value => { value.effects[0].after.mainAssetKey = value.effects[0].before.mainAssetKey; value.effects[1].after.galleryAssetKeys = []; },
  ];
  for (const change of changes) { const input = fixture(); change(input); assert.throws(() => buildMediaManifest(input)); }
});
function group(count, oldCount = 0, newCount = 0, bytes = 100) {
  const list = uuid(2000), products = Array.from({ length: count }, (_, i) => uuid(1000 + i));
  const old = products.slice(0, oldCount).map((id, i) => source(3000 + i, id, 'PRODUCT_MAIN', bytes));
  const next = products.slice(0, newCount).map((id, i) => source(4000 + i, id, 'STAGE', bytes));
  const input = fixture(); input.toolName = 'media.preview_layout'; input.assets = [...old, ...next];
  input.graphBytes = { oldBytes: oldCount * bytes, newBytes: newCount * bytes };
  const holder = count === 1 ? null : products[0];
  input.effects = [{ kind: 'LISTING', listingId: list, before: { holderId: holder, galleryAssetKeys: [] }, after: { holderId: holder, galleryAssetKeys: [] } },
    ...products.map((id, i) => ({ kind: 'PRODUCT', productId: id,
      before: { listingId: list, role: count === 1 ? 'single' : i === 0 ? 'holder' : 'variant', mainAssetKey: old[i] ? key(old[i]) : null },
      after: { listingId: list, role: count === 1 ? 'single' : i === 0 ? 'holder' : 'variant', mainAssetKey: next[i] ? key(next[i]) : old[i] ? key(old[i]) : null } }))];
  return input;
}
test('full300product graph pages deterministically without truncation and301rejects', () => {
  const input = group(MEDIA_LIMITS.products), result = buildMediaManifest(input);
  assert.equal(result.descriptor.effectCount, MEDIA_LIMITS.products + 1);
  assert.ok(result.pages.length > 1 && result.pages.length <= MEDIA_LIMITS.pages);
  for (const page of result.pages) {
    assert.ok(page.record_count <= MEDIA_LIMITS.pageRecords); assert.ok(Buffer.byteLength(page.page_json) <= MEDIA_LIMITS.pageBytes);
  }
  const ctx = context(input.toolName);
  const frame = mediaManifestRows(result, ctx);
  assert.deepEqual(readMediaManifest(frame, operation(ctx)), result);
  const wrongOrder = clone(frame); wrongOrder.pages.reverse();
  assert.throws(() => readMediaManifest(wrongOrder, operation(ctx)));
  assert.throws(() => buildMediaManifest(group(MEDIA_LIMITS.products + 1)));
});
test('exact32old10new42assets and source byte boundaries hold without decoded-data claims', () => {
  const input = group(MEDIA_LIMITS.oldAssets, MEDIA_LIMITS.oldAssets, MEDIA_LIMITS.newAssets, MEDIA_LIMITS.sourceBytes);
  const result = buildMediaManifest(input);
  assert.equal(result.assets.length, MEDIA_LIMITS.assets); assert.equal(result.stages.length, MEDIA_LIMITS.newAssets);
  assert.equal(input.graphBytes.oldBytes, MEDIA_LIMITS.oldBytes);
  assert.throws(() => buildMediaManifest(group(MEDIA_LIMITS.oldAssets + 1, MEDIA_LIMITS.oldAssets + 1)));
  assert.throws(() => buildMediaManifest(group(MEDIA_LIMITS.newAssets + 1, 0, MEDIA_LIMITS.newAssets + 1)));
  for (const patch of [{ oldBytes: MEDIA_LIMITS.oldBytes + 1, newBytes: 200 }, { oldBytes: 100, newBytes: MEDIA_LIMITS.newBytes + 1 },
    { oldBytes: 99, newBytes: 200 }, { oldBytes: 100, newBytes: 199 }, { oldBytes: 100.5, newBytes: 200 }]) {
    assert.throws(() => buildMediaManifest({ ...fixture(), graphBytes: patch }));
  }
  for (const byte_length of [0, MEDIA_LIMITS.sourceBytes + 1, 1.5]) {
    const value = fixture(); value.assets[1].byte_length = byte_length; assert.throws(() => buildMediaManifest(value));
  }
});
test('one stage cannot supply another product main or foreign listing gallery', () => {
  const input = group(2, 0, 1);
  input.effects[2].after.mainAssetKey = input.effects[1].after.mainAssetKey;
  assert.throws(() => buildMediaManifest(input));
  const value = fixture(), staged = value.assets[1]; value.assets = [staged]; value.graphBytes.oldBytes = 0;
  value.effects[0].before.mainAssetKey = key(staged); value.effects[1].before.galleryAssetKeys = [key(staged)];
  assert.throws(() => buildMediaManifest(value));
});
test('SQL metadata frames reject modified hashes/counts/order/refs and forged descriptors', () => {
  const manifest = buildMediaManifest(fixture()), base = mediaManifestRows(manifest, context());
  const changes = [
    value => { value.policy.required_scopes = 'catalog.write'; },
    value => { value.pages[0].page_hash = mediaHash('changed'); },
    value => { value.pages[0].page_index = 1; },
    value => { value.pages[0].record_count++; },
    value => { value.pages[0].operation_id = uuid(42); },
    value => { value.pages[0].page_json += ' '; value.pages[0].page_hash = mediaHash(value.pages[0].page_json); },
    value => { value.pages[0].page_json = '{"version":0,' + value.pages[0].page_json.slice(1); value.pages[0].page_hash = mediaHash(value.pages[0].page_json); },
    value => { value.pages[0].page_json = ' '.repeat(MEDIA_LIMITS.pageBytes + 1); value.pages[0].page_hash = mediaHash(value.pages[0].page_json); },
    value => { value.assets.reverse(); },
    value => { value.assets[0].after_needed ^= 1; },
    value => { value.assets[0].source_product_id = uuid(8); },
    value => { value.assets[0].byte_length++; },
    value => { value.assets[0].operation_id = uuid(42); },
    value => { value.assets[0].data = 'private bytes forbidden'; },
    value => { value.assets.pop(); },
    value => { value.pages.push(clone(value.pages[0])); },
  ];
  for (const change of changes) { const value = clone(base); change(value); assert.throws(() => readMediaManifest(value, operation())); }
  const falseFlags = clone(base), body = JSON.parse(falseFlags.pages[0].page_json);
  body.records.find(item => item.kind === 'ASSET').before_needed ^= 1;
  falseFlags.pages[0].page_json = mediaJson(body); falseFlags.pages[0].page_hash = mediaHash(falseFlags.pages[0].page_json);
  assert.throws(() => readMediaManifest(falseFlags, operation()));
  const tampered = clone(manifest); tampered.descriptorHash = mediaHash('false');
  assert.throws(() => mediaManifestRows(tampered, context()));
  const badEffect = clone(manifest); badEffect.effects[0].extra = true;
  assert.throws(() => mediaManifestRows(badEffect, context()));
});
test('unknown authority/raw fields, getters, holes, excessive nodes/depth and wrong policy tool reject', () => {
  for (const field of ['accountId', 'tenantId', 'requiredScopes', 'approved', 'imageDataUrl']) {
    assert.throws(() => buildMediaManifest({ ...fixture(), [field]: 'untrusted' }));
  }
  for (const change of [value => { value.assets[0].bytes = Buffer.alloc(1); },
    value => { value.assets[0].byte_sha256 = 'A'.repeat(64); },
    value => { value.assets[1].source_id = '/path'; }, value => { value.effects = Array(MEDIA_LIMITS.records + 1); },
    value => { value.assets = Array(1); }, value => { value.toolName = 'media.commit_upload'; }]) {
    const value = fixture(); change(value); assert.throws(() => buildMediaManifest(value));
  }
  let invoked = false; const value = fixture();
  Object.defineProperty(value, 'assets', { enumerable: true, get() { invoked = true; return []; } });
  assert.throws(() => buildMediaManifest(value)); assert.equal(invoked, false);
  const deep = fixture(); let object = {}; deep.assets[0].extra = object;
  for (let i = 0; i < 20; i++) object = object.next = {};
  assert.throws(() => buildMediaManifest(deep));
  const nodes = fixture(); nodes.assets[0].extra = Array(5000).fill(null);
  assert.throws(() => buildMediaManifest(nodes));
});
test('gallery order is semantic and existing ten shared plus distinct own main remains representable', () => {
  const input = group(2, 2), list = input.effects[0];
  const gallery = Array.from({ length: 10 }, (_, i) => source(6000 + i, input.effects[1].productId));
  input.assets.push(...gallery); input.graphBytes.oldBytes += 1000;
  list.before.galleryAssetKeys = gallery.map(key); list.after.galleryAssetKeys = gallery.map(key).reverse();
  const result = buildMediaManifest(input);
  assert.equal(list.after.galleryAssetKeys.length + 1, 11);
  const stable = clone(input); stable.effects[0].after.galleryAssetKeys.reverse();
  assert.notEqual(buildMediaManifest(stable).descriptor.manifestRoot, result.descriptor.manifestRoot);
  const over = clone(input); over.effects[0].after.galleryAssetKeys.push(key(input.assets[0]));
  assert.throws(() => buildMediaManifest(over));
  const extraListing = clone(fixture());
  for (let i = 0; i < 2; i++) {
    const id = uuid(700 + i), listId = uuid(800 + i);
    extraListing.effects.push({ kind: 'PRODUCT', productId: id, before: { listingId: listId, role: 'single', mainAssetKey: null },
      after: { listingId: listId, role: 'single', mainAssetKey: null } },
    { kind: 'LISTING', listingId: listId, before: { holderId: null, galleryAssetKeys: [] }, after: { holderId: null, galleryAssetKeys: [] } });
  }
  assert.throws(() => buildMediaManifest(extraListing));
});
test('identical gallery pixels retain multiple legacy positions without duplicating asset storage', () => {
  const input = fixture(); input.toolName = 'media.preview_layout';
  input.effects[1].before.galleryAssetKeys.push(input.effects[1].before.galleryAssetKeys[0]);
  input.effects[1].after.galleryAssetKeys.push(input.effects[1].after.galleryAssetKeys[0]);
  const manifest = buildMediaManifest(input);
  assert.equal(manifest.assets.length, 2);
  assert.equal(manifest.effects.find(row => row.kind === 'LISTING').before.galleryAssetKeys.length, 2);
  const ctx = context(input.toolName);
  assert.deepEqual(readMediaManifest(mediaManifestRows(manifest, ctx), operation(ctx)), manifest);
});
test('membership-changing catalog graph derives both scopes and cannot masquerade as direct media', () => {
  const first = uuid(71), second = uuid(72), sourceList = uuid(81), targetList = uuid(82);
  const value = fixture(); value.toolName = 'catalog.preview_update'; value.assets = [];
  value.graphBytes = { oldBytes: 0, newBytes: 0 };
  value.effects = [
    { kind: 'PRODUCT', productId: first, before: { listingId: sourceList, role: 'single', mainAssetKey: null },
      after: { listingId: targetList, role: 'variant', mainAssetKey: null } },
    { kind: 'PRODUCT', productId: second, before: { listingId: targetList, role: 'single', mainAssetKey: null },
      after: { listingId: targetList, role: 'holder', mainAssetKey: null } },
    { kind: 'LISTING', listingId: sourceList, before: { holderId: null, galleryAssetKeys: [] }, after: null },
    { kind: 'LISTING', listingId: targetList, before: { holderId: null, galleryAssetKeys: [] },
      after: { holderId: second, galleryAssetKeys: [] } },
  ];
  const result = buildMediaManifest(value), ctx = context(value.toolName);
  const frame = mediaManifestRows(result, ctx);
  assert.equal(frame.policy.required_scopes, 'catalog.write media.write');
  assert.equal(mediaPolicyForTool(value.toolName).flow, 'RESERVED');
  assert.deepEqual(readMediaManifest(frame, operation(ctx)), result);
  assert.throws(() => buildMediaManifest({ ...value, toolName: 'media.preview_layout' }));
});
