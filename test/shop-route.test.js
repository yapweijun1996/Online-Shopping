import assert from 'node:assert/strict';
import test from 'node:test';
import { productHash, readShopRoute } from '../public/shop/shop-route.js';

test('shareable product routes round-trip and reject malformed API identifiers', () => {
  const id = 'ABCD1234-1234-1234-1234-123456789ABC';
  assert.deepEqual(readShopRoute(productHash(id)), { page: 'product', id: id.toLowerCase() });
  for (const value of ['', '../../seller/orders', '%2Fapi', '1234', `${id}/image`, `${id}?x=1`]) {
    assert.deepEqual(readShopRoute(`#product/${value}`), { page: 'product', id: null });
    assert.throws(() => productHash(value), TypeError);
  }
  for (const page of ['cart', 'checkout', 'receipt', 'profile', 'settings']) assert.equal(readShopRoute(`#${page}`).page, page);
  for (const hash of ['', '#catalog', '#catalog-results', '#unknown']) assert.equal(readShopRoute(hash).page, 'catalog');
});
