import assert from 'node:assert/strict';
import test from 'node:test';
import { openTestStore } from './helpers/engine.js';
import { scopeStore, shopIdOf } from '../src/tenant.js';
import { createShop, defaultShop, listShops, renameShopCode, resolveShopCode, setShopStatus, validateShopCode } from '../src/shops.js';
import { createCategory, getCompanySettings, listCategories, updateCompanySettings } from '../src/settings.js';
import { addGalleryImage, createProduct, getProduct, getProductImage, listProducts, updateProduct } from '../src/products.js';
import { createOrder, lookupOrderStatuses } from '../src/orders.js';
import { decideSellerOrder, getSellerOrder, listSellerOrders, pendingOrderSummary } from '../src/seller-orders.js';
import { getShopSetup, resetDemo, setupShop } from '../src/shop-setup.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

async function setup(t) {
  const store = await openTestStore(t);
  const main = scopeStore(store, defaultShop(store).id);
  const other = scopeStore(store, createShop(store, { code: 'Second1', name: 'Second Shop' }).id);
  for (const shop of [main, other]) createCategory(shop, { code: 'HOME', label: 'Home' });
  return { store, main, other };
}

const product = (overrides = {}) => ({ sku: 'MUG-1', name: 'Mug', description: 'A mug', category: 'HOME', priceMinor: 1000, currency: 'MYR', active: true, ...overrides });
const checkout = (item, quantity = 1) => ({
  buyer: { fullName: 'Tenant Buyer', whatsappPhone: '+60123456789', email: null }, whatsappOrderContactOptIn: true, locale: 'en',
  deliveries: [{ recipient: { fullName: 'R', phone: '+60123456789' }, address: { line1: 'A', line2: '', city: 'KL', postcode: '50000', country: 'MY' },
    items: [{ productId: item.id, quantity, expectedPriceMinor: item.priceMinor, expectedCurrency: item.currency }] }],
});

test('shop codes are lower case letters and digits only, and reserved words are refused', () => {
  assert.equal(validateShopCode(' AcmeShop9 '), 'acmeshop9');
  for (const bad of ['ab', 'a'.repeat(31), 'my-shop', 'my shop', 'shop_1', 'café1', '', null, 'admin', 'API', 'seller']) {
    assert.throws(() => validateShopCode(bad), (error) => error.field === 'code', String(bad));
  }
});

test('an existing database becomes the default shop and a second shop starts empty', async (t) => {
  const { store, other } = await setup(t);
  assert.deepEqual(listShops(store).map((shop) => shop.code), ['main', 'second1']);
  assert.equal(defaultShop(store).code, 'main');
  assert.equal(getCompanySettings(other).defaultCurrency, 'MYR');
  assert.deepEqual(listProducts(other, new URLSearchParams()).items, []);
  assert.equal(getShopSetup(other).mode, null);
  assert.equal(getShopSetup(other).shopName, 'Second Shop');
});

test('without a shop context the plain store works for one shop and fails closed for several', async (t) => {
  const store = await openTestStore(t);
  assert.equal(shopIdOf(store), defaultShop(store).id);
  createShop(store, { code: 'other1', name: 'Other' });
  assert.throws(() => shopIdOf(store), (error) => error.code === 'SHOP_CONTEXT_REQUIRED');
  assert.throws(() => listProducts(store, new URLSearchParams()), (error) => error.code === 'SHOP_CONTEXT_REQUIRED');
  assert.throws(() => scopeStore(store, ''), TypeError);
});

