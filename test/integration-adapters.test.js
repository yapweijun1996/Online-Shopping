import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openNodeStore } from '../src/store.js';
import { openDatabase } from '../src/db.js';
import { initializeShop } from '../src/shop-setup.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { createOrder } from '../src/orders.js';
import { createSyntheticIntegrationLedger } from '../src/integration-ledger.js';
import { buildNinjaParcelRequest, buildWhatsAppMessageRequest, restoreIntegrationRequest, normalizeProviderResponse, normalizeProviderStatus } from '../src/integration-requests.js';
import { createFixtureIntegrationTransport, createSyntheticProviderAdapter } from '../src/integration-adapters.js';

const code = expected => error => error.code === expected;
const binding = (provider = 'NINJA_VAN', company = 'alpha', connectionId = provider.toLowerCase()) => ({
  companyId: `synthetic-${company}`, connectionId, accountId: `synthetic-${company}-${provider.toLowerCase().replaceAll('_','-')}`, provider, environment: 'SYNTHETIC',
});
const contact = () => ({ name: 'Fictional Person', phone: '+60123456789', email: 'fictional@example.invalid',
  address: { line1: 'Synthetic Street', city: 'Synthetic City', region: 'Synthetic Region', postcode: '00000', country: 'MY' } });
const parcel = () => ({ country: 'MY', orderRef: 'synthetic-order', requestedTrackingNumber: 'SYNTHETIC001', sender: contact(), recipient: contact(),
  weightGrams: 550, deliveryDate: '2026-10-05', deliverySlot: { start: '09:00', end: '18:00' } });
const message = () => ({ phoneNumberId: '000000000000000', apiVersion: 'v25.0', recipient: '+60123456789', kind: 'TEXT', body: 'Synthetic order update',
  consent: { optIn: true, at: 1_800_000_000, version: 'synthetic-opt-in-v1' }, lastInboundAt: 1_800_000_000 });
function fixture(t, wrap = store => store) {
  const store = openNodeStore(':memory:'); t.after(() => store.close()); let time = 1_800_000_000;
  const ledger = createSyntheticIntegrationLedger(wrap(store), { mode: 'SYNTHETIC', now: () => time });
  for (const name of ['alpha','beta']) {
    ledger.addCompany(`synthetic-${name}`);
    for (const provider of ['NINJA_VAN','WHATSAPP_CLOUD']) {
      const b = binding(provider, name);
      ledger.forCompany(b.companyId).addConnection({ id: b.connectionId, provider, environment: b.environment, accountId: b.accountId });
    }
  }
  const b = binding(), scope = ledger.forCompany(b.companyId);
  return { store, ledger, scope, b, now: () => time, advance: value => { time += value; },
    adapter(transport, bound = b) { return createSyntheticProviderAdapter({ ledger, ...bound, transport, now: () => time }); } };
}

test('verified Ninja parcel subset creates an immutable, credential-free sandbox descriptor', () => {
  const input = parcel(), prepared = buildNinjaParcelRequest(binding(), input); input.recipient.address.line1 = 'Later change';
  assert.equal(prepared.request.url, 'https://api-sandbox.ninjavan.co/sg/4.2/orders');
  assert.deepEqual(prepared.request.headers, { 'content-type': 'application/json' });
  assert.equal(prepared.request.body.parcel_job.dimensions.weight, 0.55);
  assert.equal(prepared.request.body.parcel_job.is_pickup_required, false);
  assert.equal(prepared.request.body.parcel_job.delivery_timeslot.timezone, 'Asia/Kuala_Lumpur');
  assert.equal(prepared.request.body.to.address.address1, 'Synthetic Street');
  assert.ok(Object.isFrozen(prepared.request.body.to.address));
  assert.throws(() => { prepared.request.url = 'https://foreign.invalid'; }, TypeError);
  const sg = parcel(); sg.country = 'SG'; sg.sender.address.country = 'SG'; sg.recipient.address.country = 'SG';
  assert.equal(buildNinjaParcelRequest(binding(), sg).request.body.parcel_job.delivery_timeslot.timezone, 'Asia/Singapore');
  for (const changed of [{ ...parcel(), deliveryDate: '2026-02-30' }, { ...parcel(), country: 'US' }, { ...parcel(), weightGrams: 0 },
    { ...parcel(), cashOnDelivery: 1 }, { ...parcel(), deliverySlot: { start: '01:00', end: '02:00' } }]) assert.throws(() => buildNinjaParcelRequest(binding(), changed), code('INVALID_INPUT'));
  assert.throws(() => buildNinjaParcelRequest({ ...binding(), environment: 'PRODUCTION' }, parcel()), code('INVALID_INPUT'));
});

