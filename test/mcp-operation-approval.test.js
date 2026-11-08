import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ensureAdmin, createSession, deleteSession } from '../src/auth.js';
import { setupShop } from '../src/shop-setup.js';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { ApiError } from '../src/http.js';
import { hash, secret } from '../src/mcp/credentials.js';
import { operationSchema } from '../src/mcp/operation-schema.js';
import { canonicalOperationJson, operationPreviewHash } from '../src/mcp/operation-envelope.js';
import { operationEpochHash } from '../src/mcp/operation-epoch.js';
import { createOperationApproval, createOperationReview } from '../src/mcp/operation-approval.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) {
  throw new Error('Disposable PostgreSQL test database required.');
}
const password = 'Synthetic-approval-password-2026!';

async function fixture(t, engine) {
  let store;
  if (engine === 'sqlite') {
    store = await openDatabase(':memory:');
    t.after(() => store.close());
  } else {
    const pool = new pg.Pool({ connectionString: base });
    const name = `shopping_test_approval_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE DATABASE ${name}`);
    const url = new URL(base); url.pathname = '/' + name;
    store = await openPostgresDatabase(url.href);
    t.after(async () => {
      await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end();
    });
  }
  await store.transaction(() => store.exec(operationSchema(engine)));
  await ensureAdmin(store, 'synthetic_owner', password);
  await setupShop(store, { mode: 'production', shopName: 'Synthetic approval shop' });
  const account = await store.get('SELECT * FROM seller_account WHERE username_key = ?', 'synthetic_owner');
  const session = await createSession(store, account.id);
  const now = new Date().toISOString(), later = new Date(Date.now() + 600000).toISOString();
  const binding = { tenantId: 'synthetic', issuer: 'https://seller.example.test', resource: 'https://seller.example.test/mcp' };
  // Test-only guard; production needs a platform lock held across the callback.
  const tenantGuard = { withActiveTenant: async (id, work) => {
    if (id !== binding.tenantId) throw new ApiError(403, 'FORBIDDEN', 'Synthetic tenant denied.');
    return work({ revision: 1 });
  } };
  const clientId = secret(), grantId = randomUUID(), epoch = secret(), epochHash = operationEpochHash(epoch), buildDigest = 'e'.repeat(64);
  await store.run(`INSERT INTO oauth_client(id, tenant_id, issuer, client_name, redirect_uris_json, auth_method, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, clientId, binding.tenantId, binding.issuer, 'Synthetic client',
  JSON.stringify(['https://client.example.test/callback']), 'none', now, later);
  await store.run(`INSERT INTO oauth_grant(id, account_id, client_id, tenant_id, issuer, resource, scopes,
    account_auth_version, created_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  grantId, account.id, clientId, binding.tenantId, binding.issuer, binding.resource, 'catalog.write', account.oauth_auth_version, now, later);
  await store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, grantId, binding.tenantId, account.id, clientId, 'catalog.write', account.oauth_auth_version, epochHash, now);
  const request = (patch = {}) => new Request('https://seller.example.test/api/v1/seller/mcp/approval', {
    method: 'POST', headers: { origin: 'https://seller.example.test', cookie: `seller_session=${session.token}`,
      'x-csrf-token': session.csrfToken, ...patch },
  });
  async function operation(expired = false, toolName = 'catalog.preview_update', after = 'Synthetic new name') {
    const createdAt = new Date(Date.now() - (expired ? 120000 : 0)).toISOString();
    const expiresAt = new Date(Date.now() + (expired ? -60000 : 300000)).toISOString();
    const value = {
      version: 1, operationId: randomUUID(), tenantId: binding.tenantId, tenantRevision: 1, accountId: account.id, clientId, grantId, epochHash, buildDigest,
      issuer: binding.issuer, resource: binding.resource, toolName, resourceType: 'product',
      resourceId: randomUUID(), expectedRevision: 1, requiredScope: 'catalog.write', requiredCapability: 'catalog.write',
      risk: 'MEDIUM', createdAt, expiresAt, idempotencyHash: hash(secret()), correlationId: randomUUID(),
      proposal: { before: { name: 'Synthetic old name' }, after: { name: after } },
    };
    const previewHash = operationPreviewHash(value);
    const columns = ['id', 'tenant_id', 'tenant_revision', 'account_id', 'client_id', 'grant_id', 'epoch_hash', 'build_digest', 'issuer', 'resource', 'tool_name',
      'required_scope', 'required_capability', 'risk', 'resource_type', 'resource_id', 'expected_revision',
      'envelope_json', 'preview_hash', 'request_hash', 'idempotency_hash', 'state', 'created_at', 'expires_at', 'correlation_id', 'receipt_expires_at'];
    const values = [value.operationId, value.tenantId, value.tenantRevision, value.accountId, value.clientId, value.grantId, value.epochHash, value.buildDigest, value.issuer,
      value.resource, value.toolName, value.requiredScope, value.requiredCapability, value.risk, value.resourceType,
      value.resourceId, String(value.expectedRevision), canonicalOperationJson(value), previewHash, hash('synthetic-request'),
      value.idempotencyHash, 'PENDING_APPROVAL', value.createdAt, value.expiresAt, value.correlationId, new Date(Date.parse(value.expiresAt) + 86400000).toISOString()];
    await store.run(`INSERT INTO mcp_v2_operation(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...values);
    const challenge = secret();
    await store.run(`INSERT INTO mcp_v2_approval_challenge(id, operation_id, nonce_hash, created_at, expires_at, account_id, session_hash, account_auth_version, bound_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), value.operationId, hash(challenge + ':' + previewHash), now, later, account.id, hash(session.token), account.oauth_auth_version, now);
    return { value, previewHash, input: { operationId: value.operationId, previewHash, challenge, decision: 'approve' } };
  }
  return { store, account, session, binding, grantId, epoch, buildDigest, tenantGuard, request, operation };
}

