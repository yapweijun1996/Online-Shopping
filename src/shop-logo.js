import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './http.js';

export const LOGO_MAX_BYTES = 256 * 1024;
export function shopLogoSchema(dialect) {
  const blob = dialect === 'postgres' ? 'BYTEA' : 'BLOB';
  const integer = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  const strict = dialect === 'postgres' ? '' : ' STRICT';
  return `CREATE TABLE IF NOT EXISTS shop_logo (id ${integer} PRIMARY KEY CHECK (id = 1), content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')), data ${blob} NOT NULL CHECK (length(data) BETWEEN 1 AND 262144), size ${integer} NOT NULL CHECK (size = length(data)), sha256 TEXT NOT NULL CHECK (length(sha256) = 64), updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)${strict};
CREATE TABLE IF NOT EXISTS shop_logo_event (id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK (action IN ('UPLOAD','DELETE')), actor TEXT NOT NULL, created_at TEXT NOT NULL)${strict};`;
}
export function logoType(data) {
  const starts = (...bytes) => bytes.every((b, i) => data[i] === b);
  if (data.length >= 8 && starts(137,80,78,71,13,10,26,10)) return 'image/png';
  if (data.length >= 3 && starts(255,216,255)) return 'image/jpeg';
  if (data.length >= 12 && starts(82,73,70,70) && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) return 'image/webp';
  throw new ApiError(415, 'INVALID_LOGO', 'Choose a PNG, JPEG or WebP image.');
}
export async function getShopLogo(store) {
  return store.get('SELECT content_type, data, sha256 FROM shop_logo WHERE id = 1');
}
export async function putShopLogo(store, data, actor) {
  if (data.length > LOGO_MAX_BYTES) throw new ApiError(413, 'INVALID_INPUT', 'Image is too large.');
  const type = logoType(data), hash = createHash('sha256').update(data).digest('hex'), now = new Date().toISOString();
  await store.transaction(async () => {
    await store.run(`INSERT INTO shop_logo(id, content_type, data, size, sha256, updated_at, updated_by) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, size = excluded.size, sha256 = excluded.sha256, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, type, data, data.length, hash, now, actor);
    await store.run('INSERT INTO shop_logo_event(id, action, actor, created_at) VALUES (?, ?, ?, ?)', randomUUID(), 'UPLOAD', actor, now);
  });
}
export async function deleteShopLogo(store, actor) {
  await store.transaction(async () => {
    await store.run('DELETE FROM shop_logo WHERE id = 1');
    await store.run('INSERT INTO shop_logo_event(id, action, actor, created_at) VALUES (?, ?, ?, ?)', randomUUID(), 'DELETE', actor, new Date().toISOString());
  });
}