test('verified WhatsApp text and positional template bodies exclude credentials, previews and guessed versions', () => {
  const b = binding('WHATSAPP_CLOUD'), prepared = buildWhatsAppMessageRequest(b, message());
  assert.equal(prepared.request.url, 'https://graph.facebook.com/v25.0/000000000000000/messages');
  assert.deepEqual(prepared.request.body.text, { preview_url: false, body: 'Synthetic order update' });
  const { body, lastInboundAt, ...base } = message();
  const template = buildWhatsAppMessageRequest(b, { ...base, kind: 'TEMPLATE', template: 'synthetic_order_update', templateApproved: true, language: 'en_US', parameters: ['Fictional Person','SYNTHETIC001'] });
  assert.deepEqual(template.request.body.template.components[0].parameters, [{ type: 'text', text: 'Fictional Person' }, { type: 'text', text: 'SYNTHETIC001' }]);
  for (const changed of [{ ...message(), apiVersion: 'v99.0' }, { ...message(), phoneNumberId: '../different' }, { ...message(), recipient: '123' },
    { ...message(), accessToken: 'synthetic-token' }, { ...message(), body: 'a'.repeat(4001) }]) assert.throws(() => buildWhatsAppMessageRequest(b, changed), code('INVALID_INPUT'));
});

test('only branded immutable descriptors can be queued; snapshots cannot change their target', t => {
  const f = fixture(t), prepared = buildNinjaParcelRequest(f.b, parcel());
  assert.throws(() => f.scope.queueProviderRequest(f.b.connectionId, 'forged', structuredClone(prepared)), code('INVALID_INPUT'));
  const queued = f.scope.queueProviderRequest(f.b.connectionId, 'same', prepared);
  assert.equal(f.scope.queueProviderRequest(f.b.connectionId, 'same', buildNinjaParcelRequest(f.b, parcel())).operationId, queued.operationId);
  assert.throws(() => f.scope.queueProviderRequest(f.b.connectionId, 'same', buildNinjaParcelRequest(f.b, { ...parcel(), weightGrams: 551 })), code('IDEMPOTENCY_CONFLICT'));
  const restored = restoreIntegrationRequest(f.scope.getOperation(queued.operationId).intent);
  assert.equal(restored.request.url, prepared.request.url);
  for (const mutation of [value => { value.request.url = 'https://foreign.invalid'; }, value => { value.request.headers.authorization = 'Bearer synthetic-token'; },
    value => { value.request.body.to.name = 'Different person'; }, value => { value.policy = {}; }]) {
    const changed = structuredClone(prepared); mutation(changed); assert.throws(() => restoreIntegrationRequest(changed), code('INVALID_INPUT'));
  }
});

test('default adapter stays disconnected and arbitrary transports cannot be injected', async t => {
  const f = fixture(t), queued = f.scope.queueProviderRequest(f.b.connectionId, 'none', buildNinjaParcelRequest(f.b, parcel()));
  await assert.rejects(f.adapter().execute(queued.operationId), code('NOT_CONFIGURED'));
  assert.equal(f.scope.getOperation(queued.operationId).state, 'PENDING');
  for (const transport of [fetch, { send: fetch }, () => {}, { send() { throw new Error('must not run'); } }]) assert.throws(() => f.adapter(transport), code('SYNTHETIC_ONLY'));
  assert.throws(() => createFixtureIntegrationTransport([{ status: 200, body: {}, url: 'https://foreign.invalid' }]), code('INVALID_INPUT'));
  assert.throws(() => createFixtureIntegrationTransport([{ networkFailure: 'TIMEOUT', status: 200 }]), code('INVALID_INPUT'));
  let invoked = false;
  assert.throws(() => createFixtureIntegrationTransport([{ status: 200, body: { toJSON() { invoked = true; return {}; } } }]), code('INVALID_INPUT'));
  assert.throws(() => createFixtureIntegrationTransport([{ status: 200, body: Object.defineProperty({}, 'secret', { enumerable: true, get() { invoked = true; return 'synthetic'; } }) }]), code('INVALID_INPUT'));
  assert.equal(invoked, false);
  assert.throws(() => createFixtureIntegrationTransport([{ status: 200, body: [1,,3] }]), code('INVALID_INPUT'));
});

