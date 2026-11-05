import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../../src/db.js';
import { openPostgresDatabase } from '../../src/postgres-db.js';
import { createCategory } from '../../src/settings.js';
import { createProduct } from '../../src/products.js';
import { createOrder } from '../../src/orders.js';
import { ensureAdmin } from '../../src/auth.js';
export async function inventoryFixture(t, dialect, { seed = true } = {}) {
  let store, location;
  if (dialect === 'sqlite') { store = await openDatabase(':memory:'); t.after(() => store.close()); }
  else {
    const base = process.env.SHOP_TEST_DATABASE_URL;
    if (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(base).pathname)) throw new Error('Disposable PostgreSQL required.');
    const pool = new pg.Pool({ connectionString: base }), name = 'shopping_test_inventory_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE DATABASE ${name}`); const url = new URL(base); url.pathname = '/' + name; location = url.href;
    try { store = await openPostgresDatabase(location); } catch (error) { await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); throw error; }
    t.after(async () => { await store.close(); await pool.query(`DROP DATABASE ${name} WITH (FORCE)`); await pool.end(); });
  }
  if (seed) { await ensureAdmin(store, 'synthetic_owner', 'SyntheticInventoryPassword123!'); await createCategory(store, { code: 'TEST', label: 'Synthetic' }); }
  let seq = 0;
  const product = (extra = {}) => createProduct(store, { sku: 'SYN-' + ++seq, name: 'Synthetic stock item', description: 'Synthetic', category: 'TEST', priceMinor: 500, active: true, ...extra });
  const order = async (products, quantity = 1, deliveries = 1) => { const created = await createOrder(store, 'synthetic-stock-' + randomUUID(), { buyer: { fullName: 'Synthetic Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true,
    deliveries: Array.from({ length: deliveries }, () => ({ recipient: { fullName: 'Synthetic Recipient', phone: '+60123456789' }, address: { line1: 'Synthetic Street', postcode: '50000', country: 'MY' },
      items: products.map(p => ({ productId: p.id, quantity, expectedPriceMinor: p.priceMinor, expectedCurrency: p.currency })) })) });
    return store.get('SELECT id,status,revision FROM shop_order WHERE order_no=?',created.receipt.orderNo);
  };
  return { store, location, product, order };
}
export const legacyInventoryDropSql = 'DROP TABLE IF EXISTS inventory_movement; DROP TABLE IF EXISTS inventory_state; DROP TABLE IF EXISTS inventory_coverage; DROP TABLE IF EXISTS inventory_schema;';
export const dropInventoryForLegacyFixture = store => store.exec(legacyInventoryDropSql);
