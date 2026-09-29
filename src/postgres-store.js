import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { initializePostgresSchema } from './postgres-schema.js';

const require = createRequire(import.meta.url);
const NativeClient = require('pg-native');
const integerFields = new Set(['id', 'count', 'value', 'total_minor', 'line_total_minor', 'attempted_at']);

function connectionValue(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function connectionString(config) {
  const password = readFileSync(config.pgPasswordFile, 'utf8').replace(/\r?\n$/, '');
  if (!password) throw new Error('PostgreSQL password file is empty.');
  return `host=${connectionValue(config.pgHost)} port=${config.pgPort} ` +
    `dbname=${connectionValue(config.pgDatabase)} user=${connectionValue(config.pgUser)} ` +
    `password=${connectionValue(password)} connect_timeout=5 application_name=online-shopping`;
}

function postgresSql(sql, binaryPositions = new Set()) {
  let index = 0;
  return sql
    .replace(/\binstr\(/gi, 'strpos(')
    .replace(/\blabel COLLATE NOCASE\b/gi, 'lower(label)')
    .replace(/\? IS NULL/g, '?::text IS NULL')
    .replace(/\?/g, () => {
      index += 1;
      return binaryPositions.has(index) ? `decode($${index}, 'hex')` : `$${index}`;
    });
}

function normalizeRow(row) {
  for (const [key, value] of Object.entries(row)) {
    if (integerFields.has(key) && typeof value === 'string' && /^-?\d+$/.test(value)) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new Error('PostgreSQL integer exceeds safe JavaScript range.');
      row[key] = parsed;
    }
  }
  return row;
}

// Run native synchronous libpq calls inside the dedicated API worker thread.
// The HTTP thread remains responsive when a query waits for PostgreSQL.
export function openPostgresStore(config) {
  const client = new NativeClient();
  try { client.connectSync(connectionString(config)); }
  catch { throw new Error('PostgreSQL connection failed.'); }
  function query(sql, ...params) {
    const binaryPositions = new Set();
    const values = params.map((value, index) => {
      if (!ArrayBuffer.isView(value)) return value;
      binaryPositions.add(index + 1);
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
    });
    const result = values.length
      ? client.querySync(postgresSql(sql, binaryPositions), values)
      : client.querySync(postgresSql(sql));
    return result.map(normalizeRow);
  }
  try {
    query("SET statement_timeout = '5s'");
    query("SET idle_in_transaction_session_timeout = '10s'");
    initializePostgresSchema((sql) => query(sql));
  }
  catch (error) { client.end(() => {}); throw error; }
  return {
    get: (sql, ...params) => query(sql, ...params)[0],
    all: (sql, ...params) => query(sql, ...params),
    run: (sql, ...params) => { query(sql, ...params); },
    exec: (sql) => { query(sql); },
    transaction(fn) {
      query('BEGIN');
      try {
        const result = fn();
        query('COMMIT');
        return result;
      } catch (error) {
        query('ROLLBACK');
        throw error;
      }
    },
    rebuildTransaction(fn) { return this.transaction(fn); },
    schemaVersion: () => query('SELECT version FROM schema_meta WHERE id = 1')[0]?.version ?? 0,
    setSchemaVersion(version) {
      if (!Number.isSafeInteger(version) || version < 0) throw new TypeError('Invalid schema version.');
      query('UPDATE schema_meta SET version = ? WHERE id = 1', version);
    },
    close: () => new Promise((resolve) => client.end(resolve)),
  };
}
