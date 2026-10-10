import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function encodeBase32(bytes) {
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { result += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) result += ALPHABET[(value << (5 - bits)) & 31];
  return result;
}
export function decodeBase32(text) {
  if (typeof text !== 'string' || !/^[A-Z2-7]+$/.test(text)) throw new Error('Invalid authenticator key.');
  let bits = 0, value = 0; const bytes = [];
  for (const char of text) {
    value = (value << 5) | ALPHABET.indexOf(char); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
export const newTotpSecret = () => encodeBase32(randomBytes(20));
export function totpCode(secret, step, digits = 6) {
  if (!Number.isSafeInteger(step) || step < 0 || ![6, 8].includes(digits)) throw new Error('Invalid authenticator step.');
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}
export function matchingTotpStep(secret, code, now = Date.now(), lastStep = -1) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000); let matched = null;
  for (const candidate of [step - 1, step, step + 1]) {
    if (candidate < 0) continue;
    const equal = timingSafeEqual(Buffer.from(code), Buffer.from(totpCode(secret, candidate)));
    if (equal && candidate > (lastStep ?? -1)) matched = candidate;
  }
  return matched;
}
