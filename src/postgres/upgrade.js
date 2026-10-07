import { SCHEMA_VERSION } from '../db.js';
import { migrateLegacyVariants } from '../options.js';
import { migrateListings } from '../listings.js';
import { migrateSharedGalleries } from '../product-gallery.js';

// Called only by an explicit operator/test opt-in, inside the store-owned transaction.
export async function upgradePostgres(store, version) {
  if (![10, 11, 12, 13, 14, 15, 16, 17, 18].includes(version)) throw new Error(`Unsupported PostgreSQL schema version ${version}.`);
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
  for (const column of ['availability_text', 'shipping_text', 'returns_text']) {
    await store.exec(`ALTER TABLE company_setting ADD COLUMN IF NOT EXISTS ${column} TEXT CHECK (${column} IS NULL OR length(${column}) BETWEEN 1 AND 1000)`);
  }
  await store.exec(`
    CREATE TABLE IF NOT EXISTS option_type (
      id TEXT PRIMARY KEY, code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 60), name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
      translations_json TEXT NOT NULL DEFAULT '{}' CHECK (translations_json::jsonb IS NOT NULL),
      display TEXT NOT NULL DEFAULT 'button' CHECK (display IN ('button', 'swatch', 'image', 'dropdown')),
      position BIGINT NOT NULL DEFAULT 0, active BIGINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS option_type_code ON option_type(lower(code));
    CREATE TABLE IF NOT EXISTS option_value (
      id TEXT PRIMARY KEY, option_type_id TEXT NOT NULL REFERENCES option_type(id) ON DELETE RESTRICT,
      code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 60), label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
      translations_json TEXT NOT NULL DEFAULT '{}' CHECK (translations_json::jsonb IS NOT NULL),
      swatch_color TEXT CHECK (swatch_color IS NULL OR swatch_color ~ '^#[0-9a-fA-F]{6}$'),
      position BIGINT NOT NULL DEFAULT 0, active BIGINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS option_value_code ON option_value(option_type_id, lower(code));
    CREATE TABLE IF NOT EXISTS product_option (
      product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
      option_type_id TEXT NOT NULL REFERENCES option_type(id) ON DELETE RESTRICT,
      option_value_id TEXT NOT NULL REFERENCES option_value(id) ON DELETE RESTRICT,
      PRIMARY KEY (product_id, option_type_id));
    CREATE INDEX IF NOT EXISTS product_option_value ON product_option(option_value_id);
    -- The application role was granted the tables that existed when it was created; give it the new ones.
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'online_shopping_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON option_type, option_value, product_option TO online_shopping_app;
      END IF;
    END $$;`);
  await migrateLegacyVariants(store);
  await store.exec(`
    CREATE TABLE IF NOT EXISTS listing (
      id TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
      translations_json TEXT NOT NULL DEFAULT '{}' CHECK (translations_json::jsonb IS NOT NULL),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    ALTER TABLE product ADD COLUMN IF NOT EXISTS listing_id TEXT REFERENCES listing(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS product_listing ON product(listing_id);
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'online_shopping_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON listing TO online_shopping_app;
      END IF;
    END $$;`);
  await migrateListings(store);
  await store.exec('ALTER TABLE product ALTER COLUMN listing_id SET NOT NULL');
  await migrateSharedGalleries(store);
  await store.setSchemaVersion(SCHEMA_VERSION);
}
