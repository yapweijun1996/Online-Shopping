import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { migrateStore, ready, SCHEMA_VERSION } from '../src/db.js';
import { SqlLimiter } from '../src/limiter.js';
import { openNodeStore } from '../src/store.js';

test('store transactions return results and roll back on failure', async () => {
  const store = openNodeStore(':memory:');
  try {
    await store.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT');
    assert.equal(await store.transaction(async () => {
      await store.run('INSERT INTO item(name) VALUES (?)', 'kept');
      return (await store.get('SELECT COUNT(*) AS count FROM item')).count;
    }), 1);
    await assert.rejects(async () => await store.transaction(async () => {
      await store.run('INSERT INTO item(name) VALUES (?)', 'discarded');
      throw new Error('abort');
    }), /abort/);
    assert.deepEqual((await store.all('SELECT name FROM item ORDER BY id')).map((row) => row.name), ['kept']);
    assert.equal(await store.get('SELECT name FROM item WHERE id = ?', 99), undefined);
    assert.equal((await store.get('UPDATE item SET name = ? WHERE id = ? RETURNING id', 'renamed', 1)).id, 1);
    assert.equal(await store.run('DELETE FROM item WHERE id = ?', 99), undefined);
  } finally { await store.close(); }
});

test('migrations run through the store contract and record the schema version', async () => {
  const store = openNodeStore(':memory:');
  try {
    assert.equal(await store.schemaVersion(), 0);
    await migrateStore(store);
    assert.equal(await store.schemaVersion(), SCHEMA_VERSION);
    await migrateStore(store);
    const stamp = new Date().toISOString();
    await store.run(`INSERT INTO seller_account(id, username, username_key, password_hash, role, created_at, updated_at) VALUES ('a1', 'owner', 'owner', 'x:y', 'OWNER', ?, ?)`, stamp, stamp);
    assert.equal(await ready(store), true);
    await store.setSchemaVersion(SCHEMA_VERSION + 1);
    assert.equal(await ready(store), false);
    await assert.rejects(async () => await migrateStore(store), /Unsupported database schema version/);
    await assert.rejects(async () => await store.setSchemaVersion(-1), TypeError);
  } finally { await store.close(); }
});

test('application modules use only the portable store contract', () => {
  // Trigger bodies may use BEGIN ... END; only transaction statements are the store's job.
  const forbidden = /\.prepare\(|\bBEGIN\s+(IMMEDIATE|DEFERRED|EXCLUSIVE|TRANSACTION)\b|['"`]BEGIN['"`]|\b(COMMIT|ROLLBACK|PRAGMA)\b|node:sqlite/;
  const drivers = new Set(['store.js', 'postgres-store.js']);
  const directory = new URL('../src/', import.meta.url);
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.js') && !drivers.has(entry))) {
    assert.doesNotMatch(readFileSync(new URL(name, directory), 'utf8'), forbidden, name);
  }
});

test('database limiter reserves slots per client, expires them, and stores no raw keys', async () => {
  const store = openNodeStore(':memory:');
  try {
    await migrateStore(store);
    let now = 1_000_000;
    const limiter = new SqlLimiter(store, 'login', { limit: 2, windowMs: 1000, now: () => now });
    const other = new SqlLimiter(store, 'checkout', { limit: 1, windowMs: 1000, now: () => now });
    assert.equal(await limiter.attempt('203.0.113.7'), true);
    assert.equal(await limiter.attempt('203.0.113.7'), true);
    assert.equal(await limiter.attempt('203.0.113.7'), false);
    assert.equal(await limiter.attempt('198.51.100.1'), true);
    assert.equal(await other.attempt('203.0.113.7'), true);
    assert.equal((await store.all('SELECT key_hash FROM rate_limit_attempt')).some(({ key_hash }) => key_hash.includes('203.0.113.7')), false);
    now += 1000;
    assert.equal(await limiter.attempt('203.0.113.7'), true);
    await limiter.clear('203.0.113.7');
    assert.equal(await limiter.attempt('203.0.113.7'), true);
    assert.equal(await limiter.attempt('203.0.113.7'), true);
    assert.equal(await limiter.attempt('203.0.113.7'), false);
    // The other client's expired attempt was pruned; only the two live reservations remain.
    assert.equal((await store.get("SELECT COUNT(*) AS count FROM rate_limit_attempt WHERE bucket = 'login'")).count, 2);
  } finally { await store.close(); }
});
