import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../src/mcp/credentials.js';
import { operationAuthorityPolicy } from '../src/mcp/operation-policy.js';
import { verifyOperationAuthority, verifyMediaAuthority } from '../src/mcp/operation-authorization.js';
import { mediaEngineFixture } from './helpers/mcp-media-engine-fixture.js';
const base = process.env.SHOP_TEST_DATABASE_URL;
for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !base };
  test(`${dialect}: explicitly eligible catalog UPDATE requires both live scopes and separately bound consent`, options, async t => {
    const f = await mediaEngineFixture(t, dialect);
    const verify = extra => f.store.transaction(() => verifyOperationAuthority(f.store, { ...f.authorization,
      toolName: 'catalog.preview_update', mediaPolicyId: 'catalog-media-v1', resourceType:'product', catalogUpdateEnabled:true, ...extra }));
    assert.deepEqual((await verify()).requiredScopes, ['catalog.write', 'media.write']);
    for (const scope of ['catalog.write', 'media.write']) {
      await f.store.run('DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope=?', f.context.grantId, scope);
      await assert.rejects(verify(), { status: 403 });
      await f.store.run(`INSERT INTO mcp_v2_scope_consent(grant_id,tenant_id,account_id,client_id,scope,account_auth_version,epoch_hash,consented_at)
        VALUES(?,?,?,?,?,?,?,?)`, f.context.grantId, f.context.tenantId, f.context.accountId, f.context.clientId, scope,
      f.context.accountAuthVersion, f.context.epochHash, f.now);
    }
    await f.store.run("UPDATE oauth_token SET scopes='catalog.write' WHERE token_hash=?", hash(f.bearer));
    await assert.rejects(verify(), { status: 403 });
    assert.equal((await verify({ mediaPolicyId: null })).scope, 'catalog.write');
    await f.store.run("UPDATE oauth_token SET scopes='catalog.write media.write' WHERE token_hash=?", hash(f.bearer));
    await f.store.run("UPDATE oauth_grant SET scopes='catalog.write' WHERE id=?", f.context.grantId);
    await assert.rejects(verify(), { status: 403 });
  });
  test(`${dialect}: context is server-derived and stale/time/role/malformed scopes deny`, options, async t => {
    const f = await mediaEngineFixture(t, dialect);
    const verify = () => f.store.transaction(() => verifyMediaAuthority(f.store, { ...f.authorization,
      buildDigest: f.context.buildDigest, tenantRevision: f.context.tenantRevision }));
    assert.deepEqual(await verify(), f.context);
    for (const sql of ["UPDATE mcp_v2_scope_consent SET epoch_hash='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE scope='media.write'",
      "UPDATE mcp_v2_scope_consent SET consented_at='2999-01-01T00:00:00.000Z' WHERE scope='media.write'",
      "UPDATE seller_account SET role='STAFF' WHERE id IN(SELECT account_id FROM oauth_grant)",
      "UPDATE oauth_token SET scopes='catalog.write media.write media.write'",
      "UPDATE oauth_token SET scopes='catalog.write media.write unknown.scope'",
      "UPDATE oauth_token SET issued_at='2000-not-a-time'",
      "UPDATE shop_setup SET mode='demo' WHERE id=1"]) {
      await assert.rejects(f.store.transaction(async () => { await f.store.run(sql); await verify(); }), { status: 403 });
    }
    assert.deepEqual(await verify(), f.context);
  });
}
test('source policy rejects arbitrary scopes and mismatched media markers', () => {
  assert.equal(operationAuthorityPolicy('media.prepare_upload').risk, 'HIGH');
  assert.deepEqual(operationAuthorityPolicy('media.prepare_upload').requiredScopes, ['media.write']);
  assert.throws(() => operationAuthorityPolicy('catalog.preview_update', 'media-upload-v1'));
  assert.throws(() => operationAuthorityPolicy('media.prepare_upload', ['media.write']));
});
