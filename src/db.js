import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file, { timeout: 5000 });
  if (file !== ':memory:') chmodSync(file, 0o600);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const version = database.prepare('PRAGMA user_version').get().user_version;
  if (version === 0) {
    database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE admin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX session_expiry ON session(expires_at);
      PRAGMA user_version = 1;
      COMMIT;`);
  } else if (version !== SCHEMA_VERSION) {
    database.close();
    throw new Error(`Unsupported database schema version ${version}.`);
  }
  return database;
}

export function ready(database) {
  try {
    return database.prepare('PRAGMA user_version').get().user_version === SCHEMA_VERSION &&
      Boolean(database.prepare('SELECT id FROM admin WHERE id = 1').get()) &&
      Array.isArray(database.prepare('SELECT token_hash FROM session LIMIT 1').all());
  } catch {
    return false;
  }
}
