import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationResourceBinding, readOperationRecord } from '../src/mcp/operation-record.js';
import { mediaHooksFixture } from './helpers/mcp-media-hooks-fixture.js';
import { seedSyntheticMediaApproval } from './helpers/mcp-media-engine-fixture.js';
import { maintainOperations } from '../src/mcp/operation-maintenance.js';

test('fixed operation resource bindings preserve company/catalog pseudo IDs and domain UUIDs', () => {
  for (const [tool, type, id] of [['company.preview_update', 'company', '1'], ['catalog.preview_create', 'catalog', 'catalog'],
    ['catalog.preview_update', 'product', randomUUID()], ['media.prepare_upload', 'product', randomUUID()],
    ['media.preview_layout', 'product', randomUUID()], ['inventory.preview_adjustment', 'inventory', randomUUID()],
    ['orders.preview_decision', 'order', randomUUID()]]) {
    const row = { tool_name: tool, resource_type: type, resource_id: id, expected_revision: 'a'.repeat(64) };
    assert.deepEqual(operationResourceBinding(row), { resourceType: type, resourceId: id });
    assert.equal(operationResourceBinding({ ...row, resource_id: 'unknown' }), null);
    assert.equal(operationResourceBinding({ ...row, resource_type: 'different' }), null);
    assert.equal(operationResourceBinding({ ...row, expected_revision: '1' }), null);
  }
  assert.equal(operationResourceBinding({ tool_name: '__proto__', expected_revision: 'a'.repeat(64) }), null);
});

for (const dialect of ['sqlite', 'postgres']) test(`${dialect}: shared record integrity validates immutable envelope and retained media after redaction`, async t => {
  const f = await mediaHooksFixture(t, dialect), operation = await f.prepare(await f.startStage());
  const options = { binding: f.binding, tenantRevision: f.context.tenantRevision, epochHash: f.context.epochHash,
    buildDigest: f.context.buildDigest, context: f.context, grant: { absolute_expires_at: f.context.grantExpiresAt },
    expected: { resourceType: 'product', mediaPolicyId: 'media-upload-v1', codecDigest: 'd'.repeat(64) } };
  const row = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?', operation.operationId);
  const record = await readOperationRecord(f.store, row, options);
  assert.equal(record.envelope.operationId, row.id); assert.equal(record.descriptor.policyId, 'media-upload-v1');
  for (const patch of [{ tenant_id: 'other' }, { resource_type: 'inventory' }, { risk: 'LOW' }, { epoch_hash: 'f'.repeat(64) },
    { expected_revision: 'f'.repeat(64) }, { preview_hash: 'f'.repeat(64) }, { envelope_json: '{}' }, { created_at: row.expires_at }]) {
    assert.equal(await readOperationRecord(f.store, { ...row, ...patch }, options), null);
  }
  await seedSyntheticMediaApproval(f, operation); await f.commit(operation);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(operation.expiresAt) + 1 });
  await maintainOperations(f.store, { enabled: true, tenantGuard: f.options.tenantGuard, tenantId: f.binding.tenantId });
  const redacted = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?', operation.operationId);
  const retained = await readOperationRecord(f.store, redacted, options);
  assert.equal(retained.envelope, null); assert.equal(retained.descriptor.manifestRoot, record.descriptor.manifestRoot);
});
