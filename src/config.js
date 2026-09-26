import path from 'node:path';
import { readFileSync } from 'node:fs';

const weakPasswords = new Set(['password', 'password123', 'changeme', 'admin123', 'testpassword', 'replace-me']);
const placeholderWords = /password|changeme|replace[-_]?me|example|sample|default/i;

function validateAdmin(username, password, production) {
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    throw new Error('ADMIN_USERNAME must contain 3-64 safe characters.');
  }
  if (password.length < 16 || password.length > 256 || weakPasswords.has(password.toLowerCase()) || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('ADMIN_PASSWORD must be a non-default 16-256 character secret with letters and numbers.');
  }
  if (production && (placeholderWords.test(password) || password.toLowerCase().includes(username.toLowerCase()))) {
    throw new Error('ADMIN_PASSWORD must not contain a known placeholder or the username in production.');
  }
}

function validatePublicOrigin(publicOrigin, production) {
  if (publicOrigin === null && !production) return null;
  let parsed;
  try { parsed = new URL(publicOrigin); } catch { throw new Error('PUBLIC_ORIGIN must be an exact origin.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== publicOrigin || parsed.username || parsed.password) {
    throw new Error('PUBLIC_ORIGIN must be an exact origin.');
  }
  if (production && parsed.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must be an HTTPS origin in production.');
  return publicOrigin;
}

/* Worker configuration comes from wrangler vars and secrets; it is production unless explicitly development. */
export function readWorkerConfig(env) {
  const production = env.NODE_ENV !== 'development';
  const username = (env.ADMIN_USERNAME || '').trim();
  const password = env.ADMIN_PASSWORD || '';
  validateAdmin(username, password, production);
  const publicOrigin = validatePublicOrigin(env.PUBLIC_ORIGIN || null, production);
  return { production, username, password, publicOrigin, trustProxy: true };
}

export function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const username = (env.ADMIN_USERNAME || '').trim();
  if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD_FILE) {
    throw new Error('Set only one of ADMIN_PASSWORD and ADMIN_PASSWORD_FILE.');
  }
  let password = env.ADMIN_PASSWORD || '';
  if (env.ADMIN_PASSWORD_FILE) {
    try {
      password = readFileSync(env.ADMIN_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '');
    } catch {
      throw new Error('ADMIN_PASSWORD_FILE cannot be read.');
    }
  }
  validateAdmin(username, password, production);
  const dbPath = path.resolve(env.DB_PATH || '.local/online-shopping.db');
  const publicDir = path.resolve('public');
  if (dbPath === publicDir || dbPath.startsWith(`${publicDir}${path.sep}`)) {
    throw new Error('DB_PATH must be outside the public directory.');
  }
  if (production && !env.DB_PATH) throw new Error('DB_PATH is required in production.');
  const publicOrigin = validatePublicOrigin(env.PUBLIC_ORIGIN || null, production);
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid port.');
  const trustProxy = env.TRUST_PROXY === '1';
  if (env.TRUST_PROXY && !trustProxy) throw new Error('TRUST_PROXY must be 1 when set.');
  return { production, username, password, dbPath, publicOrigin, port, trustProxy };
}
