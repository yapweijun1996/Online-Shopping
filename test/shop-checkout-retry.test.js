import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { checkoutPayload } from '../public/shop/checkout-payload.js';
import { openDatabase } from '../src/db.js';
import { createOrder } from '../src/orders.js';
import { createProduct } from '../src/products.js';
import { createCategory } from '../src/settings.js';

class FakeNode {
  constructor() { this.dataset = {}; this.handlers = {}; this.checked = true; }
  append() {}
  replaceChildren() {}
  setAttribute() {}
  removeAttribute() {}
  focus() {}
  reset() {}
  querySelectorAll() { return []; }
  querySelector() { return new FakeNode(); }
  closest() { return new FakeNode(); }
  addEventListener(type, callback) { this.handlers[type] = callback; }
}

async function fixture({ loseFirstResponse = true } = {}) {
  const store = await openDatabase(':memory:');
  await createCategory(store, { code: 'REVIEW', label: 'Review fixture' });
  const product = await createProduct(store, { sku: 'REVIEW-1', name: 'Review item',
    description: 'Synthetic fixture', category: 'REVIEW', priceMinor: 100, currency: 'MYR', active: true });
  // An existing manual shop can sell products without running the setup screen.
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new FakeNode());
      return nodes.get(id);
    },
    createElement: () => new FakeNode(), querySelector: () => new FakeNode(), dispatchEvent() {},
  };
  let language = 'en';
  let address = { id: 'address-1', fullName: 'Synthetic Recipient', phone: '+6581234567',
    line1: 'First Street', postcode: '123456', country: 'SG' };
  let loseResponse = loseFirstResponse;
  const requests = [];
  const receipts = [];
  const source = readFileSync(new URL('../public/shop/checkout.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export function mountCheckout', 'function mountCheckout');
  const mountCheckout = runInNewContext(`${source}\nmountCheckout`, {
    document, checkoutPayload, formatMoney: String, locale: () => language,
    t: (key) => key, translate() {}, addressSummary: () => 'Synthetic address',
    crypto: { randomUUID }, setTimeout, clearTimeout, AbortController, Event,
    location: { hash: '#checkout' },
    async fetch(_url, options) {
      requests.push({ key: options.headers['Idempotency-Key'], body: JSON.parse(options.body) });
      try {
        const result = await createOrder(store, options.headers['Idempotency-Key'], JSON.parse(options.body));
        if (loseResponse) {
          loseResponse = false;
          throw new TypeError('response lost after commit');
        }
        return { ok: true, json: async () => result.receipt };
      } catch (error) {
        if (error instanceof TypeError) throw error;
        return { ok: false, json: async () => ({ error: { code: error.code, field: error.field } }) };
      }
    },
  });
  const page = mountCheckout({
    async onSuccess(receipt, context) { receipts.push({ receipt, context }); page.reset(); },
    onPriceChanged() {},
    getProfile: () => ({ fullName: 'Synthetic Buyer', phone: '+6581234567' }),
    addressBook: { selected: () => address, defaultId: () => address.id, choose() {},
      ensureSelection() {}, resetSelection() {} },
  });
  page.setDemoMode(false);
  const items = [{ productId: product.id, quantity: 1, product }];
  const submit = async () => nodes.get('checkout-form').handlers.submit({ preventDefault() {} });
  return {
    store, page, items, requests, receipts, submit,
    setLanguage(value) { language = value; page.refreshLocale(); },
    setAddress(value) { address = { ...address, ...value }; page.refreshAddress(); },
    async orderCount() { return (await store.get('SELECT COUNT(*) AS count FROM shop_order')).count; },
    async close() { await store.close(); },
  };
}

test('a lost receipt followed by a language and address change replays the original order once', async () => {
  const f = await fixture();
  try {
    f.page.setItems(f.items);
    await f.submit();
    assert.equal(await f.orderCount(), 1);
    f.setLanguage('zh-Hans');
    f.setAddress({ line1: 'Changed Street' });
    await f.submit();
    assert.equal(await f.orderCount(), 1);
    assert.equal(f.receipts[0].receipt.orderNo, 'OS-00000001');
    assert.equal(f.receipts[0].context.cartBacked, false);
    assert.deepEqual(new Set(f.requests.map(({ key }) => key)).size, 1);
    assert.deepEqual(f.requests.map(({ body }) => body.locale), ['en', 'zh-Hans', 'en']);
    assert.equal((await f.store.get('SELECT address_line1 FROM delivery')).address_line1, 'First Street');

    f.page.setItems(f.items);
    await f.submit();
    assert.equal(await f.orderCount(), 2);
    assert.equal(f.receipts[1].receipt.orderNo, 'OS-00000002');
    assert.notEqual(f.requests[0].key, f.requests[3].key);
  } finally { await f.close(); }
});

test('a failed request can reuse its key for corrected details without a duplicate', async () => {
  const f = await fixture({ loseFirstResponse: false });
  try {
    f.page.setItems(f.items);
    f.setAddress({ line1: '' });
    await f.submit();
    assert.equal(await f.orderCount(), 0);
    f.setAddress({ line1: 'Corrected Street' });
    await f.submit();
    assert.equal(await f.orderCount(), 1);
    assert.equal(f.requests[0].key, f.requests[1].key);
    assert.equal((await f.store.get('SELECT address_line1 FROM delivery')).address_line1, 'Corrected Street');
  } finally { await f.close(); }
});
