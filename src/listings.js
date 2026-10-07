import { randomUUID } from 'node:crypto';

/*
 * A listing is what a shopper sees as one product: shared title, description and category. Its variants are
 * `product` rows (own SKU, price, stock, photo, options) that point at it with `listing_id`. The variant id is the
 * old product id, so carts, orders, stock holds and shared links keep working.
 *
 * The shared fields are authoritative on the listing. The same columns stay on every product row because queries and
 * order snapshots read them; they are rewritten here, inside the caller's transaction, whenever the listing changes.
 */
const SHARED = ['name', 'description', 'category'];

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

/* The listing a product row joins: the one of its variant group (created on first use), or a new private one. */
export async function listingFor(database, fields, now) {
  const group = fields.variantGroup || null;
  const existing = group && await database.get('SELECT id, name, description, category FROM listing WHERE code = ?', group);
  if (existing) return existing;
  const listing = { id: randomUUID(), name: fields.name, description: fields.description, category: fields.category };
  await database.run(`INSERT INTO listing (id, code, name, description, category, translations_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`, listing.id, group, listing.name, listing.description, listing.category, now, now);
  return listing;
}

/* Applies edited shared fields to the listing and to every variant row, so they cannot drift apart. */
export async function syncListing(database, listingId, patch, now) {
  const changed = SHARED.filter((key) => Object.hasOwn(patch, key));
  if (!changed.length) return;
  const columns = changed.map((key) => `${key} = ?`).join(', ');
  const values = changed.map((key) => patch[key]);
  await database.run(`UPDATE listing SET ${columns}, updated_at = ? WHERE id = ?`, ...values, now, listingId);
  await database.run(`UPDATE product SET ${columns} WHERE listing_id = ?`, ...values, listingId);
}

/* Moves a product row to the listing of `group` (or a private one when empty) and removes a listing left without variants. */
export async function moveToListing(database, productId, previousListingId, fields, now) {
  const listing = await listingFor(database, fields, now);
  await database.run('UPDATE product SET listing_id = ?, name = ?, description = ?, category = ? WHERE id = ?',
    listing.id, listing.name, listing.description, listing.category, productId);
  if (previousListingId && previousListingId !== listing.id &&
      !await database.get('SELECT 1 FROM product WHERE listing_id = ?', previousListingId)) {
    await database.run('DELETE FROM listing WHERE id = ?', previousListingId);
  }
  return listing;
}
