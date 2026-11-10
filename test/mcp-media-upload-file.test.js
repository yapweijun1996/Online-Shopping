import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';
import { png } from './helpers/mcp-media-coordinator-fixture.js';
import { mediaHash } from '../src/mcp/media-policy.js';
import { addGalleryImage } from '../src/products.js';

const file = { download_url: 'https://files.oaiusercontent.com/synthetic-test', file_id: 'synthetic-file' };
const argumentsFor = async (f, key = 'synthetic-file-upload-01') => {
  const input = await f.input(png);
  return { productId: input.productId, targetSlot: input.targetSlot, expectedRevision: input.expectedRevision,
    idempotencyKey: key, file };
};
const tools = (f, downloadFile) => createOperationTools({ store: f.store, binding: f.binding, config: f.config,
  tenantGuard: f.guard, quickLogin: false, entries: f.entries, downloadFile });

for (const dialect of ['sqlite', 'postgres']) {
const mediaTest = (name, run) => test(`${dialect}: ${name}`,
  { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, run);

mediaTest('file tool is discoverable and uses existing review/approval/commit with exact source bytes', async t => {
  const f = await mediaToolsFixture(t, dialect);
  const bytes = Buffer.concat([png, Buffer.alloc(50000, 3)]);
  const registered = tools(f, async () => ({ bytes, mime: 'image/png' }));
  const listed = await f.rpc('tools/list', {});
  const advertised = listed.data.result.tools.find(tool => tool.name === 'media.upload_file');
  assert.deepEqual(advertised._meta, { 'openai/fileParams': ['file'] });
  assert.deepEqual(advertised.inputSchema.properties.file.required, ['download_url', 'file_id']);
  assert.deepEqual(registered.find('media.upload_file')._meta, { 'openai/fileParams': ['file'] });
  assert.deepEqual(registered.requiredScopes('media.upload_file'), ['media.write']);
  const args = await argumentsFor(f);
  const first = await registered.call('media.upload_file', args, f.bearer);
  assert.equal(first.status, 'PENDING_APPROVAL');
  assert.equal((await f.tool('media.commit_upload', { operationId: first.operationId })).response.status, 403);
  const chunks = await f.store.all('SELECT data FROM mcp_v2_media_chunk ORDER BY "offset"');
  assert.deepEqual(Buffer.concat(chunks.map(row => Buffer.from(row.data))), bytes);
  const repeated = await registered.call('media.upload_file', args, f.bearer);
  assert.equal(repeated.operationId, first.operationId);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 1);
  await f.approve(first);
  assert.equal((await f.tool('media.commit_upload', { operationId: first.operationId })).data.result.structuredContent.status, 'COMMITTED');
  const current = (await f.tool('media.list', { productId: args.productId })).data.result.structuredContent;
  assert.ok(current.items[0].mainAssetKey);
  assert.notEqual(current.revision, args.expectedRevision);
});

mediaTest('current authorization, foreign product and stale revision fail before download', async t => {
  const f = await mediaToolsFixture(t, dialect);
  let downloads = 0;
  const registered = tools(f, async () => { downloads++; return { bytes: png, mime: 'image/png' }; });
  const args = await argumentsFor(f);
  await assert.rejects(registered.call('media.upload_file', { ...args, productId: randomUUID() }, f.bearer), { status: 400 });
  await assert.rejects(registered.call('media.upload_file', { ...args, expectedRevision: '0'.repeat(64) }, f.bearer), { status: 409 });
  await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.grantId);
  await assert.rejects(registered.call('media.upload_file', args, f.bearer), { status: 403 });
  assert.equal(downloads, 0);
});

mediaTest('revocation during download cannot create a stage and production forbids injection', async t => {
  const f = await mediaToolsFixture(t, dialect);
  const registered = tools(f, async () => {
    await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.grantId);
    return { bytes: png, mime: 'image/png' };
  });
  await assert.rejects(registered.call('media.upload_file', await argumentsFor(f), f.bearer), { status: 403 });
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 0);
  assert.throws(() => createOperationTools({ config: { production: true }, downloadFile: async () => ({}) }), TypeError);
});

mediaTest('changed bytes cannot reuse the original upload intent', async t => {
  const f = await mediaToolsFixture(t, dialect);
  let bytes = png;
  const registered = tools(f, async () => ({ bytes, mime: 'image/png' }));
  const args = await argumentsFor(f);
  await registered.call('media.upload_file', args, f.bearer);
  bytes = Buffer.concat([png, Buffer.from('different')]);
  await assert.rejects(registered.call('media.upload_file', args, f.bearer), { status: 409 });
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 1);
});

mediaTest('interrupted fixed-chunk upload resumes without duplicating stored source bytes', async t => {
  const f = await mediaToolsFixture(t, dialect);
  const bytes = Buffer.concat([png, Buffer.alloc(50000, 4)]), args = await argumentsFor(f);
  const stage = await f.coordinator.begin(f.bearer, { productId: args.productId, targetSlot: args.targetSlot,
    expectedRevision: args.expectedRevision, idempotencyKey: args.idempotencyKey,
    sourceSha256: mediaHash(bytes), sourceMime: 'image/png', declaredBytes: bytes.length });
  const first = bytes.subarray(0, 36864);
  await f.coordinator.append(f.bearer, { stageId: stage.stageId, offset: 0,
    dataParts: Array.from({ length: 12 }, (_, index) => first.subarray(index * 3072, (index + 1) * 3072).toString('base64')) });
  const operation = await tools(f, async () => ({ bytes, mime: 'image/png' })).call('media.upload_file', args, f.bearer);
  assert.equal(operation.status, 'PENDING_APPROVAL');
  const chunks = await f.store.all('SELECT data FROM mcp_v2_media_chunk WHERE stage_id=? ORDER BY "offset"', stage.stageId);
  assert.equal(chunks.length, 2);
  assert.deepEqual(Buffer.concat(chunks.map(row => Buffer.from(row.data))), bytes);
});

