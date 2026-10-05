/*
 * Store contract (see store.js) backed by a SQLite Durable Object's ctx.storage.
 * Durable Object SQL runs synchronously inside the object, so the contract maps
 * directly: transactions use transactionSync and the schema version lives in a table.
 */

function toRow(row) {
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof ArrayBuffer) row[key] = new Uint8Array(value);
  }
  return row;
}

function toParam(value) {
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return value;
}

export function openDurableStore(storage) {
  const sql = storage.sql;
  const query = (text, params) => sql.exec(text, ...params.map(toParam)).toArray().map(toRow);
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  ) STRICT`);
  return {
    get: (text, ...params) => query(text, params)[0],
    all: (text, ...params) => query(text, params),
    run: (text, ...params) => { query(text, params); },
    exec: (text) => { sql.exec(text); },
    transaction: (fn) => storage.transactionSync(fn),
    // Durable Objects always enforce foreign keys; deferring them checks once, at commit.
    rebuildTransaction: (fn) => storage.transactionSync(() => {
      sql.exec('PRAGMA defer_foreign_keys = ON');
      return fn();
    }),
    schemaVersion: () => sql.exec('SELECT version FROM schema_meta WHERE id = 1').toArray()[0]?.version ?? 0,
    setSchemaVersion(version) {
      if (!Number.isSafeInteger(version) || version < 0) throw new TypeError('Invalid schema version.');
      sql.exec('INSERT INTO schema_meta(id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version', version);
    },
    close() {},
  };
}
