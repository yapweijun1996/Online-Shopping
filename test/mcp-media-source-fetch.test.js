import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMediaSourceDownloaderForTest } from '../src/mcp/media-file-download.js';
import { createOperationTools } from '../src/mcp/operation-tools.js';
import { createProtocol } from '../src/mcp/protocol.js';
import { MEDIA_LIMITS } from '../src/mcp/media-schema.js';
import { mediaHash } from '../src/mcp/media-policy.js';
import { addGalleryImage } from '../src/products.js';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';
import { png } from './helpers/mcp-media-coordinator-fixture.js';

const sourceUrl = 'https://cdn.example.test:443/synthetic-source-locator.png';
const publicAnswer = { address: '8.8.8.8', family: 4 };
function sourceFixture({ resolve = async () => [publicAnswer], reply = () => ({}), timeoutMs } = {}) {
  const lookups = [], requests = [];
  const download = createMediaSourceDownloaderForTest({ timeoutMs,
    resolve: (host, options) => { lookups.push({ host, options }); return resolve(); },
    request: (url, options, respond) => {
      const req = new EventEmitter();
      const call = { url, options, destroyed: false };
      requests.push(call);
      req.destroy = () => { call.destroyed = true; };
      req.end = () => queueMicrotask(() => {
        const { body = png, status = 200, headers = {}, hang = false } = reply();
        const response = new PassThrough();
        response.statusCode = status;
        response.headers = { 'content-type': 'image/png', ...headers };
        response.complete = true;
        respond(response);
        if (!response.destroyed && !hang) response.end(body);
      });
      return req;
    },
  });
  return { download, lookups, requests };
}

test('fetch accepts only direct credential-free HTTPS DNS URLs on port 443', async () => {
  const source = sourceFixture();
  for (const url of ['http://cdn.example.test/image', '//cdn.example.test/image', 'file:///tmp/image',
    'https://cdn.example.test:444/image', 'https://user:password@cdn.example.test/image', 'https://@cdn.example.test/image',
    'https://cdn.example.test/image?signature=secret', 'https://cdn.example.test/image#fragment',
    'https://localhost/image', 'https://service.local/image', 'https://metadata.google.internal/image',
    'https://127.0.0.1/image', 'https://[::1]/image', 'https://0x7f000001/image', 'https://0251.0376.0251.0376/image',
    'https://8.8.8.8/image', 'https://cdn.example.test./image', 'https://cdn%2eexample.test/image',
    'https://-cdn.example.test/image', 'https://cdn.example.test\\@outside.example.test/image', 'https:/cdn.example.test/image']) {
    await assert.rejects(source.download(url), { status: 400 });
  }
  assert.equal(source.lookups.length, 0);
  assert.equal(source.requests.length, 0);
  assert.deepEqual(await source.download(sourceUrl), { bytes: png, mime: 'image/png' });
  assert.deepEqual(source.lookups, [{ host: 'cdn.example.test.', options: { all: true, verbatim: true } }]);
  const [{ url, options }] = source.requests;
  assert.equal(url.origin, 'https://cdn.example.test');
  assert.equal(options.method, 'GET');
  assert.equal(options.agent, false);
  assert.equal(options.rejectUnauthorized, true);
  assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Accept-Encoding']);
  options.lookup(url.hostname, { all: true }, (error, answers) => {
    assert.equal(error, null);
    assert.deepEqual(answers, [publicAnswer]);
  });
  options.lookup(url.hostname, {}, (error, address, family) => {
    assert.equal(error, null);
    assert.deepEqual({ address, family }, publicAnswer);
  });
  assert.equal(source.lookups.length, 1);
});

test('fetch rejects the whole DNS result if any answer is private or special-use', async () => {
  for (const [address, family] of [['127.0.0.1', 4], ['10.0.0.1', 4], ['172.16.0.1', 4], ['192.168.0.1', 4],
    ['100.100.100.200', 4], ['169.254.169.254', 4], ['168.63.129.16', 4], ['::1', 6], ['fd00:ec2::254', 6],
    ['fe80::1', 6], ['::ffff:a9fe:a9fe', 6], ['64:ff9b::a9fe:a9fe', 6], ['2002:a9fe:a9fe::1', 6],
    ['2001:db8::1', 6], ['2001:100::1', 6], ['2606:4700::1%en0', 6], ['8.8.8.8', 6]]) {
    const source = sourceFixture({ resolve: async () => [publicAnswer, { address, family }] });
    await assert.rejects(source.download(sourceUrl), { status: 503 }, address);
    assert.equal(source.requests.length, 0, address);
  }
});

