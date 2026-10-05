import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const integer = (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError('Database integer exceeds the supported range.');
  return number;
};
const types = { getTypeParser: (oid, format) => oid === 20 ? integer : pg.types.getTypeParser(oid, format) };

/* The application retains its parameterized SQL contract. Only these two search
 * expressions differ between drivers; quoted question marks are never parameters. */
export function postgresSql(sql) {
  const compatible = sql
    .replace(/instr\(lower\(([^)]+)\), lower\(\?\)\)/g, 'strpos(lower($1), lower(?))')
    .replace(/(\b\w+) COLLATE NOCASE/g, 'lower($1)')
    .replace(/\? IS NULL/g, 'CAST(? AS text) IS NULL');
  let index = 0;
  return compatible.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, (token) => token === '?' ? `$${++index}` : token);
}

export function openPostgresStore(connectionString, options = {}) {
  const pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000,
    query_timeout: 10000, statement_timeout: 10000, types, ...options });
  pool.on('error', () => console.error('Database connection unavailable.'));
  const context = new AsyncLocalStorage();
  const transaction = async (fn) => {
    if (context.getStore()) return fn();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Preserve SQLite single-writer semantics across processes. This also protects
      // sequence/idempotency, stock, limiter and setup read-then-write operations.
      await client.query('SELECT pg_advisory_xact_lock(73119, 1)');
      const result = await context.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  };
  const query = async (sql, params = []) => {
    const client = context.getStore();
    if (!client && /^\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)/i.test(sql)) {
      return transaction(() => query(sql, params));
    }
    return (client || pool).query(postgresSql(sql), params);
  };
  return {
    dialect: 'postgres',
    get: async (sql, ...params) => (await query(sql, params)).rows[0],
    all: async (sql, ...params) => (await query(sql, params)).rows,
    run: async (sql, ...params) => { await query(sql, params); },
    exec: async (sql) => { await query(sql); },
    transaction,
    schemaVersion: async () => (await query('SELECT version FROM schema_meta WHERE id = 1')).rows[0]?.version ?? 0,
    setSchemaVersion: async (version) => {
      if (!Number.isSafeInteger(version) || version < 0) throw new TypeError('Invalid schema version.');
      await query('UPDATE schema_meta SET version = ? WHERE id = 1', [version]);
    },
    close: () => pool.end(),
  };
}
