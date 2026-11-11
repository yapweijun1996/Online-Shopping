import { createHash } from 'node:crypto';

export const INVENTORY_TABLES = Object.freeze(['inventory_coverage', 'inventory_state', 'inventory_movement']);
export const INVENTORY_SCHEMA_VERSION = 1;
const hash = text => createHash('sha256').update(text).digest('hex');
export function inventorySchema(dialect) {
  if (!['sqlite', 'postgres'].includes(dialect)) throw new TypeError('Unsupported inventory dialect.');
  const integer = dialect === 'sqlite' ? 'INTEGER' : 'BIGINT', strict = dialect === 'sqlite' ? ' STRICT' : '';
  const quantity = name => `(${name} IS NULL OR (${name} >= 0 AND ${name} <= 1000000))`;
  const uuid = name => `length(${name}) = 36 AND substr(${name},9,1) = '-' AND substr(${name},14,1) = '-' AND substr(${name},19,1) = '-' AND substr(${name},24,1) = '-' AND length(replace(${name},'-','')) = 32 AND ${dialect === 'sqlite' ? `replace(${name},'-','') NOT GLOB '*[^0-9a-f]*'` : `replace(${name},'-','') ~ '^[0-9a-f]{32}$'`}`;
  return `CREATE TABLE inventory_coverage (
  product_id TEXT PRIMARY KEY REFERENCES product(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK (origin IN ('MIGRATED','CREATED')),
  started_at TEXT NOT NULL CHECK (length(started_at) = 24),
  baseline_quantity ${integer} CHECK ${quantity('baseline_quantity')}
)${strict};
CREATE TABLE inventory_state (
  product_id TEXT PRIMARY KEY REFERENCES inventory_coverage(product_id) ON DELETE RESTRICT,
  revision ${integer} NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991)
)${strict};
CREATE TABLE inventory_movement (
  id TEXT PRIMARY KEY CHECK (${uuid('id')}),
  product_id TEXT NOT NULL REFERENCES inventory_coverage(product_id) ON DELETE RESTRICT,
  revision ${integer} NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  source_key TEXT NOT NULL UNIQUE CHECK (length(source_key) >= 1 AND length(source_key) <= 200),
  kind TEXT NOT NULL CHECK (kind IN ('INITIALIZED','SET','TRACKING_ENABLED','TRACKING_DISABLED','ORDER_CONFIRMED','ORDER_CANCELLED')),
  source TEXT NOT NULL CHECK (source IN ('PRODUCT','CSV','DEMO','OPERATOR','MCP_CATALOG','MCP_ADJUST','ORDER')),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('PRODUCT_CREATE','PRODUCT_SET','CSV_CREATE','CSV_SET','DEMO_CREATE','OPERATOR_CREATE','OPERATOR_SET','ORDER_CONFIRM','ORDER_CANCEL','COUNT_CORRECTION','RECEIPT','DAMAGE','OTHER')),
  before_quantity ${integer} CHECK ${quantity('before_quantity')},
  after_quantity ${integer} CHECK ${quantity('after_quantity')},
  delta_quantity ${integer} CHECK (delta_quantity IS NULL OR (delta_quantity >= -1000000 AND delta_quantity <= 1000000)),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('SELLER','SYSTEM','OPERATOR','INTERNAL')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) >= 1 AND length(actor_id) <= 128),
  client_id TEXT CHECK (client_id IS NULL OR (length(client_id) >= 1 AND length(client_id) <= 128)),
  grant_id TEXT CHECK (grant_id IS NULL OR (length(grant_id) >= 1 AND length(grant_id) <= 128)),
  operation_id TEXT CHECK (operation_id IS NULL OR (${uuid('operation_id')})),
  correlation_id TEXT CHECK (correlation_id IS NULL OR (${uuid('correlation_id')})),
  order_id TEXT REFERENCES shop_order(id) ON DELETE RESTRICT,
  order_revision ${integer} CHECK (order_revision IS NULL OR (order_revision >= 1 AND order_revision <= 9007199254740991)),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) = 24),
  UNIQUE (product_id, revision),
  CHECK ((kind = 'INITIALIZED' AND before_quantity IS NULL AND delta_quantity IS NULL AND revision = 1 AND reason_code IN ('PRODUCT_CREATE','CSV_CREATE','DEMO_CREATE','OPERATOR_CREATE')) OR
    (kind = 'SET' AND before_quantity IS NOT NULL AND after_quantity IS NOT NULL AND before_quantity <> after_quantity AND delta_quantity IS NOT NULL AND delta_quantity = after_quantity - before_quantity AND reason_code IN ('PRODUCT_SET','CSV_SET','OPERATOR_SET','COUNT_CORRECTION','RECEIPT','DAMAGE','OTHER')) OR
    (kind = 'TRACKING_ENABLED' AND before_quantity IS NULL AND after_quantity IS NOT NULL AND delta_quantity IS NULL AND reason_code IN ('PRODUCT_SET','CSV_SET','OPERATOR_SET','COUNT_CORRECTION','RECEIPT','DAMAGE','OTHER')) OR
    (kind = 'TRACKING_DISABLED' AND before_quantity IS NOT NULL AND after_quantity IS NULL AND delta_quantity IS NULL AND reason_code IN ('PRODUCT_SET','CSV_SET','OPERATOR_SET','COUNT_CORRECTION','RECEIPT','DAMAGE','OTHER')) OR
    (kind = 'ORDER_CONFIRMED' AND before_quantity IS NOT NULL AND after_quantity IS NOT NULL AND delta_quantity IS NOT NULL AND delta_quantity < 0 AND delta_quantity = after_quantity - before_quantity AND reason_code = 'ORDER_CONFIRM') OR
    (kind = 'ORDER_CANCELLED' AND before_quantity IS NOT NULL AND after_quantity IS NOT NULL AND delta_quantity IS NOT NULL AND delta_quantity > 0 AND delta_quantity = after_quantity - before_quantity AND reason_code = 'ORDER_CANCEL')),
  CHECK ((actor_kind = 'SELLER' AND (${uuid('actor_id')})) OR (actor_kind = 'INTERNAL' AND actor_id = 'business-service') OR (actor_kind = 'SYSTEM' AND actor_id = 'demo-seed') OR (actor_kind = 'OPERATOR' AND actor_id IN ('seed-demo-shop','replace-catalog'))),
  CHECK ((source IN ('PRODUCT','MCP_CATALOG') AND reason_code IN ('PRODUCT_CREATE','PRODUCT_SET')) OR (source = 'CSV' AND reason_code IN ('CSV_CREATE','CSV_SET')) OR (source = 'DEMO' AND reason_code = 'DEMO_CREATE') OR (source = 'OPERATOR' AND reason_code IN ('OPERATOR_CREATE','OPERATOR_SET')) OR (source = 'ORDER' AND reason_code IN ('ORDER_CONFIRM','ORDER_CANCEL')) OR (source = 'MCP_ADJUST' AND reason_code IN ('COUNT_CORRECTION','RECEIPT','DAMAGE','OTHER'))),
  CHECK ((kind IN ('ORDER_CONFIRMED','ORDER_CANCELLED') AND order_id IS NOT NULL AND order_revision IS NOT NULL) OR
    (kind NOT IN ('ORDER_CONFIRMED','ORDER_CANCELLED') AND order_id IS NULL AND order_revision IS NULL))
)${strict};
CREATE INDEX inventory_movement_product ON inventory_movement(product_id, occurred_at, id);
CREATE INDEX inventory_movement_order ON inventory_movement(order_id);
CREATE TABLE inventory_schema (
  id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL CHECK (version = 1),
  ddl_digest TEXT NOT NULL CHECK (length(ddl_digest) = 64), manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64)
)${strict};
`;
}

