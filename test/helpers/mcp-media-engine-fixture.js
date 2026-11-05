import { randomUUID } from 'node:crypto';
import { ensureAdmin, createSession } from '../../src/auth.js';
import { setupShop } from '../../src/shop-setup.js';
import { hash, secret } from '../../src/mcp/credentials.js';
import { operationEpochHash } from '../../src/mcp/operation-epoch.js';
import { mediaFixture } from './mcp-media-storage-fixture.js';
import { readStoredOperation } from '../../src/mcp/operation-envelope.js';
import { readMediaFrame } from '../../src/mcp/media-frame-storage.js';
import { mediaReviewItems } from '../../src/mcp/media-approval-policy.js';
import { MEDIA_REVIEW_ACKNOWLEDGED, OPERATION_APPROVAL_MS } from '../../src/mcp/operation-policy.js';

// Real disposable credentials/storage; domain/decoder/review remain explicitly synthetic.
export async function mediaEngineFixture(t, dialect) {
  const f = await mediaFixture(t, dialect);
  await ensureAdmin(f.store, 'synthetic_media_owner', 'Synthetic-media-engine-password-2026!');
  await setupShop(f.store, { mode: 'production', shopName: 'Synthetic media engine' });
  const account = await f.store.get("SELECT * FROM seller_account WHERE username_key='synthetic_media_owner'");
  const session = await createSession(f.store, account.id), epoch = secret(), bearer = secret();
  Object.assign(f.context, { accountId: account.id, accountAuthVersion: account.oauth_auth_version, epochHash: operationEpochHash(epoch) });
  const { context, store, now } = f, scopes = 'catalog.write media.write';
  await store.run(`INSERT INTO oauth_client(id,tenant_id,issuer,client_name,redirect_uris_json,auth_method,created_at,expires_at)
    VALUES(?,?,?,'Synthetic media client','["https://client.example.test/callback"]','none',?,?)`,
  context.clientId, context.tenantId, context.issuer, now, context.grantExpiresAt);
  await store.run(`INSERT INTO oauth_grant(id,account_id,client_id,tenant_id,issuer,resource,scopes,account_auth_version,created_at,absolute_expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, context.grantId, account.id, context.clientId, context.tenantId, context.issuer, context.resource,
  scopes, account.oauth_auth_version, now, context.grantExpiresAt);
  await store.run(`INSERT INTO oauth_token(token_hash,kind,grant_id,resource,scopes,issued_at,expires_at,generation)
    VALUES(?,'access',?,?,?,?,?,0)`, hash(bearer), context.grantId, context.resource, scopes, now, context.grantExpiresAt);
  for (const scope of scopes.split(' ')) await store.run(`INSERT INTO mcp_v2_scope_consent(grant_id,tenant_id,account_id,client_id,scope,account_auth_version,epoch_hash,consented_at)
    VALUES(?,?,?,?,?,?,?,?)`, context.grantId, context.tenantId, account.id, context.clientId, scope, account.oauth_auth_version, context.epochHash, now);
  const binding = { tenantId: context.tenantId, issuer: context.issuer, resource: context.resource };
  let depth = 0;
  const tenantGuard = { withActiveTenant: async (id, work) => {
    if (id !== context.tenantId) throw new Error('Synthetic tenant mismatch.');
    depth++; try { return await work({ revision: context.tenantRevision }); } finally { depth--; }
  } };
  const options = { store, binding, epoch, buildDigest: context.buildDigest, tenantGuard, enabled: true, quickLogin: false };
  return { ...f, account, session, sessionHash: hash(session.token), epoch, bearer, binding, options, depth: () => depth,
    authorization: { bearer, binding, epochHash: context.epochHash }, productId: randomUUID() };
}

// SYNTHETIC SQL fixture only. This is not an HTTP route or evidence of actual human review.
export async function seedSyntheticMediaApproval(f, operation) {
  return f.store.transaction(async () => {
    const row = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?', operation.operationId);
    const envelope = readStoredOperation(row, { tenantId: f.context.tenantId, issuer: f.context.issuer, resource: f.context.resource });
    const manifest = await readMediaFrame(f.store, f.context, row.id, envelope.proposal.media);
    const now = new Date().toISOString(), expires = new Date(Math.min(Date.parse(now) + OPERATION_APPROVAL_MS, Date.parse(row.expires_at))).toISOString();
    const challenge = randomUUID();
    await f.store.run(`INSERT INTO mcp_v2_approval_challenge(id,operation_id,nonce_hash,created_at,expires_at,account_id,session_hash,account_auth_version,bound_at,consumed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, challenge, row.id, hash(secret()), now, expires, row.account_id, f.sessionHash, f.context.accountAuthVersion, now, now);
    for (const item of mediaReviewItems(manifest)) await f.store.run(`INSERT INTO mcp_v2_media_delivery(challenge_id,operation_id,kind,item_key,manifest_root,expected_hash,nonce_hash,issued_at,expires_at,ack_at,page_index,asset_key)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, challenge, row.id, item.kind, item.itemKey, manifest.descriptor.manifestRoot, item.hash, hash(secret()), now, expires, now, item.pageIndex, item.assetKey);
    await f.store.run(`INSERT INTO mcp_v2_approval(operation_id,approver_id,session_hash,preview_hash,decision,approved_at,expires_at)
      VALUES(?,?,?,?,'APPROVED',?,?)`, row.id, row.account_id, f.sessionHash, row.preview_hash, now, expires);
    await f.store.run(`INSERT INTO mcp_v2_media_approval_evidence(operation_id,challenge_id,manifest_root,descriptor_hash,approver_id,session_hash,account_auth_version,epoch_hash,build_digest,tenant_revision,policy_id,approved_at,expires_at,acknowledged_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, challenge, manifest.descriptor.manifestRoot, manifest.descriptorHash, row.account_id,
    f.sessionHash, f.context.accountAuthVersion, row.epoch_hash, row.build_digest, row.tenant_revision, row.media_policy_id, now, expires, now);
    await f.store.run(`INSERT INTO mcp_v2_event(id,at,tenant_id,account_id,client_id,grant_id,tool_name,resource_id,operation_id,approver_id,event,outcome,correlation_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,'APPROVE',?,?)`, randomUUID(), now, row.tenant_id, row.account_id, row.client_id, row.grant_id,
    row.tool_name, row.resource_id, row.id, row.account_id, MEDIA_REVIEW_ACKNOWLEDGED, row.correlation_id);
    await f.store.run("UPDATE mcp_v2_operation SET state='APPROVED' WHERE id=?", row.id);
    return { challengeId: challenge, approvedAt: now, expiresAt: expires };
  });
}
