import { randomUUID } from 'node:crypto';
import { ApiError } from './http.js';

/*
 * A listing is what a shopper sees as one product: shared title, description and category. Its variants are
 * `product` rows (own SKU, price, stock, photo, options) that point at it with `listing_id`. The variant id is the
 * old product id, so carts, orders, stock holds and shared links keep working.
 *
 * The shared fields are authoritative on the listing. The same columns stay on every product row because queries and
 * order snapshots read them; they are rewritten here, inside the caller's transaction, whenever the listing changes.
 */
const SHARED = ['name', 'description', 'category'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const plannedConflict = () => { throw new ApiError(409, 'LISTING_PLAN_CONFLICT', 'The planned listing creation changed.'); };

// Trusted service metadata only, never an input field or authorization proof.
export function plannedListingIdentity(value) {
  const keys = ['productId', 'previousListingId', 'targetCode', 'newListingId'];
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
      })) plannedConflict();
  const identity = Object.fromEntries(keys.map(key => [key, value[key]]));
  if (![identity.productId, identity.previousListingId, identity.newListingId].every(id => typeof id === 'string' && uuid.test(id)) ||
      identity.newListingId === identity.previousListingId ||
      !(identity.targetCode === null || typeof identity.targetCode === 'string' && /^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(identity.targetCode))) plannedConflict();
  return Object.freeze(identity);
}

/* Backfills listings for products that have none: one per variant group, one per ungrouped product. */
export async function migrateListings(store) {
  const rows = await store.all(`SELECT id, sku, name, description, category, translations_json, variant_group, created_at, updated_at
    FROM product WHERE listing_id IS NULL ORDER BY created_at, id`);
  const byGroup = new Map();
  for (const row of rows) {
    const key = row.variant_group ? `g:${row.variant_group}` : `p:${row.id}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(row);
  }
  for (const members of byGroup.values()) {
    const group = members[0].variant_group;
    const existing = group && await store.get('SELECT id FROM listing WHERE code = ?', group);
    // The listing takes its text from the product named after the group, else from the oldest member.
    const primary = members.find((row) => row.sku === group) || members[0];
    const id = existing?.id || randomUUID();
    if (!existing) {
      await store.run(`INSERT INTO listing (id, code, name, description, category, translations_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, group || null, primary.name, primary.description, primary.category,
      primary.translations_json, primary.created_at, primary.updated_at);
    }
    for (const row of members) await store.run('UPDATE product SET listing_id = ? WHERE id = ?', id, row.id);
  }
  return byGroup.size;
}

// Shared-field projection preserves omitted fields, including legacy member drift.
// These internal plans are data, not identity/permission or cross-transaction tokens.
export function projectListingFields(current, patch) {
  return { ...current, ...Object.fromEntries(SHARED.filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]])) };
}

/* SELECT-only target lookup. A new listing has no ID until actual application. */
export async function planListingFor(database, fields) {
  const code = fields.variantGroup || null;
  const existing = code && await database.get('SELECT id, name, description, category FROM listing WHERE code = ?', code);
  return { create: !existing, code, listing: existing || { id: null, ...projectListingFields({}, fields) } };
}

async function applyListingForPlan(database, plan, now, newListingId = null) {
  if (!plan.create) return plan.listing;
  const listing = { ...plan.listing, id: newListingId ?? randomUUID() };
  try {
    await database.run(`INSERT INTO listing (id, code, name, description, category, translations_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`, listing.id, plan.code, listing.name, listing.description, listing.category, now, now);
  } catch (error) {
    if (newListingId !== null && (error?.code === '23505' || /UNIQUE constraint failed: listing\.(?:id|code)/.test(error?.message || ''))) plannedConflict();
    throw error;
  }
  return listing;
}

/* The listing a product row joins: the one of its variant group (created on first use), or a new private one. */
export async function listingFor(database, fields, now) {
  return applyListingForPlan(database, await planListingFor(database, fields), now);
}

/* SELECT-only membership/shared-field projection; no gallery, option or stock plan. */
export async function planMoveToListing(database, productId, previousListingId, fields) {
  const target = await planListingFor(database, fields);
  const deletePrevious = Boolean(previousListingId && previousListingId !== target.listing.id &&
    !await database.get('SELECT 1 FROM product WHERE listing_id = ? AND id <> ? LIMIT 1', previousListingId, productId));
  return { target, previousListingId, deletePrevious,
    productAfter: projectListingFields({ id: productId, listingId: target.listing.id }, target.listing) };
}

/* Applies edited shared fields to the listing and to every variant row, so they cannot drift apart. */
export async function syncListing(database, listingId, patch, now) {
  const projected = projectListingFields({}, patch), changed = Object.keys(projected);
  if (!changed.length) return;
  const columns = changed.map((key) => `${key} = ?`).join(', ');
  const values = changed.map((key) => projected[key]);
  await database.run(`UPDATE listing SET ${columns}, updated_at = ? WHERE id = ?`, ...values, now, listingId);
  await database.run(`UPDATE product SET ${columns} WHERE listing_id = ?`, ...values, listingId);
}

/* Moves a product row to the listing of `group` (or a private one when empty) and removes a listing left without variants. */
export async function moveToListing(database, productId, previousListingId, fields, now, identity = null) {
  const plan = await planMoveToListing(database, productId, previousListingId, fields);
  if (identity !== null) {
    identity = plannedListingIdentity(identity);
    const current = await database.get('SELECT listing_id FROM product WHERE id = ?', productId);
    if (identity.productId !== productId || identity.previousListingId !== previousListingId || current?.listing_id !== previousListingId ||
        identity.targetCode !== plan.target.code || !plan.target.create || plan.target.listing.id !== null ||
        await database.get('SELECT id FROM listing WHERE id = ?', identity.newListingId)) plannedConflict();
  }
  const listing = await applyListingForPlan(database, plan.target, now, identity?.newListingId ?? null);
  const product = { ...plan.productAfter, listingId: listing.id };
  await database.run('UPDATE product SET listing_id = ?, name = ?, description = ?, category = ? WHERE id = ?',
    product.listingId, product.name, product.description, product.category, productId);
  // Recheck actual membership after the UPDATE. The earlier projection is not
  // deletion authority and cannot replace this same-transaction predicate.
  if (previousListingId && previousListingId !== listing.id &&
      !await database.get('SELECT 1 FROM product WHERE listing_id = ?', previousListingId)) {
    await database.run('DELETE FROM listing WHERE id = ?', previousListingId);
  }
  return listing;
}
