import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mediaHooksFixture } from './helpers/mcp-media-hooks-fixture.js';
import { companyMutationTool, companyRevision } from '../src/mcp/company-tools.js';
import { createOperationEngine } from '../src/mcp/operation-engine.js';
import { verifyOperationControlAuthority } from '../src/mcp/operation-authorization.js';
import { hash } from '../src/mcp/credentials.js';

// Internal authority fixture; real OAuth/RPC has separate integration tests.
async function fixture(t, dialect) {
  const f = await mediaHooksFixture(t, dialect), scopes = 'catalog.write media.write company.write operations.read operations.cancel';
  await f.store.run('UPDATE oauth_grant SET scopes=? WHERE id=?', scopes, f.context.grantId);
  await f.store.run('UPDATE oauth_token SET scopes=? WHERE token_hash=?', scopes, hash(f.bearer));
  for (const scope of ['company.write', 'operations.read', 'operations.cancel']) await f.store.run(`INSERT INTO mcp_v2_scope_consent
    (grant_id,tenant_id,account_id,client_id,scope,account_auth_version,epoch_hash,consented_at) VALUES(?,?,?,?,?,?,?,?)`,
  f.context.grantId, f.context.tenantId, f.context.accountId, f.context.clientId, scope, f.context.accountAuthVersion, f.context.epochHash, f.now);
  const operation = await f.prepare(await f.startStage());
  const verify = (toolName = 'operations.get', patch = {}) => f.options.tenantGuard.withActiveTenant(f.binding.tenantId, tenant =>
    f.store.transaction(() => verifyOperationControlAuthority(f.store, { bearer: f.bearer, binding: f.binding, epochHash: f.context.epochHash,
      buildDigest: f.context.buildDigest, tenantRevision: tenant.revision, operationId: operation.operationId, toolName, ...patch })));
  return { ...f, operation, verify };
}
for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: control identity scope and record-integrity matrix fails closed`, async t => {
    const f = await fixture(t, dialect);
    for (const patch of [{ bearer: 'invalid' }, { operationId: randomUUID() }, { epochHash: 'f'.repeat(64) },
      { buildDigest: 'f'.repeat(64) }, { tenantRevision: 2 }, { binding: { ...f.binding, tenantId: 'other' } }]) await assert.rejects(f.verify('operations.get', patch), { status: 403 });
    const mutations = [
      ["UPDATE oauth_grant SET scopes='operations.read' WHERE id=?", f.context.grantId],
      ["DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='operations.read'", f.context.grantId],
      ["DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.context.grantId],
      ["UPDATE mcp_v2_operation SET client_id='another-client' WHERE id=?", f.operation.operationId],
      ["UPDATE mcp_v2_operation SET grant_id=? WHERE id=?", randomUUID(), f.operation.operationId],
      ["UPDATE seller_account SET active=0 WHERE id=?", f.account.id],
      ["UPDATE mcp_v2_operation SET risk='LOW' WHERE id=?", f.operation.operationId],
    ];
    for (const [sql, ...args] of mutations) {
      const rollback = new Error('Synthetic rollback');
      await assert.rejects(f.store.transaction(async () => { await f.store.run(sql, ...args); await assert.rejects(f.verify(), { status: 403 }); throw rollback; }), error => error === rollback);
    }
  });
  test(`${dialect}: controls require their own consent and underlying current role`, async t => {
    const f = await fixture(t, dialect);
    for (const name of ['operations.get', 'operations.audit', 'operations.cancel']) {
      const value = await f.verify(name);
      assert.deepEqual(value.authority.requiredScopes, [name === 'operations.cancel' ? 'operations.cancel' : 'operations.read', 'media.write']);
      assert.equal(value.record.row.id, f.operation.operationId);
    }
    const company = createOperationEngine({ ...f.options, adapters: { 'company.preview_update': companyMutationTool().adapter } });
    const op = await company.prepare({ bearer: f.bearer, toolName: 'company.preview_update', idempotencyKey: 'synthetic-company-control-0001',
      args: { expectedRevision: await companyRevision(f.store), changes: { availabilityText: 'Synthetic company operation' } } });
    assert.equal((await f.verify('operations.get', { operationId: op.operationId })).record.row.resource_id, '1');
    await f.store.run("UPDATE seller_account SET role='MANAGER' WHERE id=?", f.account.id);
    assert.ok(await f.verify());
    await assert.rejects(f.verify('operations.get', { operationId: op.operationId }), { status: 403 });
  });
  test(`${dialect}: later token issuance cannot activate post-operation control consent`, async t => {
    const f = await fixture(t, dialect), row = await f.store.get('SELECT created_at FROM mcp_v2_operation WHERE id=?', f.operation.operationId);
    const late = new Date(Date.parse(row.created_at) + 1).toISOString();
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(late) + 1 });
    await f.store.run("UPDATE mcp_v2_scope_consent SET consented_at=? WHERE grant_id=? AND scope='operations.read'", late, f.context.grantId);
    await f.store.run('UPDATE oauth_token SET issued_at=? WHERE token_hash=?', late, hash(f.bearer));
    await assert.rejects(f.verify(), { status: 403 });
  });
}
