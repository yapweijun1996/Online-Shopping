import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradePostgres } from '../src/postgres/upgrade.js';
import { inventoryFixture } from './helpers/inventory-fixture.js';

const url = process.env.SHOP_TEST_DATABASE_URL;
test('PostgreSQL schema 37 upgrades to 38 transactionally', { skip: !url }, async t => {
  // Use the shared disposable-database fence rather than one developer's fixed port/database.
  const { store } = await inventoryFixture(t, 'postgres', { seed: false });
  await store.transaction(async () => {
    await store.exec('DROP TABLE shop_logo_event; DROP TABLE shop_logo; UPDATE schema_meta SET version=37');
    await upgradePostgres(store, 37);
    assert.equal(await store.schemaVersion(), 38);
    assert.equal((await store.get("SELECT to_regclass('public.shop_logo') AS name")).name, 'shop_logo');
    assert.equal((await store.get("SELECT to_regclass('public.shop_logo_event') AS name")).name, 'shop_logo_event');
    await store.run("INSERT INTO shop_logo_event (id, action, actor, created_at) VALUES ('existing', 'UPLOAD', 'seller', '2026-01-01')");
    await store.setSchemaVersion(37);
    await upgradePostgres(store, 37);
    assert.equal(await store.schemaVersion(), 38);
    assert.equal((await store.get("SELECT actor FROM shop_logo_event WHERE id='existing'")).actor, 'seller');
  });
});
