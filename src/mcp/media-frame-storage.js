import { ApiError } from '../http.js';
import { MEDIA_LIMITS } from './media-schema.js';
import { isMediaUuid, mediaJson } from './media-policy.js';
import { mediaManifestRows, readMediaManifest } from './media-manifest.js';
import { mediaContext, readMediaPolicy, withMediaWriter } from './media-storage.js';

const conflict = () => { throw new ApiError(409, 'MEDIA_FRAME_CONFLICT', 'Media frame changed.'); };
const integrity = () => { throw new ApiError(503, 'MEDIA_FRAME_INTEGRITY', 'Media frame is inconsistent.'); };
const pageColumns = 'operation_id,page_index,page_json,page_hash,record_count,created_at';
const assetColumns = 'operation_id,asset_key,source_kind,source_id,source_product_id,stage_id,byte_sha256,mime,byte_length,before_needed,after_needed';

async function parent(store, context, operationId) {
  if (!isMediaUuid(operationId)) conflict();
  // The caller separately owns live authority and platform lifecycle fencing.
  const policy = await readMediaPolicy(store, context, operationId);
  if (!policy) conflict();
  const operation = await store.get('SELECT * FROM mcp_v2_operation WHERE id=?', operationId);
  return { operation, policy };
}
async function pins(store, context, operation, manifest) {
  const stageAssets = new Map();
  for (const page of manifest.pages) for (const record of JSON.parse(page.page_json).records) {
    if (record.kind === 'ASSET') for (const ref of record.stage_refs) stageAssets.set(ref.stage_id, record);
  }
  const rows = await store.all('SELECT stage_id,canonical_sha256,codec_digest,created_at,expires_at FROM mcp_v2_media_pin WHERE operation_id=? ORDER BY stage_id LIMIT 11', operation.id);
  if (rows.length !== manifest.stages.length || rows.length > MEDIA_LIMITS.newAssets) integrity();
  await withMediaWriter(store, context, async writer => {
    for (const [index, expected] of manifest.stages.entries()) {
      const pin = rows[index], stage = await writer.inspect(expected.stage_id), asset = stageAssets.get(expected.stage_id);
      if (pin.stage_id !== expected.stage_id || pin.canonical_sha256 !== expected.canonical_sha256 ||
          pin.codec_digest !== expected.codec_digest || pin.expires_at !== operation.expires_at ||
          pin.created_at < operation.created_at || pin.created_at >= operation.expires_at ||
          stage.state !== 'BOUND' || stage.operationId !== operation.id || stage.productId !== expected.source_product_id ||
          stage.canonicalSha256 !== expected.canonical_sha256 || stage.codecDigest !== expected.codec_digest ||
          !asset || stage.canonicalMime !== asset.mime || stage.canonicalBytes !== asset.byte_length ||
          stage.boundExpiresAt !== operation.expires_at || stage.correlationId !== operation.correlation_id) integrity();
    }
  });
}
async function readFrame(store, context, operationId, proposalDescriptor) {
  const { operation, policy } = await parent(store, context, operationId);
  const pages = await store.all(`SELECT ${pageColumns} FROM mcp_v2_media_manifest_page WHERE operation_id=? ORDER BY page_index LIMIT 17`, operationId);
  const assets = await store.all(`SELECT ${assetColumns} FROM mcp_v2_media_asset_ref WHERE operation_id=? ORDER BY asset_key LIMIT 43`, operationId);
  let manifest;
  try { manifest = readMediaManifest({ policy, pages, assets }, operation, proposalDescriptor); } catch { integrity(); }
  await pins(store, context, operation, manifest);
  return manifest;
}

/** Internal only: caller holds current authority and platform -> tenant writer fence. */
export async function persistMediaFrame(store, trustedContext, operationId, manifest) {
  const context = mediaContext(trustedContext);
  return store.transaction(async () => {
    const { operation, policy } = await parent(store, context, operationId);
    if (!['PREPARED', 'PENDING_APPROVAL'].includes(operation.state)) conflict();
    const frame = mediaManifestRows(manifest, { operationId, toolName: operation.tool_name,
      createdAt: operation.created_at, expiresAt: operation.expires_at });
    if (mediaJson(frame.policy) !== mediaJson(policy)) conflict();
    await pins(store, context, operation, manifest);
    if ((await store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_manifest_page WHERE operation_id=?', operationId)).n ||
        (await store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref WHERE operation_id=?', operationId)).n) conflict();
    for (const row of frame.pages) await store.run(`INSERT INTO mcp_v2_media_manifest_page(${pageColumns}) VALUES(?,?,?,?,?,?)`,
      row.operation_id, row.page_index, row.page_json, row.page_hash, row.record_count, row.created_at);
    for (const row of frame.assets) await store.run(`INSERT INTO mcp_v2_media_asset_ref(${assetColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      row.operation_id, row.asset_key, row.source_kind, row.source_id, row.source_product_id, row.stage_id, row.byte_sha256,
      row.mime, row.byte_length, row.before_needed, row.after_needed);
    return readFrame(store, context, operationId, manifest.descriptor);
  });
}

/** Validated metadata only; never serves bytes or grants authority. */
export async function readMediaFrame(store, trustedContext, operationId, proposalDescriptor = undefined) {
  const context = mediaContext(trustedContext);
  return store.transaction(() => readFrame(store, context, operationId, proposalDescriptor));
}
