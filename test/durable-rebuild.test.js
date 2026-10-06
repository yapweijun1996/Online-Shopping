import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Execute the actual Durable Object adapter under workerd, with foreign keys
// enforced at the runtime's implicit commit boundary rather than Node SQLite.
const repairFixture = readFileSync(new URL('./fixtures/sqlite-repair-schema12.sql', import.meta.url), 'utf8');
const bundled = await build({ bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:*'], stdin: {
  resolveDir: process.cwd(), contents: `
import { openDurableStore } from './worker-runtime/durable-store.js';
import { migrateStore } from './worker-runtime/db.js';
export class FixtureStore {
  constructor(ctx) { this.ctx = ctx; this.store = openDurableStore(ctx.storage); }
  async fetch(request) {
    const action = new URL(request.url).pathname;
    const s = this.store;
    if (action === '/seed') {
      this.ctx.storage.transactionSync(() => {
        s.exec('PRAGMA defer_foreign_keys = ON');
        s.exec(${JSON.stringify(repairFixture.replace(/^PRAGMA .*;$/gm, ''))});
        s.setSchemaVersion(12);
      });
      return Response.json({ version: s.schemaVersion() });
    }
    if (action === '/failed-migrate') {
      try {
        migrateStore({ ...s, exec(text) {
          if (text.includes('ADD COLUMN tracking_carrier')) throw new Error('Injected migration failure');
          s.exec(text);
        } });
        return Response.json({ rejected: false });
      } catch { return Response.json({ rejected: true, version: s.schemaVersion() }); }
    }
    if (action === '/migrate') { migrateStore(s); }
    if (action === '/invalid') {
      try {
        s.rebuildTransaction(() => s.run("UPDATE delivery SET order_id = 'missing-parent'"));
        return Response.json({ rejected: false });
      } catch { return Response.json({ rejected: true }); }
    }
    if (action === '/enforcement') {
      try { s.run("UPDATE delivery SET order_id = 'missing-parent'"); return Response.json({ rejected: false }); }
      catch { return Response.json({ rejected: true }); }
    }
    return Response.json({ version: s.schemaVersion(), order: s.get('SELECT * FROM shop_order'),
      items: s.all('SELECT * FROM order_item'), deliveries: s.all('SELECT * FROM delivery'), violations: s.all('PRAGMA foreign_key_check') });
  }
}
export default { fetch(request, env) { return env.SHOP.get(env.SHOP.idFromName('historical')).fetch(request); } };
` } });

test('real Durable Object preserves historical orders during rebuild, rolls back invalid references and keeps enforcement', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'], durableObjects: { SHOP: { className: 'FixtureStore', useSQLite: true } } }));
  t.after(() => mf.dispose());
  const call = async path => {
    const response = await mf.dispatchFetch('http://fixture.test' + path);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  assert.equal((await call('/seed')).version, 12);
  const before = await call('/snapshot');
  assert.deepEqual(await call('/failed-migrate'), { rejected: true, version: 12 });
  const rolledBack = await call('/snapshot');
  assert.deepEqual(rolledBack.order, before.order);
  assert.deepEqual(rolledBack.items, before.items);
  assert.deepEqual(rolledBack.deliveries, before.deliveries);
  assert.deepEqual(rolledBack.violations, []);
  const after = await call('/migrate');
  assert.equal(after.version, 15);
  assert.deepEqual(after.order, { ...before.order, tracking_carrier: null, tracking_no: null });
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.deliveries, before.deliveries);
  assert.deepEqual(after.violations, []);
  assert.equal((await call('/invalid')).rejected, true);
  assert.deepEqual((await call('/snapshot')).items, before.items);
  assert.deepEqual((await call('/snapshot')).deliveries, before.deliveries);
  assert.equal((await call('/enforcement')).rejected, true);
  assert.deepEqual((await call('/snapshot')).violations, []);
});
