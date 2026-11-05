import { createHash } from 'node:crypto';
import { MEDIA_LIMITS } from './media-schema.js';
import { isMediaHash, mediaObject } from './media-policy.js';
const invalid = () => { throw new TypeError('Invalid bound upload thumbnail.'); };

/** Server-owned canonical thumbnail metadata; contains no bytes or authority. */
export function uploadThumbnail(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8 || bytes.byteLength > MEDIA_LIMITS.thumbnailBytes ||
      Buffer.from(bytes.buffer, bytes.byteOffset, 8).toString('hex') !== '89504e470d0a1a0a') invalid();
  return Object.freeze({ sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, mime: 'image/png' });
}
/** Compare immutable proposal metadata to actual private BOUND thumbnail bytes. */
export function assertUploadThumbnail(value, actualBytes) {
  mediaObject(value, ['sha256','byteLength','mime']);
  if (!isMediaHash(value.sha256) || !Number.isSafeInteger(value.byteLength) || value.byteLength < 8 ||
      value.byteLength > MEDIA_LIMITS.thumbnailBytes || value.mime !== 'image/png') invalid();
  const actual = uploadThumbnail(actualBytes);
  if (value.sha256 !== actual.sha256 || value.byteLength !== actual.byteLength || value.mime !== actual.mime) invalid();
  return actual;
}
