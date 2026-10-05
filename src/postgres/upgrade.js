import { SCHEMA_VERSION } from '../db.js';

// Called only by an explicit operator/test opt-in, inside the store-owned transaction.
export async function upgradePostgres(store, version) {
  if (![10, 11, 12, 13].includes(version)) throw new Error(`Unsupported PostgreSQL schema version ${version}.`);
  const columns = await store.all("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='product'");
  const has = name => columns.some(row => row.column_name === name);
  if (version === 13 && !has('stock_quantity') && !has('gallery_layout_json')) throw new Error('Unrecognized PostgreSQL product schema.');
  if (!has('stock_quantity')) await store.exec('ALTER TABLE product ADD COLUMN stock_quantity BIGINT CHECK (stock_quantity IS NULL OR stock_quantity BETWEEN 0 AND 1000000)');
  if (!has('gallery_layout_json')) await store.exec("ALTER TABLE product ADD COLUMN gallery_layout_json TEXT CHECK (gallery_layout_json IS NULL OR jsonb_typeof(gallery_layout_json::jsonb) = 'array')");
  if (!has('translations_json')) await store.exec("ALTER TABLE product ADD COLUMN translations_json TEXT NOT NULL DEFAULT '{}' CHECK (translations_json::jsonb IS NOT NULL)");
  for (const [table, column, values] of [
    ['product_gallery_image','position','position BETWEEN 1 AND 10'],
    ['shop_order','status',"status IN ('SUBMITTED','CONFIRMED','REJECTED','SHIPPED','DELIVERED','CANCELLED')"],
    ['order_event','event_type',"event_type IN ('SUBMITTED','CONFIRMED','REJECTED','SHIPPED','DELIVERED','CANCELLED')"],
  ]) {
    // Only replace the known single-column constraints; retain unrelated checks.
    const constraints = await store.all(`SELECT c.conname, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname='public' AND r.relname=? AND c.contype='c'`, table);
    const matches = constraints.filter(row => new RegExp(`\\b${column}\\b`).test(row.definition));
    if (matches.length !== 1) throw new Error(`Unrecognized ${table}.${column} constraints.`);
    const constraint = matches[0].conname.replaceAll('"','""');
    await store.exec(`ALTER TABLE ${table} DROP CONSTRAINT "${constraint}"; ALTER TABLE ${table} ADD CHECK (${values})`);
  }
  await store.exec('ALTER TABLE shop_order ADD COLUMN IF NOT EXISTS tracking_carrier TEXT; ALTER TABLE shop_order ADD COLUMN IF NOT EXISTS tracking_no TEXT');
  await store.setSchemaVersion(SCHEMA_VERSION);
}
