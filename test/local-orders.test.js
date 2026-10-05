import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalOrderStore, ORDER_RETENTION_MS, ORDER_CLOCK_SKEW_MS, safeOrderImage } from '../public/shop/local-orders.js';

const submittedAt = '2026-09-29T00:00:00.000Z';
const receipt = { orderNo: 'DEMO-00000001', currency: 'MYR', totalMinor: 250,
  submittedAt, simulation: true, status: 'SUBMITTED', buyerPhone: '+60123456789' };
const items = [{ productId: 'product-1', name: 'Test item', quantity: 2,
  unitPriceMinor: 125, recipientPhone: '+60123456789' }];
const statusAccessKey = '4d23d59b-dabd-4529-a03f-fbd8b6145960';

test('local orders keep item snapshots but exclude contact data and duplicate retries', async () => {
  const store = await createLocalOrderStore(null, () => Date.parse(submittedAt) + 1000);
  assert.equal(store.persistent, false);
  assert.equal(await store.save(receipt, items), false);
  assert.equal(await store.save(receipt), false);
  const orders = store.list();
  assert.equal(orders.length, 1);
  assert.deepEqual(orders[0].items, [{ productId: 'product-1', name: 'Test item', quantity: 2, unitPriceMinor: 125 }]);
  assert.equal(JSON.stringify(orders).includes('+60123456789'), false);
  orders[0].items[0].name = 'Changed';
  assert.equal(store.list()[0].items[0].name, 'Test item');
});

test('local orders retain a private status credential and update seller decisions', async () => {
  const store = await createLocalOrderStore(null, () => Date.parse(submittedAt) + 1000);
  await store.save(receipt, items, statusAccessKey);
  assert.equal(store.list()[0].status, 'SUBMITTED');
  assert.equal(store.list()[0].statusAccessKey, statusAccessKey);
  await store.updateStatuses([{ orderNo: receipt.orderNo, status: 'CONFIRMED',
    updatedAt: '2026-09-29T00:00:01.000Z', buyerPhone: '+60123456789' }]);
  assert.equal(store.list()[0].status, 'CONFIRMED');
  assert.equal(JSON.stringify(store.list()).includes('+60123456789'), false);
  await store.save(receipt);
  assert.equal(store.list()[0].status, 'CONFIRMED');
  assert.equal(store.list()[0].statusAccessKey, statusAccessKey);
  await store.updateStatuses([{ orderNo: receipt.orderNo, status: 'UNKNOWN', updatedAt: submittedAt }]);
  assert.equal(store.list()[0].status, 'CONFIRMED');
  await store.updateStatuses([{ orderNo: receipt.orderNo, status: 'SUBMITTED', updatedAt: submittedAt }]);
  assert.equal(store.list()[0].status, 'CONFIRMED');
});

test('local orders keep fulfilment status and tracking from the status API, and nothing else', async () => {
  const store = await createLocalOrderStore(null, () => Date.parse(submittedAt) + 1000);
  await store.save(receipt, items, statusAccessKey);
  await store.updateStatuses([{ orderNo: receipt.orderNo, status: 'SHIPPED', updatedAt: '2026-09-29T00:00:02.000Z',
    trackingCarrier: 'Ninja Van', trackingNo: 'NV123456', buyerPhone: '+60123456789' }]);
  const [order] = store.list();
  assert.equal(order.status, 'SHIPPED');
  assert.equal(order.trackingCarrier, 'Ninja Van');
  assert.equal(order.trackingNo, 'NV123456');
  assert.equal(JSON.stringify(order).includes('+60123456789'), false);
  await store.updateStatuses([{ orderNo: receipt.orderNo, status: 'DELIVERED', updatedAt: '2026-09-29T00:00:03.000Z' }]);
  assert.equal(store.list()[0].status, 'DELIVERED');
  assert.equal(store.list()[0].trackingNo, 'NV123456', 'tracking stays once recorded');
});

test('local orders expire at 90 days and reject invalid records', async () => {
  let now = Date.parse(submittedAt);
  const store = await createLocalOrderStore(null, () => now);
  assert.equal(await store.save({ ...receipt, orderNo: 'wrong' }, items), false);
  assert.equal(await store.save(receipt, [{ ...items[0], quantity: 0 }]), false);
  assert.deepEqual(store.list(), []);
  await store.save(receipt, items);
  now += ORDER_RETENTION_MS - 1;
  assert.equal(store.list().length, 1);
  now += 1;
  assert.deepEqual(store.list(), []);
  await store.refresh();
  assert.equal(await store.save(receipt, items), false);
});

 test('near-future server receipts survive immediately with complete sanitized backup', async () => {
  const now = Date.parse(submittedAt);
  const store = await createLocalOrderStore(null, () => now);
  await Promise.all([store.save({ ...receipt, submittedAt: new Date(now + 1000).toISOString() }, items, statusAccessKey), store.refresh()]);
  const saved = store.list()[0];
  assert.equal(saved.items.length, 1);
  assert.equal(saved.statusAccessKey, statusAccessKey);
  const restored = await createLocalOrderStore(null, () => now);
  await restored.save(saved, saved.items, saved.statusAccessKey);
  assert.deepEqual(restored.list(), store.list());
  assert.equal(JSON.stringify(restored.list()).includes('buyerPhone'), false);
  await restored.save({ ...receipt, orderNo: 'DEMO-00000002', submittedAt: new Date(now + ORDER_CLOCK_SKEW_MS + 1).toISOString() }, items);
  assert.equal(restored.list().length, 1);
});

test('optional order image snapshots allow only public shop product image paths', async () => {
  const imageUrl = '/api/v1/products/12345678-1234-1234-1234-123456789abc/image?v=abc123';
  assert.equal(safeOrderImage(imageUrl), imageUrl);
  for (const value of ['https://external.example/pixel', 'javascript:alert(1)', '//external/pixel', '/api/v1/seller/products/x/image', '/api/v1/products/x/image', imageUrl + '&token=secret']) assert.equal(safeOrderImage(value), null);
  const store = await createLocalOrderStore(null, () => Date.parse(submittedAt));
  await store.save(receipt, [{ ...items[0], imageUrl }]);
  assert.equal(store.list()[0].items[0].imageUrl, imageUrl);
  await store.save(receipt, [{ ...items[0], imageUrl: 'https://external.example' }]);
  assert.equal(store.list()[0].items[0].imageUrl, undefined);
});