test('two shops keep the same SKU, category and settings apart', async (t) => {
  const { store, main, other } = await setup(t);
  const a = createProduct(main, product());
  const b = createProduct(other, product({ name: 'Other mug', priceMinor: 2500 }));
  assert.notEqual(a.id, b.id);
  assert.deepEqual(listProducts(main, new URLSearchParams()).items.map((item) => item.name), ['Mug']);
  assert.deepEqual(listProducts(other, new URLSearchParams()).items.map((item) => item.name), ['Other mug']);
  assert.throws(() => createProduct(main, product()), (error) => error.code === 'DUPLICATE_SKU');
  // Foreign product IDs behave exactly like missing ones.
  assert.equal(getProduct(main, b.id, true), null);
  assert.equal(getProduct(other, a.id), null);
  assert.equal(getProductImage(main, b.id, true), undefined);
  assert.equal(updateProduct(main, b.id, { name: 'Hijack' }), null);
  assert.equal(getProduct(other, b.id, true).name, 'Other mug');
  assert.throws(() => addGalleryImage(main, b.id, png), (error) => error.status === 404);
  // Categories and settings are per shop; a category only exists in the shop that created it.
  createCategory(other, { code: 'TOYS', label: 'Toys' });
  assert.deepEqual(listCategories(main).map((c) => c.code), ['HOME']);
  assert.deepEqual(listCategories(other).map((c) => c.code), ['HOME', 'TOYS']);
  assert.throws(() => createProduct(main, product({ sku: 'T-1', category: 'TOYS' })), (error) => error.field === 'category');
  // The currency lock looks only at the shop's own products.
  assert.throws(() => updateCompanySettings(other, { defaultCurrency: 'SGD' }), (error) => error.code === 'COMPANY_CURRENCY_CONFLICT');
  const empty = scopeStore(store, createShop(store, { code: 'third1', name: 'Third' }).id);
  updateCompanySettings(empty, { defaultCurrency: 'SGD' });
  assert.equal(getCompanySettings(main).defaultCurrency, 'MYR');
  assert.equal(getCompanySettings(other).defaultCurrency, 'MYR');
  assert.equal(getCompanySettings(empty).defaultCurrency, 'SGD');
});

test('orders, order numbers, idempotency keys and status lookups never cross shops', async (t) => {
  const { main, other } = await setup(t);
  const a = createProduct(main, product());
  const b = createProduct(other, product({ priceMinor: 2500 }));
  const key = '11111111-1111-4111-8111-111111111111';
  const first = createOrder(main, key, checkout(a));
  const second = createOrder(other, key, checkout(b));
  // The same idempotency key is independent per shop, and each shop numbers its own orders.
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, false);
  assert.equal(first.receipt.orderNo, 'OS-00000001');
  assert.equal(second.receipt.orderNo, 'OS-00000001');
  assert.equal(createOrder(main, key, checkout(a)).replayed, true);
  // A product from another shop is unavailable at checkout.
  assert.throws(() => createOrder(main, 'bbbbbbbb-1111-4111-8111-111111111111', checkout(b)), (error) => error.code === 'PRODUCT_UNAVAILABLE');
  // Seller views see only their own shop.
  assert.equal(listSellerOrders(main, new URLSearchParams()).items.length, 1);
  assert.equal(listSellerOrders(other, new URLSearchParams()).items[0].totalMinor, 2500);
  const mainId = listSellerOrders(main, new URLSearchParams()).items[0].id;
  assert.equal(getSellerOrder(other, mainId), null);
  assert.throws(() => decideSellerOrder(other, mainId, 'confirm', { expectedRevision: 1 }, 'tester'), (error) => error.status === 404);
  assert.equal(getSellerOrder(main, mainId).status, 'SUBMITTED');
  assert.equal(pendingOrderSummary(main).pending, 1);
  assert.equal(pendingOrderSummary(other).pending, 1);
  // Status credentials work only in the shop that issued them.
  const credential = { orders: [{ orderNo: 'OS-00000001', accessKey: key }] };
  assert.equal(lookupOrderStatuses(main, credential).items.length, 1);
  assert.equal(lookupOrderStatuses(other, credential).items[0].orderNo, 'OS-00000001');
  const third = createOrder(main, '22222222-2222-4222-8222-222222222222', checkout(a));
  assert.equal(third.receipt.orderNo, 'OS-00000002');
  assert.deepEqual(lookupOrderStatuses(other, { orders: [{ orderNo: 'OS-00000002', accessKey: '22222222-2222-4222-8222-222222222222' }] }).items, []);
});

test('stock and fulfilment in one shop leave the other shop untouched', async (t) => {
  const { main, other } = await setup(t);
  const a = createProduct(main, product({ stockQuantity: 5 }));
  const b = createProduct(other, product({ stockQuantity: 5 }));
  const placed = createOrder(main, '33333333-3333-4333-8333-333333333333', checkout(a, 2));
  const id = listSellerOrders(main, new URLSearchParams()).items[0].id;
  decideSellerOrder(main, id, 'confirm', { expectedRevision: 1 }, 'tester');
  assert.equal(placed.receipt.orderNo, 'OS-00000001');
  assert.equal(getProduct(main, a.id, true).stockQuantity, 3);
  assert.equal(getProduct(other, b.id, true).stockQuantity, 5);
  decideSellerOrder(main, id, 'cancel', { expectedRevision: 2, reason: 'test' }, 'tester');
  assert.equal(getProduct(main, a.id, true).stockQuantity, 5);
  assert.equal(getProduct(other, b.id, true).stockQuantity, 5);
});

