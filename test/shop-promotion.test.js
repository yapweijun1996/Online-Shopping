import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { planShopPromotion, applyShopPromotion } from '../src/shop-promotion.js';
import { runShopPromotion, parsePromotionArguments } from '../src/shop-promotion-runner.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { trackCreate } from '../src/product-history.js';
import { createOrder } from '../src/orders.js';

const config = { production: true, shopMode: 'manual', sellerQuickLogin: false,
  publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test', dbPath: '/synthetic/shop.db' };
const input = { expectedMode: 'demo', expectedName: 'Demo General Store', shopName: 'Synthetic Live Store' };
async function fixture(t, dialect) {
  const f = await reviewFixture(t, dialect);
  await f.seedGrant();
  await f.store.run('UPDATE shop_setup SET mode = ?, shop_name = ? WHERE id = 1', 'demo', 'Demo General Store');
  await createCategory(f.store, { code: 'SYNTHETIC', label: 'Synthetic' });
  const product = await trackCreate(f.store, 'synthetic_owner', () => createProduct(f.store, { sku: 'DEMO-001', name: 'Synthetic product', description: 'Fictional', category: 'SYNTHETIC', priceMinor: 456,
    currency: 'MYR', active: true, stockQuantity: 7 }));
  await createProduct(f.store, { sku: 'DEMO-002', name: 'Inactive synthetic', description: 'Fictional inactive product', category: 'SYNTHETIC', priceMinor: 123,
    currency: 'MYR', active: false });
  await createOrder(f.store, 'synthetic-promotion-checkout-0001', {
    buyer: { fullName: 'Synthetic Buyer', whatsappPhone: '+65 8123 4567', email: null }, whatsappOrderContactOptIn: true, locale: 'en',
    deliveries: [{ recipient: { fullName: 'Synthetic Recipient', phone: '+60 12-345 6789' },
      address: { line1: 'Fictional Street 1', postcode: '47810', country: 'MY' },
      items: [{ productId: product.id, quantity: 2, expectedPriceMinor: 456, expectedCurrency: 'MYR' }] }],
  });
  return f;
}
async function businessSnapshot(store) {
  const tables = ['seller_account', 'account_event', 'session', 'product', 'listing', 'general_code', 'product_event', 'product_gallery_image',
    'shop_order', 'order_event', 'order_item', 'delivery', 'checkout_idempotency', 'inventory_movement', 'inventory_state', 'inventory_coverage', 'company_setting',
    'oauth_grant', 'oauth_token', 'oauth_client', 'mcp_v2_scope_consent', 'mcp_v2_operation'];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table,
    (await store.all(`SELECT * FROM ${table}`)).map(row => JSON.stringify(row)).sort()])));
}
for (const dialect of ['sqlite', 'postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL };
  test(`${dialect}: plan is read-only; exact promotion preserves catalog, stock, accounts, grants and history; retry is idempotent`, options, async t => {
    const f = await fixture(t, dialect), before = await businessSnapshot(f.store);
    const plan = await planShopPromotion(f.store, config, input);
    assert.ok(before.shop_order.length && before.order_event.length && before.product_event.length);
    assert.equal((await f.store.get('SELECT mode FROM shop_setup WHERE id=1')).mode, 'demo');
    assert.deepEqual(await businessSnapshot(f.store), before);
    const results = await Promise.all([applyShopPromotion(f.store, config, plan, plan.planHash), applyShopPromotion(f.store, config, plan, plan.planHash)]);
    assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
    assert.deepEqual({ ...await f.store.get('SELECT mode,shop_name FROM shop_setup WHERE id=1') }, { mode: 'production', shop_name: 'Synthetic Live Store' });
    assert.deepEqual(await businessSnapshot(f.store), before);
    assert.equal((await f.call('/api/v1/seller/setup', 'POST', { mode: 'demo' }, f.headers)).response.status, 409);
    assert.deepEqual(await businessSnapshot(f.store), before);
  });
  test(`${dialect}: wrong deployment, target, schema, expected setup and changed/tampered plan fail closed`, options, async t => {
    const f = await fixture(t, dialect), before = await businessSnapshot(f.store);
    for (const patch of [{ production: false }, { shopMode: 'demo' }, { shopMode: 'public-demo' }, { sellerQuickLogin: true },
      { sellerQuickLogin: undefined }, { publicOrigin: 'http://shop.example.test' }]) {
      await assert.rejects(planShopPromotion(f.store, { ...config, ...patch }, input));
    }
    await assert.rejects(planShopPromotion(f.store, config, { ...input, expectedName: 'Preview General Store' }));
    await assert.rejects(planShopPromotion(f.store, config, { ...input, shopName: 'Preview Store' }));
    const plan = await planShopPromotion(f.store, config, input);
    await assert.rejects(applyShopPromotion(f.store, { ...config, dbPath: '/synthetic/other.db' }, plan, plan.planHash));
    await assert.rejects(applyShopPromotion(f.store, config, plan, '0'.repeat(64)));
    await assert.rejects(applyShopPromotion(f.store, config, { ...plan, after: { ...plan.after, shopName: 'Tampered Store' } }, plan.planHash));
    await assert.rejects(planShopPromotion({ ...f.store, schemaVersion: async () => 1 }, config, input));
    await f.store.run('UPDATE shop_setup SET shop_name=? WHERE id=1', 'Changed while planning');
    await assert.rejects(applyShopPromotion(f.store, config, plan, plan.planHash));
    assert.deepEqual(await businessSnapshot(f.store), before);
  });
  test(`${dialect}: failed configuration write rolls back and a private PREPARED journal supports exact retry`, options, async t => {
    const f = await fixture(t, dialect), plan = await planShopPromotion(f.store, config, input);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'shop-promotion-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const planFile = path.join(dir, 'plan.json'), receipt = path.join(dir, 'receipt.json');
    await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
    const invocation = parsePromotionArguments(['apply', '--plan-file=' + planFile, '--receipt=' + receipt,
      '--approve=' + plan.planHash, '--backup-reference=synthetic-backup-verified', '--writers-stopped=yes']);
    const store = { ...f.store, close: async () => {} };
    const bad = { ...store, run: async (...args) => { await f.store.run(...args); throw new Error('Injected failure after configuration write'); } };
    await assert.rejects(runShopPromotion({ config, ...invocation }, { openStore: async () => bad }));
    assert.equal((await f.store.get('SELECT mode FROM shop_setup WHERE id=1')).mode, 'demo');
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).status, 'PREPARED');
    assert.equal((await runShopPromotion({ config, ...invocation }, { openStore: async () => store })).replayed, false);
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).status, 'APPLIED');
    assert.equal((await runShopPromotion({ config, ...invocation }, { openStore: async () => store })).replayed, true);
    await chmod(planFile, 0o644);
    await assert.rejects(runShopPromotion({ config, ...invocation }, { openStore: async () => store }));
    await chmod(planFile, 0o600);
    const bypass = { ...invocation, options: { ...invocation.options, receipt: dir + '/../' + path.basename(dir) + '/other.json' } };
    await assert.rejects(runShopPromotion({ config, ...bypass }, { openStore: async () => store }));
  });
  test(`${dialect}: lost commit acknowledgment leaves a recoverable journal and exact retry does not repeat the change`, options, async t => {
    const f = await fixture(t, dialect), before = await businessSnapshot(f.store);
    const plan = await planShopPromotion(f.store, config, input);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'shop-promotion-recovery-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const planFile = path.join(dir, 'plan.json'), receipt = path.join(dir, 'receipt.json');
    await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
    const invocation = parsePromotionArguments(['apply', '--plan-file=' + planFile, '--receipt=' + receipt,
      '--approve=' + plan.planHash, '--backup-reference=synthetic-backup-verified', '--writers-stopped=yes']);
    const store = { ...f.store, close: async () => {} };
    const uncertain = { ...store, transaction: async work => { await f.store.transaction(work); throw new Error('Synthetic lost commit acknowledgment'); } };
    await assert.rejects(runShopPromotion({ config, ...invocation }, { openStore: async () => uncertain }));
    assert.equal((await f.store.get('SELECT mode FROM shop_setup WHERE id=1')).mode, 'production');
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).status, 'PREPARED');
    const recovered = await runShopPromotion({ config, ...invocation }, { openStore: async () => store });
    assert.equal(recovered.replayed, true);
    assert.deepEqual(await businessSnapshot(f.store), before);
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).status, 'APPLIED');
  });
}
test('promotion CLI rejects ambiguous or incomplete invocations', () => {
  for (const args of [[], ['apply'], ['plan', '--expected-mode=demo'], ['apply', '--writers-stopped=no'],
    ['plan', '--expected-mode=demo', '--expected-name=Old', '--shop-name=New', '--shop-name=Duplicate']]) {
    assert.throws(() => parsePromotionArguments(args));
  }
});
