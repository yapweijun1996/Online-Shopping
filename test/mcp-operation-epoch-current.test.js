import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationEpochCurrent, readOperationEpochFile } from '../src/mcp/operation-epoch.js';
import { hash, liveGrant, secret } from '../src/mcp/credentials.js';
import { companyReadTool, companyMutationTool } from '../src/mcp/company-tools.js';
import { freshCatalogAccess, legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';
import { coordinatorFixture, stubDecode } from './helpers/mcp-media-coordinator-fixture.js';
import { syntheticMediaPng } from './helpers/mcp-media-hooks-fixture.js';
import { createOperationEngine } from '../src/mcp/operation-engine.js';
import { mediaReviewFixture } from './helpers/mcp-media-review-fixture.js';
import { reviewFixture, reviewPassword } from './helpers/mcp-review-fixture.js';

function epochFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'shop-live-epoch-')), epochFile = join(directory, 'epoch'), epoch = secret();
  writeFileSync(epochFile, epoch, { mode: 0o600 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const replace = value => { const next = join(directory, 'next'); writeFileSync(next, value, { mode: 0o600 }); renameSync(next, epochFile); };
  return { directory, epoch, epochFile, replace, mcpV2: { enabled: true, epoch, epochFile, buildDigest: 'e'.repeat(64) } };
}

test('live epoch reads current pathname with bounded canonical bytes and never adopts atomic replacement', t => {
  const f = epochFixture(t);
  assert.equal(operationEpochCurrent(f.mcpV2), true);
  f.replace(f.epoch + '\r\n'); assert.equal(operationEpochCurrent(f.mcpV2), true);
  f.replace(secret()); assert.equal(operationEpochCurrent(f.mcpV2), false);
  for (const invalid of ['', f.epoch + '\n\n', 'x'.repeat(43), f.epoch + ' '.repeat(4096)]) {
    f.replace(invalid); assert.equal(operationEpochCurrent(f.mcpV2), false); assert.throws(() => readOperationEpochFile(f.epochFile));
  }
  f.replace(f.epoch); const target = join(f.directory, 'other'); writeFileSync(target, f.epoch);
  rmSync(f.epochFile); symlinkSync(target, f.epochFile); assert.equal(operationEpochCurrent(f.mcpV2), false);
  rmSync(f.epochFile); assert.equal(operationEpochCurrent(f.mcpV2), false);
  assert.equal(operationEpochCurrent({ enabled: false, get epochFile() { throw Error('OFF read'); } }), true);
  assert.equal(operationEpochCurrent({ enabled: true, epoch: f.epoch }), true); // Historical dev fixtures only.
  assert.equal(operationEpochCurrent({ enabled: true, epoch: f.epoch, profile: { kind: 'production' } }), false);
});

for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL ? 'Disposable PostgreSQL not configured.' : false };
  test(`${dialect}: actual OAuth, legacy token and current proposal/review/approval deny a rotated external epoch`, options, async t => {
    const epoch = epochFixture(t), f = await reviewFixture(t, dialect, { operationTools: [companyReadTool(), companyMutationTool()],
      config: { mcpV2: epoch.mcpV2, mcpRedirectUris: ['https://client.example.com/catalog-callback'] } });
    let refresh, clientId;
    const call = async (...args) => {
      const value = await f.call(...args);
      if (args[0] === '/oauth/token' && value.response.status === 200) { refresh = value.data.refresh_token; clientId = new URLSearchParams(args[2]).get('client_id'); }
      return value;
    };
    const old = await freshCatalogAccess(f, legacyCatalogScopes, call), current = await freshCatalogAccess(f, 'company.read company.write', call);
    const runRead = f.store.run;
    f.store.run = async (sql, ...args) => { const value = await runRead(sql, ...args); if (/INSERT INTO mcp_audit/.test(sql) && args.includes('READ')) epoch.replace(secret()); return value; };
    try { assert.equal((await old.call('catalog.list', {})).response.status, 401); }
    finally { f.store.run = runRead; epoch.replace(epoch.epoch); }
    const company = (await current.call('company.get', {})).data.result.structuredContent.company;
    const prepare = await current.call('company.preview_update', { input: { expectedRevision: company.revision, changes: { availabilityText: 'Epoch fixture text' } }, idempotencyKey: 'epoch-current-company-0001' });
    assert.equal(prepare.response.status, 200); const operation = prepare.data.result.structuredContent;
    const path = '/api/v1/seller/mcp/operations/' + operation.operationId;
    const reviewed = await f.call(path, 'GET', undefined, current.headers); assert.equal(reviewed.response.status, 200);
    const grantId = (await f.store.get('SELECT grant_id FROM oauth_token WHERE token_hash=?', hash(old.bearer))).grant_id;
    const binding = { ...f.binding, mcpV2: epoch.mcpV2 };
    assert.ok(await liveGrant(f.store, grantId, binding));
    epoch.replace(secret());
    assert.equal(await liveGrant(f.store, grantId, binding), null);
    assert.equal((await old.rpc('tools/list', {})).response.status, 401);
    assert.equal((await current.call('company.get', {})).response.status, 401);
    assert.equal((await f.call(path, 'GET', undefined, current.headers)).response.status, 403);
    assert.equal((await f.call(path + '/approval', 'POST', { operationId: operation.operationId, previewHash: operation.previewHash,
      challenge: reviewed.data.challenge, decision: 'approve', password: reviewPassword }, current.headers)).response.status, 403);
    const refreshed = await f.call('/oauth/token', 'POST', new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId,
      refresh_token: refresh, resource: f.binding.resource }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(refreshed.response.status, 403);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', operation.operationId)).state, 'PENDING_APPROVAL');
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n), 0);
    // Restore the same test epoch solely to exercise rotation inside the final
    // decision transaction; operational recovery must never restore old epochs.
    epoch.replace(epoch.epoch);
    const run = f.store.run;
    f.store.run = async (sql, ...args) => { const result = await run(sql, ...args); if (/INSERT INTO mcp_v2_event/.test(sql) && args.includes('APPROVE')) epoch.replace(secret()); return result; };
    try {
      const denied = await f.call(path + '/approval', 'POST', { operationId: operation.operationId, previewHash: operation.previewHash,
        challenge: reviewed.data.challenge, decision: 'approve', password: reviewPassword }, current.headers);
      assert.equal(denied.response.status, 403);
    } finally { f.store.run = run; }
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', operation.operationId)).state, 'PENDING_APPROVAL');
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n), 0);
    assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE event='APPROVE'")).n), 0);
  });

  test(`${dialect}: rotation during actual code issuance rolls back tokens and code consumption`, options, async t => {
    const epoch = epochFixture(t), f = await reviewFixture(t, dialect, { config: { mcpV2: epoch.mcpV2, mcpRedirectUris: ['https://client.example.com/catalog-callback'] } });
    const redirect = 'https://client.example.com/catalog-callback', verifier = secret() + secret();
    const registered = await f.call('/oauth/register', 'POST', { client_name: 'Epoch fixture', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
    const clientId = registered.data.client_id;
    const staged = await f.call('/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect,
      scope: 'catalog.read', state: secret(), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: f.binding.resource }));
    const authorizationRequestId = /data-request="([^"]+)"/.exec(staged.data)?.[1], proof = /data-proof="([^"]+)"/.exec(staged.data)?.[1];
    const login = await f.call('/api/v1/seller/session', 'POST', { username: 'synthetic_owner', password: reviewPassword, mcpAuthorization: { authorizationRequestId, proof } }, { origin: f.config.sellerOrigin });
    const headers = { origin: f.config.sellerOrigin, cookie: login.response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': login.data.csrfToken };
    const consent = await f.call('/api/v1/seller/mcp/consent', 'POST', { authorizationRequestId, decision: 'approve', scopes: ['catalog.read'] }, headers);
    assert.equal(consent.response.status, 200); const code = new URL(consent.data.redirectTo).searchParams.get('code');
    const run = f.store.run;
    f.store.run = async (sql, ...args) => { const result = await run(sql, ...args); if (/INSERT INTO mcp_audit/.test(sql) && args.includes('ISSUE')) epoch.replace(secret()); return result; };
    try {
      const issued = await f.call('/oauth/token', 'POST', new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code,
        code_verifier: verifier, redirect_uri: redirect, resource: f.binding.resource }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
      assert.equal(issued.response.status, 403);
    } finally { f.store.run = run; }
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM oauth_token')).n), 0);
    assert.equal((await f.store.get('SELECT consumed_at FROM oauth_authorization_code WHERE code_hash=?', hash(code))).consumed_at, null);
  });
  test(`${dialect}: protected media delivery and ACK reject rotation and roll back late ACK evidence`, options, async t => {
    const epoch = epochFixture(t), f = await mediaReviewFixture(t, dialect, { fixtureOptions: { config: { mcpV2: epoch.mcpV2 } } });
    const review = await f.review(), item = review.mediaReview.items[0], delivery = await f.deliver(review, item);
    assert.equal(delivery.status, 200); const nonce = delivery.headers.get('x-media-nonce');
    epoch.replace(secret());
    assert.equal((await f.deliver(review, item)).status, 403);
    assert.equal((await f.acknowledge(review, item, nonce)).status, 403);
    assert.equal((await f.approve(review, { mediaReviewed: true })).status, 403);
    epoch.replace(epoch.epoch); // Test-only restoration to exercise late-check rollback.
    const get = f.store.get;
    f.store.get = async (sql, ...args) => { const value = await get(sql, ...args); if (/UPDATE mcp_v2_media_delivery SET ack_at/.test(sql)) epoch.replace(secret()); return value; };
    try { assert.equal((await f.acknowledge(review, item, nonce)).status, 403); }
    finally { f.store.get = get; }
    assert.equal((await f.store.get('SELECT ack_at FROM mcp_v2_media_delivery WHERE operation_id=? AND item_key=?', f.operation.operationId, item.itemKey)).ack_at, null);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_approval_evidence')).n), 0);
  });

  test(`${dialect}: epoch rotation during lock-free media resolution denies final engine persistence`, options, async t => {
    const epoch = epochFixture(t), issuer = 'https://seller.example.test';
    let decoded = 0, f;
    f = await coordinatorFixture(t, dialect, { fixtureOptions: { config: { mcpV2: epoch.mcpV2 } },
      binding: { tenantId: 'default', issuer, resource: issuer + '/mcp', mcpV2: epoch.mcpV2 },
      decode: async input => { assert.equal(f.depth(), 0); decoded++; epoch.replace(secret()); return stubDecode(input); } });
    const source = syntheticMediaPng(), stage = await f.coordinator.begin(f.bearer, await f.input(source));
    await f.coordinator.append(f.bearer, { stageId: stage.stageId, offset: 0, dataParts: [source.toString('base64')] });
    const engine = createOperationEngine({ ...f.options, adapters: { 'media.prepare_upload': f.coordinator.uploadAdapter } });
    await assert.rejects(engine.prepare({ bearer: f.bearer, toolName: 'media.prepare_upload', args: { stageId: stage.stageId }, idempotencyKey: 'epoch-resolve-rotation-0001' }), { status: 403 });
    assert.ok(decoded > 0);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation_media_policy')).n), 0);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_pin')).n), 0);
  });

}
