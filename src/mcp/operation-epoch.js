import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import path from 'node:path';

// The owner must keep this value outside the shop database's restore domain
// and rotate it on every restore. This helper does not provision or persist it.
export function operationEpochHash(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new TypeError('A 32-byte operation epoch is required.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) throw new TypeError('Invalid operation epoch.');
  return createHash('sha256').update(bytes).digest('hex');
}

// Read the pathname again on every fence: a directory bind exposes atomic
// replacement, whereas retaining an open file descriptor would pin old bytes.
export function readOperationEpochFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('Invalid epoch file.');
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 43n || before.size > 45n) throw new TypeError('Invalid epoch file.');
    const bytes = Buffer.alloc(46), length = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(file, { bigint: true });
    if (length !== Number(before.size) || !current.isFile() ||
        [after, current].some(stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => stat[key] !== before[key]))) {
      throw new TypeError('Epoch file changed.');
    }
    const value = bytes.subarray(0, length).toString('utf8').replace(/\r?\n$/, '');
    operationEpochHash(value);
    return value;
  } finally { if (fd !== undefined) closeSync(fd); }
}

// Eligibility fence only, never an authority grant. A stale process must be
// restarted with the new restore domain; it must not adopt the replacement.
export function operationEpochCurrent(mcpV2) {
  if (mcpV2?.enabled !== true) return true;
  if (mcpV2.epochFile === undefined) return mcpV2.profile?.kind !== 'production';
  try { return readOperationEpochFile(mcpV2.epochFile) === mcpV2.epoch; }
  catch { return false; }
}
