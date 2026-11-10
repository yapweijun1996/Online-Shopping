import { basePath } from '../shared/base-path.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const TEMPORARY_PASSWORD_LENGTH = 24;
export const PASSWORD_GENERATION_ATTEMPTS = 32;

// Client assistance only: the existing account API remains the policy authority.
export function validTemporaryPassword(value, username = '') {
  return typeof value === 'string' && value.length >= 12 && value.length <= 256
    && (!username || !value.toLowerCase().includes(username.toLowerCase())) && !/^(.)\1+$/.test(value);
}

export function generateTemporaryPassword(username = '', source = globalThis.crypto) {
  if (typeof source?.getRandomValues !== 'function') throw new Error('SECURE_RANDOM_UNAVAILABLE');
  for (let attempt = 0; attempt < PASSWORD_GENERATION_ATTEMPTS; attempt++) {
    const bytes = new Uint8Array(TEMPORARY_PASSWORD_LENGTH);
    try { source.getRandomValues(bytes); } catch { throw new Error('SECURE_RANDOM_UNAVAILABLE'); }
    // The alphabet has exactly64 symbols, so each six-bit index is uniform; no modulo bias.
    const password = [...bytes].map(byte => ALPHABET[byte & 63]).join('');
    if (validTemporaryPassword(password, username) && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password)) return password;
  }
  throw new Error('SECURE_RANDOM_RETRY_LIMIT');
}

export function sellerLoginUrl(location = globalThis.location) {
  return new URL(`${basePath(location.pathname)}/seller/`, location.origin).href;
}
