import { createHash } from 'node:crypto';

// The owner must keep this value outside the shop database's restore domain
// and rotate it on every restore. This helper does not provision or persist it.
export function operationEpochHash(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new TypeError('A 32-byte operation epoch is required.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) throw new TypeError('Invalid operation epoch.');
  return createHash('sha256').update(bytes).digest('hex');
}