test('accepted fixture response is persisted atomically and DONE replay never submits twice', async t => {
  const f = fixture(t), transport = createFixtureIntegrationTransport([{ status: 201, body: { tracking_number: 'SYNTHETIC001', to: { name: 'private echo' } } }]);
  const queued = f.scope.queueProviderRequest(f.b.connectionId, 'accepted', buildNinjaParcelRequest(f.b, parcel())), adapter = f.adapter(transport);
  const result = await adapter.execute(queued.operationId);
  assert.equal(result.state, 'DONE'); assert.equal(result.result.category, 'ACCEPTED');
  assert.deepEqual(f.scope.getOperation(queued.operationId).providerResult, result.result);
  assert.equal((await adapter.execute(queued.operationId)).replayed, true); assert.equal(transport.requests().length, 1);
  assert.doesNotMatch(f.store.get('SELECT result_json FROM integration_demo_provider_result').result_json, /private echo|name|address/);
});

test('foreign operation, account changes and mismatched connection never reach the transport', async t => {
  const f = fixture(t), transport = createFixtureIntegrationTransport([{ status: 201, body: { tracking_number: 'SYNTHETIC001' } }]);
  const queued = f.scope.queueProviderRequest(f.b.connectionId, 'foreign', buildNinjaParcelRequest(f.b, parcel()));
  await assert.rejects(f.adapter(transport, binding('NINJA_VAN','beta')).execute(queued.operationId), code('NOT_FOUND'));
  await assert.rejects(f.adapter(transport, binding('WHATSAPP_CLOUD')).execute(queued.operationId), code('NOT_FOUND'));
  assert.throws(() => f.ledger.forCompany('synthetic-beta').queueProviderRequest(f.b.connectionId, 'foreign', buildNinjaParcelRequest(f.b, parcel())), code('NOT_FOUND'));
  f.store.run('UPDATE integration_demo_connection SET account_id = ? WHERE company_id = ? AND id = ?', 'synthetic-changed', f.b.companyId, f.b.connectionId);
  await assert.rejects(f.adapter(transport).execute(queued.operationId), code('NOT_FOUND'));
  assert.equal(transport.requests().length, 0); assert.equal(f.scope.getOperation(queued.operationId).state, 'PENDING');
});

