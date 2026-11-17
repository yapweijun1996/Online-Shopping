import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';
import { png } from './helpers/mcp-media-coordinator-fixture.js';
import { mediaHash } from '../src/mcp/media-policy.js';

for (const dialect of ['sqlite', 'postgres']) {
  const check = (name, run) => test(`${dialect}: upload URL ${name}`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, run);
  const args = async (f, changes = {}) => {
    const { sourceSha256: _optional, ...input } = await f.input(png);
    return { ...input, ...changes };
  };
  const issue = async (f, input) => {
    const reply = await f.tool('media.request_upload_url', input ?? await args(f));
    assert.equal(reply.response.status, 200, JSON.stringify(reply.data));
    assert.ok(reply.data.result?.structuredContent?.uploadUrl, JSON.stringify(reply.data));
    return reply.data.result.structuredContent;
  };
  const put = (f, link, bytes = png, headers = {}) => f.api(new Request(link.uploadUrl, {
    method: 'PUT', headers, body: bytes,
  }), { clientAddress: 'synthetic-url-upload' });

  check('raw bytes create the existing durable proposal without changing the product', async t => {
    const f = await mediaToolsFixture(t, dialect), before = await f.input(png);
    const input = await args(f), link = await issue(f, input);
    assert.equal(link.method, 'PUT');
    assert.ok(Date.parse(link.expiresAt) > Date.now() && Date.parse(link.expiresAt) <= Date.now() + 300000);
    assert.deepEqual(await issue(f, input), link);
    const page = await f.api(new Request(link.uploadUrl));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /type="file"/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    for (const suffix of ['js','css']) {
      const asset = await f.api(new Request(f.binding.issuer + '/media/upload-picker.' + suffix));
      assert.equal(asset.status, 200); assert.equal(asset.headers.get('cache-control'), 'no-store');
    }
    const response = await put(f, link), result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    assert.equal(result.stageId, link.stageId);
    assert.equal(result.sourceSha256, mediaHash(png));
    assert.equal(result.byteLength, png.length);
    assert.equal(result.operation.status, 'PENDING_APPROVAL');
    const stored = await f.store.get('SELECT state,product_id,target_slot,canonical_data,source_sha256 FROM mcp_v2_media_stage WHERE id=?', link.stageId);
    assert.equal(stored.state, 'BOUND'); assert.equal(stored.product_id, f.product.id); assert.equal(stored.target_slot, 'MAIN');
    assert.equal(stored.source_sha256, mediaHash(png)); assert.deepEqual(Buffer.from(stored.canonical_data), png);
    assert.equal((await f.input(png)).expectedRevision, before.expectedRevision);
    assert.equal((await f.tool('media.commit_upload', { operationId: result.operation.operationId })).response.status, 403);
    assert.equal((await put(f, link)).status, 410);
    assert.equal((await f.api(new Request(link.uploadUrl))).status, 410);
  });

  check('size, digest, signature, encoding and MIME failures consume the token without creating a proposal', async t => {
    const f = await mediaToolsFixture(t, dialect);
    const cases = [
      [{ declaredBytes: png.length + 1 }, png, {}],
      [{ declaredBytes: png.length - 1 }, png, {}],
      [{ sourceSha256: 'a'.repeat(64) }, png, {}],
      [{ sourceMime: 'image/jpeg' }, png, {}],
      [{}, Buffer.alloc(png.length), {}],
      [{}, png, { 'content-type': 'image/jpeg' }],
      [{}, png, { 'content-encoding': 'gzip' }],
      [{}, png, { 'content-length': String(png.length + 1) }],
    ];
    for (const [index, [changes, bytes, headers]] of cases.entries()) {
      const link = await issue(f, await args(f, { ...changes, idempotencyKey: 'synthetic-invalid-url-' + index }));
      assert.ok([400,413].includes((await put(f, link, bytes, headers)).status));
      assert.equal((await put(f, link)).status, 410);
    }
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 0);
  });

  check('token forgery, changed intent, unsafe origin and revocation are denied', async t => {
    const f = await mediaToolsFixture(t, dialect), input = await args(f), link = await issue(f, input);
    const conflict = await f.tool('media.request_upload_url', { ...input, targetSlot: 'GALLERY' });
    assert.equal(conflict.data.error.code, -32009);
    const forged = { ...link, uploadUrl: link.uploadUrl.slice(0, -1) + (link.uploadUrl.endsWith('A') ? 'B' : 'A') };
    assert.equal((await put(f, forged)).status, 410);
    assert.equal((await put(f, link, png, { origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await put(f, { ...link, uploadUrl: link.uploadUrl + '?redirect=https://attacker.invalid' })).status, 400);
    await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.grantId);
    assert.equal((await put(f, link)).status, 403);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
  });

  check('streamed overrun and simultaneous token reuse cannot substitute bytes', async t => {
    const f = await mediaToolsFixture(t, dialect);
    const bad = await issue(f), stream = new ReadableStream({ start(controller) {
      controller.enqueue(png); controller.enqueue(new Uint8Array([0])); controller.close();
    } });
    const overrun = await f.api(new Request(bad.uploadUrl, { method: 'PUT', body: stream, duplex: 'half' }));
    assert.equal(overrun.status, 413);
    const link = await issue(f, await args(f, { idempotencyKey: 'synthetic-url-race-001' }));
    const responses = await Promise.all([put(f, link), put(f, link)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201,410]);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 1);
  });

  check('closed inputs, stale revision and lifecycle changes cannot create upload authority', async t => {
    const f = await mediaToolsFixture(t, dialect), input = await args(f);
    for (const changes of [{ declaredBytes: 524289 }, { declaredBytes: 0 }, { sourceMime: 'image/gif' },
      { sourceSha256: 'invalid' }, { uploadUrl: 'https://attacker.invalid' }, { approved: true },
      { productId: '11111111-1111-4111-8111-111111111111' }]) {
      const result = await f.tool('media.request_upload_url', { ...input, ...changes });
      assert.equal(result.data.error.code, -32602);
    }
    assert.equal((await f.tool('media.request_upload_url', { ...input, expectedRevision: '0'.repeat(64) })).data.error.code, -32009);
    const link = await issue(f, input);
    let release, reading;
    const started = new Promise(resolve => { reading = resolve; });
    const stream = new ReadableStream({ start(controller) { release = () => { controller.enqueue(png); controller.close(); }; },
      pull() { reading(); } }, { highWaterMark: 0 });
    const pending = f.api(new Request(link.uploadUrl, { method: 'PUT', body: stream, duplex: 'half' }));
    // The body read must finish before exact original lifecycle context is rechecked.
    await started; f.bump(); release();
    assert.equal((await pending).status, 403);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 0);
  });

  check('a different connector or shop cannot redeem the capability', async t => {
    const original = await mediaToolsFixture(t, dialect), other = await mediaToolsFixture(t, dialect);
    const link = await issue(original);
    assert.equal((await put(other, link)).status, 410);
    assert.equal((await other.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 0);
    assert.equal((await put(original, link)).status, 201);
  });
}
