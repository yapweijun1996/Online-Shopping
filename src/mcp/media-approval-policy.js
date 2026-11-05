import { ApiError } from '../http.js';
import { stamp } from './credentials.js';
import { MEDIA_LIMITS } from './media-schema.js';
import { isMediaHash, isMediaUuid, mediaDescriptorHash, mediaInstant, validateMediaDescriptor } from './media-policy.js';
import { MEDIA_REVIEW_ACKNOWLEDGED, OPERATION_APPROVAL_MS } from './operation-policy.js';
const deny = () => { throw new ApiError(403, 'FORBIDDEN', 'Image review could not be verified.'); };

// Expected delivery identities from a validated canonical manifest. No authority granted.
export function mediaReviewItems(manifest) {
  if (!manifest || manifest.pages?.length !== manifest.descriptor?.pageCount || manifest.assets?.length !== manifest.descriptor?.assetCount ||
      manifest.pages.length > MEDIA_LIMITS.pages || manifest.assets.length > MEDIA_LIMITS.assets) deny();
  const items = [...manifest.pages.map(page => ({ kind: 'PAGE', itemKey: String(page.page_index), hash: page.page_hash,
    pageIndex: page.page_index, assetKey: null })), ...manifest.assets.map(asset => ({ kind: 'ASSET', itemKey: asset.asset_key,
    hash: asset.byte_sha256, pageIndex: null, assetKey: asset.asset_key }))];
  if (items.some(item => !isMediaHash(item.hash)) || new Set(items.map(item => item.kind + ':' + item.itemKey)).size !== items.length) deny();
  return Object.freeze(items.map(Object.freeze));
}
// Same-transaction evidence integrity; caller verifies current live authority/domain state.
export async function readMediaApprovalEvidence(store, { operation: row, envelope, approval, authority, manifest }) {
  let descriptor;
  try { descriptor = validateMediaDescriptor(envelope.proposal.media, row.tool_name); } catch { deny(); }
  const proof = await store.get('SELECT * FROM mcp_v2_media_approval_evidence WHERE operation_id=?', row.id);
  if (!proof || !isMediaUuid(proof.challenge_id) || proof.manifest_root !== descriptor.manifestRoot ||
      proof.descriptor_hash !== mediaDescriptorHash(descriptor) || proof.policy_id !== row.media_policy_id ||
      proof.approver_id !== row.account_id || proof.approver_id !== approval.approver_id || proof.session_hash !== approval.session_hash ||
      proof.account_auth_version !== authority.accountAuthVersion || proof.epoch_hash !== row.epoch_hash ||
      proof.build_digest !== row.build_digest || proof.tenant_revision !== row.tenant_revision ||
      proof.approved_at !== approval.approved_at || proof.expires_at !== approval.expires_at ||
      ![proof.approved_at, proof.expires_at, proof.acknowledged_at].every(mediaInstant) ||
      proof.expires_at <= proof.approved_at || proof.expires_at > row.expires_at ||
      Date.parse(proof.expires_at) - Date.parse(proof.approved_at) > OPERATION_APPROVAL_MS ||
      proof.acknowledged_at < row.created_at || proof.acknowledged_at > approval.approved_at ||
      mediaDescriptorHash(manifest.descriptor) !== mediaDescriptorHash(descriptor)) deny();
  const challenge = await store.get('SELECT * FROM mcp_v2_approval_challenge WHERE id=?', proof.challenge_id);
  if (!challenge || challenge.operation_id !== row.id || challenge.account_id !== row.account_id ||
      challenge.session_hash !== approval.session_hash || challenge.account_auth_version !== authority.accountAuthVersion ||
      !isMediaHash(challenge.nonce_hash) || challenge.consumed_at !== approval.approved_at ||
      ![challenge.created_at, challenge.expires_at, challenge.bound_at].every(mediaInstant) ||
      challenge.created_at < row.created_at || challenge.bound_at < challenge.created_at || challenge.bound_at > approval.approved_at ||
      challenge.expires_at <= approval.approved_at || challenge.expires_at > row.expires_at ||
      Date.parse(challenge.expires_at) - Date.parse(challenge.created_at) > OPERATION_APPROVAL_MS || approval.approved_at > stamp()) deny();
  const items = mediaReviewItems(manifest), expected = new Map(items.map(item => [item.kind + ':' + item.itemKey, item]));
  const deliveries = await store.all('SELECT * FROM mcp_v2_media_delivery WHERE challenge_id=? LIMIT ?',
    proof.challenge_id, MEDIA_LIMITS.pages + MEDIA_LIMITS.assets + 1);
  if (deliveries.length !== expected.size) deny();
  for (const delivery of deliveries) {
    const key = delivery.kind + ':' + delivery.item_key, item = expected.get(key);
    if (!item || delivery.operation_id !== row.id || delivery.manifest_root !== descriptor.manifestRoot ||
        delivery.expected_hash !== item.hash || !isMediaHash(delivery.nonce_hash) ||
        delivery.page_index !== item.pageIndex || delivery.asset_key !== item.assetKey ||
        ![delivery.issued_at, delivery.expires_at, delivery.ack_at].every(mediaInstant) ||
        delivery.issued_at < challenge.bound_at || delivery.expires_at <= delivery.issued_at ||
        delivery.expires_at > challenge.expires_at || delivery.ack_at < delivery.issued_at ||
        delivery.ack_at > delivery.expires_at || delivery.ack_at > proof.acknowledged_at) deny();
    expected.delete(key);
  }
  if (expected.size) deny();
  const event = await store.get(`SELECT id FROM mcp_v2_event WHERE operation_id=? AND tenant_id=?
    AND account_id=? AND client_id=? AND grant_id=? AND tool_name=? AND approver_id=?
    AND correlation_id=? AND at=? AND event='APPROVE' AND outcome=? LIMIT 1`,
  row.id, row.tenant_id, row.account_id, row.client_id, row.grant_id, row.tool_name,
  approval.approver_id, row.correlation_id, approval.approved_at, MEDIA_REVIEW_ACKNOWLEDGED);
  if (!event) deny();
  return Object.freeze({ manifestRoot: descriptor.manifestRoot, descriptorHash: proof.descriptor_hash,
    challengeId: proof.challenge_id, approvedAt: approval.approved_at });
}
