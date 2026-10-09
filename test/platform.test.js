import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { openPlatformDatabase, recordAudit } from '../src/platform/platform-db.js';
import { createTenant, tenantUrl, validateTenantInput } from '../src/platform/provisioner.js';
import { createTenantPool } from '../src/platform/tenant-pool.js';
import { normalizeTenantCode } from '../src/platform/tenant-code.js';
import { parseKeyFile, createSecretBox } from '../src/secret-box.js';
import { authenticate } from '../src/auth.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { openPostgresStore } from '../src/postgres-store.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('PostgreSQL tests require NODE_ENV=test and a disposable test database.');
const secretBox = createSecretBox(parseKeyFile(`k1=${randomBytes(32).toString('base64')}`));

test('shop codes: letters and digits only, 3 to 30, lower-cased, reserved words refused', () => {
  assert.equal(normalizeTenantCode('  MyShop1 '), 'myshop1');
  for (const bad of ['ab', 'a'.repeat(31), 'my-shop', 'my_shop', 'shop 1', '../etc', 'a/b', 'admin', 'API', 'default', 'ünï', '', null, 42]) {
    assert.throws(() => normalizeTenantCode(bad), /code|letters|reserved/i, String(bad));
  }
});

test('tenant input is validated before anything is created', () => {
  const ok = { code: 'acme', name: 'Acme', currency: 'MYR', sellerUsername: 'acme.owner' };
  assert.equal(validateTenantInput(ok).generated, true);
  assert.ok(validateTenantInput(ok).sellerPassword.length >= 20);
  for (const bad of [{ ...ok, currency: 'USD' }, { ...ok, name: '' }, { ...ok, sellerUsername: 'a b' }, { ...ok, sellerPassword: 'short' }, { ...ok, extra: 1 }, { ...ok, sellerPassword: 'acme.owner-is-in-here-123' }]) {
    assert.throws(() => validateTenantInput(bad));
  }
  assert.equal(validateTenantInput({ ...ok, sellerPassword: 'A-Chosen-Password-2026!' }).generated, false);
});

test('tenantUrl keeps the server and swaps role, password and database', () => {
  assert.equal(tenantUrl('postgres://admin:x@db.internal:5433/postgres?sslmode=disable', { role: 't_a_12345678', password: 'p-w', database: 't_a_12345678' }),
    'postgres://t_a_12345678:p-w@db.internal:5433/t_a_12345678');
});

