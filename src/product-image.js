import { FieldError } from './validation.js';

const MAX_IMAGE_BYTES = 512 * 1024;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

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
