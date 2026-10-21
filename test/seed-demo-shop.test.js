import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { getProduct } from '../src/products.js';
import { seedDemoShop } from '../scripts/seed-demo-shop.mjs';

const jpeg = Buffer.from('ffd8ffe000104a4649460001ffd9', 'hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'seed-shop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const products = [1, 2].map(n => ({ sku: `TEST-${n}`, name: `Synthetic ${n}`, category: 'Test Goods', description: 'Synthetic fixture', priceMinor: n * 500, stock: n * 3, currency: 'MYR' }));
  for (const p of products) {
    await mkdir(join(root, p.sku));
    for (let n = 1; n <= 3; n++) {
      await writeFile(join(root, p.sku, `view-${n}.jpg`), Buffer.concat([jpeg, Buffer.from([n])]));
      await writeFile(join(root, p.sku, `view-${n}.thumb.jpg`), jpeg);
    }
  }
  const data = join(root, 'products.json');
  await writeFile(data, JSON.stringify({ shopName: 'Ignored without flag', products }));
  return { root, products, options: { data, images: root } };
}
const quiet = () => {};
for (const backend of ['sqlite', 'postgres']) {
  test(`${backend}: seeding preserves data, supports dry run and resumes atomically`, { skip: backend === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async t => {
    const f = await fixture(t);
    let store;
    if (backend === 'sqlite') store = await openDatabase(join(f.root, 'shop.db'));
    else {
      const base = process.env.SHOP_TEST_DATABASE_URL;
      if (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname)) throw new Error('Disposable PostgreSQL test database required.');
      const pool = new pg.Pool({ connectionString: base });
      const name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`CREATE DATABASE ${name}`);
      const url = new URL(base); url.pathname = `/${name}`;
      t.after(async () => { await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
      store = await openPostgresDatabase(url.href);
    }
    t.after(() => store.close());
    const snapshot = async () => ({ products: await store.all('SELECT * FROM product'), categories: await store.all('SELECT * FROM general_code'), setup: await store.get('SELECT * FROM shop_setup WHERE id = 1') });
    const before = await snapshot();
    const preview = await seedDemoShop(store, { ...f.options, dryRun: true, shopName: 'Preview' }, quiet);
    assert.equal(preview.created, 2);
    assert.deepEqual(await snapshot(), before);
    for (const bad of [Buffer.from('not jpeg'), Buffer.alloc(512 * 1024 + 1, 255)]) {
      await writeFile(join(f.root, 'TEST-2/view-3.jpg'), bad);
      await assert.rejects(seedDemoShop(store, { ...f.options, shopName: 'Must not persist' }, quiet), /TEST-2 view-3: invalid JPEG/);
      assert.deepEqual(await snapshot(), before);
    }
    await writeFile(join(f.root, 'TEST-2/view-3.jpg'), Buffer.concat([jpeg, Buffer.from([3])]));
    const originalRun = store.run;
    store.run = async (sql, ...args) => {
      if (sql.startsWith('INSERT INTO product_event') && args[2] === 'seed-demo-shop') {
        const row = await store.get('SELECT sku FROM product WHERE id = ?', args[1]);
        if (row.sku === 'TEST-2') throw new Error('Injected history failure');
      }
      return originalRun(sql, ...args);
    };
    await assert.rejects(seedDemoShop(store, f.options, quiet), /Injected history failure/);
    store.run = originalRun;
    assert.deepEqual((await store.all('SELECT sku FROM product')).map(p => p.sku), ['TEST-1']);
    const result = await seedDemoShop(store, { ...f.options, shopName: 'Demo Mart Malaysia' }, quiet);
    assert.deepEqual(result, { created: 1, skipped: 1, categoriesCreated: 0, shopName: 'Demo Mart Malaysia', imagesAdded: 3 });
    for (const expected of f.products) {
      const row = await store.get('SELECT id, thumb_data FROM product WHERE sku = ?', expected.sku);
      const actual = await getProduct(store, row.id, true);
      assert.equal(actual.name, expected.name);
      assert.equal(actual.priceMinor, expected.priceMinor);
      assert.equal(actual.stockQuantity, expected.stock);
      assert.equal(actual.active, true);
      assert.equal(actual.categoryCode, 'TEST-GOODS');
      assert.equal(actual.category, 'Test Goods');
      assert.equal(actual.images.length, 3);
      assert.deepEqual(Buffer.from(row.thumb_data), jpeg);
      assert.equal((await store.get('SELECT actor FROM product_event WHERE product_id = ?', row.id)).actor, 'seed-demo-shop');
    }
    const saved = await snapshot();
    assert.deepEqual(await seedDemoShop(store, f.options, quiet), { created: 0, skipped: 2, categoriesCreated: 0, shopName: 'Demo Mart Malaysia', imagesAdded: 0 });
    assert.deepEqual(await snapshot(), saved);
  });
}
test('CLI uses readConfig SQLite environment and emits summary JSON', async t => {
  const f = await fixture(t);
  const output = execFileSync(process.execPath, ['scripts/seed-demo-shop.mjs', '--data', f.options.data, '--images', f.root, '--shop-name', 'CLI Shop'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test', ADMIN_USERNAME: 'fixture_owner', ADMIN_PASSWORD: 'SyntheticFixtureOnly4920!', DB_PATH: join(f.root, 'cli.db') }
  });
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)), { created: 2, skipped: 0, categoriesCreated: 1, shopName: 'CLI Shop', imagesAdded: 6 });
});
