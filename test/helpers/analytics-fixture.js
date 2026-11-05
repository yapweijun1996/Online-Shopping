import { createCategory } from '../../src/settings.js';
import { createProduct } from '../../src/products.js';
import { createOrder } from '../../src/orders.js';
import { reviewFixture } from './mcp-review-fixture.js';

export const analyticsNow = new Date('2026-10-09T17:00:00.000Z');
export async function analyticsFixture(t, dialect, options = {}) {
  const f = await reviewFixture(t, dialect, options);
  await createCategory(f.store, { code: 'SYNTHETIC', label: 'Synthetic category' });
  await createCategory(f.store, { code: 'ALTERNATE', label: 'Alternate category' });
  const make = (sku, priceMinor, extra = {}) => createProduct(f.store, { sku, name: 'Synthetic ' + sku, description: 'Synthetic analytics product', category: 'SYNTHETIC', priceMinor, active: true, ...extra });
  const a = await make('A', 1250), b = await make('B', 5000), c = await make('C', 200, { category: 'ALTERNATE' });
  await f.store.run("UPDATE product SET currency = 'SGD' WHERE id = ?", b.id); b.currency = 'SGD';
  await f.store.run('UPDATE product SET created_at = ?', '2026-08-01T00:00:00.000Z');
  let serial = 0;
  const place = async (product, quantity, submittedAt, status) => {
    const result = await createOrder(f.store, 'synthetic-analytics-intent-' + ++serial, { buyer: { fullName: 'Synthetic private buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true,
      deliveries: [{ recipient: { fullName: 'Synthetic private recipient', phone: '+60123456789' }, address: { line1: 'Synthetic private street', postcode: '50000', country: 'MY' },
        items: [{ productId: product.id, quantity, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency }] }] });
    const order = await f.store.get('SELECT id FROM shop_order WHERE order_no = ?', result.receipt.orderNo);
    await f.store.run('UPDATE shop_order SET submitted_at = ?, status = ? WHERE id = ?', submittedAt, status, order.id);
    return order.id;
  };
  const ids = [await place(a, 2, '2026-10-09T16:30:00.000Z', 'CONFIRMED'), await place(b, 1, '2026-10-09T20:00:00.000Z', 'SHIPPED'),
    await place(a, 1, '2026-10-09T15:59:59.000Z', 'DELIVERED'), await place(a, 9, '2026-10-09T17:00:00.000Z', 'REJECTED'),
    await place(a, 9, '2026-10-09T17:30:00.000Z', 'CANCELLED'), await place(a, 1, '2026-10-09T16:50:00.000Z', 'SUBMITTED'),
    await place(a, 7, '2026-08-01T04:00:00.000Z', 'DELIVERED'), await place(c, 3, '2026-09-30T18:00:00.000Z', 'DELIVERED'),
    await place(a, 4, '2026-09-30T15:59:00.000Z', 'CONFIRMED')];
  return { ...f, a, b, c, ids, place, make };
}
