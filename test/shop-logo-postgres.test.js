import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { postgresSql } from '../src/postgres-store.js';
import { upgradePostgres } from '../src/postgres/upgrade.js';

const url = process.env.SHOP_TEST_DATABASE_URL;
test('PostgreSQL schema 37 upgrades to 38 transactionally', { skip: !url }, async () => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(url, 'postgres://postgres@127.0.0.1:55433/shop_logo_test');
  const types = { getTypeParser: (oid, format) => oid === 20 ? Number : pg.types.getTypeParser(oid, format) };
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, types });
  await client.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    assert.equal(existing.rowCount, 0, 'The designated test database must be empty');
    await client.query(await readFile(new URL('../src/postgres/schema.sql', import.meta.url), 'utf8'));
    await client.query('DROP TABLE shop_logo_event; DROP TABLE shop_logo; UPDATE schema_meta SET version=37');
    const query = (sql, args = []) => client.query(postgresSql(sql), args);
    const store = { dialect: 'postgres', get: async (sql, ...args) => (await query(sql, args)).rows[0], all: async (sql, ...args) => (await query(sql, args)).rows,
      run: async (sql, ...args) => { await query(sql, args); }, exec: async sql => { await query(sql); },
      schemaVersion: async () => Number((await query('SELECT version FROM schema_meta WHERE id=1')).rows[0].version),
      setSchemaVersion: async version => { await query('UPDATE schema_meta SET version=? WHERE id=1', [version]); }, transaction: fn => fn() };
    await upgradePostgres(store, 37);
    assert.equal(await store.schemaVersion(), 38);
    assert.equal((await store.get("SELECT to_regclass('public.shop_logo') AS name")).name, 'shop_logo');
    assert.equal((await store.get("SELECT to_regclass('public.shop_logo_event') AS name")).name, 'shop_logo_event');
    await store.run("INSERT INTO shop_logo_event (id, action, actor, created_at) VALUES ('existing', 'UPLOAD', 'seller', '2026-01-01')");
    await store.setSchemaVersion(37);
    await upgradePostgres(store, 37);
    assert.equal(await store.schemaVersion(), 38);
    assert.equal((await store.get("SELECT actor FROM shop_logo_event WHERE id='existing'")).actor, 'seller');
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
});
