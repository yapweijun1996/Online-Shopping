import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinatorFixture, png, stubDecode } from './helpers/mcp-media-coordinator-fixture.js';
import { createMediaCoordinator } from '../src/mcp/media-coordinator.js';
import { verifyMediaAuthority } from '../src/mcp/operation-authorization.js';
import { withMediaWriter } from '../src/mcp/media-storage.js';

const parts = bytes => Array.from({ length: Math.ceil(bytes.length / 3072) }, (_, n) => bytes.subarray(n * 3072, (n + 1) * 3072).toString('base64'));
async function captured(f, c) {
  const stage = await c.begin(f.bearer, await f.input());
  await c.append(f.bearer, { stageId: stage.stageId, offset: 0, dataParts: parts(png) });
  const capture = await f.guard.withActiveTenant(f.binding.tenantId, tenant => f.store.transaction(async () => {
    const context = await verifyMediaAuthority(f.store, { bearer: f.bearer, binding: f.binding, epochHash: f.epochHash,
      buildDigest: f.options.buildDigest, tenantRevision: tenant.revision });
    return withMediaWriter(f.store, context, w => c.uploadAdapter.media.capture(f.store, { stageId: stage.stageId }, context, w));
  }));
  return { stage, capture };
}
for (const dialect of ['sqlite','postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: capture acquires real lease and resolve does no SQL/fence work`, options, async t => {
    const f = await coordinatorFixture(t, dialect); let calls = 0;
    const c = createMediaCoordinator({ ...f.options, decode: async args => {
      assert.equal(f.depth(), 0); calls++;
      // A tenant writer can run while native work is outstanding.
      await f.store.transaction(() => f.store.run('UPDATE product SET stock_quantity=stock_quantity WHERE id=?', f.product.id));
      return stubDecode(args);
    } });
    const { stage, capture } = await captured(f, c);
    const result = await c.uploadAdapter.media.resolve(capture.resources, { signal: new AbortController().signal, deadline: performance.now() + 30000 });
    assert.equal(calls, 2); assert.ok(Buffer.isBuffer(result.result.image)); assert.equal(Object.hasOwn(result, 'old'), false);
    assert.equal(Object.hasOwn(result.lease, 'source'), false); assert.equal(result.lease.correlationId, stage.correlationId);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_media_stage WHERE id=?', stage.stageId)).state, 'VALIDATING');
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n, 0);
  });
  test(`${dialect}: short budget/pre-abort starts no decode and invalid codec proof cannot produce resolved resources`, options, async t => {
    const f = await coordinatorFixture(t, dialect); let calls = 0;
    const c = createMediaCoordinator({ ...f.options, decode: async args => { calls++; return { ...await stubDecode(args), sourceSha256: '0'.repeat(64) }; } });
    const { stage, capture } = await captured(f, c);
    await assert.rejects(c.uploadAdapter.media.resolve(capture.resources, { deadline: performance.now() + 4999 }), { code: 'MEDIA_DEADLINE' });
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(c.uploadAdapter.media.resolve(capture.resources, { deadline: performance.now() + 30000, signal: aborted.signal }), { code: 'MEDIA_DEADLINE' });
    assert.equal(calls, 0);
    await assert.rejects(c.uploadAdapter.media.resolve(capture.resources, { deadline: performance.now() + 30000 }), { code: 'MEDIA_CODEC_FAILED' });
    assert.equal(calls, 1);
    assert.equal((await f.store.get('SELECT validation_attempts FROM mcp_v2_media_stage WHERE id=?', stage.stageId)).validation_attempts, 1);
    assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_pin')).n, 0);
  });
}
