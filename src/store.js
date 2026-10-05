import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/* Async storage contract: get/all/run/exec, transaction(callback), schemaVersion,
 * setSchemaVersion and close. A transaction owns its connection until the async
 * callback settles. Callers must await all operations before returning. */
export function openNodeStore(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file, { timeout: 5000 });
  if (file !== ':memory:') chmodSync(file, 0o600);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const context = new AsyncLocalStorage();
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    if (context.getStore()) return Promise.resolve().then(fn);
    const result = queue.then(() => context.run({ transaction: false }, fn));
    queue = result.catch(() => {});
    return result;
  };
  const transaction = (fn, rebuild = false) => exclusive(async () => {
    const scope = context.getStore();
    if (scope.transaction) return fn();
    scope.transaction = true;
    if (rebuild) database.exec('PRAGMA foreign_keys = OFF');
    try {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        if (rebuild && database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migration failed foreign-key check.');
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } finally {
      if (rebuild) database.exec('PRAGMA foreign_keys = ON');
      scope.transaction = false;
    }
  });
  return {
    dialect: 'sqlite',
    get: (sql, ...params) => exclusive(() => database.prepare(sql).get(...params)),
    all: (sql, ...params) => exclusive(() => database.prepare(sql).all(...params)),
    run: (sql, ...params) => exclusive(() => { database.prepare(sql).run(...params); }),
    exec: (sql) => exclusive(() => database.exec(sql)),
    transaction: (fn) => transaction(fn),
    rebuildTransaction: (fn) => transaction(fn, true),
    schemaVersion: () => exclusive(() => database.prepare('PRAGMA user_version').get().user_version),
    setSchemaVersion: (version) => exclusive(() => {
      if (!Number.isSafeInteger(version) || version < 0) throw new TypeError('Invalid schema version.');
      database.exec(`PRAGMA user_version = ${version}`);
    }),
    close: () => exclusive(() => database.close()),
  };
}
