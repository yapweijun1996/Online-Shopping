import { ApiError } from '../http.js';
import { can } from '../roles.js';
import { hash, liveGrant, stamp } from './credentials.js';
import { OPERATION_SCOPE_POLICIES } from './operation-policy.js';
const deny = () => { throw new ApiError(403, 'FORBIDDEN', 'Operation authorization failed.'); };
const scopes = (value) => typeof value === 'string' ? value.split(' ') : [];

// Call inside the *same store transaction* as the eventual operation and
// repeat immediately before commit. The caller must also verify the separate,
// explicit human approval, stored proposal, resource ownership, revision,
// policy and audit. Never derive binding from model-controlled input.
export async function verifyOperationAuthority(store, { bearer, binding, toolName, epochHash }) {
  if (typeof bearer !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(bearer)) deny();
  if (typeof toolName !== 'string' || !Object.hasOwn(OPERATION_SCOPE_POLICIES, toolName) ||
      typeof epochHash !== 'string' || !/^[0-9a-f]{64}$/.test(epochHash) ||
      !binding || typeof binding.tenantId !== 'string' || typeof binding.issuer !== 'string' ||
      typeof binding.resource !== 'string') deny();
  const { scope, capability } = OPERATION_SCOPE_POLICIES[toolName];

  // Deployment mode is not the shop's persisted setup choice. Require a real
  // configured shop on every v2 read/prepare/commit/replay inside its transaction.
  const setup = await store.get('SELECT mode FROM shop_setup WHERE id = 1');
  if (setup?.mode !== 'production') deny();

  const token = await store.get("SELECT * FROM oauth_token WHERE token_hash = ? AND kind = 'access'", hash(bearer));
  const grant = token && await liveGrant(store, token.grant_id, binding);
  const now = stamp();
  if (!token || token.revoked_at || token.issued_at > now || token.expires_at <= now || token.resource !== binding.resource || !grant ||
      !scopes(token.scopes).includes(scope) || !scopes(grant.scopes).includes(scope) ||
      !can(grant.account.role, capability)) deny();

  // A string present in an older grant is insufficient: this separate record
  // must be written by a future explicit, authenticated v2 consent flow.
  const consent = await store.get(`SELECT grant_id FROM mcp_v2_scope_consent
    WHERE grant_id = ? AND tenant_id = ? AND account_id = ? AND client_id = ?
      AND scope = ? AND account_auth_version = ? AND epoch_hash = ? AND consented_at <= ?`,
  grant.id, binding.tenantId, grant.account_id, grant.client_id, scope, grant.account_auth_version, epochHash, token.issued_at);
  if (!consent) deny();
  return { tenantId: binding.tenantId, accountId: grant.account_id, clientId: grant.client_id, grantId: grant.id, scope };
}
