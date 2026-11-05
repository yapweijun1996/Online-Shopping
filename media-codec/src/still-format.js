import { CodecError, MIME } from './contract.js';

/** Reject animation containers that a still-only loader may silently flatten. Full decode still follows. */
export function requireStillContainer(bytes, mime) {
  if (mime === MIME.png) {
    if (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new CodecError();
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (length > bytes.length - offset - 12 || ['acTL', 'fcTL', 'fdAT'].includes(kind)) throw new CodecError();
      offset += length + 12;
      if (kind === 'IEND') break;
    }
  } else if (mime === MIME.webp) {
    if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new CodecError();
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString('ascii', offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      if (length > bytes.length - offset - 8 || ['ANIM', 'ANMF'].includes(kind) ||
          (kind === 'VP8X' && length > 0 && (bytes[offset + 8] & 2))) throw new CodecError();
      offset += 8 + length + (length & 1);
    }
  } else if (mime === MIME.jpeg) {
    if (bytes.length < 3 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new CodecError();
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 255) {
      const marker = bytes[offset + 1];
      if (marker === 218 || marker === 217) break;
      if (marker === 255) { offset++; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || length > bytes.length - offset - 2) throw new CodecError();
      if (marker === 226 && bytes.toString('ascii', offset + 4, offset + 8) === 'MPF\0') throw new CodecError();
      offset += 2 + length;
    }
  } else throw new CodecError();
}
