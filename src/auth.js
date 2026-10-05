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

export async function ensureAdmin(database, username, password) {
  return database.transaction(async () => {
    const existing = await database.get('SELECT username, password_hash FROM admin WHERE id = 1');
    if (!existing) {
      await database.run('INSERT INTO admin(id, username, password_hash, created_at) VALUES (1, ?, ?, ?)',
        username, encodePassword(password), new Date().toISOString());
      return;
    }
    if (existing.username !== username || !verifyPassword(password, existing.password_hash)) {
      throw new Error('Configured admin credentials do not match the provisioned administrator.');
    }
  });
}

export async function authenticate(database, username, password) {
  const admin = await database.get('SELECT username, password_hash FROM admin WHERE id = 1');
  if (!admin) return false;
  const passwordOk = await verifyPasswordAsync(password, admin.password_hash);
  return admin.username === username && passwordOk;
}

export async function createSession(database) {
  return database.transaction(async () => {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const now = Date.now();
  await database.run('DELETE FROM session WHERE expires_at <= ?', new Date(now).toISOString());
  await database.run('INSERT INTO session(token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?)',
    hashToken(token), csrfToken, new Date(now + SESSION_MS).toISOString(), new Date(now).toISOString());
  return { token, csrfToken, maxAge: SESSION_MS / 1000 };
  });
}

export async function readSession(database, token) {
  if (!token || token.length > 128) return null;
  const row = await database.get('SELECT token_hash, csrf_token, expires_at FROM session WHERE token_hash = ?', hashToken(token));
  return row && row.expires_at > new Date().toISOString() ? row : null;
}

export async function deleteSession(database, token) {
  return database.transaction(async () => {
  if (token) await database.run('DELETE FROM session WHERE token_hash = ?', hashToken(token));
  });
}

export function cookieFor(token, maxAge, secure) {
  return `seller_session=${token}; HttpOnly; SameSite=Strict; Path=/api/v1/seller; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function sessionCookieFrom(header = '') {
  const match = header.match(/(?:^|;\s*)seller_session=([^;]+)/);
  return match?.[1] || null;
}
