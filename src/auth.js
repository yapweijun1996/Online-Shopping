import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_MS = 12 * 60 * 60 * 1000;

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

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function ensureAdmin(database, username, password) {
  const existing = database.prepare('SELECT username, password_hash FROM admin WHERE id = 1').get();
  if (!existing) {
    database.prepare('INSERT INTO admin(id, username, password_hash, created_at) VALUES (1, ?, ?, ?)')
      .run(username, encodePassword(password), new Date().toISOString());
    return;
  }
  if (existing.username !== username || !verifyPassword(password, existing.password_hash)) {
    throw new Error('Configured admin credentials do not match the provisioned administrator.');
  }
}

export function authenticate(database, username, password) {
  const admin = database.prepare('SELECT username, password_hash FROM admin WHERE id = 1').get();
  if (!admin) return false;
  const passwordOk = verifyPassword(password, admin.password_hash);
  return admin.username === username && passwordOk;
}

export function createSession(database) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const now = Date.now();
  database.prepare('DELETE FROM session WHERE expires_at <= ?').run(new Date(now).toISOString());
  database.prepare('INSERT INTO session(token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), csrfToken, new Date(now + SESSION_MS).toISOString(), new Date(now).toISOString());
  return { token, csrfToken, maxAge: SESSION_MS / 1000 };
}

export function readSession(database, token) {
  if (!token || token.length > 128) return null;
  const row = database.prepare('SELECT token_hash, csrf_token, expires_at FROM session WHERE token_hash = ?')
    .get(hashToken(token));
  return row && row.expires_at > new Date().toISOString() ? row : null;
}

export function deleteSession(database, token) {
  if (token) database.prepare('DELETE FROM session WHERE token_hash = ?').run(hashToken(token));
}

export function cookieFor(token, maxAge, secure) {
  return `seller_session=${token}; HttpOnly; SameSite=Strict; Path=/api/v1/seller; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function sessionCookieFrom(header = '') {
  const match = header.match(/(?:^|;\s*)seller_session=([^;]+)/);
  return match?.[1] || null;
}

export class LoginLimiter {
  #attempts = new Map();
  allowed(key) {
    const now = Date.now();
    const attempts = (this.#attempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
    this.#attempts.set(key, attempts);
    return attempts.length < 5;
  }
  recordFailure(key) {
    this.#attempts.get(key)?.push(Date.now());
  }
  clear(key) {
    this.#attempts.delete(key);
  }
}
