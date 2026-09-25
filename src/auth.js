import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const SESSION_MS = 12 * 60 * 60 * 1000;
const scryptAsync = promisify(scrypt);

function passwordHash(password, salt) {
  return scryptSync(password, salt, 64);
}

function encodePassword(password) {
  const salt = randomBytes(24).toString('hex');
  return `${salt}:${passwordHash(password, salt).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const candidate = passwordHash(password, salt);
  return timingSafeEqual(candidate, Buffer.from(expected, 'hex'));
}

async function verifyPasswordAsync(password, stored) {
  const [salt, expected] = stored.split(':');
  const candidate = await scryptAsync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(expected, 'hex'));
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function ensureAdmin(database, username, password) {
  const existing = database.get('SELECT username, password_hash FROM admin WHERE id = 1');
  if (!existing) {
    database.run('INSERT INTO admin(id, username, password_hash, created_at) VALUES (1, ?, ?, ?)',
      username, encodePassword(password), new Date().toISOString());
    return;
  }
  if (existing.username !== username || !verifyPassword(password, existing.password_hash)) {
    throw new Error('Configured admin credentials do not match the provisioned administrator.');
  }
}

export async function authenticate(database, username, password) {
  const admin = database.get('SELECT username, password_hash FROM admin WHERE id = 1');
  if (!admin) return false;
  const passwordOk = await verifyPasswordAsync(password, admin.password_hash);
  return admin.username === username && passwordOk;
}

export function createSession(database) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const now = Date.now();
  database.run('DELETE FROM session WHERE expires_at <= ?', new Date(now).toISOString());
  database.run('INSERT INTO session(token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?)',
    hashToken(token), csrfToken, new Date(now + SESSION_MS).toISOString(), new Date(now).toISOString());
  return { token, csrfToken, maxAge: SESSION_MS / 1000 };
}

export function readSession(database, token) {
  if (!token || token.length > 128) return null;
  const row = database.get('SELECT token_hash, csrf_token, expires_at FROM session WHERE token_hash = ?', hashToken(token));
  return row && row.expires_at > new Date().toISOString() ? row : null;
}

export function deleteSession(database, token) {
  if (token) database.run('DELETE FROM session WHERE token_hash = ?', hashToken(token));
}

export function cookieFor(token, maxAge, secure) {
  return `seller_session=${token}; HttpOnly; SameSite=Strict; Path=/api/v1/seller; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function sessionCookieFrom(header = '') {
  const match = header.match(/(?:^|;\s*)seller_session=([^;]+)/);
  return match?.[1] || null;
}

/* Each attempt reserves a slot before the password check, so concurrent requests cannot exceed the limit. */
export class LoginLimiter {
  #attempts = new Map();
  attempt(key) {
    const now = Date.now();
    const attempts = (this.#attempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
    if (attempts.length >= 5) {
      this.#attempts.set(key, attempts);
      return false;
    }
    if (!this.#attempts.has(key) && this.#attempts.size >= 5000) {
      this.#attempts.delete(this.#attempts.keys().next().value);
    }
    attempts.push(now);
    this.#attempts.set(key, attempts);
    return true;
  }
  clear(key) {
    this.#attempts.delete(key);
  }
}