mediaTest('gallery file review and approved commit preserve the existing main identity', async t => {
  const f = await mediaToolsFixture(t, dialect);
  const args = { ...await argumentsFor(f), targetSlot: 'GALLERY' };
  const before = (await f.tool('media.list', { productId: args.productId })).data.result.structuredContent;
  const bytes = Buffer.concat([png, Buffer.from('gallery-image')]);
  const operation = await tools(f, async () => ({ bytes, mime: 'image/png' })).call('media.upload_file', args, f.bearer);
  await f.approve(operation);
  assert.equal((await f.tool('media.commit_upload', { operationId: operation.operationId })).data.result.structuredContent.status, 'COMMITTED');
  const after = (await f.tool('media.list', { productId: args.productId })).data.result.structuredContent;
  assert.equal(after.items[0].mainAssetKey, before.items[0].mainAssetKey);
  assert.equal(after.items[0].gallery.length, before.items[0].gallery.length + 1);
});

mediaTest('maximum source uses fifteen chunks and stores the exact source SHA-256', async t => {
  const f = await mediaToolsFixture(t, dialect);
  const bytes = Buffer.alloc(524288, 0x69); png.copy(bytes);
  const args = await argumentsFor(f, 'synthetic-maximum-file-01');
  const operation = await tools(f, async () => ({ bytes, mime: 'image/png' })).call('media.upload_file', args, f.bearer);
  assert.equal(operation.status, 'PENDING_APPROVAL');
  const stage = await f.store.get('SELECT id,source_sha256,declared_bytes,next_offset FROM mcp_v2_media_stage');
  assert.equal(stage.source_sha256, mediaHash(bytes));
  assert.equal(stage.declared_bytes, bytes.length);
  assert.equal(stage.next_offset, bytes.length);
  const chunks = await f.store.all('SELECT data,byte_length FROM mcp_v2_media_chunk WHERE stage_id=? ORDER BY "offset"', stage.id);
  assert.equal(chunks.length, 15);
  assert.ok(chunks.every(row => row.byte_length <= 36864));
  assert.deepEqual(Buffer.concat(chunks.map(row => Buffer.from(row.data))), bytes);
});

mediaTest('two approved MAIN replacements commit once and preserve another product', async t => {
  const f = await mediaToolsFixture(t, dialect);
  const other = await f.make('UNRELATED-MEDIA');
  const unrelatedBefore = await f.store.get('SELECT * FROM product WHERE id=?', other.id);
  const args = await argumentsFor(f, 'synthetic-concurrent-main-01');
  const bytes = [Buffer.concat([png, Buffer.from('replacement-one')]), Buffer.concat([png, Buffer.from('replacement-two')])];
  const proposals = await Promise.all(bytes.map((source, index) => tools(f, async () => ({ bytes: source, mime: 'image/png' }))
    .call('media.upload_file', { ...args, idempotencyKey: args.idempotencyKey + index }, f.bearer)));
  for (const proposal of proposals) await f.approve(proposal);
  const replies = await Promise.all(proposals.map(proposal => f.tool('media.commit_upload', { operationId: proposal.operationId })));
  const results = replies.map(reply => reply.data.result?.structuredContent);
  assert.equal(results.filter(result => result?.status === 'COMMITTED').length, 1, JSON.stringify(replies.map(reply => reply.data)));
  assert.equal(results.filter(result => result?.error === 'STALE_REVISION').length, 1, JSON.stringify(replies.map(reply => reply.data)));
  const winner = results.findIndex(result => result?.status === 'COMMITTED');
  const listed = (await f.tool('media.list', { productId: args.productId })).data.result.structuredContent;
  const main = listed.assets.find(asset => asset.assetKey === listed.items[0].mainAssetKey);
  assert.equal(main.sha256, mediaHash(bytes[winner]));
  assert.deepEqual(await f.store.get('SELECT * FROM product WHERE id=?', other.id), unrelatedBefore);
  assert.equal((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE event='COMMIT'")).n, 1);
});

mediaTest('media revision changed during download rolls back the upload stage', async t => {
  const f = await mediaToolsFixture(t, dialect);
  const args = await argumentsFor(f, 'synthetic-download-revision-01');
  const externallyAdded = Buffer.concat([png, Buffer.from('concurrent-portal-image')]);
  const registered = tools(f, async () => {
    await addGalleryImage(f.store, args.productId, 'data:image/png;base64,' + externallyAdded.toString('base64'));
    return { bytes: Buffer.concat([png, Buffer.from('should-not-upload')]), mime: 'image/png' };
  });
  await assert.rejects(registered.call('media.upload_file', args, f.bearer), { status: 409 });
  for (const table of ['mcp_v2_media_stage', 'mcp_v2_media_chunk', 'mcp_v2_operation']) {
    assert.equal((await f.store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n, 0);
  }
  const after = (await f.tool('media.list', { productId: args.productId })).data.result.structuredContent;
  assert.ok(after.assets.some(asset => asset.sha256 === mediaHash(externallyAdded)));
});
}
