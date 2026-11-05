import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { can } from '../roles.js';
import { OPERATION_SCOPE_CAPABILITIES } from './operation-policy.js';
import { operationEpochHash } from './operation-epoch.js';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export const stamp = (offset = 0) => new Date(Date.now() + offset).toISOString();
export const SCOPES = Object.freeze(['catalog.read', 'orders.read', 'analytics.read']);
// Resource-specific operation policies are not implemented and confer no scope.
export const V2_SCOPES = Object.freeze(Object.keys(OPERATION_SCOPE_CAPABILITIES).filter((scope) => OPERATION_SCOPE_CAPABILITIES[scope] !== null));
export function v2Epoch(config) {
  if (config?.mcpV2?.enabled !== true || !/^[0-9a-f]{64}$/.test(config.mcpV2.buildDigest || '')) return null;
  try { return operationEpochHash(config.mcpV2.epoch); } catch { return null; }
}
export const supportedScopes = (config) => v2Epoch(config) ? [...SCOPES, ...V2_SCOPES] : [...SCOPES];
const capability = { 'catalog.read': 'catalog.write', 'orders.read': 'orders.fulfil', 'analytics.read': 'figures.read' };
export const eligible = (account) => account && account.active === 1 && account.must_change_password === 0 && ['OWNER', 'MANAGER'].includes(account.role);
export const effective = (account, scopes, config) => eligible(account) && typeof scopes === 'string'
  ? scopes.split(' ').filter((scope) => supportedScopes(config).includes(scope) && can(account.role, capability[scope] ?? OPERATION_SCOPE_CAPABILITIES[scope])) : [];

export async function audit(store, tenantId, event, context = {}, outcome = 'OK', tool = null, count = 0) {
  await store.run('DELETE FROM mcp_audit WHERE id IN (SELECT id FROM mcp_audit WHERE at < ? ORDER BY at LIMIT 100)', stamp(-90 * 86400000));
  await store.run(`INSERT INTO mcp_audit(id, at, tenant_id, account_id, client_id, grant_id, correlation_id,
    event, tool_name, resource_id, outcome, duration_ms, result_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  randomUUID(), stamp(), tenantId, context.account_id ?? null, context.client_id ?? null, context.grant_id ?? context.id ?? null,
  randomUUID(), event, tool, null, outcome, 0, count);
}

// Call inside the credential mutation transaction, under the store's shared writer lock.
export async function invalidateOAuth(store, accountId) {
  await store.run('UPDATE seller_account SET oauth_auth_version = oauth_auth_version + 1 WHERE id = ?', accountId);
  await store.run("UPDATE oauth_grant SET revoked_at = ?, revoke_reason = 'ACCOUNT_CHANGED' WHERE account_id = ? AND revoked_at IS NULL", stamp(), accountId);
  await store.run('UPDATE oauth_authorization_code SET consumed_at = ? WHERE grant_id IN (SELECT id FROM oauth_grant WHERE account_id = ?) AND consumed_at IS NULL', stamp(), accountId);
  await store.run('UPDATE oauth_token SET revoked_at = ? WHERE grant_id IN (SELECT id FROM oauth_grant WHERE account_id = ?) AND revoked_at IS NULL', stamp(), accountId);
  await store.run('UPDATE oauth_authorization_request SET consumed_at = ? WHERE account_id = ? AND consumed_at IS NULL', stamp(), accountId);
  const grant = await store.get('SELECT tenant_id FROM oauth_grant WHERE account_id = ? LIMIT 1', accountId);
  if (grant) await audit(store, grant.tenant_id, 'INVALIDATE', { account_id: accountId }, 'ACCOUNT_CHANGED');
}

export async function revokeGrant(store, grantId, reason = 'REVOKED') {
  await store.run('UPDATE oauth_grant SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL', stamp(), reason, grantId);
  await store.run('UPDATE oauth_token SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL', stamp(), grantId);
}

export async function liveGrant(store, id, { tenantId, issuer, resource, mcpV2 }, issuedAt = stamp()) {
  const grant = await store.get('SELECT * FROM oauth_grant WHERE id = ?', id);
  if (!grant || grant.revoked_at || grant.absolute_expires_at <= stamp() || grant.created_at > stamp() || grant.tenant_id !== tenantId || grant.issuer !== issuer || grant.resource !== resource) return null;
  const account = await store.get('SELECT * FROM seller_account WHERE id = ?', grant.account_id);
  const client = await store.get('SELECT * FROM oauth_client WHERE id = ?', grant.client_id);
  if (!eligible(account) || account.oauth_auth_version !== grant.account_auth_version || !client || client.disabled_at || client.tenant_id !== tenantId || client.issuer !== issuer) return null;
  let allowed = effective(account, grant.scopes, { mcpV2 });
  const requestedV2 = allowed.filter((scope) => V2_SCOPES.includes(scope));
  if (requestedV2.length) {
    const evidence = await store.all(`SELECT scope FROM mcp_v2_scope_consent
      WHERE grant_id = ? AND tenant_id = ? AND account_id = ? AND client_id = ?
        AND account_auth_version = ? AND epoch_hash = ? AND consented_at >= ? AND consented_at <= ?`,
    grant.id, tenantId, grant.account_id, grant.client_id, grant.account_auth_version, v2Epoch({ mcpV2 }), grant.created_at, issuedAt);
    allowed = allowed.filter((scope) => SCOPES.includes(scope) || evidence.some((row) => row.scope === scope));
  }
  return { ...grant, grant_id: grant.id, account, allowed };
}
