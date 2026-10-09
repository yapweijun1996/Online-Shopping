// Who changed which product, when, and what from and to (SEL review item 11). Entries are appended in the same
// transaction as the edit and never changed or deleted by the application (the Demo reset aside). Stock that moves
// because an order is confirmed or cancelled is not listed here; the order's own events show it.
import { randomUUID } from 'node:crypto';
import { FieldError } from './validation.js';
import { getProduct } from './products.js';

const TRACKED = ['sku', 'name', 'description', 'category', 'priceMinor', 'currency', 'active', 'stockQuantity', 'variantLabel'];
const SHORT = 120;
const clip = (value) => typeof value === 'string' && value.length > SHORT ? `${value.slice(0, SHORT)}…` : value ?? null;

function diff(before, after) {
  const changes = [];
  for (const field of TRACKED) {
    const key = field === 'category' ? 'categoryCode' : field;
    const from = before?.[key] ?? null, to = after?.[key] ?? null;
    if (from !== to) changes.push({ field, from: clip(from), to: clip(to) });
  }
  const photos = (product) => (product?.images ?? []).length;
  if (before && photos(before) !== photos(after)) changes.push({ field: 'photos', from: photos(before), to: photos(after) });
  return changes;
}

async function append(database, productId, actor, action, changes) {
  if (!changes.length && action === 'UPDATED') return;
  let text = JSON.stringify(changes);
  // The column holds 4000 characters: drop the old and new texts of the longest entries before dropping entries.
  if (text.length > 3900) text = JSON.stringify(changes.map((change) => ({ field: change.field, from: null, to: null })));
  await database.run('INSERT INTO product_event(id, product_id, actor, action, changes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    randomUUID(), productId, actor, action, text, new Date().toISOString());
}

/* Runs a product edit and records what it changed, atomically. `work` returns the updated product, or null when the
   product does not exist. */
export async function trackUpdate(database, id, actor, work) {
  return database.transaction(async () => {
    const before = await getProduct(database, id, true);
    const result = await work();
    if (!result) return result;
    await append(database, id, actor, 'UPDATED', diff(before, await getProduct(database, id, true)));
    return result;
  });
}

export async function trackCreate(database, actor, work) {
  return database.transaction(async () => {
    const created = await work();
    await append(database, created.id, actor, 'CREATED', diff(null, created).filter((change) => ['sku', 'name', 'priceMinor', 'currency', 'active', 'stockQuantity'].includes(change.field)));
    return created;
  });
}

export async function listProductHistory(database, productId, params) {
  const limit = Number(params.get('limit') ?? 50), offset = Number(params.get('offset') ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new FieldError('limit', 'Enter a valid list range.');
  const rows = await database.all('SELECT id, actor, action, changes, created_at FROM product_event WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', productId, limit + 1, offset);
  return { items: rows.slice(0, limit).map((row) => ({ id: row.id, actor: row.actor, action: row.action, changes: JSON.parse(row.changes), at: row.created_at })),
    nextOffset: rows.length > limit ? offset + limit : null };
}

/* Activate or deactivate many products at once. All or nothing: one product that cannot change (for example a legacy
   currency conflict) stops the whole request and nothing is saved. */
export async function bulkSetActive(database, ids, active, actor, update) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || !ids.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id))) {
    throw new FieldError('ids', 'Choose 1 to 100 different products.');
  }
  return database.transaction(async () => {
    let changed = 0;
    for (const id of ids) {
      const current = await getProduct(database, id, true);
      if (!current) throw new FieldError('ids', 'A chosen product no longer exists.');
      if (current.active === active) continue;
      await trackUpdate(database, id, actor, () => update(id, { active }));
      changed += 1;
    }
    return { requested: ids.length, changed };
  });
}
