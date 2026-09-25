import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { migrateStore, ready, SCHEMA_VERSION } from '../src/db.js';
import { openNodeStore } from '../src/store.js';

test('store transactions return results and roll back on failure', () => {
  const store = openNodeStore(':memory:');
  try {
    store.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT');
    assert.equal(store.transaction(() => {
      store.run('INSERT INTO item(name) VALUES (?)', 'kept');
      return store.get('SELECT COUNT(*) AS count FROM item').count;
    }), 1);
    assert.throws(() => store.transaction(() => {
      store.run('INSERT INTO item(name) VALUES (?)', 'discarded');
      throw new Error('abort');
    }), /abort/);
    assert.deepEqual(store.all('SELECT name FROM item ORDER BY id').map((row) => row.name), ['kept']);
    assert.equal(store.get('SELECT name FROM item WHERE id = ?', 99), undefined);
    assert.equal(store.get('UPDATE item SET name = ? WHERE id = ? RETURNING id', 'renamed', 1).id, 1);
    assert.equal(store.run('DELETE FROM item WHERE id = ?', 99), undefined);
  } finally { store.close(); }
});

test('migrations run through the store contract and record the schema version', () => {
  const store = openNodeStore(':memory:');
  try {
    assert.equal(store.schemaVersion(), 0);
    migrateStore(store);
    assert.equal(store.schemaVersion(), SCHEMA_VERSION);
    migrateStore(store);
    store.run(`INSERT INTO admin(id, username, password_hash, created_at) VALUES (1, 'owner', 'x:y', ?)`, new Date().toISOString());
    assert.equal(ready(store), true);
    store.setSchemaVersion(SCHEMA_VERSION + 1);
    assert.equal(ready(store), false);
    assert.throws(() => migrateStore(store), /Unsupported database schema version/);
    assert.throws(() => store.setSchemaVersion(-1), TypeError);
  } finally { store.close(); }
});

test('application modules use only the portable store contract', () => {
  const forbidden = /\.prepare\(|\b(BEGIN|COMMIT|ROLLBACK|PRAGMA)\b|node:sqlite/;
  const directory = new URL('../src/', import.meta.url);
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.js') && entry !== 'store.js')) {
    assert.doesNotMatch(readFileSync(new URL(name, directory), 'utf8'), forbidden, name);
  }
});
