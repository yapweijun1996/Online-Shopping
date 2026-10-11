import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { apiUrl } from '../public/shared/base-path.js';
import { checkoutPayload } from '../public/shop/checkout-payload.js';
import { openDatabase } from '../src/db.js';
import { createOrder } from '../src/orders.js';
import { createProduct } from '../src/products.js';
import { createCategory } from '../src/settings.js';
import { errorResponse } from '../src/http.js';

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

async function fixture({ loseFirstResponse = true, storageFails = false, corruptIntent = false, receiptFails = false } = {}) {
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
  const saved = new Map();
  if (corruptIntent) saved.set('checkout-pending-intent-v1', '{broken');
  const storage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem(key, value) { if (storageFails) throw new Error('Synthetic storage failure'); saved.set(key, value); },
    removeItem: (key) => saved.delete(key),
  };
  const persistenceSource = readFileSync(new URL('../public/shop/checkout-intent.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replaceAll('export function', 'function');
  const persistence = runInNewContext(`${persistenceSource}\n({readCheckoutIntent,writeCheckoutIntent,clearCheckoutIntent})`, {
    localStorage: storage, storageKey: (key) => key,
  });
  const source = readFileSync(new URL('../public/shop/checkout.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export function mountCheckout', 'function mountCheckout');
  const mountCheckout = runInNewContext(`${source}\nmountCheckout`, {
    document, apiUrl, checkoutPayload, formatMoney: String, locale: () => language,
    t: (key) => key, translate() {}, addressSummary: () => 'Synthetic address',
    crypto: { randomUUID }, setTimeout, clearTimeout, AbortController, Event,
    ...persistence,
    location: { hash: '#checkout' },
    async fetch(_url, options) {
      requests.push({ key: options.headers['Idempotency-Key'], body: JSON.parse(options.body) });
      try {
        const result = await createOrder(store, options.headers['Idempotency-Key'], JSON.parse(options.body));
        if (loseResponse) {
          loseResponse = false;
          throw new TypeError('response lost after commit');
        }
        return { ok: true, status: 201, json: async () => result.receipt };
      } catch (error) {
        if (error instanceof TypeError) throw error;
        return errorResponse(error);
      }
    },
  });
  let page;
  const reload = () => {
    nodes.clear();
    page = mountCheckout({
    async onSuccess(receipt, context) {
      if (receiptFails) { receiptFails = false; throw new Error('Synthetic rendering failure'); }
      receipts.push({ receipt, context }); page.reset();
    },
    onPriceChanged() {},
    getProfile: () => ({ fullName: 'Synthetic Buyer', phone: '+6581234567' }),
    addressBook: { selected: () => address, defaultId: () => address.id, choose() {},
      ensureSelection() {}, resetSelection() {} },
  });
  page.setDemoMode(false);
  };
  reload();
  const items = [{ productId: product.id, quantity: 1, product }];
  const submit = async () => nodes.get('checkout-form').handlers.submit({ preventDefault() {} });
  return {
    store, get page() { return page; }, items, requests, receipts, submit, saved, reload,
    loseNextResponse() { loseResponse = true; },
    error: () => nodes.get('checkout-error').textContent,
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
    assert.deepEqual(f.requests.map(({ body }) => body.locale), ['en', 'en']);
    assert.equal((await f.store.get('SELECT address_line1 FROM delivery')).address_line1, 'First Street');

    f.page.setItems(f.items);
    await f.submit();
    assert.equal(await f.orderCount(), 2);
    assert.equal(f.receipts[1].receipt.orderNo, 'OS-00000002');
    assert.notEqual(f.requests[0].key, f.requests[2].key);
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

test('reload after a committed response is lost preserves the original key and body', async () => {
  const f = await fixture();
  try {
    f.page.setItems(f.items);
    await f.submit();
    assert.equal(f.page.hasPendingIntent(), true);
    f.reload();
    f.page.setItems(f.items);
    f.setAddress({ line1: 'Changed after reload' });
    await f.submit();
    assert.equal(await f.orderCount(), 1);
    assert.equal(f.requests[0].key, f.requests[1].key);
    assert.deepEqual(f.requests[0].body, f.requests[1].body);
    assert.equal(f.receipts[0].context.cartBacked, false);
    assert.equal(f.page.hasPendingIntent(), false);
    assert.equal(f.saved.size, 0);
  } finally { await f.close(); }
});

test('corrected details are saved before a committed response is lost and the page reloads', async () => {
  const f = await fixture({ loseFirstResponse: false });
  try {
    f.page.setItems(f.items);
    f.setAddress({ line1: '' });
    await f.submit();
    f.setAddress({ line1: 'Corrected Street' });
    f.loseNextResponse();
    await f.submit();
    f.reload();
    f.page.setItems(f.items);
    await f.submit();
    assert.equal(await f.orderCount(), 1);
    assert.equal(new Set(f.requests.map(({ key }) => key)).size, 1);
    assert.deepEqual(f.requests[1].body, f.requests[2].body);
    assert.equal(f.receipts.length, 1);
  } finally { await f.close(); }
});

for (const mode of ['storageFails', 'corruptIntent']) test(`${mode} blocks submission instead of replacing an unknown intent`, async () => {
  const f = await fixture({ [mode]: true });
  try {
    f.page.setItems(f.items);
    await f.submit();
    assert.equal(await f.orderCount(), 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.error(), 'checkoutIntentStorageFailed');
    assert.equal(f.page.hasPendingIntent(), true);
  } finally { await f.close(); }
});

test('a receipt failure remains recoverable after reload even with an empty cart', async () => {
  const f = await fixture({ loseFirstResponse: false, receiptFails: true });
  try {
    f.page.setItems(f.items);
    await f.submit();
    f.reload();
    f.page.setItems([]);
    await f.submit();
    assert.equal(await f.orderCount(), 1);
    assert.equal(f.requests[0].key, f.requests[1].key);
    assert.equal(f.receipts.length, 1);
    assert.equal(f.receipts[0].context.cartBacked, false);
  } finally { await f.close(); }
});

test('an unknown committed order can replay after its cart product becomes unavailable', async () => {
  const f = await fixture();
  try {
    f.page.setItems(f.items);
    await f.submit();
    f.reload();
    f.page.setItems(f.items.map(item => ({ ...item, product: null })));
    await f.submit();
    assert.equal(await f.orderCount(), 1);
    assert.equal(f.receipts.length, 1);
    assert.equal(f.requests[0].key, f.requests[1].key);
  } finally { await f.close(); }
});
