import { mediaPolicyForTool } from './media-policy.js';

// Server-owned draft policy. Nothing here registers tools, issues scopes, or
// grants authority. Operations inspection/cancellation need an additional
// per-resource policy and are deliberately absent from the tool map.
export const OPERATION_SCOPE_CAPABILITIES = Object.freeze({
  'company.read': 'settings.write',
  'company.write': 'settings.write',
  'catalog.write': 'catalog.write',
  'media.read': 'catalog.write',
  'media.write': 'catalog.write',
  'inventory.read': 'catalog.write',
  'inventory.adjust': 'catalog.write',
  'orders.decide': 'orders.decide',
  'analytics.extended': 'figures.read',
  'operations.read': null,
  'operations.cancel': null,
});
export const OPERATION_SCOPES = Object.freeze(Object.keys(OPERATION_SCOPE_CAPABILITIES));
const scopeByTool = {
  'company.get': 'company.read', 'company.preview_update': 'company.write', 'company.commit_update': 'company.write',
  'catalog.preview_create': 'catalog.write', 'catalog.commit_create': 'catalog.write',
  'catalog.preview_update': 'catalog.write', 'catalog.commit_update': 'catalog.write',
  'media.list': 'media.read', 'media.prepare_upload': 'media.write', 'media.commit_upload': 'media.write',
  'media.preview_layout': 'media.write', 'media.commit_layout': 'media.write',
  'inventory.summary': 'inventory.read', 'inventory.movements': 'inventory.read',
  'inventory.preview_adjustment': 'inventory.adjust', 'inventory.commit_adjustment': 'inventory.adjust',
  'orders.preview_decision': 'orders.decide', 'orders.commit_decision': 'orders.decide',
  'analytics.sales_trend': 'analytics.extended', 'analytics.top_products': 'analytics.extended',
  'analytics.inventory_risk': 'analytics.extended',
};
export const OPERATION_SCOPE_POLICIES = Object.freeze(Object.fromEntries(
  Object.entries(scopeByTool).map(([name, scope]) => [name, Object.freeze({ scope, capability: OPERATION_SCOPE_CAPABILITIES[scope] })]),
));

// Media stays ineligible until staged bytes and old/new image review exist.
export const OPERATION_MUTATION_PAIRS = Object.freeze({
  'company.preview_update': 'company.commit_update',
  'catalog.preview_create': 'catalog.commit_create',
  'catalog.preview_update': 'catalog.commit_update',
  'inventory.preview_adjustment': 'inventory.commit_adjustment',
  'orders.preview_decision': 'orders.commit_decision',
});
export const OPERATION_APPROVAL_TOOLS = Object.freeze(Object.keys(OPERATION_MUTATION_PAIRS));
// All company updates are conservatively HIGH until field-specific policy is
// designed and verified, including the separate currency-change requirement.
export const OPERATION_PREVIEW_RISKS = Object.freeze({
  'company.preview_update': 'HIGH',
  'catalog.preview_create': 'MEDIUM',
  'catalog.preview_update': 'MEDIUM',
  'inventory.preview_adjustment': 'HIGH',
  'orders.preview_decision': 'HIGH',
});

export const MEDIA_REVIEW_ACKNOWLEDGED = 'MEDIA_REVIEW_ACKNOWLEDGED';
// The optional marker is source-owned stored metadata, never an MCP scope argument.
// Describing a reserved catalog policy does not enable its write path.
export function operationAuthorityPolicy(toolName, mediaPolicyId = null) {
  if (typeof toolName !== 'string' || !Object.hasOwn(OPERATION_SCOPE_POLICIES, toolName)) {
    throw new TypeError('Unknown operation policy.');
  }
  const base = OPERATION_SCOPE_POLICIES[toolName];
  if (mediaPolicyId !== null || ['media.prepare_upload', 'media.commit_upload', 'media.preview_layout', 'media.commit_layout'].includes(toolName)) {
    const media = mediaPolicyForTool(toolName);
    if (mediaPolicyId !== null && mediaPolicyId !== media.policyId) throw new TypeError('Invalid media operation policy.');
    return Object.freeze({ scope: base.scope, capability: media.capability, requiredScopes: media.requiredScopes,
      risk: media.risk, mediaPolicyId: media.policyId, flow: media.flow });
  }
  return Object.freeze({ scope: base.scope, capability: base.capability, requiredScopes: Object.freeze([base.scope]),
    risk: OPERATION_PREVIEW_RISKS[toolName] ?? null, mediaPolicyId: null, flow: 'LEGACY' });
}
