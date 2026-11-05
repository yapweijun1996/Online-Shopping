import { createHash } from 'node:crypto';

export const MAX_SOURCE = 512 * 1024;
export const MAX_THUMBNAIL = 80 * 1024;
export const MAX_PIXELS = 4 * 1024 * 1024;
export const MAX_SIDE = 8192;
export const MAX_HEADER = 2048;
export const MAX_OUTPUT = 4 + MAX_HEADER + MAX_SOURCE + MAX_THUMBNAIL;
export const TOTAL_MS = 5000;
export const CODEC = 'sharp/0.35.5/policy-1';
export const MIME = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export class CodecError extends Error {
  constructor(code = 'INVALID_IMAGE') { super(code); this.code = code; }
}
export function sourceContract(bytes, mime, digest) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_SOURCE ||
      !Object.values(MIME).includes(mime) || !/^[a-f0-9]{64}$/.test(digest ?? '') ||
      sha256(bytes) !== digest) throw new CodecError();
}
export function encodeOutput(result) {
  const { image, thumbnail, ...header } = result;
  const json = Buffer.from(JSON.stringify(header));
  if (json.length > MAX_HEADER) throw new CodecError('CODEC_FAILED');
  const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, image, thumbnail]);
}
export function decodeOutput(bytes, expectedDigest) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > MAX_OUTPUT) throw 0;
    const n = bytes.readUInt32BE();
    if (n < 1 || n > MAX_HEADER || bytes.length < 4 + n) throw 0;
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + n));
    const header = JSON.parse(json);
    if (JSON.stringify(header) !== json) throw 0;
    const keys = ['version', 'codec', 'sourceSha256', 'mime', 'width', 'height', 'imageBytes', 'imageSha256',
      'thumbnailMime', 'thumbnailBytes', 'thumbnailSha256'];
    if (!header || Array.isArray(header) || Object.keys(header).length !== keys.length ||
        keys.some(key => !Object.hasOwn(header, key)) || header.version !== 1 || header.codec !== CODEC ||
        header.sourceSha256 !== expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest) ||
        !Object.values(MIME).includes(header.mime) || header.thumbnailMime !== MIME.png ||
        !Number.isInteger(header.width) || !Number.isInteger(header.height) ||
        header.width < 1 || header.height < 1 || header.width > MAX_SIDE || header.height > MAX_SIDE ||
        header.width * header.height > MAX_PIXELS || !Number.isInteger(header.imageBytes) ||
        header.imageBytes < 1 || header.imageBytes > MAX_SOURCE || !Number.isInteger(header.thumbnailBytes) ||
        header.thumbnailBytes < 1 || header.thumbnailBytes > MAX_THUMBNAIL ||
        bytes.length !== 4 + n + header.imageBytes + header.thumbnailBytes) throw 0;
    const image = bytes.subarray(4 + n, 4 + n + header.imageBytes);
    const thumbnail = bytes.subarray(4 + n + header.imageBytes);
    if (sha256(image) !== header.imageSha256 || sha256(thumbnail) !== header.thumbnailSha256) throw 0;
    const png = data => data.length >= 8 && data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    if (!png(thumbnail) || (header.mime === MIME.png && !png(image)) ||
        (header.mime === MIME.jpeg && (image.length < 3 || image[0] !== 255 || image[1] !== 216 || image[2] !== 255)) ||
        (header.mime === MIME.webp && (image.length < 12 || image.toString('ascii', 0, 4) !== 'RIFF' || image.toString('ascii', 8, 12) !== 'WEBP'))) throw 0;
    return { ...header, image, thumbnail };
  } catch { throw new CodecError('CODEC_FAILED'); }
}