for (const engine of ['sqlite', 'postgres']) {
  test(`${engine}: approval requires current seller session, exact preview and live grant`,
    { skip: engine === 'postgres' && !base }, async (t) => {
      const f = await fixture(t, engine);
      const config = { store: f.store, binding: f.binding, sellerOrigin: f.binding.issuer, quickLogin: false,
        epoch: f.epoch, buildDigest: f.buildDigest, tenantGuard: f.tenantGuard, enabled: true };
      assert.throws(() => createOperationApproval({ ...config, enabled: false }), TypeError);
      assert.throws(() => createOperationApproval({ ...config, tenantGuard: undefined }), TypeError);
      assert.throws(() => createOperationApproval({ ...config, epoch: undefined }), TypeError);
      assert.throws(() => createOperationApproval({ ...config, buildDigest: 'invalid' }), TypeError);
      assert.throws(() => createOperationApproval({ ...config, quickLogin: true }), TypeError);
      assert.throws(() => createOperationApproval({ ...config, sellerOrigin: 'http://seller.example.test' }), TypeError);
      assert.throws(() => createOperationApproval({ ...config, binding: { ...f.binding, resource: 'https://other.example.test/mcp' } }), TypeError);
      const approve = createOperationApproval(config);
      const review = createOperationReview(config);
      const denied = (promise) => assert.rejects(promise, { status: 403, code: 'FORBIDDEN' });
      const injection = '</pre><script>window.injected = true</script>';
      const op = await f.operation(false, 'catalog.preview_update', injection);
      const reviewRequest = new Request('https://seller.example.test/api/v1/seller/mcp/operations/' + op.value.operationId,
        { method: 'GET', headers: { cookie: `seller_session=${f.session.token}` } });
      const reviewed = await review(reviewRequest, op.value.operationId);
      assert.equal(reviewed.proposal.after.name, injection);
      op.input.challenge = reviewed.challenge;
      await denied(review(new Request(reviewRequest.url), op.value.operationId));
      await denied(review(new Request(reviewRequest.url, { headers: { origin: 'https://other.example.test',
        cookie: `seller_session=${f.session.token}` } }), op.value.operationId));
      await denied(approve(f.request({ origin: 'https://other.example.test' }), op.input, 'ip-origin'));
      await denied(approve(f.request({ 'x-csrf-token': 'wrong' }), op.input, 'ip-csrf'));
      await denied(approve(f.request(), { ...op.input, approved: true }, 'ip-model'));
      await denied(approve(f.request({cookie:''}), op.input, 'ip-no-session'));
      await denied(approve(f.request(), { ...op.input, previewHash: 'b'.repeat(64) }, 'ip-hash'));
      const commitAsProposal = await f.operation(false, 'catalog.commit_update');
      await denied(approve(f.request(), commitAsProposal.input, 'ip-commit-name'));
      const otherTenant = createOperationApproval({ ...config, binding: { ...f.binding, tenantId: 'another' } });
      await denied(otherTenant(f.request(), op.input, 'ip-tenant'));
      const rotated = createOperationApproval({ ...config, epoch: secret() });
      await denied(rotated(f.request(), op.input, 'ip-rotated'));
      const differentBuild = createOperationApproval({ ...config, buildDigest: 'f'.repeat(64) });
      await denied(differentBuild(f.request(), op.input, 'ip-build'));
      assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', op.value.operationId)).state, 'PENDING_APPROVAL');

      const approved = await approve(f.request(), op.input, 'ip-valid');
      assert.equal(approved.status, 'APPROVED');
      await denied(review(reviewRequest, op.value.operationId));
      const proof = await f.store.get('SELECT * FROM mcp_v2_approval WHERE operation_id = ?', op.value.operationId);
      assert.equal(proof.approver_id, f.account.id);
      assert.equal(proof.session_hash, hash(f.session.token));
      assert.equal(proof.preview_hash, op.previewHash);
      assert.equal(proof.consumed_at, null);
      const events = await f.store.all('SELECT * FROM mcp_v2_event WHERE operation_id = ?', op.value.operationId);
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'APPROVE');
      assert.doesNotMatch(JSON.stringify(events), /Synthetic-approval-password|seller_session=/);
      await denied(approve(f.request(), op.input, 'ip-replay'));

      const revoked = await f.operation();
      await f.store.run('UPDATE oauth_grant SET revoked_at = ? WHERE id = ?', new Date().toISOString(), f.grantId);
      await denied(approve(f.request(), revoked.input, 'ip-revoked'));
      await f.store.run('UPDATE oauth_grant SET revoked_at = NULL WHERE id = ?', f.grantId);
      await f.store.run('UPDATE seller_account SET role = ? WHERE id = ?', 'STAFF', f.account.id);
      await denied(approve(f.request(), revoked.input, 'ip-role'));
      await f.store.run('UPDATE seller_account SET role = ? WHERE id = ?', 'OWNER', f.account.id);
      const expired = await f.operation(true);
      await denied(approve(f.request(), expired.input, 'ip-expired'));

      const tampered = await f.operation();
      await f.store.run('UPDATE mcp_v2_operation SET envelope_json = ? WHERE id = ?', '{}', tampered.value.operationId);
      await denied(approve(f.request(), tampered.input, 'ip-tampered'));

      const fault = await f.operation();
      const faultStore = { ...f.store, run: async (sql, ...values) => {
        if (sql.includes('INSERT INTO mcp_v2_event')) throw new Error('Synthetic audit failure.');
        return f.store.run(sql, ...values);
      } };
      const faultApproval = createOperationApproval({ ...config, store: faultStore });
      await assert.rejects(faultApproval(f.request(), fault.input, 'ip-fault'), /Synthetic audit failure/);
      assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', fault.value.operationId)).state, 'PENDING_APPROVAL');
      assert.equal(await f.store.get('SELECT operation_id FROM mcp_v2_approval WHERE operation_id = ?', fault.value.operationId), undefined);

      const race = await f.operation();
      const attempts = await Promise.allSettled([approve(f.request(), race.input, 'ip-race-1'), approve(f.request(), race.input, 'ip-race-2')]);
      assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
      assert.equal(attempts.filter((item) => item.status === 'rejected').length, 1);
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval WHERE operation_id = ?', race.value.operationId)).n), 1);

      const rejected = await f.operation();
      assert.equal((await approve(f.request(), { ...rejected.input, decision: 'reject' }, 'ip-reject')).status, 'REJECTED');
      assert.equal((await f.store.get('SELECT decision FROM mcp_v2_approval WHERE operation_id = ?', rejected.value.operationId)).decision, 'REJECTED');
      await denied(approve(f.request(), rejected.input, 'ip-reject-replay'));
      const consentRemoved = await f.operation();
      await f.store.run('DELETE FROM mcp_v2_scope_consent WHERE grant_id = ?', f.grantId);
      await denied(approve(f.request(), consentRemoved.input, 'ip-consent'));
      await deleteSession(f.store, f.session.token);
      await denied(approve(f.request(), consentRemoved.input, 'ip-signed-out'));
    });
}

