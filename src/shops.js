import { randomUUID } from 'node:crypto';
import { ApiError } from './http.js';
import { FieldError, boundedText } from './validation.js';

// Letters and digits only, stored lower case. Words that would collide with application paths are reserved.
const CODE_PATTERN = /^[a-z0-9]{3,30}$/;
const RESERVED = new Set(['admin', 'api', 'app', 'assets', 'demo', 'health', 'ready', 's', 'seller', 'shop', 'static',
  'www', 'platform', 'superadmin', 'login', 'public', 'system']);

export function validateShopCode(value) {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!CODE_PATTERN.test(code)) throw new FieldError('code', 'Use 3 to 30 letters or digits.');
  if (RESERVED.has(code)) throw new FieldError('code', 'This shop code is reserved.');
  return code;
}

function shopRow(row) {
  return row && { id: row.id, code: row.code, name: row.name, status: row.status, mode: row.mode,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

function codeTaken(database, code, exceptShopId = null) {
  const owner = database.get('SELECT id FROM shop WHERE code = ?', code)
    || database.get('SELECT shop_id AS id FROM shop_code_alias WHERE code = ?', code);
  return Boolean(owner) && owner.id !== exceptShopId;
}

export function createShop(database, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['code', 'name'].includes(key))) {
    throw new FieldError('shop', 'Enter a shop code and name.');
  }
  const code = validateShopCode(input.code);
  const name = boundedText(input.name, 'name', 80);
  return database.transaction(() => {
    if (codeTaken(database, code)) throw new ApiError(409, 'SHOP_CODE_TAKEN', 'This shop code is already in use.');
    const id = randomUUID();
    const now = new Date().toISOString();
    database.run("INSERT INTO shop(id, code, name, status, mode, created_at, updated_at) VALUES (?, ?, ?, 'ACTIVE', NULL, ?, ?)",
      id, code, name, now, now);
    database.run("INSERT INTO company_setting(shop_id, default_currency, updated_at) VALUES (?, 'MYR', ?)", id, now);
    database.run('INSERT INTO order_sequence(shop_id, value) VALUES (?, 0)', id);
    return getShop(database, id);
  });
}

export function getShop(database, id) {
  return shopRow(database.get('SELECT id, code, name, status, mode, created_at, updated_at FROM shop WHERE id = ?', id));
}

export function listShops(database) {
  return database.all('SELECT id, code, name, status, mode, created_at, updated_at FROM shop ORDER BY code').map(shopRow);
}

/* Resolves a code from a URL: the shop itself, or the shop that used to own the code (callers redirect). */
export function resolveShopCode(database, rawCode) {
  const code = typeof rawCode === 'string' ? rawCode.trim().toLowerCase() : '';
  if (!CODE_PATTERN.test(code)) return null;
  const direct = database.get('SELECT id, code, name, status, mode, created_at, updated_at FROM shop WHERE code = ?', code);
  if (direct) return { shop: shopRow(direct), redirect: false };
  const aliased = database.get(`SELECT s.id, s.code, s.name, s.status, s.mode, s.created_at, s.updated_at
    FROM shop_code_alias a JOIN shop s ON s.id = a.shop_id WHERE a.code = ?`, code);
  return aliased ? { shop: shopRow(aliased), redirect: true } : null;
}

/* Only the SuperAdmin calls this. The old code keeps working as a redirect. */
export function renameShopCode(database, id, rawCode) {
  const code = validateShopCode(rawCode);
  return database.transaction(() => {
    const current = database.get('SELECT code FROM shop WHERE id = ?', id);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    if (current.code === code) return getShop(database, id);
    if (codeTaken(database, code, id)) throw new ApiError(409, 'SHOP_CODE_TAKEN', 'This shop code is already in use.');
    const now = new Date().toISOString();
    database.run('INSERT INTO shop_code_alias(code, shop_id, created_at) VALUES (?, ?, ?)', current.code, id, now);
    // A shop that returns to one of its own earlier codes no longer needs that alias.
    database.run('DELETE FROM shop_code_alias WHERE code = ? AND shop_id = ?', code, id);
    database.run('UPDATE shop SET code = ?, updated_at = ? WHERE id = ?', code, now, id);
    return getShop(database, id);
  });
}

export function setShopStatus(database, id, status) {
  if (!['ACTIVE', 'DISABLED'].includes(status)) throw new FieldError('status', 'Choose ACTIVE or DISABLED.');
  const changed = database.get('UPDATE shop SET status = ?, updated_at = ? WHERE id = ? RETURNING id',
    status, new Date().toISOString(), id);
  if (!changed) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  return getShop(database, id);
}

export function defaultShop(database) {
  return shopRow(database.get('SELECT id, code, name, status, mode, created_at, updated_at FROM shop ORDER BY created_at, id LIMIT 1'));
}
