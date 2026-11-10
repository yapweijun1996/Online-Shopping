import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';
import { png } from './helpers/mcp-media-coordinator-fixture.js';
import { mediaHash } from '../src/mcp/media-policy.js';

const file = { download_url: 'https://files.oaiusercontent.com/synthetic-test', file_id: 'synthetic-file' };
const argumentsFor = async (f, key = 'synthetic-file-upload-01') => {
  const input = await f.input(png);
  return { productId: input.productId, targetSlot: input.targetSlot, expectedRevision: input.expectedRevision,
    idempotencyKey: key, file };
};
const tools = (f, downloadFile) => createOperationTools({ store: f.store, binding: f.binding, config: f.config,
  tenantGuard: f.guard, quickLogin: false, entries: f.entries, downloadFile });

test('file tool is discoverable and uses existing review/approval/commit with exact source bytes', async t => {
  const f = await mediaToolsFixture(t, 'sqlite');
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

test('current authorization, foreign product and stale revision fail before download', async t => {
  const f = await mediaToolsFixture(t, 'sqlite');
  let downloads = 0;
  const registered = tools(f, async () => { downloads++; return { bytes: png, mime: 'image/png' }; });
  const args = await argumentsFor(f);
  await assert.rejects(registered.call('media.upload_file', { ...args, productId: randomUUID() }, f.bearer), { status: 400 });
  await assert.rejects(registered.call('media.upload_file', { ...args, expectedRevision: '0'.repeat(64) }, f.bearer), { status: 409 });
  await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.grantId);
  await assert.rejects(registered.call('media.upload_file', args, f.bearer), { status: 403 });
  assert.equal(downloads, 0);
});

test('revocation during download cannot create a stage and production forbids injection', async t => {
  const f = await mediaToolsFixture(t, 'sqlite');
  const registered = tools(f, async () => {
    await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.grantId);
    return { bytes: png, mime: 'image/png' };
  });
  await assert.rejects(registered.call('media.upload_file', await argumentsFor(f), f.bearer), { status: 403 });
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 0);
  assert.throws(() => createOperationTools({ config: { production: true }, downloadFile: async () => ({}) }), TypeError);
});

test('changed bytes cannot reuse the original upload intent', async t => {
  const f = await mediaToolsFixture(t, 'sqlite');
  let bytes = png;
  const registered = tools(f, async () => ({ bytes, mime: 'image/png' }));
  const args = await argumentsFor(f);
  await registered.call('media.upload_file', args, f.bearer);
  bytes = Buffer.concat([png, Buffer.from('different')]);
  await assert.rejects(registered.call('media.upload_file', args, f.bearer), { status: 409 });
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 1);
});

test('interrupted fixed-chunk upload resumes without duplicating stored source bytes', async t => {
  const f = await mediaToolsFixture(t, 'sqlite');
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

test('gallery file review and approved commit preserve the existing main identity', async t => {
  const f = await mediaToolsFixture(t, 'sqlite');
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