test('fetch rejects redirects, compression, stream overruns and invalid or mismatched MIME', async () => {
  for (const [options, error] of [
    [{ status: 302, headers: { location: 'https://169.254.169.254/' } }, { status: 503 }],
    [{ status: 301, headers: { location: 'https://other.example.test/image' } }, { status: 503 }],
    [{ headers: { 'content-encoding': 'gzip' } }, { status: 503 }],
    [{ headers: { 'content-length': String(MEDIA_LIMITS.sourceBytes + 1) } }, { status: 503 }],
    [{ body: Buffer.alloc(MEDIA_LIMITS.sourceBytes + 1) }, { status: 503 }],
    [{ headers: { 'content-type': undefined } }, { code: 'MEDIA_FILE_MIME' }],
    [{ headers: { 'content-type': 'application/octet-stream' } }, { code: 'MEDIA_FILE_MIME' }],
    [{ headers: { 'content-type': 'text/html' } }, { code: 'MEDIA_FILE_MIME' }],
    [{ headers: { 'content-type': 'image/jpeg' } }, { code: 'MEDIA_FILE_MIME' }],
    [{ body: Buffer.from('<html>not an image</html>') }, { code: 'MEDIA_FILE_CONTENT' }],
    [{ body: Buffer.from('\xd2IFF0000WEBP', 'latin1'), headers: { 'content-type': 'image/webp' } }, { code: 'MEDIA_FILE_CONTENT' }],
  ]) {
    const source = sourceFixture({ reply: () => options });
    await assert.rejects(source.download(sourceUrl), error);
    assert.equal(source.lookups.length, 1);
    assert.equal(source.requests.length, 1);
    assert.equal(source.requests[0].destroyed, true);
  }
});

test('fetch accepts matching JPEG and WebP headers and signatures', async () => {
  for (const [mime, body] of [['image/jpeg', Buffer.from([255,216,255,224])], ['image/webp', Buffer.from('RIFF0000WEBP')]]) {
    const source = sourceFixture({ reply: () => ({ body, headers: { 'content-type': mime, 'content-length': String(body.length) } }) });
    assert.deepEqual(await source.download(sourceUrl), { bytes: body, mime });
  }
});

test('fetch deadlines close slow streams and retain permits for unresolved DNS without starting a late socket', async () => {
  const slow = sourceFixture({ reply: () => ({ hang: true }), timeoutMs: 15 });
  await assert.rejects(slow.download(sourceUrl), { status: 503 });
  assert.equal(slow.requests[0].destroyed, true);
  let resolve;
  const dns = new Promise(done => { resolve = done; });
  const source = sourceFixture({ resolve: () => dns, timeoutMs: 15 });
  try {
    await Promise.all(Array.from({ length: 4 }, () => assert.rejects(source.download(sourceUrl), { status: 503 })));
    await assert.rejects(source.download(sourceUrl), { status: 503 });
    assert.equal(source.lookups.length, 4);
  } finally {
    resolve([publicAnswer]);
  }
  await new Promise(done => setImmediate(done));
  assert.equal(source.requests.length, 0);
  assert.equal((await sourceFixture().download(sourceUrl)).mime, 'image/png');
});

test('production registration cannot replace the HTTPS downloader', () => {
  assert.throws(() => createOperationTools({ config: { production: true }, downloadSource: async () => ({}) }), TypeError);
});

const fetchInput = async f => ({ action: 'fetch', productId: f.product.id, expectedRevision: (await f.input()).expectedRevision,
  idempotencyKey: 'synthetic-image-fetch-01', sourceUrl });
function fetchRpc(f, downloadSource) {
  const operationTools = createOperationTools({ store: f.store, binding: f.binding, config: f.config,
    tenantGuard: f.guard, quickLogin: false, entries: f.entries, downloadSource });
  const protocol = createProtocol({ store: f.store, config: f.config, binding: { ...f.binding, mcpV2: f.config.mcpV2 },
    limit: async () => {}, operationTools });
  return async input => {
    const response = await protocol(new Request(f.binding.resource, { method: 'POST', headers: {
      authorization: 'Bearer ' + f.bearer, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'media.prepare_upload', arguments: { input } } }),
    }), 'synthetic-media-fetch');
    return response.json();
  };
}

