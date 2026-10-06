import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { migrateStore } from '../../src/db.js';

/*
 * A synchronous node:sqlite store implementing the storage contract (src/store.js documents it).
 * The synthetic integration modules (ledger, consent, ingress, adapters) are written for a synchronous
 * store and are only exercised by tests, so the tests build their database with this helper instead of
 * the asynchronous production store. `transaction` accepts async callbacks, so the application code
 * (createApi, products, orders, migrations) runs on it unchanged.
 */
export function openSyncStore(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file, { timeout: 5000 });
  if (file !== ':memory:') chmodSync(file, 0o600);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  let depth = 0;
  const inTransaction = (fn, { rebuild = false } = {}) => {
    if (depth > 0) return fn();
    depth++;
    if (rebuild) database.exec('PRAGMA foreign_keys = OFF');
    const finish = () => { depth--; if (rebuild) database.exec('PRAGMA foreign_keys = ON'); };
    database.exec('BEGIN IMMEDIATE');
    const commit = (value) => {
      if (rebuild && database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migration failed foreign-key check.');
      database.exec('COMMIT'); finish(); return value;
    };
    const rollback = (error) => { database.exec('ROLLBACK'); finish(); throw error; };
    let result;
    try { result = fn(); } catch (error) { return rollback(error); }
    if (result && typeof result.then === 'function') return result.then(commit, rollback);
    try { return commit(result); } catch (error) { return rollback(error); }
  };
  return {
    dialect: 'sqlite',
    get: (sql, ...params) => database.prepare(sql).get(...params),
    all: (sql, ...params) => database.prepare(sql).all(...params),
    run: (sql, ...params) => { database.prepare(sql).run(...params); },
    exec: (sql) => database.exec(sql),
    transaction: (fn) => inTransaction(fn),
    rebuildTransaction: (fn) => inTransaction(fn, { rebuild: true }),
    schemaVersion: () => database.prepare('PRAGMA user_version').get().user_version,
    setSchemaVersion(version) {
      if (!Number.isSafeInteger(version) || version < 0) throw new TypeError('Invalid schema version.');
      database.exec(`PRAGMA user_version = ${version}`);
    },
    close: () => database.close(),
  };
}

/** Opens and migrates a synchronous store, like `openDatabase` for the production store. */
export async function openSyncDatabase(file) {
  const store = openSyncStore(file);
  try { await migrateStore(store); } catch (error) { store.close(); throw error; }
  return store;
}
