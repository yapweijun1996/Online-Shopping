import { createHash } from 'node:crypto';
import { canonicalOperationJson } from './operation-envelope.js';
import { MEDIA_LIMITS, MEDIA_POLICY_IDS, MEDIA_POLICY_DESCRIPTOR_FIELDS } from './media-schema.js';

const invalid = () => { throw new TypeError('Invalid media metadata.'); };
export const mediaHash = value => createHash('sha256').update(value, 'utf8').digest('hex');
export const isMediaHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isMediaUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const mediaInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function mediaJson(value, maxBytes = MEDIA_LIMITS.pageBytes) {
  const text = canonicalOperationJson(value);
  if (Buffer.byteLength(text) > maxBytes) invalid();
  return text;
}
export function mediaObject(value, keys) {
  // Validate accessors/prototypes/symbols before reading any metadata field.
  canonicalOperationJson(value);
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) invalid();
  return value;
}
export function freezeMedia(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeMedia(child); Object.freeze(value); }
  return value;
}
const families = [
  ['media-upload-v1', 'media.prepare_upload', 'media.commit_upload', ['media.write'], 'DIRECT'],
  ['media-layout-v1', 'media.preview_layout', 'media.commit_layout', ['media.write'], 'DIRECT'],
  ['catalog-media-v1', 'catalog.preview_create', 'catalog.commit_create', ['catalog.write', 'media.write'], 'RESERVED'],
  ['catalog-media-v1', 'catalog.preview_update', 'catalog.commit_update', ['catalog.write', 'media.write'], 'RESERVED'],
];
/** Fixed metadata only: this does not register tools, authorize access or activate reserved catalog flow. */
export function mediaPolicyForTool(toolName) {
  const family = families.find(([, preview, commit]) => toolName === preview || toolName === commit);
  if (!family || !MEDIA_POLICY_IDS.includes(family[0])) invalid();
  const [policyId, previewTool, commitTool, requiredScopes, flow] = family;
  return freezeMedia({ policyId, previewTool, commitTool, requiredScopes: [...requiredScopes],
    capability: 'catalog.write', risk: 'HIGH', flow });
}
export const MEDIA_DESCRIPTOR_FIELDS = MEDIA_POLICY_DESCRIPTOR_FIELDS;
export function validateMediaDescriptor(value, toolName = undefined) {
  mediaObject(value, MEDIA_DESCRIPTOR_FIELDS);
  if (!MEDIA_POLICY_IDS.includes(value.policyId) ||
      (toolName !== undefined && mediaPolicyForTool(toolName).policyId !== value.policyId) ||
      ![value.manifestRoot, value.graphRevision, value.codecDigest].every(isMediaHash) ||
      !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > MEDIA_LIMITS.pages ||
      !Number.isSafeInteger(value.assetCount) || value.assetCount < 0 || value.assetCount > MEDIA_LIMITS.assets ||
      !Number.isSafeInteger(value.effectCount) || value.effectCount < 1 ||
      value.effectCount + value.assetCount > MEDIA_LIMITS.records ||
      value.pageCount > value.effectCount + value.assetCount ||
      value.pageCount < Math.ceil((value.effectCount + value.assetCount) / MEDIA_LIMITS.pageRecords)) invalid();
  return freezeMedia(JSON.parse(mediaJson(value)));
}
export function makeMediaDescriptor(toolName, input) {
  mediaObject(input, MEDIA_DESCRIPTOR_FIELDS.filter(key => key !== 'policyId'));
  return validateMediaDescriptor({ policyId: mediaPolicyForTool(toolName).policyId, ...input }, toolName);
}
export const mediaDescriptorHash = value => mediaHash(mediaJson(validateMediaDescriptor(value)));
export function makeMediaPolicyRow(context, value) {
  mediaObject(context, ['operationId', 'toolName', 'createdAt', 'expiresAt']);
  const descriptor = validateMediaDescriptor(value, context.toolName);
  if (mediaPolicyForTool(context.toolName).previewTool !== context.toolName || !isMediaUuid(context.operationId) || !mediaInstant(context.createdAt) || !mediaInstant(context.expiresAt) ||
      Date.parse(context.expiresAt) - Date.parse(context.createdAt) !== MEDIA_LIMITS.absoluteMs - MEDIA_LIMITS.uploadMs) invalid();
  return freezeMedia({ operation_id: context.operationId, policy_id: descriptor.policyId,
    required_scopes: mediaPolicyForTool(context.toolName).requiredScopes.join(' '), descriptor_hash: mediaDescriptorHash(descriptor),
    manifest_root: descriptor.manifestRoot, graph_revision: descriptor.graphRevision, codec_digest: descriptor.codecDigest,
    page_count: descriptor.pageCount, asset_count: descriptor.assetCount, effect_count: descriptor.effectCount,
    created_at: context.createdAt, expires_at: context.expiresAt });
}
const rowKeys = ['operation_id', 'policy_id', 'required_scopes', 'descriptor_hash', 'manifest_root', 'graph_revision',
  'codec_digest', 'page_count', 'asset_count', 'effect_count', 'created_at', 'expires_at'];
function field(object, key, optional = false) {
  if (!object || ![Object.prototype, null].includes(Object.getPrototypeOf(object))) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (optional && !descriptor) return undefined;
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
  return descriptor.value;
}
/** Checks retained integrity only; token/grant/RBAC/tenant/current revision/approval remain separate. */
export function validateRetainedMediaPolicy(operation, row, proposalDescriptor = undefined) {
  const marker = field(operation, 'media_policy_id', true), tool = field(operation, 'tool_name');
  if (marker === null || marker === undefined) {
    if (row !== null || proposalDescriptor !== undefined || typeof tool !== 'string' || tool.startsWith('media.')) invalid();
    return null;
  }
  mediaObject(row, rowKeys);
  const policy = mediaPolicyForTool(tool);
  if (tool !== policy.previewTool || marker !== policy.policyId || field(operation, 'required_scope') !== policy.requiredScopes[0] ||
      field(operation, 'required_capability') !== policy.capability || field(operation, 'risk') !== policy.risk) invalid();
  const descriptor = makeMediaDescriptor(tool, { manifestRoot: row.manifest_root, graphRevision: row.graph_revision,
    codecDigest: row.codec_digest, pageCount: row.page_count, assetCount: row.asset_count, effectCount: row.effect_count });
  const expected = makeMediaPolicyRow({ operationId: field(operation, 'id'), toolName: tool,
    createdAt: field(operation, 'created_at'), expiresAt: field(operation, 'expires_at') }, descriptor);
  if (mediaJson(row) !== mediaJson(expected) ||
      (proposalDescriptor !== undefined && mediaJson(validateMediaDescriptor(proposalDescriptor, tool)) !== mediaJson(descriptor))) invalid();
  return descriptor;
}
