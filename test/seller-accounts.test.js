import assert from 'node:assert/strict';
import test from 'node:test';
import { sellerFixture } from './helpers/seller-app.js';
import { openDatabase, migrateStore } from '../src/db.js';
import { authenticate } from '../src/auth.js';
import { resetPasswordFromHost } from '../src/accounts.js';
import { can, ROLES } from '../src/roles.js';
import { randomBytes } from 'node:crypto';
import { parseKeyFile } from '../src/secret-box.js';

const STRONG = 'Temporary-Pass-2026!';
const NEXT = 'My-Own-Password-2026!';

async function team(f) {
  const owner = await f.login();
  const create = async (username, role) => {
    const made = await f.request('POST', '/api/v1/seller/accounts', { username, role, password: STRONG }, owner.headers);
    assert.equal(made.response.status, 201, JSON.stringify(made.data));
    const first = await f.login(username, STRONG);
    assert.equal(first.session.mustChangePassword, true);
    const changed = await f.request('POST', '/api/v1/seller/account/password', { currentPassword: STRONG, newPassword: NEXT }, first.headers);
    assert.equal(changed.response.status, 200, JSON.stringify(changed.data));
    return { ...(await f.login(username, NEXT)), id: made.data.id };
  };
  return { owner, manager: await create('manager.one', 'MANAGER'), staff: await create('staff.one', 'STAFF') };
}

test('an upgrade from schema 22 keeps the existing administrator as Owner with the same password', async () => {
  const store = await openDatabase(':memory:');
  try {
    const stamp = new Date().toISOString();
    await store.run('DELETE FROM seller_account');
    await store.exec('DROP TABLE account_event; DROP TABLE seller_account; ALTER TABLE session DROP COLUMN account_id');
    await store.run("INSERT INTO admin(id, username, password_hash, created_at) VALUES (1, 'Legacy_Owner', 'abcd:1234', ?)", stamp);
    await store.setSchemaVersion(22);
    await migrateStore(store);
    assert.equal(await store.schemaVersion(), 23);
    const owner = await store.get('SELECT username, username_key, password_hash, role, active, must_change_password FROM seller_account');
    assert.deepEqual({ ...owner }, { username: 'Legacy_Owner', username_key: 'legacy_owner', password_hash: 'abcd:1234', role: 'OWNER', active: 1, must_change_password: 0 });
    await migrateStore(store);   // repeatable
    assert.equal((await store.get('SELECT COUNT(*) AS n FROM seller_account')).n, 1);
  } finally { await store.close(); }
});

