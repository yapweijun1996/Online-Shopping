import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalOrderStore, ORDER_RETENTION_MS } from '../public/shop/local-orders.js';

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
