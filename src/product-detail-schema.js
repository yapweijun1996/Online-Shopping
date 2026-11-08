// Rich detail is listing-owned; the short description remains a separate field.
export function productDetailSchema(dialect) {
  const integer = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  const blob = dialect === 'postgres' ? 'BYTEA' : 'BLOB';
  const json = dialect === 'postgres' ? 'document_json::jsonb IS NOT NULL' : 'json_valid(document_json)';
  const strict = dialect === 'postgres' ? '' : ' STRICT';
  return `
CREATE TABLE IF NOT EXISTS listing_detail (
 listing_id TEXT PRIMARY KEY REFERENCES listing(id) ON DELETE CASCADE,
 revision ${integer} NOT NULL CHECK (revision >= 1),
 document_json TEXT NOT NULL CHECK (${json} AND length(document_json) <= 160000),
 updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 64),
 updated_at TEXT NOT NULL
)${strict};
CREATE TABLE IF NOT EXISTS listing_detail_image (
 id TEXT PRIMARY KEY,
 listing_id TEXT NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
 mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp')),
 data ${blob} NOT NULL CHECK (length(data) BETWEEN 1 AND 524288),
 width ${integer} NOT NULL CHECK (width BETWEEN 1 AND 32768),
 height ${integer} NOT NULL CHECK (height BETWEEN 1 AND 32768),
 sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
 committed ${integer} NOT NULL DEFAULT 0 CHECK (committed IN (0,1)),
 created_at TEXT NOT NULL,
 CHECK (width * height <= 40000000)
)${strict};
CREATE INDEX IF NOT EXISTS listing_detail_image_owner ON listing_detail_image(listing_id, committed, created_at);
`;
}
export async function migrateProductDetail(store) {
  await store.exec(productDetailSchema(store.dialect));
  await assertProductDetailStorage(store);
}

const compact = sql => sql.replace(/IF NOT EXISTS /g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
const columns = {
  listing_detail: [['listing_id','text'],['revision','bigint'],['document_json','text'],['updated_by','text'],['updated_at','text']],
  listing_detail_image: [['id','text'],['listing_id','text'],['mime','text'],['data','bytea'],['width','bigint'],['height','bigint'],['sha256','text'],['committed','bigint'],['created_at','text']],
};
const constraints = {
  listing_detail: [
    'CHECK ((((document_json)::jsonb IS NOT NULL) AND (length(document_json) <= 160000)))',
    'CHECK (((length(updated_by) >= 1) AND (length(updated_by) <= 64)))',
    'CHECK ((revision >= 1))',
    'FOREIGN KEY (listing_id) REFERENCES listing(id) ON DELETE CASCADE',
    'PRIMARY KEY (listing_id)',
  ],
  listing_detail_image: [
    'CHECK (((height >= 1) AND (height <= 32768)))',
    'CHECK (((length(data) >= 1) AND (length(data) <= 524288)))',
    'CHECK (((width * height) <= 40000000))',
    'CHECK (((width >= 1) AND (width <= 32768)))',
    'CHECK ((committed = ANY (ARRAY[(0)::bigint, (1)::bigint])))',
    'CHECK ((length(sha256) = 64))',
    "CHECK ((mime = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])))",
    'FOREIGN KEY (listing_id) REFERENCES listing(id) ON DELETE CASCADE',
    'PRIMARY KEY (id)',
  ],
};

// Validate source-owned constraints as well as column presence. Global35 must
// not label a partially created or operator-modified detail schema compatible.
export async function assertProductDetailStorage(store) {
  if (store.dialect === 'sqlite') {
    const expected = productDetailSchema('sqlite').split(';').map(sql => sql.trim()).filter(Boolean).map(compact).sort();
    const rows = await store.all("SELECT sql FROM sqlite_schema WHERE tbl_name IN ('listing_detail','listing_detail_image') AND sql IS NOT NULL ORDER BY name");
    const actual = rows.map(row => compact(row.sql)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Incompatible rich detail storage.');
    return;
  }
  for (const [table, entries] of Object.entries(columns)) {
    const actual = await store.all('SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position','public',table);
    if (actual.length !== entries.length || actual.some((row,i) => row.column_name !== entries[i][0] || row.data_type !== entries[i][1] || row.is_nullable !== 'NO' || row.column_default !== (row.column_name === 'committed' ? '0' : null))) throw new Error('Incompatible rich detail columns.');
    const checks = await store.all("SELECT pg_get_constraintdef(c.oid) AS definition,c.convalidated FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=?",table);
    if (checks.some(row => !row.convalidated) || JSON.stringify(checks.map(row => row.definition).sort()) !== JSON.stringify([...constraints[table]].sort())) throw new Error('Incompatible rich detail constraints.');
    const metadata = await store.get("SELECT relrowsecurity,relkind,relpersistence,(SELECT COUNT(*) FROM pg_trigger WHERE tgrelid=r.oid AND NOT tgisinternal) AS triggers FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND r.relname=?",table);
    if (!metadata || metadata.relrowsecurity || metadata.relkind !== 'r' || metadata.relpersistence !== 'p' || Number(metadata.triggers)) throw new Error('Incompatible rich detail tables.');
  }
  const indexes = await store.all("SELECT pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid,i.indisready FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname IN ('listing_detail','listing_detail_image')");
  const expectedIndexes = [
    'CREATE UNIQUE INDEX listing_detail_pkey ON public.listing_detail USING btree (listing_id)',
    'CREATE UNIQUE INDEX listing_detail_image_pkey ON public.listing_detail_image USING btree (id)',
    'CREATE INDEX listing_detail_image_owner ON public.listing_detail_image USING btree (listing_id, committed, created_at)',
  ];
  if (indexes.some(row=>!row.indisvalid||!row.indisready) || JSON.stringify(indexes.map(row=>row.definition).sort()) !== JSON.stringify(expectedIndexes.sort())) throw new Error('Incompatible rich detail indexes.');
}
export async function productDetailStorageReady(store) {
  try { await assertProductDetailStorage(store); return true; } catch { return false; }
}