test('roles: the matrix is enforced on the server, not only hidden in the page', async () => {
  const f = await sellerFixture();
  try {
    const { owner, manager, staff } = await team(f);
    const ghost = '11111111-1111-4111-8111-111111111111';
    // [method, path, capability]. A forbidden role gets 403 before the (unknown) id is even looked up.
    const routes = [
      ['POST', `/api/v1/seller/orders/${ghost}/confirm`, 'orders.decide'], ['POST', `/api/v1/seller/orders/${ghost}/reject`, 'orders.decide'],
      ['POST', `/api/v1/seller/orders/${ghost}/cancel`, 'orders.decide'], ['POST', `/api/v1/seller/orders/${ghost}/ship`, 'orders.fulfil'],
      ['POST', `/api/v1/seller/orders/${ghost}/deliver`, 'orders.fulfil'], ['POST', `/api/v1/seller/orders/${ghost}/erase-contact`, 'data.erase'],
      ['GET', '/api/v1/seller/orders/export.csv', 'data.export'], ['GET', '/api/v1/seller/dashboard', 'figures.read'],
      ['POST', '/api/v1/seller/products', 'catalog.write'], ['PATCH', `/api/v1/seller/products/${ghost}`, 'catalog.write'],
      ['POST', '/api/v1/seller/categories', 'catalog.write'], ['POST', '/api/v1/seller/option-types', 'catalog.write'],
      ['PATCH', '/api/v1/seller/company-settings', 'settings.write'], ['POST', '/api/v1/seller/setup', 'settings.write'],
      ['PUT', '/api/v1/seller/integrations/whatsapp/SANDBOX', 'settings.write'],
      ['POST', `/api/v1/seller/messages/outbox/${ghost}/resolve`, 'messages.act'],
      ['GET', '/api/v1/seller/accounts', 'staff.manage'], ['POST', '/api/v1/seller/accounts', 'staff.manage'], ['PATCH', `/api/v1/seller/accounts/${ghost}`, 'staff.manage'],
    ];
    for (const [name, who] of [['OWNER', owner], ['MANAGER', manager], ['STAFF', staff]]) {
      for (const [method, path, capability] of routes) {
        const result = await f.request(method, path, method === 'GET' ? null : {}, who.headers);
        const expectedForbidden = !can(name, capability);
        assert.equal(result.response.status === 403, expectedForbidden, `${name} ${method} ${path} -> ${result.response.status}`);
      }
    }
    // Everyone can read orders and the session reports the role.
    for (const who of [owner, manager, staff]) assert.equal((await f.request('GET', '/api/v1/seller/orders', null, who.headers)).response.status, 200);
    assert.equal((await f.request('GET', '/api/v1/seller/session', null, staff.headers)).data.role, 'STAFF');
    assert.deepEqual(ROLES, ['OWNER', 'MANAGER', 'STAFF']);
  } finally { await f.close(); }
});

test('the person who acted is the signed-in account, and a stale role never outlives a change', async () => {
  const f = await sellerFixture();
  try {
    const { owner, manager, staff } = await team(f);
    const order = await f.submit();
    const id = (await f.app.database.get('SELECT id FROM shop_order WHERE order_no = ?', order.data.orderNo)).id;
    assert.equal((await f.request('POST', `/api/v1/seller/orders/${id}/confirm`, { expectedRevision: 1 }, staff.headers)).response.status, 403);
    assert.equal((await f.request('POST', `/api/v1/seller/orders/${id}/confirm`, { expectedRevision: 1 }, manager.headers)).response.status, 200);
    const shipped = await f.request('POST', `/api/v1/seller/orders/${id}/ship`, { expectedRevision: 2, carrier: 'Ninja Van' }, staff.headers);
    assert.equal(shipped.response.status, 200);
    assert.deepEqual(shipped.data.events.filter((event) => event.actorType === 'SELLER').map((event) => event.actorId), ['manager.one', 'staff.one']);
    // Promote the staff member: the very next request is allowed to decide.
    const promoted = await f.request('PATCH', `/api/v1/seller/accounts/${staff.id}`, { role: 'MANAGER' }, owner.headers);
    assert.equal(promoted.data.role, 'MANAGER');
    assert.notEqual((await f.request('POST', `/api/v1/seller/orders/${id}/cancel`, { expectedRevision: 3, reason: 'x' }, staff.headers)).response.status, 403);
  } finally { await f.close(); }
});

