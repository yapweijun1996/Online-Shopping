import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 2;

function migrate(database, version, sql) {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(sql);
    database.exec(`PRAGMA user_version = ${version}`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file, { timeout: 5000 });
  if (file !== ':memory:') chmodSync(file, 0o600);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  let version = database.prepare('PRAGMA user_version').get().user_version;
  if (version === 0) {
    migrate(database, 1, `
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
      CREATE INDEX session_expiry ON session(expires_at);`);
    version = 1;
  }
  if (version === 1) {
    migrate(database, 2, `
      CREATE TABLE product (
        id TEXT PRIMARY KEY,
        sku TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        price_minor INTEGER NOT NULL CHECK (price_minor BETWEEN 1 AND 1000000000),
        currency TEXT NOT NULL CHECK (currency = 'MYR'),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        translations_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(translations_json)),
        image_mime TEXT,
        image_data BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((image_mime IS NULL AND image_data IS NULL) OR
               (image_mime IN ('image/png', 'image/jpeg', 'image/webp') AND image_data IS NOT NULL))
      ) STRICT;
      CREATE INDEX product_public ON product(active, category, updated_at);`);
    version = 2;
  }
  if (version !== SCHEMA_VERSION) {
    database.close();
    throw new Error(`Unsupported database schema version ${version}.`);
  }
  return database;
}

export function ready(database) {
  try {
    return database.prepare('PRAGMA user_version').get().user_version === SCHEMA_VERSION &&
      Boolean(database.prepare('SELECT id FROM admin WHERE id = 1').get()) &&
      Array.isArray(database.prepare('SELECT token_hash FROM session LIMIT 1').all()) &&
      Array.isArray(database.prepare('SELECT id FROM product LIMIT 1').all());
  } catch {
    return false;
  }
}
