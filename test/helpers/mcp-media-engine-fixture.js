import { randomUUID } from 'node:crypto';
import { ensureAdmin, createSession } from '../../src/auth.js';
import { setupShop } from '../../src/shop-setup.js';
import { hash, secret } from '../../src/mcp/credentials.js';
import { operationEpochHash } from '../../src/mcp/operation-epoch.js';
import { mediaFixture } from './mcp-media-storage-fixture.js';

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
  return { ...f, account, session, epoch, bearer, binding, options, depth: () => depth,
    authorization: { bearer, binding, epochHash: context.epochHash }, productId: randomUUID() };
}
