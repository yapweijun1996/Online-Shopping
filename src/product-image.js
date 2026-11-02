import { FieldError } from './validation.js';

const MAX_IMAGE_BYTES = 512 * 1024;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const MAX_THUMBNAIL_BYTES = 80 * 1024;

/* A small preview of an image (made by the seller's browser): same formats, much smaller; always optional. */
export function decodeThumbnail(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 120_000) throw new FieldError('thumbDataUrl', 'The preview image is too large.');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  const data = match && Buffer.from(match[2], 'base64');
  if (!data?.length || data.length > MAX_THUMBNAIL_BYTES || data.toString('base64') !== match[2]) {
    throw new FieldError('thumbDataUrl', 'The preview image is not valid.');
  }
  const png = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = data.length > 3 && data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  const webp = data.length > 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!({ 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp })[match[1]]) throw new FieldError('thumbDataUrl', 'The preview image is not valid.');
  return { mime: match[1], data };
}

export function decodeProductImage(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 750_000) {
    throw new FieldError('imageDataUrl', 'Choose a PNG, JPEG, or WebP image under 512 KB.');
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || !MIME_TYPES.has(match[1])) {
    throw new FieldError('imageDataUrl', 'Choose a PNG, JPEG, or WebP image under 512 KB.');
  }
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > MAX_IMAGE_BYTES || data.toString('base64') !== match[2]) {
    throw new FieldError('imageDataUrl', 'Choose a PNG, JPEG, or WebP image under 512 KB.');
  }
  const png = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = data.length > 3 && data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  const webp = data.length > 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!({ 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp })[match[1]]) {
    throw new FieldError('imageDataUrl', 'The image content does not match its format.');
  }
  return { mime: match[1], data };
}
