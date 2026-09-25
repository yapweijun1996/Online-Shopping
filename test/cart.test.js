import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCartStore } from '../public/shop/cart.js';

test('cart remains usable when browser storage is unavailable', async () => {
  const cart = await createCartStore(null);
  assert.equal(cart.persistent, false);
  assert.equal(await cart.set('product-example', 2), false);
  assert.deepEqual(cart.list(), [{ productId: 'product-example', quantity: 2 }]);
  await cart.set('product-example', 0);
  assert.deepEqual(cart.list(), []);
  await cart.set('another-product', 3);
  await cart.clear();
  assert.deepEqual(cart.list(), []);
});

test('cart rejects malformed IDs and quantities before changing state', async () => {
  const cart = await createCartStore(null);
  await assert.rejects(cart.set('', 1), /productId/);
  await assert.rejects(cart.set('product-example', 101), /quantity/);
  await assert.rejects(cart.set('product-example', 1.5), /quantity/);
  assert.deepEqual(cart.list(), []);
});

test('cart falls back when opening IndexedDB throws', async () => {
  const cart = await createCartStore({ open() { throw new Error('storage denied'); } });
  assert.equal(cart.persistent, false);
  await cart.set('product-example', 1);
  assert.deepEqual(cart.list(), [{ productId: 'product-example', quantity: 1 }]);
});
