import assert from 'node:assert/strict';
import test from 'node:test';
import { productHash, orderHash, ordersHash, readShopRoute } from '../public/shop/shop-route.js';

test('shareable product routes round-trip and reject malformed API identifiers', () => {
  const id = 'ABCD1234-1234-1234-1234-123456789ABC';
  assert.deepEqual(readShopRoute(productHash(id)), { page: 'product', id: id.toLowerCase() });
  for (const value of ['', '../../seller/orders', '%2Fapi', '1234', `${id}/image`, `${id}?x=1`]) {
    assert.deepEqual(readShopRoute(`#product/${value}`), { page: 'product', id: null });
    assert.throws(() => productHash(value), TypeError);
  }
  for (const page of ['cart', 'checkout', 'receipt', 'profile', 'orders', 'settings']) assert.equal(readShopRoute(`#${page}`).page, page);
  for (const hash of ['', '#catalog', '#catalog-results', '#unknown']) assert.equal(readShopRoute(hash).page, 'catalog');
});


test('catalog links restore filters and clear them without losing unrelated URL values', async () => {
  const { readCatalogFilters, catalogFilterURL } = await import('../public/shop/shop-route.js');
  const original = 'https://shop.example/shop/?lang=en#cart';
  const first = catalogFilterURL(original, { search: ' tofu & food ', category: 'Cat Food' });
  assert.deepEqual(readCatalogFilters(first.search), { search: 'tofu & food', category: 'Cat Food' });
  assert.equal(first.hash, '#catalog-results');
  assert.equal(first.searchParams.get('lang'), 'en');
  const second = catalogFilterURL(first.href, { search: '', category: '' });
  assert.deepEqual(readCatalogFilters(second.search), { search: '', category: '' });
  assert.deepEqual(readCatalogFilters(new URL(first.href).search), { search: 'tofu & food', category: 'Cat Food' });
  assert.equal(second.searchParams.get('lang'), 'en');
});

test('order detail routes accept only bounded public order identifiers', () => {
  assert.deepEqual(readShopRoute(orderHash('DEMO-00000001')), { page: 'orders', id: 'DEMO-00000001' });
  for (const id of ['../admin', 'DEMO-x', 'OS-123', 'DEMO-00000001?key=secret']) {
    assert.throws(() => orderHash(id));
    assert.deepEqual(readShopRoute(`#orders/${id}`), { page: 'orders', id: null });
  }
});

test('order status filters round-trip through list and detail without inventing states', () => {
  for (const filter of ['SUBMITTED', 'CONFIRMED', 'REJECTED', 'SHIPPED', 'DELIVERED', 'CANCELLED']) {
    assert.equal(readShopRoute(ordersHash(filter)).filter, filter);
    assert.deepEqual(readShopRoute(orderHash('DEMO-00000001', filter)), { page: 'orders', id: 'DEMO-00000001', filter });
  }
  assert.equal(readShopRoute('#orders?status=REFUNDED').filter, undefined);
});
