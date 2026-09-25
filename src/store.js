import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/*
 * Storage contract shared by every runtime. Application code talks only to this
 * interface so the same SQL can run on node:sqlite or a Durable Object's SQLite.
 *
 *   get(sql, ...params)   -> first row object, or undefined
 *   all(sql, ...params)   -> array of row objects
 *   run(sql, ...params)   -> undefined; use RETURNING when a result is needed
 *   exec(sql)             -> runs one or more statements without parameters
 *   transaction(fn)       -> runs fn atomically and returns its result; a throw rolls back
 *   schemaVersion()       -> integer schema version, 0 for a new database
 *   setSchemaVersion(v)   -> records the version; call inside a migration transaction
 *   close()               -> releases the database
 *
 * SQL must not contain BEGIN/COMMIT/ROLLBACK or PRAGMA statements; the store owns those.
 */

export function openNodeStore(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file, { timeout: 5000 });
  if (file !== ':memory:') chmodSync(file, 0o600);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  return {
    get: (sql, ...params) => database.prepare(sql).get(...params),
    all: (sql, ...params) => database.prepare(sql).all(...params),
    run: (sql, ...params) => { database.prepare(sql).run(...params); },
    exec: (sql) => database.exec(sql),
    transaction(fn) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    schemaVersion: () => database.prepare('PRAGMA user_version').get().user_version,
    setSchemaVersion(version) {
      if (!Number.isSafeInteger(version) || version < 0) throw new TypeError('Invalid schema version.');
      database.exec(`PRAGMA user_version = ${version}`);
    },
    close: () => database.close(),
  };
}
