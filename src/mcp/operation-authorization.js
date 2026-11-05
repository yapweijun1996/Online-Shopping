import { ApiError } from '../http.js';
import { can } from '../roles.js';
import { hash, liveGrant, stamp, SCOPES, V2_SCOPES } from './credentials.js';
import { operationAuthorityPolicy, OPERATION_RESOURCE_CONTROLS } from './operation-policy.js';
import { mediaInstant } from './media-policy.js';
import { operationResourceBinding, readOperationRecord } from './operation-record.js';
import { catalogMediaUpdateAllowed } from './catalog-media-config.js';
const deny = () => { throw new ApiError(403, 'FORBIDDEN', 'Operation authorization failed.'); };
const knownScopes = new Set([...SCOPES, ...V2_SCOPES]);
function scopes(value) {
  if (typeof value !== 'string') deny();
  const list = value.split(' ');
  if (new Set(list).size !== list.length || list.some(scope => !knownScopes.has(scope))) deny();
  return list;
}

// Call inside the *same store transaction* as the eventual operation and
// repeat immediately before commit. The caller must also verify the separate,
// explicit human approval, stored proposal, resource ownership, revision,
// policy and audit. Never derive binding from model-controlled input.
async function authorizePolicy(store, { bearer, binding, epochHash, policy, consentCutoff }) {
  if (typeof bearer !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(bearer)) deny();
  if (typeof epochHash !== 'string' || !/^[0-9a-f]{64}$/.test(epochHash) ||
      !binding || typeof binding.tenantId !== 'string' || typeof binding.issuer !== 'string' ||
      typeof binding.resource !== 'string') deny();
  const { scope, capability, requiredScopes } = policy;

  // Deployment mode is not the shop's persisted setup choice. Require a real
  // configured shop on every v2 read/prepare/commit/replay inside its transaction.
  const setup = await store.get('SELECT mode FROM shop_setup WHERE id = 1');
  if (setup?.mode !== 'production') deny();

  const token = await store.get("SELECT * FROM oauth_token WHERE token_hash = ? AND kind = 'access'", hash(bearer));
  const grant = token && await liveGrant(store, token.grant_id, binding);
  const now = stamp();
  if (!token || token.revoked_at || !mediaInstant(token.issued_at) || !mediaInstant(token.expires_at) ||
      token.issued_at > now || token.expires_at <= now || token.issued_at >= token.expires_at || token.resource !== binding.resource || !grant ||
      !mediaInstant(grant.created_at) || !mediaInstant(grant.absolute_expires_at) || token.issued_at < grant.created_at ||
      !Number.isSafeInteger(grant.account_auth_version) || grant.account_auth_version < 0 ||
      !requiredScopes.every(required => scopes(token.scopes).includes(required) && scopes(grant.scopes).includes(required)) ||
      !can(grant.account.role, capability)) deny();

  const cutoff = consentCutoff === undefined ? token.issued_at : consentCutoff < token.issued_at ? consentCutoff : token.issued_at;
  if (!mediaInstant(cutoff)) deny();
  // Scope strings alone never replace explicit, identity-bound consent evidence.
  for (const required of requiredScopes) {
  const consent = await store.get(`SELECT grant_id, consented_at FROM mcp_v2_scope_consent
    WHERE grant_id = ? AND tenant_id = ? AND account_id = ? AND client_id = ?
      AND scope = ? AND account_auth_version = ? AND epoch_hash = ? AND consented_at >= ? AND consented_at <= ?`,
  grant.id, binding.tenantId, grant.account_id, grant.client_id, required, grant.account_auth_version, epochHash, grant.created_at, cutoff);
  if (!consent || !mediaInstant(consent.consented_at)) deny();
  }
  return { grant, authority: Object.freeze({ tenantId: binding.tenantId, accountId: grant.account_id, clientId: grant.client_id, grantId: grant.id,
    accountAuthVersion: grant.account_auth_version, grantExpiresAt: grant.absolute_expires_at, tokenIssuedAt: token.issued_at,
    scope, requiredScopes }) };
}

