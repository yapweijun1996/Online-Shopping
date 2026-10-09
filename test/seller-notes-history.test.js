import assert from 'node:assert/strict';
import test from 'node:test';
import { sellerFixture } from './helpers/seller-app.js';

const orderId = async (f, orderNo) => (await f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', orderNo)).id;

test('order notes: any signed-in role can add one, they are append-only, bounded and shown on the order', async () => {
  const f = await sellerFixture();
  try {
    const { headers } = await f.login();
    const order = await f.submit();
    const id = await orderId(f, order.data.orderNo);
    const url = `/api/v1/seller/orders/${id}/notes`;
    assert.equal((await f.request('POST', url, { body: 'x' }, { origin: f.origin })).response.status, 401);
    assert.equal((await f.request('POST', url, { body: 'x' }, { ...headers, 'x-csrf-token': 'wrong' })).response.status, 403);
    for (const bad of [{}, { body: '' }, { body: '   ' }, { body: 'a'.repeat(1001) }, { body: 'bad\u0007char' }, { body: 'ok', extra: 1 }, { body: 42 }]) {
      assert.equal((await f.request('POST', url, bad, headers)).response.status, 400, JSON.stringify(bad).slice(0, 40));
    }
    const first = await f.request('POST', url, { body: 'Buyer asked to deliver after 6pm.\nCalled twice.' }, headers);
    assert.equal(first.response.status, 201);
    assert.equal(first.data.author, 'review_owner');
    await f.request('POST', url, { body: 'Packed.' }, headers);
    const detail = await f.request('GET', `/api/v1/seller/orders/${id}`, null, headers);
    assert.deepEqual(detail.data.notes.map((note) => note.body), ['Buyer asked to deliver after 6pm.\nCalled twice.', 'Packed.']);
    assert.equal((await f.request('POST', `/api/v1/seller/orders/11111111-1111-4111-8111-111111111111/notes`, { body: 'x' }, headers)).response.status, 404);
    // Notes never reach the buyer's status lookup.
    assert.ok(!JSON.stringify((await f.request('POST', '/api/v1/orders/statuses', { orders: [] }, { origin: f.origin })).data).includes('Packed'));
    for (let n = 2; n < 50; n++) await f.request('POST', url, { body: `Note ${n}` }, headers);
    assert.equal((await f.request('POST', url, { body: 'one too many' }, headers)).data.error.code, 'TOO_MANY_NOTES');
  } finally { await f.close(); }
});

test('product history records who changed what, with old and new values', async () => {
  const f = await sellerFixture();
  try {
    const { headers } = await f.login();
    const created = await f.request('POST', '/api/v1/seller/products', { sku: 'HIST-1', name: 'History item', description: 'Fictional', category: 'EXAMPLES', priceMinor: 1000, stockQuantity: 5, active: true }, headers);
    assert.equal(created.response.status, 201);
    const id = created.data.id;
    const patch = (body) => f.request('PATCH', `/api/v1/seller/products/${id}`, body, headers);
    assert.equal((await patch({ priceMinor: 1200, stockQuantity: 9 })).response.status, 200);
    assert.equal((await patch({ active: false })).response.status, 200);
    assert.equal((await patch({ name: 'History item' })).response.status, 200);       // no real change: nothing recorded
    const history = await f.request('GET', `/api/v1/seller/products/${id}/history`, null, headers);
    assert.deepEqual(history.data.items.map((item) => item.action), ['UPDATED', 'UPDATED', 'CREATED']);
    assert.deepEqual(history.data.items[0].changes, [{ field: 'active', from: true, to: false }]);
    assert.deepEqual(history.data.items[1].changes, [{ field: 'priceMinor', from: 1000, to: 1200 }, { field: 'stockQuantity', from: 5, to: 9 }]);
    assert.ok(history.data.items.every((item) => item.actor === 'review_owner'));
    assert.equal((await f.request('GET', `/api/v1/seller/products/${id}/history?limit=1`, null, headers)).data.nextOffset, 1);
    assert.equal((await f.request('GET', `/api/v1/seller/products/${id}/history?limit=0`, null, headers)).response.status, 400);
    assert.equal((await f.request('GET', '/api/v1/seller/products/11111111-1111-4111-8111-111111111111/history', null, headers)).response.status, 404);
    // A rejected edit leaves no entry.
    assert.equal((await patch({ priceMinor: -5 })).response.status, 400);
    assert.equal((await f.request('GET', `/api/v1/seller/products/${id}/history`, null, headers)).data.items.length, 3);
  } finally { await f.close(); }
});

test('bulk activate and deactivate is all or nothing, bounded, and recorded per product', async () => {
  const f = await sellerFixture();
  try {
    const { headers } = await f.login();
    const make = async (sku, active) => (await f.request('POST', '/api/v1/seller/products', { sku, name: `Item ${sku}`, description: 'Fictional', category: 'EXAMPLES', priceMinor: 500, active }, headers)).data.id;
    const [a, b, c] = [await make('B-1', true), await make('B-2', true), await make('B-3', false)];
    const bulk = (body) => f.request('POST', '/api/v1/seller/products/bulk', body, headers);
    const done = await bulk({ ids: [a, b, c], action: 'deactivate' });
    assert.deepEqual(done.data, { requested: 3, changed: 2 });
    const state = async () => (await f.app.database.all('SELECT sku, active FROM product WHERE sku LIKE ? ORDER BY sku', 'B-%')).map((row) => row.active);
    assert.deepEqual(await state(), [0, 0, 0]);
    assert.equal((await f.request('GET', `/api/v1/seller/products/${a}/history`, null, headers)).data.items[0].changes[0].field, 'active');
    assert.deepEqual((await bulk({ ids: [a, c], action: 'activate' })).data, { requested: 2, changed: 2 });
    // One missing product stops everything: nothing else is changed.
    const ghost = '11111111-1111-4111-8111-111111111111';
    assert.equal((await bulk({ ids: [b, ghost], action: 'activate' })).response.status, 400);
    assert.deepEqual(await state(), [1, 0, 1]);
    for (const bad of [{ ids: [], action: 'activate' }, { ids: [a, a], action: 'activate' }, { ids: ['nope'], action: 'activate' }, { ids: [a], action: 'delete' }, { ids: Array(101).fill(a), action: 'activate' }, { ids: [a] }]) {
      assert.equal((await bulk(bad)).response.status, 400, JSON.stringify(bad).slice(0, 50));
    }
    assert.equal((await f.request('POST', '/api/v1/seller/products/bulk', { ids: [a], action: 'activate' }, { origin: f.origin })).response.status, 401);
  } finally { await f.close(); }
});

test('roles: Staff may write notes but not edit products; Managers may do both', async () => {
  const f = await sellerFixture();
  try {
    const owner = await f.login();
    const temp = 'Temporary-Pass-2026!', own = 'My-Own-Password-2026!';
    const join = async (username, role) => {
      await f.request('POST', '/api/v1/seller/accounts', { username, role, password: temp }, owner.headers);
      const first = await f.login(username, temp);
      await f.request('POST', '/api/v1/seller/account/password', { currentPassword: temp, newPassword: own }, first.headers);
      return f.login(username, own);
    };
    const staff = await join('staff.n', 'STAFF'), manager = await join('manager.n', 'MANAGER');
    const id = await orderId(f, (await f.submit()).data.orderNo);
    assert.equal((await f.request('POST', `/api/v1/seller/orders/${id}/notes`, { body: 'From staff' }, staff.headers)).response.status, 201);
    const ghost = '11111111-1111-4111-8111-111111111111';
    for (const [who, expected] of [[staff, 403], [manager, 400]]) {
      assert.equal((await f.request('POST', '/api/v1/seller/products/bulk', { ids: [], action: 'activate' }, who.headers)).response.status, expected);
      assert.equal((await f.request('GET', `/api/v1/seller/products/${ghost}/history`, null, who.headers)).response.status, expected === 403 ? 403 : 404);
    }
  } finally { await f.close(); }
});