test('message permission is checked at queue and again before execution; old DONE facts remain replayable', async t => {
  const f = fixture(t), b = binding('WHATSAPP_CLOUD'), transport = createFixtureIntegrationTransport([{ status: 200, body: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.SYNTHETIC001' }] } }]);
  const prepared = buildWhatsAppMessageRequest(b, message());
  const queued = f.scope.queueProviderRequest(b.connectionId, 'done', prepared);
  assert.equal((await f.adapter(transport, b).execute(queued.operationId)).state, 'DONE');
  const waiting = f.scope.queueProviderRequest(b.connectionId, 'waiting', prepared);
  f.advance(24 * 60 * 60 * 1000);
  assert.equal(f.scope.queueProviderRequest(b.connectionId, 'done', prepared).replayed, true);
  assert.equal((await f.adapter(transport, b).execute(queued.operationId)).replayed, true);
  await assert.rejects(f.adapter(transport, b).execute(waiting.operationId), code('MESSAGE_WINDOW_CLOSED'));
  assert.throws(() => f.scope.queueProviderRequest(b.connectionId, 'new', prepared), code('MESSAGE_WINDOW_CLOSED'));
  assert.equal(transport.requests().length, 1); assert.equal(f.scope.getOperation(waiting.operationId).state, 'PENDING');
  const { body, lastInboundAt, ...base } = message();
  assert.throws(() => f.scope.queueProviderRequest(b.connectionId, 'unapproved', buildWhatsAppMessageRequest(b, { ...base, kind: 'TEMPLATE', template: 'synthetic_order_update', templateApproved: false, language: 'en_US', parameters: ['Fictional Person'] })), code('APPROVED_TEMPLATE_REQUIRED'));
});

test('timeouts and unverifiable responses require explicit reconciliation before a retry', async t => {
  const f = fixture(t), transport = createFixtureIntegrationTransport([{ networkFailure: 'TIMEOUT' }, { status: 201, body: { tracking_number: 'SYNTHETIC001' } }]);
  const queued = f.scope.queueProviderRequest(f.b.connectionId, 'unknown', buildNinjaParcelRequest(f.b, parcel())), adapter = f.adapter(transport);
  assert.equal((await adapter.execute(queued.operationId)).state, 'RECONCILE');
  await assert.rejects(adapter.execute(queued.operationId), code('INVALID_STATE')); assert.equal(transport.requests().length, 1);
  f.scope.recordReconciliation(queued.operationId, 'ABSENT'); assert.equal((await adapter.execute(queued.operationId)).state, 'DONE');
  assert.equal(transport.requests().length, 2);
  const found = f.scope.queueProviderRequest(f.b.connectionId, 'found', buildNinjaParcelRequest(f.b, parcel()));
  const unknown = createFixtureIntegrationTransport([{ status: 200, body: {} }]);
  assert.equal((await f.adapter(unknown).execute(found.operationId)).state, 'RECONCILE');
  f.scope.recordReconciliation(found.operationId, 'FOUND');
  assert.equal((await f.adapter(unknown).execute(found.operationId)).replayed, true); assert.equal(unknown.requests().length, 1);
});

test('verified rejection fails without resending; rate limits and conflicts remain uncertain', async t => {
  const f = fixture(t), transport = createFixtureIntegrationTransport([{ status: 400, body: { error: { code: 'INVALID_FIELD', message: 'private error' } } }]);
  const queued = f.scope.queueProviderRequest(f.b.connectionId, 'invalid', buildNinjaParcelRequest(f.b, parcel())), adapter = f.adapter(transport);
  assert.equal((await adapter.execute(queued.operationId)).state, 'FAILED'); assert.equal((await adapter.execute(queued.operationId)).replayed, true);
  assert.equal(transport.requests().length, 1); assert.doesNotMatch(JSON.stringify(f.scope.getOperation(queued.operationId).providerResult), /private error/);
  for (const provider of ['NINJA_VAN','WHATSAPP_CLOUD']) {
    const error = { code: provider === 'NINJA_VAN' ? 'THROTTLED' : 131000, message: 'private message' };
    for (const status of [409,429,500,503]) assert.equal(normalizeProviderResponse(provider, { status, body: { error } }).outcome, 'UNKNOWN');
    for (const status of [401,403]) assert.equal(normalizeProviderResponse(provider, { status, body: { error } }).category, 'CONFIGURATION_REQUIRED');
    assert.equal(normalizeProviderResponse(provider, { status: 400, body: { error: { message: 'missing code' } } }).outcome, 'UNKNOWN');
  }
});

test('provider-result persistence failure rolls back state, leaving a lease for reconciliation', async t => {
  const f = fixture(t, store => ({ ...store, run(sql, ...args) { if (sql.startsWith('INSERT INTO integration_demo_provider_result')) throw new Error('synthetic persistence failure'); return store.run(sql, ...args); } }));
  const transport = createFixtureIntegrationTransport([{ status: 201, body: { tracking_number: 'SYNTHETIC001' } }]);
  const queued = f.scope.queueProviderRequest(f.b.connectionId, 'fault', buildNinjaParcelRequest(f.b, parcel()));
  await assert.rejects(f.adapter(transport).execute(queued.operationId), /synthetic persistence failure/);
  assert.equal(f.scope.getOperation(queued.operationId).state, 'LEASED'); assert.equal(f.scope.getOperation(queued.operationId).providerResult, null);
  await assert.rejects(f.adapter(transport).execute(queued.operationId), code('INVALID_STATE'));
  f.advance(30000); assert.equal((await f.adapter(transport).execute(queued.operationId)).state, 'RECONCILE'); assert.equal(transport.requests().length, 1);
});

test('concurrent execution sends once and expired replies cannot persist an accepted result', async t => {
  const f = fixture(t), transport = createFixtureIntegrationTransport([{ status: 201, body: { tracking_number: 'SYNTHETIC001' } }]);
  const queued = f.scope.queueProviderRequest(f.b.connectionId, 'concurrent', buildNinjaParcelRequest(f.b, parcel())), adapter = f.adapter(transport);
  const first = adapter.execute(queued.operationId);
  await assert.rejects(adapter.execute(queued.operationId), code('INVALID_STATE'));
  assert.equal((await first).state, 'DONE'); assert.equal(transport.requests().length, 1);
  const lateTransport = createFixtureIntegrationTransport([{ status: 201, body: { tracking_number: 'SYNTHETIC002' } }]);
  const late = f.scope.queueProviderRequest(f.b.connectionId, 'late', buildNinjaParcelRequest(f.b, parcel()));
  const lateExecution = f.adapter(lateTransport).execute(late.operationId); f.advance(30000);
  const result = await lateExecution; assert.equal(result.state, 'RECONCILE'); assert.equal(result.result, null);
  assert.equal(f.scope.getOperation(late.operationId).providerResult, null); assert.equal(lateTransport.requests().length, 1);
});

test('synthetic shipment/message execution leaves actual order, currency, consent and audit snapshots unchanged', async t => {
  const store = openDatabase(':memory:'); t.after(() => store.close()); initializeShop(store, { shopMode: 'public-demo' });
  createCategory(store, { code: 'SYNTHETIC', label: 'Synthetic Category' });
  const product = createProduct(store, { sku: 'synthetic-price', name: 'Fictional Product', description: 'Fictional description', category: 'SYNTHETIC', priceMinor: 1234, currency: 'MYR', active: true });
  createOrder(store, 'synthetic-checkout-key-001', { buyer: { fullName: 'Fictional Buyer', whatsappPhone: '+60123456789', email: null }, whatsappOrderContactOptIn: true,
    locale: 'en', deliveries: [{ recipient: { fullName: 'Fictional Recipient', phone: '+60123456789' }, address: { line1: 'Synthetic Street', postcode: '47810', country: 'MY' },
      items: [{ productId: product.id, quantity: 1, expectedPriceMinor: 1234, expectedCurrency: 'MYR' }] }] });
  const tables = ['shop_order','delivery','order_item','order_event','checkout_idempotency','product'];
  const snapshots = () => Object.fromEntries(tables.map(table => [table, store.all(`SELECT * FROM ${table}`)]));
  const before = snapshots();
  const ledger = createSyntheticIntegrationLedger(store, { mode: 'SYNTHETIC', now: () => 1_800_000_000 }); ledger.addCompany('synthetic-alpha');
  for (const provider of ['NINJA_VAN','WHATSAPP_CLOUD']) {
    const b = binding(provider), scope = ledger.forCompany(b.companyId);
    scope.addConnection({ id: b.connectionId, provider, environment: b.environment, accountId: b.accountId });
    const prepared = provider === 'NINJA_VAN' ? buildNinjaParcelRequest(b, parcel()) : buildWhatsAppMessageRequest(b, message());
    const queued = scope.queueProviderRequest(b.connectionId, 'snapshot', prepared);
    const response = provider === 'NINJA_VAN' ? { tracking_number: 'SYNTHETIC001' } : { messaging_product: 'whatsapp', messages: [{ id: 'wamid.SYNTHETIC001' }] };
    const adapter = createSyntheticProviderAdapter({ ledger, ...b, now: () => 1_800_000_000, transport: createFixtureIntegrationTransport([{ status: 200, body: response }]) });
    assert.equal((await adapter.execute(queued.operationId)).state, 'DONE');
    scope.receiveSyntheticEvent(b.connectionId, { accountId: b.accountId, eventId: 'synthetic-delivered', subjectId: 'synthetic-subject', sequence: 1, status: 'DELIVERED' });
  }
  assert.deepEqual(snapshots(), before);
});

test('known status mapping preserves receipt versus delivery and quarantines unknown or prototype keys', t => {
  const f = fixture(t);
  assert.deepEqual(normalizeProviderStatus('NINJA_VAN','Delivered'), { status: 'DELIVERED', requiresReconciliation: false });
  assert.equal(normalizeProviderStatus('WHATSAPP_CLOUD','sent').status, 'SENT');
  assert.equal(normalizeProviderStatus('WHATSAPP_CLOUD','read').status, 'READ');
  for (const provider of ['NINJA_VAN','WHATSAPP_CLOUD']) for (const status of ['unknown-new-status','__proto__','constructor']) assert.deepEqual(normalizeProviderStatus(provider,status), { status: 'UNKNOWN', requiresReconciliation: true });
  const event = { accountId: f.b.accountId, eventId: 'synthetic-event-new', subjectId: 'SYNTHETIC001', sequence: 2, status: normalizeProviderStatus('NINJA_VAN','Delivered').status };
  assert.equal(f.scope.receiveSyntheticEvent(f.b.connectionId, event).applied, true);
  assert.equal(f.scope.receiveSyntheticEvent(f.b.connectionId, event).duplicate, true);
  assert.equal(f.scope.receiveSyntheticEvent(f.b.connectionId, { ...event, eventId: 'synthetic-event-old', sequence: 1, status: 'IN_TRANSIT' }).applied, false);
  assert.equal(f.scope.getProjection(f.b.connectionId, 'SYNTHETIC001').status, 'DELIVERED');
});

test('adapter modules remain outside normal startup and contain no network or credential implementation', () => {
  for (const file of ['src/app.js','src/server.js','src/worker.js','src/db.js']) assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url),'utf8'), /integration-adapters|integration-requests|integration-ledger/);
  for (const file of ['integration-adapters','integration-requests']) assert.doesNotMatch(readFileSync(new URL(`../src/${file}.js`, import.meta.url),'utf8'), /\bfetch\s*\(|node:https|node:http|Authorization|Bearer|access_token/);
});
