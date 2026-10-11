import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { authenticate, createSession, ensureAdmin, readSession } from '../src/auth.js';
import { changeOwnPassword, resetPasswordFromHost } from '../src/accounts.js';
import { createApi } from '../src/app.js';
import { createCategory } from '../src/settings.js';
import { createProduct, getProduct, updateProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { decideSellerOrder } from '../src/seller-orders.js';

const base = process.env.SHOP_TEST_DATABASE_URL;
if (base && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname))) throw new Error('Use a disposable PostgreSQL test database.');
const username = 'fixture_owner', password = 'Initial-Fixture-Password-1!', recovery = 'Recovery-Fixture-Password-2!';

async function database(t, dialect) {
  if (dialect === 'sqlite') {
    const store = await openDatabase(':memory:');
    t.after(() => store.close());
    return store;
  }
  const name = `shopping_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: base });
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = `/${name}`;
  const store = await openPostgresDatabase(url.href);
  t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  return store;
}

// Hold the credential snapshot while recovery runs independently. Fixed code serializes recovery behind verification.
function holdRead(store, matches) {
  const get = store.get;
  let reached, release;
  const entered = new Promise(resolve => { reached = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  store.get = async (sql, ...params) => {
    const row = await get(sql, ...params);
    if (matches(sql)) { store.get = get; reached(); await wait; }
    return row;
  };
  return { entered, release: () => { store.get = get; release(); } };
}

async function allowRecoveryToRun(recover, gate) {
  const resetting = recover();
  // Waiting for completion alone would deadlock when the credential transaction correctly owns the writer lock.
  await Promise.race([resetting, new Promise(resolve => setTimeout(resolve, 100))]);
  gate.release();
  await resetting;
}

const orderInput = product => ({ buyer: { fullName: 'Synthetic Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true,
  deliveries: [{ recipient: { fullName: 'Synthetic Recipient', phone: '+6581234567' },
    address: { line1: 'Synthetic Street', postcode: '123456', country: 'SG' },
    items: [{ productId: product.id, quantity: 1, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency }] }] });

for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !base, timeout: 15_000 };
  test(`${dialect}: an overlapping own password change cannot undo host recovery`, options, async t => {
    const store = await database(t, dialect);
    await ensureAdmin(store, username, password);
    const account = await authenticate(store, username, password);
    const session = await createSession(store, account.id);
    const gate = holdRead(store, sql => sql.startsWith('SELECT username, password_hash FROM seller_account'));
    const changing = changeOwnPassword(store, account.id, { currentPassword: password, newPassword: 'Self-Fixture-Password-3!' }, session.token);
    try {
      await gate.entered;
      await allowRecoveryToRun(() => resetPasswordFromHost(store, username, recovery), gate);
      await changing;
      assert.equal(await authenticate(store, username, 'Self-Fixture-Password-3!'), null);
      assert.equal((await authenticate(store, username, recovery)).mustChangePassword, true);
      assert.equal(await readSession(store, session.token), null);
      await assert.rejects(changeOwnPassword(store, account.id, { currentPassword: recovery, newPassword: 'Stolen-Fixture-Password-4!' }, session.token), error => error.code === 'UNAUTHORIZED');
    } finally { gate.release(); await changing.catch(() => {}); }
  });

  test(`${dialect}: login cannot issue a surviving session from a credential snapshot preceding recovery`, options, async t => {
    const store = await database(t, dialect);
    await ensureAdmin(store, username, password);
    const handle = await createApi({ store, config: { production: false } });
    await handle(new Request('https://fixture.test/health'));
    const gate = holdRead(store, sql => sql.startsWith('SELECT id, username, role, password_hash'));
    const signingIn = handle(new Request('https://fixture.test/api/v1/seller/session', { method: 'POST',
      headers: { origin: 'https://fixture.test', 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }));
    try {
      await gate.entered;
      await allowRecoveryToRun(() => resetPasswordFromHost(store, username, recovery), gate);
      const response = await signingIn;
      assert.equal(response.status, 200);
      const token = /seller_session=([^;]+)/.exec(response.headers.get('set-cookie'))[1];
      assert.equal(await readSession(store, token), null);
      assert.equal((await store.get('SELECT COUNT(*) AS n FROM session')).n, 0);
      assert.equal(await authenticate(store, username, password), null);
    } finally { gate.release(); await signingIn; }
  });

  test(`${dialect}: confirmation and cancellation invalidate stale product drafts`, options, async t => {
    const store = await database(t, dialect);
    await createCategory(store, { code: 'FIXTURE', label: 'Fixture' });
    const draft = await createProduct(store, { sku: 'TRACKED', name: 'Fixture', description: 'Synthetic fixture', category: 'FIXTURE', priceMinor: 100, stockQuantity: 5, active: true });
    const { receipt } = await createOrder(store, randomUUID(), orderInput(draft));
    const { id } = await store.get('SELECT id FROM shop_order WHERE order_no = ?', receipt.orderNo);
    await decideSellerOrder(store, id, 'confirm', { expectedRevision: 1 }, username);
    const confirmed = await getProduct(store, draft.id, true);
    assert.equal(confirmed.stockQuantity, 4);
    assert.ok(confirmed.updatedAt > draft.updatedAt);
    await assert.rejects(updateProduct(store, draft.id, { stockQuantity: 5, expectedUpdatedAt: draft.updatedAt }), error => error.code === 'PRODUCT_CHANGED');
    await assert.rejects(updateProduct(store, draft.id, { name: 'Stale metadata', expectedUpdatedAt: draft.updatedAt }), error => error.code === 'PRODUCT_CHANGED');
    await decideSellerOrder(store, id, 'cancel', { expectedRevision: 2, reason: 'Synthetic cancellation' }, username);
    const cancelled = await getProduct(store, draft.id, true);
    assert.equal(cancelled.stockQuantity, 5);
    assert.ok(cancelled.updatedAt > confirmed.updatedAt);
    await assert.rejects(updateProduct(store, draft.id, { stockQuantity: 4, expectedUpdatedAt: confirmed.updatedAt }), error => error.code === 'PRODUCT_CHANGED');
    assert.equal((await updateProduct(store, draft.id, { name: 'Fresh metadata', expectedUpdatedAt: cancelled.updatedAt })).stockQuantity, 5);
  });

  test(`${dialect}: a shared-gallery sibling still validates its stock revision`, options, async t => {
    const store = await database(t, dialect);
    await createCategory(store, { code: 'FIXTURE', label: 'Fixture' });
    const input = { name: 'Fixture', description: 'Synthetic fixture', category: 'FIXTURE', priceMinor: 100, stockQuantity: 5, active: true, variantGroup: 'FIXTURE_GROUP' };
    await createProduct(store, { ...input, sku: 'HOLDER', variantLabel: 'A' });
    const sibling = await createProduct(store, { ...input, sku: 'SIBLING', variantLabel: 'B' });
    await createOrder(store, randomUUID(), orderInput(sibling));
    const { id } = await store.get('SELECT id FROM shop_order');
    await decideSellerOrder(store, id, 'confirm', { expectedRevision: 1 }, username);
    await assert.rejects(updateProduct(store, sibling.id, { stockQuantity: 5, gallery: [], expectedUpdatedAt: sibling.updatedAt }), error => error.code === 'PRODUCT_CHANGED');
    const current = await getProduct(store, sibling.id, true);
    assert.equal((await updateProduct(store, sibling.id, { stockQuantity: 3, gallery: [], expectedUpdatedAt: current.updatedAt })).stockQuantity, 3);
  });

  for (const stock of [null, 5]) test(`${dialect}: a confirmed ${stock === null ? 'unlimited' : 'tracked'} order blocks tracking changes until cancellation`, options, async t => {
    const store = await database(t, dialect);
    await createCategory(store, { code: 'FIXTURE', label: 'Fixture' });
    const product = await createProduct(store, { sku: 'STOCK', name: 'Fixture', description: 'Synthetic fixture', category: 'FIXTURE', priceMinor: 100, stockQuantity: stock, active: true });
    await createOrder(store, randomUUID(), orderInput(product));
    const { id } = await store.get('SELECT id FROM shop_order');
    await decideSellerOrder(store, id, 'confirm', { expectedRevision: 1 }, username);
    await assert.rejects(updateProduct(store, product.id, { stockQuantity: stock === null ? 10 : null, name: 'Must roll back' }), error => error.code === 'STOCK_TRACKING_CONFLICT');
    assert.equal((await getProduct(store, product.id, true)).name, 'Fixture');
    assert.equal((await getProduct(store, product.id, true)).stockQuantity, stock === null ? null : 4);
    await decideSellerOrder(store, id, 'cancel', { expectedRevision: 2, reason: 'Synthetic cancellation' }, username);
    assert.equal((await getProduct(store, product.id, true)).stockQuantity, stock);
    assert.equal((await updateProduct(store, product.id, { stockQuantity: stock === null ? 10 : null })).stockQuantity, stock === null ? 10 : null);
  });
}
