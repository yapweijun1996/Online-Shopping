// Seller accounts (SEL-04): the Owner adds Managers and Staff, resets their passwords and deactivates them; everyone
// can change their own password. Accounts are never deleted, because order history names the person who acted.
// Every change is recorded in account_event (never a password) and takes effect on the account's next request.
import { randomUUID } from 'node:crypto';
import { ApiError } from './http.js';
import { FieldError } from './validation.js';
import { encodePassword, revokeSessions, verifyPasswordAsync } from './auth.js';

const ASSIGNABLE = ['MANAGER', 'STAFF'];
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const now = () => new Date().toISOString();

export function checkPassword(value, field, username = '') {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) throw new FieldError(field, 'Use 12 to 256 characters.');
  if (username && value.toLowerCase().includes(username.toLowerCase())) throw new FieldError(field, 'The password must not contain the username.');
  if (/^(.)\1+$/.test(value)) throw new FieldError(field, 'Choose a less repetitive password.');
  return value;
}

const view = (row) => ({ id: row.id, username: row.username, role: row.role, active: row.active === 1, mustChangePassword: row.must_change_password === 1,
  createdAt: row.created_at, lastLoginAt: row.last_login_at, passwordChangedAt: row.password_changed_at });

async function record(database, accountId, actor, action, detail = null) {
  await database.run('INSERT INTO account_event(id, account_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), accountId, actor, action, detail, now());
}

export async function listAccounts(database) {
  const rows = await database.all('SELECT * FROM seller_account ORDER BY created_at, id');
  const events = await database.all(`SELECT e.id, e.actor, e.action, e.detail, e.created_at, a.username FROM account_event e
    JOIN seller_account a ON a.id = e.account_id ORDER BY e.created_at DESC, e.id DESC LIMIT 20`);
  return { items: rows.map(view), events: events.map((event) => ({ id: event.id, actor: event.actor, action: event.action, detail: event.detail, account: event.username, at: event.created_at })) };
}

export async function createAccount(database, input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['username', 'role', 'password'].includes(key))) {
    throw new FieldError('account', 'Unexpected account field.');
  }
  if (typeof input.username !== 'string' || !USERNAME.test(input.username)) throw new FieldError('username', 'Use 3 to 64 letters, digits, dots, dashes or underscores.');
  if (!ASSIGNABLE.includes(input.role)) throw new FieldError('role', 'Choose Manager or Staff.');
  checkPassword(input.password, 'password', input.username);
  const id = randomUUID(), stamp = now();
  return database.transaction(async () => {
    if (await database.get('SELECT 1 AS found FROM seller_account WHERE username_key = ?', input.username.toLowerCase())) {
      throw new ApiError(409, 'USERNAME_TAKEN', 'This username is already used.');
    }
    // A password chosen by the Owner is temporary: the new person must replace it at first sign-in.
    await database.run(`INSERT INTO seller_account(id, username, username_key, password_hash, role, active, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`, id, input.username, input.username.toLowerCase(), encodePassword(input.password), input.role, stamp, stamp);
    await record(database, id, actor, 'CREATED', input.role);
    return view(await database.get('SELECT * FROM seller_account WHERE id = ?', id));
  });
}

/* Owner-only changes to another account: role, active flag, or a new temporary password. The Owner account itself
   cannot be demoted or deactivated here, so the shop can never be left without one. */
export async function updateAccount(database, id, input, actor, actorId) {
  const allowed = ['role', 'active', 'resetPassword'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new FieldError('account', 'Send role, active or resetPassword.');
  }
  return database.transaction(async () => {
    const account = await database.get('SELECT * FROM seller_account WHERE id = ?', id);
    if (!account) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    if (account.role === 'OWNER' || account.id === actorId) throw new ApiError(403, 'FORBIDDEN', 'This account cannot be changed here. Use Change password, or the reset script on the server.');
    const stamp = now();
    if (Object.hasOwn(input, 'role')) {
      if (!ASSIGNABLE.includes(input.role)) throw new FieldError('role', 'Choose Manager or Staff.');
      if (input.role !== account.role) {
        await database.run('UPDATE seller_account SET role = ?, updated_at = ? WHERE id = ?', input.role, stamp, id);
        await record(database, id, actor, 'ROLE_CHANGED', `${account.role} to ${input.role}`);
      }
    }
    if (Object.hasOwn(input, 'active')) {
      if (typeof input.active !== 'boolean') throw new FieldError('active', 'Send true or false.');
      if (input.active !== (account.active === 1)) {
        await database.run('UPDATE seller_account SET active = ?, updated_at = ? WHERE id = ?', input.active ? 1 : 0, stamp, id);
        if (!input.active) await revokeSessions(database, id);
        await record(database, id, actor, input.active ? 'ACTIVATED' : 'DEACTIVATED');
      }
    }
    if (Object.hasOwn(input, 'resetPassword')) {
      checkPassword(input.resetPassword, 'resetPassword', account.username);
      await database.run('UPDATE seller_account SET password_hash = ?, must_change_password = 1, password_changed_at = ?, updated_at = ? WHERE id = ?',
        encodePassword(input.resetPassword), stamp, stamp, id);
      await revokeSessions(database, id);
      await record(database, id, actor, 'PASSWORD_RESET');
    }
    return view(await database.get('SELECT * FROM seller_account WHERE id = ?', id));
  });
}

/* Own password change. The current password is checked again, every other session of the account ends, and the
   temporary-password flag clears. */
export async function changeOwnPassword(database, accountId, input, currentToken) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['currentPassword', 'newPassword'].includes(key))) {
    throw new FieldError('password', 'Send currentPassword and newPassword.');
  }
  if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 256) throw new FieldError('currentPassword', 'Enter your current password.');
  const account = await database.get('SELECT username, password_hash FROM seller_account WHERE id = ?', accountId);
  if (!account || !await verifyPasswordAsync(input.currentPassword, account.password_hash)) throw new ApiError(403, 'WRONG_PASSWORD', 'The current password is not correct.');
  checkPassword(input.newPassword, 'newPassword', account.username);
  if (input.newPassword === input.currentPassword) throw new FieldError('newPassword', 'Choose a different password.');
  const hash = encodePassword(input.newPassword), stamp = now();
  await database.transaction(async () => {
    await database.run('UPDATE seller_account SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ?', hash, stamp, stamp, accountId);
    await revokeSessions(database, accountId, currentToken);
    await record(database, accountId, account.username, 'PASSWORD_CHANGED');
  });
  return { changed: true };
}

/* Server-side recovery for the Owner (and anyone else): sets a temporary password that must be replaced at next sign-in. */
export async function resetPasswordFromHost(database, username, password, { forceChange = true } = {}) {
  checkPassword(password, 'password', username);
  return database.transaction(async () => {
    const account = await database.get('SELECT id, username FROM seller_account WHERE username_key = ?', username.toLowerCase());
    if (!account) throw new ApiError(404, 'NOT_FOUND', 'No account has this username.');
    const stamp = now();
    await database.run('UPDATE seller_account SET password_hash = ?, must_change_password = ?, active = 1, password_changed_at = ?, updated_at = ? WHERE id = ?',
      encodePassword(password), forceChange ? 1 : 0, stamp, stamp, account.id);
    await revokeSessions(database, account.id);
    await record(database, account.id, 'host-script', 'PASSWORD_RESET', 'reset on the server');
    return account.username;
  });
}