export async function verifyOperationAuthority(store, { bearer, binding, toolName, epochHash, mediaPolicyId = null, resourceType = null, catalogUpdateEnabled = false }) {
  let policy;
  try { policy = operationAuthorityPolicy(toolName, mediaPolicyId); } catch { deny(); }
  if (policy.flow === 'RESERVED' && !catalogMediaUpdateAllowed(catalogUpdateEnabled, {toolName,mediaPolicyId,resourceType})) deny();
  return (await authorizePolicy(store, { bearer, binding, epochHash, policy })).authority;
}

// Fixed control names and an operation ID only. The caller holds the current
// platform->tenant writer fence; no scope, identity or record comes from args.
export async function verifyOperationControlAuthority(store, { bearer, binding, toolName, epochHash, buildDigest, tenantRevision, operationId, catalogUpdateEnabled = false }) {
  if (!Object.hasOwn(OPERATION_RESOURCE_CONTROLS, toolName) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId || '') ||
      !Number.isSafeInteger(tenantRevision) || tenantRevision < 0 || !/^[0-9a-f]{64}$/.test(buildDigest || '')) deny();
  const row = await store.get('SELECT * FROM mcp_v2_operation WHERE id=?', operationId);
  const resourceBinding = operationResourceBinding(row);
  if (!resourceBinding || !mediaInstant(row.created_at)) deny();
  let underlying;
  try { underlying = operationAuthorityPolicy(row.tool_name, row.media_policy_id ?? null); } catch { deny(); }
  if (underlying.flow === 'RESERVED' && !catalogMediaUpdateAllowed(catalogUpdateEnabled,
    {toolName:row.tool_name,mediaPolicyId:row.media_policy_id,resourceType:resourceBinding.resourceType})) deny();
  const scope = OPERATION_RESOURCE_CONTROLS[toolName].scope;
  const policy = Object.freeze({ ...underlying, scope, requiredScopes: Object.freeze([scope, ...underlying.requiredScopes]) });
  const { authority, grant } = await authorizePolicy(store, { bearer, binding, epochHash, policy, consentCutoff: row.created_at });
  if (row.grant_id !== authority.grantId || row.account_id !== authority.accountId || row.client_id !== authority.clientId) deny();
  const context = Object.freeze({ tenantId: authority.tenantId, tenantRevision, accountId: authority.accountId, clientId: authority.clientId,
    grantId: authority.grantId, accountAuthVersion: authority.accountAuthVersion, epochHash, buildDigest, issuer: binding.issuer,
    resource: binding.resource, grantExpiresAt: authority.grantExpiresAt });
  const record = await readOperationRecord(store, row, { binding, tenantRevision, epochHash, buildDigest, grant, context,
    expected: { resourceType: resourceBinding.resourceType, mediaPolicyId: underlying.mediaPolicyId } });
  if (!record) deny();
  return Object.freeze({ authority, record });
}

// Already inside the caller's platform->tenant writer fence. Never selects a store.
export async function verifyMediaAuthority(store, { bearer, binding, epochHash, buildDigest, tenantRevision }) {
  if (!Number.isSafeInteger(tenantRevision) || tenantRevision < 0 || typeof buildDigest !== 'string' || !/^[a-f0-9]{64}$/.test(buildDigest)) deny();
  const authority = await verifyOperationAuthority(store, { bearer, binding, toolName: 'media.prepare_upload', epochHash });
  return Object.freeze({ tenantId: authority.tenantId, tenantRevision, accountId: authority.accountId, clientId: authority.clientId,
    grantId: authority.grantId, accountAuthVersion: authority.accountAuthVersion, epochHash, buildDigest,
    issuer: binding.issuer, resource: binding.resource, grantExpiresAt: authority.grantExpiresAt });
}