test('a temporary password blocks everything except changing it; changing it ends other sessions', async () => {
  const f = await sellerFixture();
  try {
    const owner = await f.login();
    const made = await f.request('POST', '/api/v1/seller/accounts', { username: 'New.Person', role: 'STAFF', password: STRONG }, owner.headers);
    assert.equal(made.response.status, 201);
    assert.equal((await f.request('POST', '/api/v1/seller/accounts', { username: 'new.person', role: 'STAFF', password: STRONG }, owner.headers)).data.error.code, 'USERNAME_TAKEN');
    const one = await f.login('NEW.PERSON', STRONG), two = await f.login('new.person', STRONG);   // usernames ignore case
    assert.equal((await f.request('GET', '/api/v1/seller/orders', null, one.headers)).data.error.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await f.request('GET', '/api/v1/seller/session', null, one.headers)).response.status, 200);
    const change = (body, who = one) => f.request('POST', '/api/v1/seller/account/password', body, who.headers);
    assert.equal((await change({ currentPassword: 'wrong-password-123', newPassword: NEXT })).data.error.code, 'WRONG_PASSWORD');
    for (const weak of ['short', 'new.person-is-in-here', 'aaaaaaaaaaaaaaaa', STRONG]) {
      assert.equal((await change({ currentPassword: STRONG, newPassword: weak })).response.status, 400, weak);
    }
    assert.equal((await change({ currentPassword: STRONG, newPassword: NEXT, extra: 1 })).response.status, 400);
    assert.equal((await f.request('POST', '/api/v1/seller/account/password', { currentPassword: STRONG, newPassword: NEXT }, { origin: f.origin, cookie: one.cookie })).response.status, 403);   // no CSRF token
    assert.equal((await change({ currentPassword: STRONG, newPassword: NEXT })).response.status, 200);
    assert.equal((await f.request('GET', '/api/v1/seller/orders', null, one.headers)).response.status, 200);      // this session continues
    assert.equal((await f.request('GET', '/api/v1/seller/orders', null, two.headers)).response.status, 401);      // the other one ended
    assert.equal((await f.request('POST', '/api/v1/seller/session', { username: 'new.person', password: STRONG }, { origin: f.origin })).response.status, 401);
    assert.equal((await f.request('POST', '/api/v1/seller/session', { username: 'new.person', password: NEXT }, { origin: f.origin })).response.status, 200);
    const listed = await f.request('GET', '/api/v1/seller/accounts', null, owner.headers);
    assert.deepEqual(listed.data.events.map((event) => event.action).sort(), ['CREATED', 'PASSWORD_CHANGED']);
    assert.ok(!JSON.stringify(listed.data).includes('password_hash') && !JSON.stringify(listed.data).includes(NEXT));
  } finally { await f.close(); }
});

test('deactivating ends sessions at once; the Owner and the actor cannot be changed through the API', async () => {
  const f = await sellerFixture();
  try {
    const { owner, manager, staff } = await team(f);
    assert.equal((await f.request('PATCH', `/api/v1/seller/accounts/${staff.id}`, { active: false }, owner.headers)).data.active, false);
    assert.equal((await f.request('GET', '/api/v1/seller/orders', null, staff.headers)).response.status, 401);
    assert.equal((await f.request('POST', '/api/v1/seller/session', { username: 'staff.one', password: NEXT }, { origin: f.origin })).response.status, 401);
    await f.request('PATCH', `/api/v1/seller/accounts/${staff.id}`, { active: true }, owner.headers);
    assert.equal((await f.request('POST', '/api/v1/seller/session', { username: 'staff.one', password: NEXT }, { origin: f.origin })).response.status, 200);
    const ownerId = (await f.request('GET', '/api/v1/seller/accounts', null, owner.headers)).data.items.find((item) => item.role === 'OWNER').id;
    for (const body of [{ active: false }, { role: 'STAFF' }, { resetPassword: STRONG }]) {
      assert.equal((await f.request('PATCH', `/api/v1/seller/accounts/${ownerId}`, body, owner.headers)).response.status, 403);
    }
    assert.equal((await f.request('PATCH', `/api/v1/seller/accounts/${manager.id}`, { role: 'OWNER' }, owner.headers)).response.status, 400);
    assert.equal((await f.request('PATCH', `/api/v1/seller/accounts/${manager.id}`, { resetPassword: 'Another-Temp-Pass-9!' }, owner.headers)).data.mustChangePassword, true);
    assert.equal((await f.request('GET', '/api/v1/seller/orders', null, manager.headers)).response.status, 401);   // reset ends their sessions
    assert.equal((await f.request('PATCH', `/api/v1/seller/accounts/${manager.id}`, { role: 'STAFF' }, manager.headers)).response.status, 401);
  } finally { await f.close(); }
});

