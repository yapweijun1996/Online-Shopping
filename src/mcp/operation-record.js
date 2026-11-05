import { stamp } from './credentials.js';
import { readStoredOperation } from './operation-envelope.js';
import { operationAuthorityPolicy, OPERATION_SCOPE_POLICIES } from './operation-policy.js';
import { operationInstant, operationReceiptExpiry, OPERATION_TERMINAL_STATES } from './operation-maintenance.js';
import { readMediaPolicy } from './media-storage.js';
import { validateRetainedMediaPolicy } from './media-policy.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const ttl = 10 * 60 * 1000;
const resources = Object.freeze({
  'company.preview_update': Object.freeze({ type: 'company', id: '1' }),
  'catalog.preview_create': Object.freeze({ type: 'catalog', id: 'catalog' }),
  'catalog.preview_update': Object.freeze({ type: 'product', id: null }),
  'media.prepare_upload': Object.freeze({ type: 'product', id: null }),
  'media.preview_layout': Object.freeze({ type: 'product', id: null }),
  'inventory.preview_adjustment': Object.freeze({ type: 'inventory', id: null }),
  'orders.preview_decision': Object.freeze({ type: 'order', id: null }),
});

// Source-owned binding, not a model-selected resource type or operation capability.
export function operationResourceBinding(row) {
  const rule = row && Object.hasOwn(resources, row.tool_name) && resources[row.tool_name];
  if (!rule || row.resource_type !== rule.type || (rule.id === null ? !uuid.test(row.resource_id || '') : row.resource_id !== rule.id) ||
      !digest.test(row.expected_revision || '')) return null;
  return Object.freeze({ resourceType: rule.type, resourceId: row.resource_id });
}

// Record integrity only. The caller must separately hold the platform/tenant
// fence and verify current original-grant authority in this same transaction.
// expected is trusted adapter metadata; controls use the fixed binding above.
export async function readOperationRecord(store, row, { binding, tenantRevision, epochHash, buildDigest, grant, context, expected }) {
  let policy;
  try { policy = operationAuthorityPolicy(row?.tool_name, row?.media_policy_id ?? null); } catch { return null; }
  if (!row || !expected || !grant || !uuid.test(row.id || '') || !uuid.test(row.account_id || '') ||
      !uuid.test(row.grant_id || '') || !uuid.test(row.correlation_id || '') ||
      row.tenant_id !== binding.tenantId || row.issuer !== binding.issuer || row.resource !== binding.resource ||
      row.tenant_revision !== tenantRevision || row.epoch_hash !== epochHash || row.build_digest !== buildDigest ||
      typeof row.client_id !== 'string' || !row.client_id.length || row.client_id.length > 128 ||
      row.resource_type !== expected.resourceType || !/^[a-z][a-z0-9_.-]{0,127}$/.test(row.resource_type) ||
      !(row.resource_id === null || (typeof row.resource_id === 'string' && row.resource_id.length > 0 && row.resource_id.length <= 128)) ||
      !(row.expected_revision === null || (typeof row.expected_revision === 'string' && row.expected_revision.length > 0 && row.expected_revision.length <= 128)) ||
      !operationInstant(row.created_at) || !operationInstant(row.expires_at) || row.created_at >= row.expires_at ||
      Date.parse(row.expires_at) - Date.parse(row.created_at) !== ttl || row.created_at > stamp() ||
      !operationInstant(row.receipt_expires_at) || row.receipt_expires_at !== operationReceiptExpiry(grant.absolute_expires_at) || row.receipt_expires_at <= stamp() ||
      !['request_hash', 'preview_hash', 'idempotency_hash'].every(key => digest.test(row[key] || '')) ||
      !Object.hasOwn(OPERATION_SCOPE_POLICIES, row.tool_name) || row.required_scope !== OPERATION_SCOPE_POLICIES[row.tool_name].scope ||
      row.required_capability !== OPERATION_SCOPE_POLICIES[row.tool_name].capability || row.risk !== policy.risk ||
      (row.media_policy_id ?? null) !== (expected.mediaPolicyId ?? null)) return null;
  const envelope = row.redacted_at === null ? readStoredOperation(row, binding) : null;
  if (row.redacted_at === null && !envelope) return null;
  let descriptor;
  try {
    const stored = await readMediaPolicy(store, context, row.id);
    descriptor = validateRetainedMediaPolicy(row, stored, envelope && Object.hasOwn(envelope.proposal, 'media') ? envelope.proposal.media : undefined);
    if (expected.mediaPolicyId && (!descriptor || (expected.codecDigest && descriptor.codecDigest !== expected.codecDigest) || descriptor.graphRevision !== row.expected_revision)) return null;
  } catch { return null; }
  if (row.redacted_at !== null && !(OPERATION_TERMINAL_STATES.includes(row.state) && row.envelope_json === null &&
      operationInstant(row.redacted_at) && row.redacted_at >= row.expires_at && row.redacted_at <= stamp())) return null;
  return Object.freeze({ row, envelope, descriptor, policy });
}
