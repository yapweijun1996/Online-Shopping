import { lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { relative, isAbsolute } from 'node:path';

// Inputs are operator-trusted and must remain unchanged throughout the import.
export async function readSeedFile(path, cap, root) {
  const entry = await lstat(path);
  if (!entry.isFile()) throw new Error('Input must be a regular file.');
  const actual = await realpath(path);
  if (root) {
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Input escapes image root.');
  }
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size > cap) throw new Error('Input is not a bounded regular file.');
    const bytes = Buffer.alloc(cap + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > cap) throw new Error('Input exceeds size limit.');
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

// Structural validation, not a full entropy decoder. Require a frame and a scan,
// bounded segments, properly escaped scan bytes, and an exact terminal EOI.
export function validateSeedJpeg(b) {
  const invalid = () => { throw new Error('Invalid JPEG structure.'); };
  if (b.length < 4 || b.readUInt16BE(0) !== 0xffd8) invalid();
  let p = 2, frame = false, scan = false;
  while (p < b.length) {
    if (b[p++] !== 0xff) invalid();
    while (b[p] === 0xff) p++;
    const marker = b[p++];
    if (marker === 0xd9) {
      if (!frame || !scan || p !== b.length) invalid();
      return;
    }
    if (!marker || marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7 || p + 2 > b.length) invalid();
    const length = b.readUInt16BE(p);
    if (length < 2 || p + length > b.length) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || length < 8) invalid();
      const height = b.readUInt16BE(p + 3), width = b.readUInt16BE(p + 5), components = b[p + 7];
      if (b[p + 2] !== 8 || !components || components > 4 || length !== 8 + 3 * components || !width || !height || width > 4096 || height > 4096 || width * height > 16_000_000) invalid();
      frame = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) invalid();
    if (marker === 0xda) {
      if (!frame || length < 6 || !b[p + 2] || length !== 6 + 2 * b[p + 2]) invalid();
      scan = true;
      p += length;
      const start = p;
      while (p < b.length) {
        if (b[p] !== 0xff) { p++; continue; }
        if (b[p + 1] === 0 || b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7) { p += 2; continue; }
        break;
      }
      if (p === start) invalid();
    } else p += length;
  }
  invalid();
}