for (const dialect of ['sqlite', 'postgres']) {
  const check = (name, run) => test(`${dialect}: media fetch ${name}`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, run);

  check('is discoverable, stages exactly 512 KiB and replays the same pending proposal', async t => {
    const f = await mediaToolsFixture(t, dialect), input = await fetchInput(f);
    const listed = (await f.rpc('tools/list', {})).data.result.tools.find(tool => tool.name === 'media.prepare_upload');
    assert.equal(listed.annotations.openWorldHint, true);
    assert.deepEqual(listed.inputSchema.properties.input.anyOf.find(branch => branch.properties.action.const === 'fetch').required,
      ['action', 'productId', 'expectedRevision', 'sourceUrl', 'idempotencyKey']);
    const body = Buffer.alloc(MEDIA_LIMITS.sourceBytes, 0x61);
    png.copy(body); // Synthetic decoder only; native validation is exercised separately.
    let bytes = body;
    const transport = sourceFixture({ reply: () => ({ body: bytes }) });
    const fetch = fetchRpc(f, transport.download);
    const dto = (await fetch(input)).result.structuredContent;
    assert.equal(dto.action, 'fetch');
    assert.equal(dto.stage, null);
    assert.equal(dto.operation.status, 'PENDING_APPROVAL');
    assert.equal(new URL(dto.operation.reviewUrl).origin, f.binding.issuer);
    assert.equal((await f.tool('media.commit_upload', { operationId: dto.operation.operationId })).response.status, 403);
    assert.equal((await f.input()).expectedRevision, input.expectedRevision);
    const stage = await f.store.get('SELECT * FROM mcp_v2_media_stage');
    assert.equal(stage.state, 'BOUND');
    assert.equal(stage.target_slot, 'GALLERY');
    assert.equal(stage.source_sha256, mediaHash(body));
    assert.equal(stage.declared_bytes, body.length);
    const chunks = await f.store.all('SELECT data FROM mcp_v2_media_chunk WHERE stage_id=? ORDER BY "offset"', stage.id);
    assert.equal(chunks.length, 15);
    assert.deepEqual(Buffer.concat(chunks.map(row => Buffer.from(row.data))), body);
    const repeated = (await fetch({ ...input, targetSlot: 'GALLERY' })).result.structuredContent.operation;
    assert.equal(repeated.replayed, true);
    assert.equal(repeated.operationId, dto.operation.operationId);
    bytes = png;
    assert.equal((await fetch(input)).error.code, -32009);
    assert.equal(transport.requests.length, 3);
    const operations = await f.store.all('SELECT * FROM mcp_v2_operation');
    assert.equal(operations.length, 1);
    assert.equal(operations[0].tool_name, 'media.prepare_upload');
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n, 0);
    assert.doesNotMatch(JSON.stringify([dto, operations, await f.store.all('SELECT * FROM mcp_audit')]), /synthetic-source-locator|cdn\.example\.test/);
  });

  check('rejects stale and unconsented requests before DNS and cannot accept approval fields', async t => {
    const f = await mediaToolsFixture(t, dialect), input = await fetchInput(f);
    const transport = sourceFixture(), fetch = fetchRpc(f, transport.download);
    assert.equal((await fetch({ ...input, expectedRevision: '0'.repeat(64) })).error.code, -32009);
    assert.equal((await fetch({ ...input, approved: true })).error.code, -32602);
    // Exercise the actual connector closure (no injectable transport needed for validation).
    const denied = await f.tool('media.prepare_upload', { input: { ...input, sourceUrl: 'https://192.168.1.1/private' } });
    assert.equal(denied.data.error.code, -32602);
    assert.doesNotMatch(JSON.stringify(denied.data), /192\.168\.1\.1|private/);
    await f.store.run("DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.grantId);
    assert.equal((await f.tool('media.prepare_upload', { input })).response.status, 403);
    assert.equal(transport.lookups.length, 0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 0);
  });

  check('does not stage a response that fails content validation', async t => {
    const f = await mediaToolsFixture(t, dialect);
    const source = sourceFixture({ reply: () => ({ headers: { 'content-type': 'image/jpeg' } }) });
    const reply = await fetchRpc(f, source.download)(await fetchInput(f));
    assert.equal(reply.error.code, -32602);
    assert.doesNotMatch(JSON.stringify(reply), /synthetic-source-locator|cdn\.example\.test/);
    assert.equal(source.requests.length, 1);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
  });

  check('rechecks revision and exact authority after download outside the tenant fence', async t => {
    const f = await mediaToolsFixture(t, dialect), input = await fetchInput(f);
    const fetch = fetchRpc(f, async url => {
      assert.equal(f.depth(), 0);
      assert.equal(url, sourceUrl);
      await addGalleryImage(f.store, f.product.id, 'data:image/png;base64,' + Buffer.concat([png, Buffer.from('portal edit')]).toString('base64'));
      return { bytes: png, mime: 'image/png' };
    });
    assert.equal((await fetch(input)).error.code, -32009);
    const registered = createOperationTools({ store: f.store, binding: f.binding, config: f.config,
      tenantGuard: f.guard, quickLogin: false, entries: f.entries,
      downloadSource: async () => { f.bump(); return { bytes: png, mime: 'image/png' }; } });
    await assert.rejects(registered.call('media.prepare_upload', { input: await fetchInput(f) }, f.bearer), { status: 403 });
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 0);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
  });
}
