import { ApiError } from '../http.js';
import { mediaHash } from './media-policy.js';
import { MEDIA_LIMITS } from './media-schema.js';
import { mediaFileMimeHint } from './media-contracts.js';

const conflict = () => { throw new ApiError(409, 'MEDIA_RESOURCE_CHANGED', 'Media upload cannot be resumed.'); };

// Trusted orchestration only. Download runs after authorization and outside the
// database/platform fence. Existing coordinator phases recheck current authority.
export async function uploadMediaFile({ args, bearer, coordinator, prepare, downloadFile }) {
  const { productId, targetSlot, expectedRevision, idempotencyKey, file } = args;
  await coordinator.preflight(bearer, { productId, targetSlot, expectedRevision });
  const downloaded = await downloadFile(file);
  const hint = mediaFileMimeHint(file.mime_type);
  if (!(downloaded?.bytes instanceof Uint8Array) || downloaded.bytes.byteLength < 1 ||
      downloaded.bytes.byteLength > MEDIA_LIMITS.sourceBytes || !['image/jpeg','image/png','image/webp'].includes(downloaded.mime) ||
      (hint !== undefined && hint !== downloaded.mime)) {
    throw new ApiError(400, 'MEDIA_FILE_INVALID', 'Invalid image file.');
  }
  return uploadMediaBytes({ args, bearer, coordinator, prepare, bytes: downloaded.bytes, mime: downloaded.mime });
}

// Both transports share exactly the same stage, native decoder and approval path.
export async function uploadMediaBytes({ args, bearer, coordinator, prepare, bytes: source, mime, stageId }) {
  const { productId, targetSlot, expectedRevision, idempotencyKey } = args;
  if (!(source instanceof Uint8Array) || !source.byteLength || source.byteLength > MEDIA_LIMITS.sourceBytes ||
      !['image/jpeg','image/png','image/webp'].includes(mime)) throw new ApiError(400, 'MEDIA_FILE_INVALID', 'Invalid image file.');
  const bytes = Buffer.from(source), sourceSha256 = mediaHash(bytes);
  const stage = await coordinator.begin(bearer, { productId, targetSlot, expectedRevision, idempotencyKey,
    sourceSha256, sourceMime: mime, declaredBytes: bytes.length }, stageId);
  if (!['UPLOADING','VALIDATING','BOUND'].includes(stage.state) || !Number.isSafeInteger(stage.nextOffset) ||
      stage.nextOffset < 0 || stage.nextOffset > bytes.length ||
      (stage.nextOffset !== bytes.length && stage.nextOffset % MEDIA_LIMITS.chunkBytes !== 0) ||
      (stage.state === 'VALIDATING' && stage.nextOffset !== bytes.length) ||
      (stage.state === 'BOUND' && (stage.nextOffset !== bytes.length || !stage.operationId))) conflict();
  for (let offset = stage.nextOffset; offset < bytes.length; offset += MEDIA_LIMITS.chunkBytes) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + MEDIA_LIMITS.chunkBytes));
    const dataParts = [];
    for (let part = 0; part < chunk.length; part += 3072) dataParts.push(chunk.subarray(part, part + 3072).toString('base64'));
    const next = await coordinator.append(bearer, { stageId: stage.stageId, offset, dataParts });
    if (next.state !== 'UPLOADING' || next.nextOffset !== offset + chunk.length) conflict();
  }
  return prepare({ bearer, toolName: 'media.prepare_upload', args: { stageId: stage.stageId },
    idempotencyKey: mediaHash('media.upload_file:seal:' + idempotencyKey) });
}
