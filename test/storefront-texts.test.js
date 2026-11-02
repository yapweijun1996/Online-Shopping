import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { setupShop } from '../src/shop-setup.js';
import { createApi } from '../src/app.js';
import { ownerSession } from './helpers/session.js';
import { updateCompanySettings, getCompanySettings, storefrontTexts } from '../src/settings.js';

async function fixture(t) {
  const store = await openDatabase(':memory:'); t.after(async () => await store.close());
  await setupShop(store, { mode: 'production', shopName: 'Synthetic shop' });
  const config = { shopMode: 'manual', production: false, publicOrigin: 'http://fixture.test' };
  const api = await createApi({ store, config }), session = await ownerSession(store);
  const call = async (path, method = 'GET', body) => {
    const response = await api(new Request('http://fixture.test' + path, {
      method, headers: { cookie: 'seller_session=' + session.token, 'x-csrf-token': session.csrfToken,
        ...(method === 'GET' ? {} : { origin: 'http://fixture.test', 'content-type': 'application/json' }) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), { clientAddress: 'synthetic-client' });
    return { status: response.status, data: await response.json() };
  };
  return { store, call };
}

test('storefront texts default to null and are returned by the public shop endpoint', async t => {
  const { call } = await fixture(t);
  const settings = await call('/api/v1/seller/company-settings');
  assert.equal(settings.data.availabilityText, null);
  const shop = await call('/api/v1/shop');
  assert.deepEqual(shop.data.storefrontTexts, { availability: null, shipping: null, returns: null });
});

test('seller can save, trim, clear and read back the three texts', async t => {
  const { call, store } = await fixture(t);
  const saved = await call('/api/v1/seller/company-settings', 'PATCH', { availabilityText: '  In stock, ships in 2 days.\r\nCall us.  ', shippingText: 'Flat RM 8 within Malaysia', returnsText: '' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.availabilityText, 'In stock, ships in 2 days.\nCall us.');
  assert.equal(saved.data.shippingText, 'Flat RM 8 within Malaysia');
  assert.equal(saved.data.returnsText, null, 'an empty box clears the text');
  const shop = await call('/api/v1/shop');
  assert.deepEqual(shop.data.storefrontTexts, { availability: 'In stock, ships in 2 days.\nCall us.', shipping: 'Flat RM 8 within Malaysia', returns: null });
  // Other settings stay untouched, and an unrelated update keeps the texts.
  const other = await call('/api/v1/seller/company-settings', 'PATCH', { mobileHideBarsOnScroll: true });
  assert.equal(other.data.shippingText, 'Flat RM 8 within Malaysia');
  assert.deepEqual(storefrontTexts(await getCompanySettings(store)).shipping, 'Flat RM 8 within Malaysia');
  const cleared = await call('/api/v1/seller/company-settings', 'PATCH', { shippingText: null });
  assert.equal(cleared.data.shippingText, null);
});

test('texts must be strings of at most 1000 characters', async t => {
  const { call, store } = await fixture(t);
  const long = await call('/api/v1/seller/company-settings', 'PATCH', { returnsText: 'x'.repeat(1001) });
  assert.equal(long.status, 400); assert.equal(long.data.error.field, 'returnsText');
  const wrong = await call('/api/v1/seller/company-settings', 'PATCH', { shippingText: 42 });
  assert.equal(wrong.status, 400); assert.equal(wrong.data.error.field, 'shippingText');
  const ok = await call('/api/v1/seller/company-settings', 'PATCH', { returnsText: 'x'.repeat(1000) });
  assert.equal(ok.status, 200);
  assert.equal((await getCompanySettings(store)).returnsText.length, 1000);
  await assert.rejects(() => updateCompanySettings(store, { unknownField: 'x' }), /supported company settings/);
});
