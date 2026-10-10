import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/app.js';
import { createPlatformRegistry } from '../src/platform/registry.js';
import { createTenant } from '../src/platform/provisioner.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { authenticate, createSession } from '../src/auth.js';
import { createOrder, lookupOrderStatuses } from '../src/orders.js';
import { platformFixture, platformTestUrl } from './helpers/platform-fixture.js';

test('PostgreSQL shops isolate SKU, category, order number, phone, access keys and seller sessions', { skip: !platformTestUrl }, async (t) => {
  const f = await platformFixture(t), defaultStore = await openDatabase(':memory:'); t.after(() => defaultStore.close());
  const initial = (await defaultStore.get('SELECT COUNT(*) AS n FROM product')).n;
  const config = { shopMode: 'manual', sellerQuickLogin: true, publicOrigin: 'https://shop.example.test', sellerOrigin: 'https://seller.example.test', platform: { adminHost: 'admin.example.test' } };
  const rows = [], results = [], stores = [], products = [], keys = [randomUUID(), randomUUID()];
  for (const [index, code] of ['alpha', 'beta'].entries()) {
    results.push(await createTenant(f.platform, f.deps, { code, name: `Fictional ${code}`, currency: 'MYR', sellerUsername: `${code}.owner` }, 'owner'));
    rows.push(await f.platform.get('SELECT * FROM tenant WHERE code = ?', code)); stores.push(await f.pool.get(rows[index]));
    await createCategory(stores[index], { code: 'GEN', label: `Fictional ${code}` });
    products.push(await createProduct(stores[index], { sku: 'SAME-SKU', name: `Fictional ${code}`, description: 'Fictional', category: 'GEN', priceMinor: 900, active: true }));
    await createOrder(stores[index], keys[index], { buyer: { fullName: 'Fictional Buyer', whatsappPhone: '+60123456789' }, whatsappOrderContactOptIn: true,
      deliveries: [{ recipient: { fullName: 'Fictional Recipient', phone: '+60123456789' }, address: { line1: '123 Fictional Lane', postcode: '80000', country: 'MY' },
        items: [{ productId: products[index].id, quantity: 1, expectedPriceMinor: 900, expectedCurrency: 'MYR' }] }] });
  }
  const orders = await Promise.all(stores.map((store) => store.get('SELECT id,order_no,buyer_phone FROM shop_order')));
  assert.equal(orders[0].order_no, orders[1].order_no); assert.equal(orders[0].buyer_phone, orders[1].buyer_phone);
  assert.equal((await lookupOrderStatuses(stores[1], { orders: [{ orderNo: orders[0].order_no, accessKey: keys[0] }] })).items.length, 0);
  const seller = await authenticate(stores[0], 'alpha.owner', results[0].sellerPassword), sellerSession = await createSession(stores[0], seller.id);
  const registry = createPlatformRegistry({ store: defaultStore, config, platform: f.platform, pool: f.pool });
  const handle = await createApi({ store: defaultStore, config, registry });
  const api = (code, path, method = 'GET', body, headers = {}) => handle(new Request(`https://seller.example.test/${code}/api/v1/${path}`, { method,
    headers: { origin: 'https://seller.example.test', cookie: `seller_session=${sellerSession.token}`, 'x-csrf-token': sellerSession.csrfToken,
      ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), { clientAddress: 'fictional-isolation' });
  assert.equal((await api('alpha', 'seller/session')).status, 200);
  assert.equal((await api('beta', 'seller/session')).status, 401);
  assert.equal((await api('beta', `seller/orders/${orders[0].id}`)).status, 401);
  assert.equal((await api('alpha', 'platform/shops')).status, 404);
  assert.equal((await api('alpha', 'seller/demo-session', 'POST', {})).status, 404);
  assert.equal((await api('alpha', 'seller/session', 'GET', undefined, { cookie: `platform_session=${randomBytes(32).toString('base64url')}` })).status, 401);
  const betaSeller = await authenticate(stores[1], 'beta.owner', results[1].sellerPassword), betaSession = await createSession(stores[1], betaSeller.id);
  // The beta account must change its password; foreign CSRF is refused even on the permitted password route.
  const denied = await api('beta', 'seller/account/password', 'POST', { currentPassword: results[1].sellerPassword, newPassword: randomBytes(24).toString('base64url') }, { cookie: `seller_session=${betaSession.token}` });
  assert.equal(denied.status, 403);
  assert.equal((await defaultStore.get('SELECT COUNT(*) AS n FROM product')).n, initial);
  for (const [index, store] of stores.entries()) { assert.equal((await store.get('SELECT name FROM product WHERE sku = ?', 'SAME-SKU')).name, `Fictional ${index ? 'beta' : 'alpha'}`); }
});
