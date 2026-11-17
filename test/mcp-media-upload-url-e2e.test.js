import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startContainer } from '../media-codec/scripts/dev-container.js';
import { mediaHash } from '../src/mcp/media-policy.js';
import { uploadUrlE2eFixture } from './helpers/mcp-upload-url-e2e-fixture.js';

const exec = promisify(execFile), enabled = process.env.MCP_UPLOAD_URL_E2E === '1';
test('real TLS curl upload, native codec, both stores and five-minute single-use expiry', { skip: !enabled, timeout: 420000 }, async t => {
  assert.ok(process.env.SHOP_TEST_DATABASE_URL, 'Explicit acceptance requires PostgreSQL and SQLite.');
  const worker = await startContainer((await readFile(new URL('../.local/media-codec-image-id', import.meta.url), 'utf8')).trim());
  t.after(worker.stop);
  const { image } = await import('../media-codec/test/fixtures.js');
  const original = await image('jpeg', { width: 1024, height: 1024 });
  // Valid JPEG COM segments produce an exact 121 KiB transport fixture, without
  // trailing garbage or fabricated decode results. The native worker decodes it.
  const comments = []; let remaining = 121 * 1024 - original.length;
  while (remaining > 0) {
    const size = Math.min(remaining, 65537), chunk = Buffer.alloc(size, 32);
    assert.ok(size >= 4); chunk[0] = 255; chunk[1] = 254; chunk.writeUInt16BE(size - 2, 2);
    comments.push(chunk); remaining -= size;
  }
  const jpeg = Buffer.concat([original.subarray(0,2), ...comments, original.subarray(2)]);
  assert.equal(jpeg.length, 123904);
  for (const dialect of ['sqlite', 'postgres']) await t.test(dialect, async child => {
    const f = await uploadUrlE2eFixture(child, dialect, worker);
    const dto = reply => { assert.equal(reply.response.status, 200, JSON.stringify(reply.data));
      assert.ok(reply.data.result?.structuredContent, JSON.stringify(reply.data)); return reply.data.result.structuredContent; };
    const before = dto(await f.client.call('media.list', { productId: f.product.id }));
    let sequence = 0;
    const issue = async changes => dto(await f.client.call('media.request_upload_url', {
      productId: f.product.id, targetSlot: 'MAIN', expectedRevision: before.revision,
      sourceMime: 'image/jpeg', declaredBytes: jpeg.length, idempotencyKey: 'local-real-url-upload-' + ++sequence, ...changes,
    }));
    const path = join(f.dir, 'original.jpg'); await writeFile(path, jpeg, { mode: 0o600 });
    async function put(link, file = path, extra = []) {
      // No verbose logging: signed URLs and credential headers stay out of evidence.
      let stdout;
      try { ({ stdout } = await exec('curl', ['--silent','--show-error','--noproxy','*','--max-time','30',
        '--cacert',f.cert,'-w','\n%{http_code}','-T',file,...extra,link.uploadUrl], { maxBuffer: 65536, timeout: 35000 })); }
      catch { throw new Error('Local curl transport failed; capability redacted.'); }
      const split = stdout.lastIndexOf('\n'); return { status: Number(stdout.slice(split + 1)), body: JSON.parse(stdout.slice(0, split)) };
    }
    // Only the PostgreSQL subtest waits on the real clock. No expiration override.
    const expiring = dialect === 'postgres' ? await issue({}) : null;
    const link = await issue({ sourceSha256: mediaHash(jpeg) });
    const page = await f.call(new URL(link.uploadUrl).pathname);
    assert.equal(page.response.status, 200); assert.match(page.data, /type="file"/);
    assert.equal(page.response.headers.get('referrer-policy'), 'no-referrer');
    const uploaded = await put(link);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.stageId, link.stageId); assert.equal(uploaded.body.byteLength, jpeg.length);
    assert.equal(uploaded.body.sourceSha256, mediaHash(jpeg));
    const operation = uploaded.body.operation; assert.equal(operation.status, 'PENDING_APPROVAL');
    assert.equal(dto(await f.client.call('operations.get', { operationId: operation.operationId })).status, 'PENDING_APPROVAL');
    const stage = await f.store.get('SELECT state,declared_bytes,source_sha256,canonical_data FROM mcp_v2_media_stage WHERE id=?', link.stageId);
    assert.equal(stage.state, 'BOUND'); assert.equal(stage.declared_bytes, jpeg.length); assert.equal(stage.source_sha256, mediaHash(jpeg));
    assert.ok(stage.canonical_data.length > 0);
    const chunks = await f.store.all('SELECT data FROM mcp_v2_media_chunk WHERE stage_id=? ORDER BY "offset"', link.stageId);
    assert.deepEqual(Buffer.concat(chunks.map(row => Buffer.from(row.data))), jpeg);
    assert.deepEqual(dto(await f.client.call('media.list', { productId: f.product.id })), before);
    assert.equal((await f.client.call('media.commit_upload', { operationId: operation.operationId })).response.status, 403);
    assert.equal((await put(link)).status, 410);
    for (const changes of [{ declaredBytes: jpeg.length + 1 }, { sourceSha256: '0'.repeat(64) }, { sourceMime: 'image/png' }]) {
      const bad = await issue(changes); assert.equal((await put(bad)).status, 400); assert.equal((await put(bad)).status, 410);
    }
    for (const format of ['png','webp']) {
      const bytes = await image(format), file = join(f.dir, 'image.' + format); await writeFile(file, bytes);
      const valid = await issue({ sourceMime: 'image/' + format, declaredBytes: bytes.length });
      const result = await put(valid, file); assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.sourceSha256, mediaHash(bytes));
    }
    child.diagnostic(JSON.stringify({ bytes: jpeg.length, dialect, stageId: link.stageId,
      operationId: operation.operationId, status: operation.status, sourceSha256: stage.source_sha256,
      canonicalBytes: stage.canonical_data.length, productUnchanged: true, codecImage: worker.image }));
    if (expiring) {
      const wait = Date.parse(expiring.expiresAt) - Date.now() + 100;
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      assert.equal((await put(expiring)).status, 410);
      child.diagnostic('Real five-minute expiration rejected with HTTP 410.');
    }
  });
});
