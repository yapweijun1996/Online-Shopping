import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { authenticate, createSession, ensureAdmin, readSession, revokeSessions } from '../src/auth.js';
import { changeOwnPassword, createAccount, listAccounts, resetPasswordFromHost, updateAccount } from '../src/accounts.js';
import { ready } from '../src/db.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('PostgreSQL tests require NODE_ENV=test and a disposable test database.');

test('PostgreSQL: owner bootstrap, accounts, sessions and recovery behave like SQLite', { skip: !base }, async (t) => {
  const name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: base });
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  await ensureAdmin(store, 'Pg_Owner', 'Owner-Password-2026!');
  await ensureAdmin(store, 'Pg_Owner', 'Ignored-Other-Password-1!');          // bootstrap only
  assert.equal(await ready(store), true);
  const owner = await authenticate(store, 'pg_owner', 'Owner-Password-2026!');
  assert.equal(owner.role, 'OWNER');
  assert.equal(await authenticate(store, 'pg_owner', 'Ignored-Other-Password-1!'), null);
  const staff = await createAccount(store, { username: 'Pg.Staff', role: 'STAFF', password: 'Temporary-Pass-2026!' }, 'Pg_Owner');
  await assert.rejects(createAccount(store, { username: 'pg.staff', role: 'STAFF', password: 'Temporary-Pass-2026!' }, 'Pg_Owner'), /already used/);
  const session = await createSession(store, staff.id);
  assert.equal((await readSession(store, session.token)).account.mustChangePassword, true);
  await changeOwnPassword(store, staff.id, { currentPassword: 'Temporary-Pass-2026!', newPassword: 'My-Own-Password-2026!' }, session.token);
  assert.equal((await readSession(store, session.token)).account.mustChangePassword, false);
  const other = await createSession(store, staff.id);
  await updateAccount(store, staff.id, { active: false }, 'Pg_Owner', owner.id);
  assert.equal(await readSession(store, other.token), null);
  assert.equal(await readSession(store, session.token), null);
  await updateAccount(store, staff.id, { active: true, role: 'MANAGER' }, 'Pg_Owner', owner.id);
  assert.equal((await authenticate(store, 'pg.staff', 'My-Own-Password-2026!')).role, 'MANAGER');
  assert.equal(await resetPasswordFromHost(store, 'PG_OWNER', 'Recovery-Pass-2026!'), 'Pg_Owner');
  assert.equal((await authenticate(store, 'pg_owner', 'Recovery-Pass-2026!')).mustChangePassword, true);
  const events = (await listAccounts(store)).events.map((event) => event.action).sort();
  assert.deepEqual(events, ['ACTIVATED', 'CREATED', 'DEACTIVATED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'ROLE_CHANGED']);
  await revokeSessions(store, staff.id);
});

test('PostgreSQL: the schema 22 to 23 upgrade copies the administrator in as Owner, repeatably', { skip: !base }, async (t) => {
  const name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: base });
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = '/' + name;
  t.after(async () => { await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  const fresh = await openPostgresDatabase(url.href);
  await fresh.exec('DROP TABLE account_event; DROP TABLE seller_account; ALTER TABLE session DROP COLUMN account_id');
  await fresh.run("INSERT INTO admin(id, username, password_hash, created_at) VALUES (1, 'Legacy_Owner', 'abcd:1234', ?)", '2026-10-01T00:00:00.000Z');
  await fresh.setSchemaVersion(22);
  await fresh.close();
  for (let pass = 0; pass < 2; pass++) {
    const upgraded = await openPostgresDatabase(url.href, { allowUpgrade: true });
    try {
      assert.equal(await upgraded.schemaVersion(), 24);
      assert.deepEqual((await upgraded.all('SELECT username, username_key, password_hash, role, active FROM seller_account')).map((row) => ({ ...row, active: Number(row.active) })),
        [{ username: 'Legacy_Owner', username_key: 'legacy_owner', password_hash: 'abcd:1234', role: 'OWNER', active: 1 }]);
      await upgraded.setSchemaVersion(22);   // run the upgrade a second time over the finished schema
    } finally { await upgraded.close(); }
  }
});
