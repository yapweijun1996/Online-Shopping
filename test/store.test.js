import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { migrateStore, ready, SCHEMA_VERSION } from '../src/db.js';
import { SqlLimiter } from '../src/limiter.js';
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
  // Trigger bodies may use BEGIN ... END; only transaction statements are the store's job.
  const forbidden = /\.prepare\(|\bBEGIN\s+(IMMEDIATE|DEFERRED|EXCLUSIVE|TRANSACTION)\b|['"`]BEGIN['"`]|\b(COMMIT|ROLLBACK|PRAGMA)\b|node:sqlite/;
  const drivers = new Set(['store.js', 'durable-store.js']);
  const directory = new URL('../src/', import.meta.url);
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.js') && !drivers.has(entry))) {
    assert.doesNotMatch(readFileSync(new URL(name, directory), 'utf8'), forbidden, name);
  }
});

test('database limiter reserves slots per client, expires them, and stores no raw keys', () => {
  const store = openNodeStore(':memory:');
  try {
    migrateStore(store);
    let now = 1_000_000;
    const limiter = new SqlLimiter(store, 'login', { limit: 2, windowMs: 1000, now: () => now });
    const other = new SqlLimiter(store, 'checkout', { limit: 1, windowMs: 1000, now: () => now });
    assert.equal(limiter.attempt('203.0.113.7'), true);
    assert.equal(limiter.attempt('203.0.113.7'), true);
    assert.equal(limiter.attempt('203.0.113.7'), false);
    assert.equal(limiter.attempt('198.51.100.1'), true);
    assert.equal(other.attempt('203.0.113.7'), true);
    assert.equal(store.all('SELECT key_hash FROM rate_limit_attempt').some(({ key_hash }) => key_hash.includes('203.0.113.7')), false);
    now += 1000;
    assert.equal(limiter.attempt('203.0.113.7'), true);
    limiter.clear('203.0.113.7');
    assert.equal(limiter.attempt('203.0.113.7'), true);
    assert.equal(limiter.attempt('203.0.113.7'), true);
    assert.equal(limiter.attempt('203.0.113.7'), false);
    // The other client's expired attempt was pruned; only the two live reservations remain.
    assert.equal(store.get("SELECT COUNT(*) AS count FROM rate_limit_attempt WHERE bucket = 'login'").count, 2);
  } finally { store.close(); }
});
