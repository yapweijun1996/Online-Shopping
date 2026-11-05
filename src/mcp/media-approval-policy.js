import { ApiError } from '../http.js';
import { stamp } from './credentials.js';
import { MEDIA_LIMITS } from './media-schema.js';
import { isMediaHash, isMediaUuid, mediaDescriptorHash, mediaInstant, validateMediaDescriptor } from './media-policy.js';
import { MEDIA_REVIEW_ACKNOWLEDGED, OPERATION_APPROVAL_MS } from './operation-policy.js';
import { readMediaFrame } from './media-frame-storage.js';
import { readMediaSnapshot, loadOldMediaAsset } from './media-resources.js';
import { withMediaWriter, mediaHash } from './media-storage.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { assertUploadThumbnail } from './media-upload-policy.js';
import { catalogMediaAllowed, catalogMediaCreateAllowed } from './catalog-media-config.js';
import { parseCatalogMediaUpdateProposal, readCatalogMediaUpdateReview } from './catalog-media-adapter.js';
import { parseCatalogMediaCreateProposal, readCatalogMediaCreateReview } from './catalog-media-create-adapter.js';
const deny = () => { throw new ApiError(403, 'FORBIDDEN', 'Image review could not be verified.'); };

// Metadata only: callers supply current human authority inside the same fence/transaction.
// The content revision binds literal labels and all physical images, not timestamps.
export async function readMediaReviewState(store, operation, envelope, context, {catalogUpdateEnabled=false,catalogCreateEnabled=false,codecDigest}={}) {
  if (operation.media_policy_id === 'catalog-media-v1') {
    if (!catalogMediaAllowed({catalogUpdateEnabled,catalogCreateEnabled},
      {toolName:operation.tool_name,mediaPolicyId:operation.media_policy_id,resourceType:operation.resource_type}) || !isMediaHash(codecDigest)) deny();
    return catalogMediaCreateAllowed(catalogCreateEnabled,{toolName:operation.tool_name,mediaPolicyId:operation.media_policy_id,resourceType:operation.resource_type})
      ? readCatalogCreateReviewState(store,operation,envelope,context,codecDigest)
      : readCatalogReviewState(store,operation,envelope,context,codecDigest);
  }
  const manifest = await readMediaFrame(store, context, operation.id, envelope.proposal.media);
  const snapshot = await readMediaSnapshot(store, operation.resource_id);
  if (snapshot.revision !== operation.expected_revision || manifest.descriptor.graphRevision !== snapshot.revision ||
      operation.risk !== 'HIGH' || operation.resource_type !== 'product' ||
      (operation.media_policy_id === 'media-upload-v1' ? manifest.stages.length !== 1 : manifest.stages.length !== 0)) deny();
  const expected = [...snapshot.before.products.map(({ productId, ...before }) => ({ kind: 'PRODUCT', productId, before })),
    ...snapshot.before.listings.map(({ listingId, ...before }) => ({ kind: 'LISTING', listingId, before }))];
  if (expected.length !== manifest.effects.length) deny();
  for (const effect of expected) {
    const actual = manifest.effects.find(value => value.kind === effect.kind &&
      (value.productId ?? value.listingId) === (effect.productId ?? effect.listingId));
    if (!actual || canonicalOperationJson(actual.before) !== canonicalOperationJson(effect.before)) deny();
  }
  await withMediaWriter(store, context, async writer => {
    for (const expected of manifest.stages) {
      const stage = await writer.inspect(expected.stage_id);
      if (stage.productId !== operation.resource_id || stage.expectedRevision !== snapshot.revision ||
          stage.receiptExpiresAt !== operation.receipt_expires_at || stage.correlationId !== operation.correlation_id ||
          stage.codecDigest !== manifest.descriptor.codecDigest) deny();
      const bytes = await writer.boundBytes(expected.stage_id, operation.id);
      if (operation.media_policy_id === 'media-upload-v1') assertUploadThumbnail(envelope.proposal.thumbnail, bytes.thumbnail);
      if (bytes.canonicalSha256 !== expected.canonical_sha256) deny();
    }
  });
  return { manifest, snapshot };
}

async function readCatalogReviewState(store,operation,envelope,context,codecDigest) {
  const manifest = await readMediaFrame(store,context,operation.id,envelope.proposal.media);
  try {
    const value = parseCatalogMediaUpdateProposal(envelope.proposal);
    if (operation.risk !== 'HIGH' || !isMediaUuid(operation.resource_id) || value.productId !== operation.resource_id) deny();
    const fresh = await readCatalogMediaUpdateReview(store,{productId:operation.resource_id,
      normalizedInput:value.normalizedInput,plannedIdentity:value.plannedIdentity},codecDigest);
    if (fresh.revision !== operation.expected_revision || manifest.descriptor.graphRevision !== fresh.revision || manifest.stages.length !== 0 ||
        canonicalOperationJson(fresh.proposal) !== canonicalOperationJson(value) ||
        canonicalOperationJson(fresh.manifest.descriptor) !== canonicalOperationJson(manifest.descriptor) ||
        fresh.manifest.pages.length !== manifest.pages.length || fresh.manifest.pages.some((page,n) => page.page_json !== manifest.pages[n].page_json)) deny();
    // The byte loader must retain the raw B1 capture and its union selector.
    // Never overwrite its revision with the final catalog composite.
    return {manifest,snapshot:fresh.state.mediaSnapshot};
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) throw error;
    deny();
  }
}

