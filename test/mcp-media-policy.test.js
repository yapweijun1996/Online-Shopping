import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalOperationJson } from '../src/mcp/operation-envelope.js';
import { OPERATION_MUTATION_PAIRS } from '../src/mcp/operation-policy.js';
import { MEDIA_LIMITS } from '../src/mcp/media-schema.js';
import { makeMediaDescriptor, makeMediaPolicyRow, mediaDescriptorHash, mediaHash, mediaPolicyForTool,
  validateMediaDescriptor, validateRetainedMediaPolicy } from '../src/mcp/media-policy.js';
const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const input = () => ({ manifestRoot: mediaHash('manifest'), graphRevision: mediaHash('graph'), codecDigest: mediaHash('codec'),
  pageCount: 1, assetCount: 2, effectCount: 2 });
const context = toolName => ({ operationId: uuid(1), toolName, createdAt: '2026-11-05T00:00:00.000Z', expiresAt: '2026-11-05T00:10:00.000Z' });
function operation(tool = 'media.prepare_upload') {
  const policy = mediaPolicyForTool(tool), ctx = context(tool);
  return { id: ctx.operationId, tool_name: tool, media_policy_id: policy.policyId, required_scope: policy.requiredScopes[0],
    required_capability: policy.capability, risk: policy.risk, created_at: ctx.createdAt, expires_at: ctx.expiresAt };
}
test('fixed tools derive immutable HIGH policy; reserved catalog does not enter media registry', () => {
  for (const tool of ['media.prepare_upload', 'media.commit_upload', 'media.preview_layout', 'media.commit_layout']) {
    const value = mediaPolicyForTool(tool);
    assert.deepEqual(value.requiredScopes, ['media.write']); assert.equal(value.capability, 'catalog.write');
    assert.equal(value.risk, 'HIGH'); assert.equal(value.flow, 'DIRECT'); assert.ok(Object.isFrozen(value.requiredScopes));
    assert.equal(Object.hasOwn(OPERATION_MUTATION_PAIRS, tool), false);
  }
  const reserved = mediaPolicyForTool('catalog.preview_update');
  assert.equal(reserved.flow, 'RESERVED'); assert.deepEqual(reserved.requiredScopes, ['catalog.write', 'media.write']);
  for (const value of ['media.list', 'unknown', '', null, { scopes: [] }]) assert.throws(() => mediaPolicyForTool(value));
});
test('descriptor matches seven-field storage preimage and rejects policy reductions/extra fields', () => {
  const descriptor = makeMediaDescriptor('media.prepare_upload', input());
  assert.equal(mediaDescriptorHash(descriptor), mediaHash(canonicalOperationJson(descriptor)));
  assert.equal(descriptor.policyId, 'media-upload-v1'); assert.deepEqual(validateMediaDescriptor(descriptor), descriptor);
  for (const field of ['requiredScopes', 'capability', 'risk', 'accountId', 'tenantId', 'url', 'thumbnail']) {
    assert.throws(() => makeMediaDescriptor('media.prepare_upload', { ...input(), [field]: [] }));
    assert.throws(() => validateMediaDescriptor({ ...descriptor, [field]: false }));
  }
  assert.throws(() => validateMediaDescriptor({ ...descriptor, policyId: 'catalog-media-v1' }, 'media.prepare_upload'));
});
test('descriptor count/hash boundaries and non-data properties fail closed', () => {
  const checks = { pageCount: [0, MEDIA_LIMITS.pages + 1, 1.2], assetCount: [-1, MEDIA_LIMITS.assets + 1],
    effectCount: [0, MEDIA_LIMITS.records + 1], codecDigest: ['x'.repeat(64), 'A'.repeat(64)], manifestRoot: [null] };
  for (const [key, values] of Object.entries(checks)) for (const value of values) assert.throws(() => makeMediaDescriptor('media.preview_layout', { ...input(), [key]: value }));
  assert.throws(() => makeMediaDescriptor('media.preview_layout', { ...input(), effectCount: MEDIA_LIMITS.records, assetCount: 1 }));
  let accessed = false; const getter = { ...input() }; Object.defineProperty(getter, 'codecDigest', { enumerable: true, get() { accessed = true; return mediaHash('x'); } });
  assert.throws(() => makeMediaDescriptor('media.preview_layout', getter)); assert.equal(accessed, false);
  assert.throws(() => makeMediaDescriptor('media.preview_layout', Object.assign(Object.create({}), input())));
});
test('retained row binds tool/marker/scopes/time/hash and survives proposal scrub', () => {
  const descriptor = makeMediaDescriptor('media.prepare_upload', input());
  const row = makeMediaPolicyRow(context('media.prepare_upload'), descriptor), op = operation();
  assert.deepEqual(validateRetainedMediaPolicy(op, row, descriptor), descriptor);
  assert.deepEqual(validateRetainedMediaPolicy({ ...op, envelope_json: null, state: 'COMMITTED' }, row), descriptor);
  for (const patch of [{ required_scopes: 'catalog.write' }, { descriptor_hash: mediaHash('wrong') }, { manifest_root: mediaHash('wrong') },
    { operation_id: uuid(2) }, { created_at: '2026-11-05T00:00:01.000Z' }, { policy_id: 'media-layout-v1' }]) {
    assert.throws(() => validateRetainedMediaPolicy(op, { ...row, ...patch }));
  }
  for (const patch of [{ required_scope: 'catalog.write' }, { required_capability: 'orders.decide' }, { risk: 'LOW' },
    { media_policy_id: null }, { tool_name: 'media.preview_layout' }]) assert.throws(() => validateRetainedMediaPolicy({ ...op, ...patch }, row));
  assert.throws(() => makeMediaPolicyRow({ ...context('media.prepare_upload'), expiresAt: '2026-11-05T00:10:00.001Z' }, descriptor));
});
test('legacy null/absent marker keeps old handling but cannot hide media metadata', () => {
  for (const tool_name of ['company.preview_update', 'catalog.preview_update']) {
    assert.equal(validateRetainedMediaPolicy({ tool_name, media_policy_id: null }, null), null);
    assert.equal(validateRetainedMediaPolicy({ tool_name }, null), null);
  }
  assert.throws(() => validateRetainedMediaPolicy({ tool_name: 'media.prepare_upload', media_policy_id: null }, null));
  assert.throws(() => validateRetainedMediaPolicy({ tool_name: 'company.preview_update', media_policy_id: null }, null, {}));
  const descriptor = makeMediaDescriptor('catalog.preview_update', input());
  const row = makeMediaPolicyRow(context('catalog.preview_update'), descriptor);
  assert.equal(row.required_scopes, 'catalog.write media.write');
  assert.throws(() => validateRetainedMediaPolicy(operation('catalog.preview_update'), { ...row, required_scopes: 'catalog.write' }));
});
