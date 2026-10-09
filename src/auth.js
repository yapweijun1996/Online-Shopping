import { createHash, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
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

async function verifyPasswordAsync(password, stored) {
  const [salt, expected] = stored.split(':');
  const candidate = await scryptAsync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(expected, 'hex'));
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export { encodePassword, verifyPasswordAsync };

/* The configured username and password only create the first Owner, on a database that has no accounts. After that the
   accounts in the database are the truth: changing the password in the app or with the reset script sticks across restarts,
   and a different ADMIN_PASSWORD in the environment is ignored. */
export async function ensureAdmin(database, username, password) {
  return database.transaction(async () => {
    if (await database.get('SELECT 1 AS found FROM seller_account LIMIT 1')) return;
    const now = new Date().toISOString();
    await database.run(`INSERT INTO seller_account(id, username, username_key, password_hash, role, active, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'OWNER', 1, 0, ?, ?)`, randomUUID(), username, username.toLowerCase(), encodePassword(password), now, now);
  });
}

const DUMMY_HASH = encodePassword('not-a-real-password-for-timing');

/* Returns the active account for a correct username and password, otherwise null. An unknown or deactivated account
   still costs one password hash, so the response time does not reveal which usernames exist. */
export async function authenticate(database, username, password) {
  const account = await database.get('SELECT id, username, role, password_hash, active, must_change_password FROM seller_account WHERE username_key = ?', username.toLowerCase());
  const passwordOk = await verifyPasswordAsync(password, account?.password_hash ?? DUMMY_HASH);
  if (!account || !passwordOk || account.active !== 1) return null;
  await database.run('UPDATE seller_account SET last_login_at = ? WHERE id = ?', new Date().toISOString(), account.id);
  return { id: account.id, username: account.username, role: account.role, mustChangePassword: account.must_change_password === 1 };
}

/* The first active Owner: the account a passwordless sample site signs visitors in as. */
export async function sampleAccount(database) {
  const row = await database.get("SELECT id, username, role, must_change_password FROM seller_account WHERE role = 'OWNER' AND active = 1 ORDER BY created_at, id LIMIT 1");
  return row ? { id: row.id, username: row.username, role: row.role, mustChangePassword: false } : null;
}

export async function createSession(database, accountId) {
  return database.transaction(async () => {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const now = Date.now();
  await database.run('DELETE FROM session WHERE expires_at <= ?', new Date(now).toISOString());
  await database.run('INSERT INTO session(token_hash, csrf_token, expires_at, created_at, account_id) VALUES (?, ?, ?, ?, ?)',
    hashToken(token), csrfToken, new Date(now + SESSION_MS).toISOString(), new Date(now).toISOString(), accountId);
  return { token, csrfToken, maxAge: SESSION_MS / 1000 };
  });
}

/* The session and its account. A deactivated or missing account ends the session on its next request. */
export async function readSession(database, token) {
  if (!token || token.length > 128) return null;
  const row = await database.get(`SELECT s.token_hash, s.csrf_token, s.expires_at, a.id AS account_id, a.username, a.role, a.active, a.must_change_password
    FROM session s JOIN seller_account a ON a.id = s.account_id WHERE s.token_hash = ?`, hashToken(token));
  if (!row || row.expires_at <= new Date().toISOString() || row.active !== 1) return null;
  return { ...row, account: { id: row.account_id, username: row.username, role: row.role, mustChangePassword: row.must_change_password === 1 } };
}

/* Ends every session of an account, except the one named (the person who just changed their own password). */
export async function revokeSessions(database, accountId, exceptToken = null) {
  if (exceptToken) await database.run('DELETE FROM session WHERE account_id = ? AND token_hash <> ?', accountId, hashToken(exceptToken));
  else await database.run('DELETE FROM session WHERE account_id = ?', accountId);
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