async function environment(t) {
  const name = `shopping_test_platform_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: base });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const platform = await openPlatformDatabase(url.href);
  const pool = createTenantPool({ secretBox, baseUrl: base });
  t.after(async () => {
    const rows = await platform.all('SELECT database_name, database_role FROM tenant WHERE database_name IS NOT NULL');
    await pool.closeAll(); await platform.close();
    for (const row of rows) { await admin.query(`DROP DATABASE IF EXISTS ${row.database_name} WITH (FORCE)`); await admin.query(`DROP ROLE IF EXISTS ${row.database_role}`); }
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end();
  });
  return { platform, pool, deps: { provisionerUrl: base, baseUrl: base, secretBox } };
}

test('platform database: schema, constraints and an append-only audit trail', { skip: !base }, async (t) => {
  const { platform } = await environment(t);
  assert.equal(await platform.schemaVersion(), 1);
  await recordAudit(platform, { actor: 'root', action: 'LOGIN' });
  await assert.rejects(platform.run("UPDATE platform_audit SET actor = 'x'"), /append-only/);
  await assert.rejects(platform.run('DELETE FROM platform_audit'), /append-only/);
  await assert.rejects(platform.exec('TRUNCATE platform_audit'), /append-only/);
  await assert.rejects(recordAudit(platform, { actor: 'root', action: 'NOT_AN_ACTION' }), /check/i);
  const stamp = new Date().toISOString();
  await assert.rejects(platform.run("INSERT INTO tenant(id, code, name, status, currency, created_at, updated_at) VALUES ('x', 'abc', 'X', 'ACTIVE', 'MYR', ?, ?)", stamp, stamp), /check/i);   // needs its own database
  await assert.rejects(platform.run("INSERT INTO tenant(id, code, name, status, currency, is_default, created_at, updated_at) VALUES ('y', 'Bad-Code', 'Y', 'ACTIVE', 'MYR', 1, ?, ?)", stamp, stamp), /check/i);
});

test('createTenant builds an isolated shop with its own database, role, schema, shop and seller', { skip: !base }, async (t) => {
  const { platform, pool, deps } = await environment(t);
  const result = await createTenant(platform, deps, { code: 'Acme', name: 'Acme Store', currency: 'SGD', sellerUsername: 'acme.owner' }, 'root');
  assert.equal(result.tenant.status, 'ACTIVE');
  assert.equal(result.tenant.code, 'acme');
  assert.ok(result.sellerPassword);
  const row = await platform.get('SELECT * FROM tenant WHERE code = ?', 'acme');
  assert.ok(!JSON.stringify(row).includes(result.sellerPassword), 'the seller password is not stored on the platform');
  assert.ok(Buffer.isBuffer(row.database_password_sealed));
  assert.deepEqual((await platform.all('SELECT action FROM platform_audit ORDER BY created_at, id')).map((r) => r.action), ['TENANT_CREATE', 'TENANT_ACTIVE']);
  assert.ok(!JSON.stringify(await platform.all('SELECT * FROM platform_audit')).includes(result.sellerPassword));

  const store = await pool.get(row);
  assert.equal((await store.get('SELECT shop_name, mode FROM shop_setup WHERE id = 1')).mode, 'production');
  assert.equal((await store.get('SELECT default_currency FROM company_setting WHERE id = 1')).default_currency, 'SGD');
  const seller = await authenticate(store, 'acme.owner', result.sellerPassword);
  assert.equal(seller.role, 'OWNER');
  assert.equal(seller.mustChangePassword, true);
  assert.equal(await pool.get(row), store, 'the same open store is reused');
  // A second shop is a separate database: the same SKU can exist in both.
  const other = await createTenant(platform, deps, { code: 'beta', name: 'Beta', currency: 'MYR', sellerUsername: 'beta.owner', sellerPassword: 'Beta-Owner-Pass-2026!' }, 'root');
  assert.equal(other.sellerPassword, undefined);
  const otherRow = await platform.get('SELECT * FROM tenant WHERE code = ?', 'beta');
  const otherStore = await pool.get(otherRow);
  for (const [shop, currency] of [[store, 'SGD'], [otherStore, 'MYR']]) {
    await createCategory(shop, { code: 'GEN', label: 'General' });
    await createProduct(shop, { sku: 'SAME-SKU', name: 'Item', description: 'Fictional', category: 'GEN', priceMinor: 500, active: true });
    assert.equal((await shop.get('SELECT currency FROM product')).currency, currency);
    assert.equal((await shop.get('SELECT COUNT(*) AS n FROM product')).n, 1);
  }
  assert.equal(await authenticate(otherStore, 'acme.owner', result.sellerPassword), null, 'a seller of one shop is unknown in the other');
  // The shop's role cannot open another shop's database.
  const password = secretBox.open(row.database_password_sealed, row.database_key_id, `TENANT_DB:${row.id}`);
  const intruder = openPostgresStore(tenantUrl(base, { role: row.database_role, password, database: otherRow.database_name }), { max: 1 });
  await assert.rejects(intruder.get('SELECT 1 AS ok'), /permission denied|not permitted|CONNECT/i);
  await intruder.close();
  // Codes are unique, also against reserved words.
  await assert.rejects(createTenant(platform, deps, { code: 'acme', name: 'Again', currency: 'MYR', sellerUsername: 'x.owner' }, 'root'), /already used/);
  await assert.rejects(createTenant(platform, deps, { code: 'admin', name: 'Nope', currency: 'MYR', sellerUsername: 'x.owner' }, 'root'), /reserved/);
});

test('a shop that failed half-way is marked FAILED, leaks no secret, and a retry cleans up and succeeds', { skip: !base }, async (t) => {
  const { platform, pool, deps } = await environment(t);
  // A provisioner that cannot reach the server fails before anything exists.
  await assert.rejects(createTenant(platform, { ...deps, provisionerUrl: 'postgres://nobody:wrong@127.0.0.1:1/postgres' }, { code: 'flaky', name: 'Flaky', currency: 'MYR', sellerUsername: 'flaky.owner' }, 'root'));
  let row = await platform.get("SELECT * FROM tenant WHERE code = 'flaky'");
  assert.equal(row.status, 'FAILED');
  assert.ok(row.last_error && row.last_error.length <= 60, 'only a short error code is kept');
  assert.ok(!row.last_error.includes('wrong'));
  // A leftover database from a crashed attempt is removed by the retry.
  const admin = new pg.Pool({ connectionString: base });
  await admin.query(`CREATE ROLE ${row.database_role} LOGIN`); await admin.query(`CREATE DATABASE ${row.database_name} OWNER ${row.database_role}`);
  const retried = await createTenant(platform, deps, { code: 'flaky', name: 'Flaky Shop', currency: 'MYR', sellerUsername: 'flaky.owner' }, 'root');
  await admin.end();
  assert.equal(retried.tenant.status, 'ACTIVE');
  assert.equal(retried.tenant.id, row.id, 'the retry reuses the same tenant');
  row = await platform.get("SELECT * FROM tenant WHERE code = 'flaky'");
  assert.equal((await (await pool.get(row)).get('SELECT shop_name FROM shop_setup WHERE id = 1')).shop_name, 'Flaky Shop');
  assert.ok((await platform.all('SELECT action FROM platform_audit')).some((r) => r.action === 'TENANT_CLEANUP'));
});

test('the tenant pool is bounded, closes idle shops and refuses a shop with an unexpected schema', { skip: !base }, async (t) => {
  const { platform, deps } = await environment(t);
  let clock = 1_000_000;
  const pool = createTenantPool({ secretBox, baseUrl: base, maxOpen: 2, idleMs: 60_000, clock: () => clock });
  t.after(() => pool.closeAll());
  const rows = [];
  for (const code of ['pool1', 'pool2', 'pool3']) {
    await createTenant(platform, deps, { code, name: code, currency: 'MYR', sellerUsername: `${code}.owner` }, 'root');
    rows.push(await platform.get('SELECT * FROM tenant WHERE code = ?', code));
  }
  await pool.get(rows[0]); clock += 10; await pool.get(rows[1]);
  assert.equal(pool.size(), 2);
  clock += 10; await pool.get(rows[2]);            // the least recently used shop is closed to make room
  assert.equal(pool.size(), 2);
  clock += 120_000; await pool.get(rows[0]);       // idle shops are closed
  assert.equal(pool.size(), 1);
  await pool.release(rows[0].id);
  assert.equal(pool.size(), 0);
  // A shop at another schema version is not served.
  const admin = new pg.Pool({ connectionString: tenantUrl(base, { role: 'postgres', password: '', database: rows[1].database_name }).replace(':@', '@') });
  await admin.query('UPDATE schema_meta SET version = 1');
  await admin.end();
  await assert.rejects(pool.get(rows[1]), /Unsupported database schema version/);
  assert.equal(pool.size(), 0, 'a refused shop is not kept open');
});