test('renaming a shop code keeps the old code as a redirect and cannot take another shop code', async (t) => {
  const { store, main, other } = await setup(t);
  assert.deepEqual(resolveShopCode(store, 'MAIN'), { shop: resolveShopCode(store, 'main').shop, redirect: false });
  const renamed = renameShopCode(store, defaultShop(store).id, 'Acme2');
  assert.equal(renamed.code, 'acme2');
  const old = resolveShopCode(store, 'main');
  assert.equal(old.redirect, true);
  assert.equal(old.shop.code, 'acme2');
  assert.equal(resolveShopCode(store, 'acme2').redirect, false);
  assert.equal(resolveShopCode(store, 'nothere'), null);
  assert.equal(resolveShopCode(store, 'bad code'), null);
  // The renamed shop keeps its data, and other shops cannot claim its old or new code.
  assert.equal(listProducts(main, new URLSearchParams()).items.length, 0);
  assert.throws(() => renameShopCode(store, other.shopId, 'main'), (error) => error.code === 'SHOP_CODE_TAKEN');
  assert.throws(() => renameShopCode(store, other.shopId, 'acme2'), (error) => error.code === 'SHOP_CODE_TAKEN');
  assert.throws(() => createShop(store, { code: 'main', name: 'Copy' }), (error) => error.code === 'SHOP_CODE_TAKEN');
  assert.throws(() => renameShopCode(store, other.shopId, 'admin'), (error) => error.field === 'code');
  // Returning to an earlier own code frees that alias.
  renameShopCode(store, defaultShop(store).id, 'main');
  assert.equal(resolveShopCode(store, 'main').redirect, false);
  assert.equal(resolveShopCode(store, 'acme2').redirect, true);
  assert.throws(() => renameShopCode(store, 'unknown-id', 'fresh1'), (error) => error.status === 404);
});

test('shops can be disabled and re-enabled', async (t) => {
  const { store, other } = await setup(t);
  assert.equal(setShopStatus(store, other.shopId, 'DISABLED').status, 'DISABLED');
  assert.equal(setShopStatus(store, other.shopId, 'ACTIVE').status, 'ACTIVE');
  assert.throws(() => setShopStatus(store, other.shopId, 'GONE'), (error) => error.field === 'status');
  assert.throws(() => setShopStatus(store, 'unknown-id', 'ACTIVE'), (error) => error.status === 404);
});

test('resetting a demo shop restores only that shop', async (t) => {
  const { main, other } = await setup(t);
  for (const shop of [main, other]) { shop.run('DELETE FROM general_code WHERE shop_id = ?', shop.shopId); }
  setupShop(main, { mode: 'demo' });
  setupShop(other, { mode: 'demo' });
  const mainProducts = listProducts(main, new URLSearchParams('limit=100')).items.length;
  assert.equal(mainProducts, 35);
  const keep = listProducts(other, new URLSearchParams('limit=1')).items[0];
  createOrder(main, '44444444-4444-4444-8444-444444444444', checkout(listProducts(main, new URLSearchParams('limit=1')).items[0]));
  createOrder(other, '55555555-5555-4555-8555-555555555555', checkout(keep));
  updateProduct(main, listProducts(main, new URLSearchParams('limit=1')).items[0].id, { name: 'Changed' });
  assert.deepEqual(resetDemo(main), { reset: true, products: 35 });
  assert.equal(listSellerOrders(main, new URLSearchParams()).items.length, 0);
  assert.equal(listSellerOrders(other, new URLSearchParams()).items.length, 1);
  assert.ok(!listProducts(main, new URLSearchParams('limit=100')).items.some((item) => item.name === 'Changed'));
  assert.equal(listProducts(other, new URLSearchParams('limit=100')).items.length, 35);
  const next = createOrder(main, '66666666-6666-4666-8666-666666666666', checkout(listProducts(main, new URLSearchParams('limit=1')).items[0]));
  assert.equal(next.receipt.orderNo, 'DEMO-00000001');
  assert.equal(getShopSetup(other).mode, 'demo');
});