async function readCatalogCreateReviewState(store,operation,envelope,context,codecDigest) {
  const manifest = await readMediaFrame(store,context,operation.id,envelope.proposal.media);
  try {
    const value = parseCatalogMediaCreateProposal(envelope.proposal);
    if (operation.risk !== 'HIGH' || operation.resource_id !== 'catalog' || operation.resource_type !== 'catalog') deny();
    const fresh = await readCatalogMediaCreateReview(store,{normalizedInput:value.normalizedInput,
      creationIdentity:value.creationIdentity},codecDigest,value.sourceRevision);
    if (fresh.revision !== operation.expected_revision || manifest.descriptor.graphRevision !== fresh.revision || manifest.stages.length !== 0 ||
        canonicalOperationJson(fresh.proposal) !== canonicalOperationJson(value) ||
        canonicalOperationJson(fresh.manifest.descriptor) !== canonicalOperationJson(manifest.descriptor) ||
        fresh.manifest.pages.length !== manifest.pages.length || fresh.manifest.pages.some((page,n) => page.page_json !== manifest.pages[n].page_json)) deny();
    const source = fresh.state.source;
    const labels = value.reviewLabels.map(({productId,after}) => ({productId,sku:after.sku,name:after.name}));
    if (source.kind === 'EXISTING_TARGET') return {manifest,snapshot:source.snapshot,labels};
    // EMPTY_BEFORE is not a database capture. Its PAGE proof is still mandatory.
    if (source.kind !== 'EMPTY_BEFORE' || manifest.assets.length !== 0 || manifest.stages.length !== 0 || manifest.pages.length < 1) deny();
    return {manifest,snapshot:null,labels};
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) throw error;
    deny();
  }
}

// Exact SSOT loader only; never accepts a URL, path, user thumbnail or caller source identity.
export async function loadMediaReviewAsset(store, operation, state, context, assetKey) {
  const asset = state.manifest.assets.find(value => value.asset_key === assetKey);
  if (!asset) deny();
  let data;
  if (asset.source_kind === 'STAGE') {
    const result = await withMediaWriter(store, context, writer => writer.boundBytes(asset.stage_id, operation.id));
    if (result.mime !== asset.mime || result.canonicalSha256 !== asset.byte_sha256) deny();
    data = result.image;
  } else {
    if (!state.snapshot) deny();
    const source = Object.fromEntries(['source_kind','source_id','source_product_id','stage_id','byte_sha256','mime','byte_length'].map(key => [key, asset[key]]));
    data = (await loadOldMediaAsset(store, state.snapshot, source)).data;
  }
  if (data.byteLength !== asset.byte_length || mediaHash(data) !== asset.byte_sha256 || data.byteLength > MEDIA_LIMITS.canonicalBytes) deny();
  return { data, mime: asset.mime };
}

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
export async function readMediaAcknowledgements(store, { operation: row, manifest, challenge, before = stamp() }) {
  const items = mediaReviewItems(manifest), expected = new Map(items.map(item => [item.kind + ':' + item.itemKey, item]));
  const deliveries = await store.all('SELECT * FROM mcp_v2_media_delivery WHERE challenge_id=? LIMIT ?',
    challenge.id, MEDIA_LIMITS.pages + MEDIA_LIMITS.assets + 1);
  if (deliveries.length !== expected.size) deny();
  let latest = null;
  for (const delivery of deliveries) {
    const key = delivery.kind + ':' + delivery.item_key, item = expected.get(key);
    if (!item || delivery.operation_id !== row.id || delivery.manifest_root !== manifest.descriptor.manifestRoot ||
        delivery.expected_hash !== item.hash || !isMediaHash(delivery.nonce_hash) ||
        delivery.page_index !== item.pageIndex || delivery.asset_key !== item.assetKey ||
        ![delivery.issued_at, delivery.expires_at, delivery.ack_at].every(mediaInstant) ||
        delivery.issued_at < challenge.bound_at || delivery.expires_at <= delivery.issued_at ||
        delivery.expires_at > challenge.expires_at || delivery.ack_at < delivery.issued_at ||
        delivery.ack_at >= delivery.expires_at || delivery.ack_at > before) deny();
    if (latest === null || delivery.ack_at > latest) latest = delivery.ack_at;
    expected.delete(key);
  }
  if (expected.size || latest === null) deny();
  return latest;
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
  if (await readMediaAcknowledgements(store, { operation: row, manifest, challenge, before: approval.approved_at }) !== proof.acknowledged_at) deny();
  const event = await store.get(`SELECT id FROM mcp_v2_event WHERE operation_id=? AND tenant_id=?
    AND account_id=? AND client_id=? AND grant_id=? AND tool_name=? AND approver_id=?
    AND correlation_id=? AND at=? AND event='APPROVE' AND outcome=? LIMIT 1`,
  row.id, row.tenant_id, row.account_id, row.client_id, row.grant_id, row.tool_name,
  approval.approver_id, row.correlation_id, approval.approved_at, MEDIA_REVIEW_ACKNOWLEDGED);
  if (!event) deny();
  return Object.freeze({ manifestRoot: descriptor.manifestRoot, descriptorHash: proof.descriptor_hash,
    challengeId: proof.challenge_id, approvedAt: approval.approved_at });
}
