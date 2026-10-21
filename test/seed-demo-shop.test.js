import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { getProduct } from '../src/products.js';
import { seedDemoShop } from '../scripts/seed-demo-shop.mjs';
import { exactScenario } from './seed-demo-scenario.js';
import { createCategory } from '../src/settings.js';
import { validateSeedJpeg, readSeedFile } from '../scripts/seed-image-input.mjs';

const jpeg = await readFile(new URL('../public/demo-assets/DEMO-035/view-6-aa74175f5b43-160.jpg', import.meta.url));
// Legal COM segments distinguish views without corrupting the JPEG.
const viewJpeg = n => Buffer.concat([jpeg.subarray(0, 2), Buffer.from([255, 254, 0, 3, n]), jpeg.subarray(2)]);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'seed-shop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const products = [1, 2].map(n => ({ sku: `TEST-${n}`, name: `Synthetic ${n}`, category: 'Test Goods', description: 'Synthetic fixture', priceMinor: n * 500, stock: n * 3, currency: 'MYR' }));
  for (const p of products) {
    await mkdir(join(root, p.sku));
    for (let n = 1; n <= 3; n++) {
      await writeFile(join(root, p.sku, `view-${n}.jpg`), viewJpeg(n));
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
    for (const bad of [Buffer.from('not jpeg'), Buffer.from('ffd8ff010203', 'hex'), jpeg.subarray(0, -2), Buffer.concat([jpeg, Buffer.from([0])]), Buffer.alloc(512 * 1024 + 1, 255)]) {
      await writeFile(join(f.root, 'TEST-2/view-3.jpg'), bad);
      await assert.rejects(seedDemoShop(store, { ...f.options, shopName: 'Must not persist' }, quiet), /TEST-2 view-3: invalid JPEG/);
      assert.deepEqual(await snapshot(), before);
    }
    await writeFile(join(f.root, 'TEST-2/view-3.jpg'), viewJpeg(3));
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
    // A separate initialized shop mirrors the production catalog and orders.
    const exact = await fixture(t);
    let exactStore;
    if (backend === 'sqlite') exactStore = await openDatabase(join(exact.root, 'exact.db'));
    else {
      const pool = new pg.Pool({ connectionString: process.env.SHOP_TEST_DATABASE_URL });
      const name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`CREATE DATABASE ${name}`);
      const url = new URL(process.env.SHOP_TEST_DATABASE_URL); url.pathname = `/${name}`;
      t.after(async () => { await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
      exactStore = await openPostgresDatabase(url.href);
    }
    t.after(() => exactStore.close());
    await exactScenario(exactStore, exact, viewJpeg);
  });
}
test('CLI uses readConfig SQLite environment and emits summary JSON', async t => {
  const f = await fixture(t);
  const output = execFileSync(process.execPath, ['scripts/seed-demo-shop.mjs', '--data', f.options.data, '--images', f.root, '--shop-name', 'CLI Shop'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test', ADMIN_USERNAME: 'fixture_owner', ADMIN_PASSWORD: 'SyntheticFixtureOnly4920!', DB_PATH: join(f.root, 'cli.db') }
  });
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)), { created: 2, skipped: 0, categoriesCreated: 1, shopName: 'CLI Shop', imagesAdded: 6 });
});

test('preflight rejects unsafe files, duplicate views and invalid previews before writes', async t => {
  const f = await fixture(t);
  const store = await openDatabase(join(f.root, 'unsafe.db'));
  t.after(() => store.close());
  const image = join(f.root, 'TEST-1/view-2.jpg');
  await writeFile(image, viewJpeg(1));
  await assert.rejects(seedDemoShop(store, f.options, quiet), /duplicate image/);
  await rm(image);
  const outside = await mkdtemp(join(tmpdir(), 'seed-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'photo.jpg'), jpeg);
  await symlink(join(outside, 'photo.jpg'), image);
  await assert.rejects(seedDemoShop(store, f.options, quiet), /contained regular file/);
  await rm(image);
  execFileSync('mkfifo', [image]);
  await assert.rejects(seedDemoShop(store, f.options, quiet), /contained regular file/);
  await rm(image);
  await writeFile(image, viewJpeg(2));
  await writeFile(join(f.root, 'TEST-1/view-1.thumb.jpg'), jpeg.subarray(0, -2));
  await assert.rejects(seedDemoShop(store, f.options, quiet), /view-1.thumb: invalid JPEG/);
  await rm(join(f.root, 'TEST-1'), { recursive: true });
  await symlink(outside, join(f.root, 'TEST-1'));
  await writeFile(join(outside, 'view-1.jpg'), jpeg);
  await assert.rejects(seedDemoShop(store, f.options, quiet), /contained regular file/);
  await assert.rejects(readSeedFile(f.root, 1024), /regular file/);
  await writeFile(join(f.root, 'large.json'), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(readSeedFile(join(f.root, 'large.json'), 1024 * 1024), /bounded regular/);
  await symlink(join(outside, 'photo.jpg'), join(f.root, 'data-link'));
  await assert.rejects(readSeedFile(join(f.root, 'data-link'), 1024), /regular file/);
  execFileSync('mkfifo', [join(f.root, 'data-fifo')]);
  await assert.rejects(readSeedFile(join(f.root, 'data-fifo'), 1024), /regular file/);
  assert.deepEqual(await store.all('SELECT * FROM product'), []);
});

test('JPEG frame dimensions are bounded', () => {
  validateSeedJpeg(jpeg);
  const oversized = Buffer.from(jpeg);
  const sof = oversized.indexOf(Buffer.from([255, 192]));
  assert.ok(sof >= 0);
  oversized.writeUInt16BE(4097, sof + 5);
  assert.throws(() => validateSeedJpeg(oversized), /Invalid JPEG/);
  oversized.writeUInt16BE(4096, sof + 5);
  oversized.writeUInt16BE(4096, sof + 7);
  assert.throws(() => validateSeedJpeg(oversized), /Invalid JPEG/);
});

test('category labels reuse custom codes and casing without edits', async t => {
  const f = await fixture(t);
  const store = await openDatabase(join(f.root, 'category.db'));
  t.after(() => store.close());
  await createCategory(store, { code: 'CUSTOM_GOODS', label: 'TEST GOODS' });
  const before = await store.all('SELECT * FROM general_code');
  assert.equal((await seedDemoShop(store, f.options, quiet)).categoriesCreated, 0);
  assert.deepEqual(await store.all('SELECT * FROM general_code'), before);
  assert.deepEqual((await store.all('SELECT category FROM product')).map(row => row.category), ['CUSTOM_GOODS', 'CUSTOM_GOODS']);
});

test('category code collisions fail before catalog or name writes', async t => {
  const f = await fixture(t);
  const store = await openDatabase(join(f.root, 'conflict.db'));
  t.after(() => store.close());
  await createCategory(store, { code: 'TEST-GOODS', label: 'Different label' });
  const before = await store.all('SELECT * FROM shop_setup');
  await assert.rejects(seedDemoShop(store, { ...f.options, shopName: 'Must not persist' }, quiet), /Category conflict/);
  assert.deepEqual(await store.all('SELECT * FROM product'), []);
  assert.deepEqual(await store.all('SELECT * FROM shop_setup'), before);
});