for (const engine of ['sqlite', 'postgres']) {
  test(`${engine}: session-only approval succeeds without password and rejects a session invalidated between fences`,
    {skip:engine==='postgres'&&!base},async t=>{
      const f=await fixture(t,engine),config={store:f.store,binding:f.binding,sellerOrigin:f.binding.issuer,quickLogin:false,
        epoch:f.epoch,buildDigest:f.buildDigest,tenantGuard:f.tenantGuard,enabled:true};
      const op=await f.operation(),review=await createOperationReview(config)(new Request(f.binding.issuer+'/api/v1/seller/mcp/operations/'+op.value.operationId,
        {headers:{cookie:`seller_session=${f.session.token}`}}),op.value.operationId);
      const input={...op.input,challenge:review.challenge};assert.equal(Object.hasOwn(input,'password'),false);
      assert.equal((await createOperationApproval(config)(f.request(),input,'session-only-success')).status,'APPROVED');
      const legacy=await f.operation(),legacyReview=await createOperationReview(config)(new Request(f.binding.issuer+'/api/v1/seller/mcp/operations/'+legacy.value.operationId,
        {headers:{cookie:`seller_session=${f.session.token}`}}),legacy.value.operationId);
      assert.equal((await createOperationApproval(config)(f.request(),{...legacy.input,challenge:legacyReview.challenge,password:'Ignored legacy compatibility value'},'session-only-legacy')).status,'APPROVED');
      const next=await f.operation(),nextReview=await createOperationReview(config)(new Request(f.binding.issuer+'/api/v1/seller/mcp/operations/'+next.value.operationId,
        {headers:{cookie:`seller_session=${f.session.token}`}}),next.value.operationId);
      let fences=0;
      const guard={async withActiveTenant(id,work){if(++fences===2)await deleteSession(f.store,f.session.token);return f.tenantGuard.withActiveTenant(id,work);}};
      await assert.rejects(createOperationApproval({...config,tenantGuard:guard})(f.request(),{...next.input,challenge:nextReview.challenge},'session-invalidated'),{status:403});
      assert.equal(fences,2);assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?',next.value.operationId)).state,'PENDING_APPROVAL');
      assert.equal(await f.store.get('SELECT operation_id FROM mcp_v2_approval WHERE operation_id=?',next.value.operationId),undefined);
    });
}