export function inventoryManifestSql() {
  return `SELECT encode(sha256(convert_to(jsonb_build_object(
    'columns', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY table_name,ordinal_position) FROM (SELECT table_name,column_name,ordinal_position,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'inventory!_%' ESCAPE '!') t),'[]'::jsonb),
    'constraints', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,conname) FROM (SELECT r.relname AS table_name,c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND r.relname LIKE 'inventory!_%' ESCAPE '!') c),'[]'::jsonb),
    'indexes', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY tablename,indexname) FROM (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'inventory!_%' ESCAPE '!') i),'[]'::jsonb)
  )::text,'UTF8')),'hex') AS digest`;
}
const objects = store => store.all("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'inventory_*' OR tbl_name GLOB 'inventory_*' ORDER BY type,name");
const manifest = async store => store.dialect === 'postgres' ? (await store.get(inventoryManifestSql())).digest : hash(JSON.stringify(await objects(store)));
export function inventorySeedSql() {
  return `INSERT INTO inventory_schema VALUES(1,1,'${hash(inventorySchema('postgres'))}',(${inventoryManifestSql()}));`;
}
// The frozen32 table manifest remains unchanged by the separate33 index.
export async function assertInventoryStorage(store) {
  if (![32,33,34,35,36].includes(await store.schemaVersion())) throw new Error('Inventory tables require schema32 through36.');
  const row = await store.get('SELECT version,ddl_digest,manifest_digest FROM inventory_schema WHERE id=1');
  if (row?.version !== INVENTORY_SCHEMA_VERSION || row.ddl_digest !== hash(inventorySchema(store.dialect)) || row.manifest_digest !== await manifest(store)) throw new Error('Incompatible inventory storage.');
}
export const INVENTORY_ORDER_INDEX_SQL = 'CREATE INDEX order_item_inventory ON order_item(product_id, id, delivery_id);';
// SELECT-only definition check is also used before bounded per-product reads.
export async function inventoryOrderIndexDefinitionReady(store) {
  try {
    if (store.dialect === 'sqlite') {
      const row = await store.get("SELECT sql FROM sqlite_schema WHERE type='index' AND name='order_item_inventory' AND tbl_name='order_item'");
      return row?.sql === INVENTORY_ORDER_INDEX_SQL.slice(0,-1);
    }
    const row = await store.get("SELECT pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid,i.indisready FROM pg_index i WHERE i.indexrelid=to_regclass('public.order_item_inventory') AND i.indrelid='public.order_item'::regclass");
    return row?.definition === 'CREATE INDEX order_item_inventory ON public.order_item USING btree (product_id, id, delivery_id)' && row.indisvalid === true && row.indisready === true;
  } catch { return false; }
}
export async function inventoryOrderIndexReady(store) {
  if (!await inventoryOrderIndexDefinitionReady(store)) return false;
  if (store.dialect !== 'sqlite') return true;
  const columns = (await store.all("SELECT name, \"desc\", coll, \"key\" FROM pragma_index_xinfo('order_item_inventory') WHERE \"key\"=1 ORDER BY seqno")).filter(row=>row.key===1);
  return columns.map(row=>row.name).join(',') === 'product_id,id,delivery_id' && columns.every(row=>row.desc===0&&row.coll==='BINARY');
}
export async function inventoryStorageReady(store) {
  try { if (![34,35,36].includes(await store.schemaVersion())) return false; await assertInventoryStorage(store); return await inventoryOrderIndexReady(store); } catch { return false; }
}
export async function migrateInventoryOrderIndex(store) {
  if (await store.schemaVersion() !== 32) throw new Error('Inventory index migration requires schema32.');
  await assertInventoryStorage(store);
  const existing = store.dialect === 'sqlite'
    ? await store.all("SELECT name FROM sqlite_schema WHERE name GLOB 'order_item_inventory*'")
    : await store.all("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'order!_item!_inventory%' ESCAPE '!'");
  if (existing.length) throw new Error('Unversioned inventory index prototype.');
  await store.exec(INVENTORY_ORDER_INDEX_SQL);
  if (!await inventoryOrderIndexReady(store)) throw new Error('Incompatible inventory order index.');
}
// Called only from the explicit schema migration transaction; never adopt prototypes.
export async function migrateInventory(store) {
  const present = store.dialect === 'sqlite' ? (await objects(store)).length : (await store.all("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'inventory!_%' ESCAPE '!'")).length;
  if (present) throw new Error('Unrecognized inventory storage before schema32 migration.');
  await store.exec(inventorySchema(store.dialect));
  await store.run("INSERT INTO inventory_coverage(product_id,origin,started_at,baseline_quantity) SELECT id,'MIGRATED',?,stock_quantity FROM product", new Date().toISOString());
  await store.run('INSERT INTO inventory_state(product_id,revision) SELECT id,0 FROM product');
  await store.run('INSERT INTO inventory_schema VALUES(1,1,?,?)', hash(inventorySchema(store.dialect)), await manifest(store));
}
