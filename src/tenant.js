import { ApiError } from './http.js';

/*
 * Every shop-owned query runs through a shop-scoped store handle. A handle is the plain
 * store plus a read-only `shopId`; repository functions read it with shopIdOf() and put it
 * in every WHERE clause and INSERT. Nothing else selects the shop, so a request that never
 * resolved a shop cannot reach shop data.
 */
export function scopeStore(store, shopId) {
  if (typeof shopId !== 'string' || !shopId) throw new TypeError('A shop id is required.');
  return Object.create(store, { shopId: { value: shopId, enumerable: true } });
}

/*
 * Transitional rule for code that still passes the plain store (older tests, scripts):
 * with exactly one shop the plain store means that shop; with several it fails closed.
 */
export function shopIdOf(database) {
  if (database.shopId) return database.shopId;
  const shops = database.all('SELECT id FROM shop ORDER BY created_at, id LIMIT 2');
  if (shops.length === 1) return shops[0].id;
  throw new ApiError(500, 'SHOP_CONTEXT_REQUIRED', 'A shop context is required.');
}
