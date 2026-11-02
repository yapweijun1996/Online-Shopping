import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupShop } from '../src/shop-setup.js';
import { createOrder } from '../src/orders.js';
import { getProduct } from '../src/products.js';
import { seedDemoShop } from '../scripts/seed-demo-shop.mjs';

export async function exactScenario(store, f, viewJpeg) {
  await setupShop(store, { mode: 'demo' });
  await store.run("UPDATE shop_setup SET mode = 'production', shop_name = 'Existing shop' WHERE id = 1");
  await store.run("UPDATE company_setting SET shipping_text = 'Existing shipping terms' WHERE id = 1");
  const existing = await store.all('SELECT * FROM product ORDER BY sku');
  assert.equal(existing.length, 35);
  for (let n = 0; n < 2; n++) await createOrder(store, `seed-existing-order-${n}`, {
    buyer: { fullName: 'Fictional Buyer', whatsappPhone: '+60123456789', email: 'fictional@example.invalid' },
    whatsappOrderContactOptIn: true, locale: 'en',
    deliveries: [{ recipient: { fullName: 'Fictional Recipient', phone: '+60129876543' },
      address: { line1: 'Synthetic Street', postcode: '47810', country: 'MY' },
      items: [{ productId: existing[n].id, quantity: 1, expectedPriceMinor: existing[n].price_minor, expectedCurrency: 'MYR' }] }]
  });
  const source = JSON.parse(await readFile(new URL('./seed-demo-products.json', import.meta.url), 'utf8'));
  for (const p of source.products) {
    await mkdir(join(f.root, p.sku));
    for (let n = 1; n <= 3; n++) await writeFile(join(f.root, p.sku, `view-${n}.jpg`), viewJpeg(n));
  }
  await writeFile(f.options.data, JSON.stringify(source));
  const snapshot = async () => {
    const rows = {};
    for (const table of ['product', 'general_code', 'shop_order', 'order_event', 'order_item', 'delivery', 'company_setting', 'shop_setup', 'product_event']) {
      const values = await store.all(`SELECT * FROM ${table}`);
      rows[table] = values.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
        [key, value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value])));
      rows[table].sort((a, b) => String(a.id ?? a.code).localeCompare(String(b.id ?? b.code)));
    }
    return rows;
  };
  const before = await snapshot();
  const options = { ...f.options, shopName: 'Demo Mart Malaysia' };
  const expected = { created: 14, skipped: 0, categoriesCreated: 2, shopName: 'Demo Mart Malaysia', imagesAdded: 42 };
  assert.deepEqual(await seedDemoShop(store, { ...options, dryRun: true }, () => {}), expected);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await seedDemoShop(store, options, () => {}), expected);
  const after = await snapshot();
  for (const table of ['product', 'general_code', 'shop_order', 'order_event', 'order_item', 'delivery', 'company_setting', 'product_event']) {
    const persisted = new Set(after[table].map(value => JSON.stringify(value)));
    for (const row of before[table]) assert.ok(persisted.has(JSON.stringify(row)), `Preserved ${table}`);
  }
  assert.deepEqual(after.shop_setup, before.shop_setup.map(row => ({ ...row, shop_name: 'Demo Mart Malaysia' })));
  assert.equal(after.product.length, 49);
  assert.equal(after.general_code.length - before.general_code.length, 2);
  assert.equal(after.shop_order.length, 2);
  for (const p of source.products) {
    const row = after.product.find(row => row.sku === p.sku);
    const product = await getProduct(store, row.id, true);
    assert.equal(product.images.length, 3);
    assert.equal(product.category, p.category);
    assert.equal(product.stockQuantity, p.stock);
    assert.equal(product.priceMinor, p.priceMinor);
    assert.equal(product.currency, 'MYR');
    assert.equal(product.active, true);
    assert.equal(after.product_event.filter(event => event.product_id === row.id && event.actor === 'seed-demo-shop').length, 1);
  }
  assert.deepEqual(await seedDemoShop(store, options, () => {}), { ...expected, created: 0, skipped: 14, categoriesCreated: 0, imagesAdded: 0 });
  assert.deepEqual(await snapshot(), after);
}