test('host recovery resets the Owner password and forces a change; unknown accounts are refused', async () => {
  const f = await sellerFixture();
  try {
    const owner = await f.login();
    await resetPasswordFromHost(f.app.database, f.config.username.toUpperCase(), STRONG);
    assert.equal((await f.request('GET', '/api/v1/seller/orders', null, owner.headers)).response.status, 401);
    assert.equal((await f.request('POST', '/api/v1/seller/session', { username: f.config.username, password: f.config.password }, { origin: f.origin })).response.status, 401);
    const again = await f.login(f.config.username, STRONG);
    assert.equal(again.session.mustChangePassword, true);
    await assert.rejects(resetPasswordFromHost(f.app.database, 'nobody', STRONG), /No account/);
    await assert.rejects(resetPasswordFromHost(f.app.database, f.config.username, 'short'), /12 to 256/);
    assert.equal(await authenticate(f.app.database, 'nobody', STRONG), null);
  } finally { await f.close(); }
});

test('a quick sign-in site cannot manage accounts or change the Owner password', async () => {
  const f = await sellerFixture({ sellerQuickLogin: true });
  try {
    const quick = await f.request('POST', '/api/v1/seller/demo-session', null, { origin: f.origin });
    assert.equal(quick.response.status, 200);
    const headers = { origin: f.origin, cookie: quick.response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': quick.data.csrfToken };
    assert.equal(quick.data.quickLogin, true);
    assert.equal((await f.request('GET', '/api/v1/seller/accounts', null, headers)).response.status, 403);
    assert.equal((await f.request('POST', '/api/v1/seller/accounts', { username: 'intruder', role: 'MANAGER', password: STRONG }, headers)).response.status, 403);
    assert.equal((await f.request('POST', '/api/v1/seller/account/password', { currentPassword: f.config.password, newPassword: NEXT }, headers)).response.status, 403);
    assert.equal((await f.app.database.get('SELECT COUNT(*) AS n FROM seller_account')).n, 1);
    assert.equal((await f.request('POST', '/api/v1/seller/session', { username: f.config.username, password: f.config.password }, { origin: f.origin })).response.status, 200);
  } finally { await f.close(); }
});

test('Managers and Staff can learn that WhatsApp is on, but only the Owner sees the connection', async () => {
  const f = await sellerFixture({ integrationKeys: parseKeyFile(`k1=${randomBytes(32).toString('base64')}`) });
  try {
    const { owner, manager, staff } = await team(f);
    const seen = async (who) => (await f.request('GET', '/api/v1/seller/integrations/whatsapp', null, who.headers)).data;
    assert.equal((await seen(owner)).available, true);
    assert.ok(Object.hasOwn(await seen(owner), 'webhookUrl'));
    for (const who of [manager, staff]) assert.deepEqual(await seen(who), { available: true, connections: [] });
  } finally { await f.close(); }
});

test('a reset Owner on a quick sign-in site is not locked out by the temporary-password rule', async () => {
  const f = await sellerFixture({ sellerQuickLogin: true });
  try {
    await resetPasswordFromHost(f.app.database, f.config.username, STRONG);
    assert.equal((await f.app.database.get('SELECT must_change_password AS m FROM seller_account')).m, 1);
    const quick = await f.request('POST', '/api/v1/seller/demo-session', null, { origin: f.origin });
    const headers = { origin: f.origin, cookie: quick.response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': quick.data.csrfToken };
    assert.equal(quick.data.mustChangePassword, false);
    assert.equal((await f.request('GET', '/api/v1/seller/orders', null, headers)).response.status, 200);
    await resetPasswordFromHost(f.app.database, f.config.username, STRONG, { forceChange: false });
    assert.equal((await f.app.database.get('SELECT must_change_password AS m FROM seller_account')).m, 0);
  } finally { await f.close(); }
});
