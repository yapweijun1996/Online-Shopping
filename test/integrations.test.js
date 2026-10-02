import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openNodeStore } from '../src/store.js';
import { openDatabase, SCHEMA_VERSION } from '../src/db.js';
import { createSyntheticIntegrationLedger } from '../src/integration-ledger.js';
import { ninjaContractLocation, verifyNinjaSignature, messagingPolicy } from '../src/integration-contracts.js';
import { integrationCatalog } from '../public/shared/integration-catalog.js';
import { createApi } from '../src/app.js';
import { createSession, cookieFor } from '../src/auth.js';
import { initializeShop } from '../src/shop-setup.js';

const code = expected => error => error.code === expected;
const parcel = () => ({ orderRef: 'synthetic-order', weightGrams: 500, addressSnapshot: {
  name: 'Fictional Recipient', line1: 'Synthetic Street', city: 'Demo City', region: 'Demo Region', postcode: '00000', country: 'MY',
} });
function fixture(t, wrapped = store => store) {
  const store = openNodeStore(':memory:'); t.after(() => store.close());
  let time = 1_800_000_000;
  const ledger = createSyntheticIntegrationLedger(wrapped(store), { mode: 'SYNTHETIC', now: () => time });
  ledger.addCompany('synthetic-alpha'); ledger.addCompany('synthetic-beta');
  const alpha = ledger.forCompany('synthetic-alpha'), beta = ledger.forCompany('synthetic-beta');
  for (const [name, company] of [['alpha', alpha], ['beta', beta]]) company.addConnection({ id: `ninja-${name}`, provider: 'NINJA_VAN', environment: 'SYNTHETIC', accountId: `synthetic-${name}` });
  return { store, ledger, alpha, beta, advance: milliseconds => { time += milliseconds; }, now: () => time };
}

test('no integration schema or enabled capability appears on normal startup or status read', async t => {
  const store = openDatabase(':memory:'); t.after(() => store.close());
  initializeShop(store, { shopMode: 'public-demo', username: 'fictional-owner' });
  const session = createSession(store), api = createApi({ store, config: { publicOrigin: 'https://fixture.test', shopMode: 'public-demo' } });
  assert.equal((await api(new Request('https://fixture.test/api/v1/seller/integrations'))).status, 401);
  const cookie = cookieFor(session.token, session.maxAge, false).split(';')[0];
  const response = await api(new Request('https://fixture.test/api/v1/seller/integrations', { headers: { cookie } }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json(); assert.deepEqual(result, integrationCatalog());
  assert.equal(result.dispatchEnabled, false); assert.equal(result.providers.length, 4);
  assert.ok(result.providers.every(provider => provider.status === 'NOT_CONFIGURED' && provider.enabledCapabilities.length === 0 && !provider.readiness.liveAccepted));
  assert.equal(result.providers.find(provider => provider.id === 'SPX').plannedCapabilities.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /secret_reference|secretReference|access_token|accountId/);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.equal(store.get("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'integration_demo_%'").n, 0);
  assert.equal((await api(new Request('https://fixture.test/api/v1/seller/integrations', { method: 'POST', headers: { cookie } }))).status, 404);
  const copy = integrationCatalog(); copy.providers[0].status = 'forged'; assert.equal(integrationCatalog().providers[0].status, 'NOT_CONFIGURED');
});

test('fictional company status requires the current membership and rejects forged company context', async t => {
  const store = openDatabase(':memory:'); t.after(() => store.close()); initializeShop(store, { shopMode: 'public-demo' });
  const api = createApi({ store, config: { publicOrigin: 'https://fixture.test', shopMode: 'public-demo' } });
  const login = await api(new Request('https://fixture.test/api/v1/demo/session', { method: 'POST', headers: { origin: 'https://fixture.test', 'content-type': 'application/json' }, body: JSON.stringify({ role: 'SELLER' }) }));
  assert.equal(login.status, 201); const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = company => api(new Request(`https://fixture.test/api/v1/demo/companies/${company}/integrations`, { headers: { cookie, 'x-company-id': 'company-beta', 'x-role': 'ADMIN' } }));
  const own = await get('company-alpha'); assert.equal(own.status, 200); assert.equal((await own.json()).companyId, 'company-alpha');
  assert.equal((await get('company-beta')).status, 404); assert.equal((await get('unknown')).status, 404);
  assert.equal((await api(new Request('https://fixture.test/api/v1/demo/companies/company-alpha/integrations'))).status, 401);
});

test('ledger refuses implicit mode, live attempts, private contracts and raw or foreign credentials', t => {
  const f = fixture(t);
  assert.throws(() => createSyntheticIntegrationLedger(f.store), code('SYNTHETIC_ONLY'));
  assert.throws(() => f.ledger.addCompany('actual-company'), code('SYNTHETIC_ONLY'));
  const connection = { id: 'sandbox', provider: 'NINJA_VAN', environment: 'SANDBOX', accountId: 'synthetic-sandbox' };
  assert.throws(() => f.alpha.addConnection({ ...connection, apiKey: 'synthetic-key' }), code('INVALID_INPUT'));
  assert.throws(() => f.alpha.addConnection({ ...connection, secretReference: 'secret-ref://synthetic-beta/NINJA_VAN/SANDBOX/key' }), code('INVALID_INPUT'));
  assert.throws(() => f.alpha.addConnection({ ...connection, secretReference: 'secret-ref://synthetic-alpha/WHATSAPP_CLOUD/SANDBOX/key' }), code('INVALID_INPUT'));
  const saved = f.alpha.addConnection({ ...connection, secretReference: 'secret-ref://synthetic-alpha/NINJA_VAN/SANDBOX/key' });
  assert.equal(saved.status, 'NOT_CONFIGURED'); assert.equal(saved.dispatchEnabled, false);
  assert.throws(() => f.alpha.createShipment('sandbox', 'key', parcel()), code('NOT_CONFIGURED'));
  for (const provider of ['SPX','WHATSAPP_QR']) {
    f.alpha.addConnection({ id: provider, provider, environment: 'SYNTHETIC', accountId: 'synthetic-' + provider });
    assert.throws(() => f.alpha.createShipment(provider, 'key', parcel()), code('CONTRACT_REQUIRED'));
  }
  assert.throws(() => f.beta.addConnection({ id: 'duplicate-account', provider: 'NINJA_VAN', environment: 'SYNTHETIC', accountId: 'synthetic-alpha' }));
});

test('scoped idempotency preserves address snapshots and rejects foreign IDs and changed payloads', t => {
  const f = fixture(t), input = parcel(), result = f.alpha.createShipment('ninja-alpha', 'same-key', input);
  input.addressSnapshot.line1 = 'Changed after submit';
  assert.equal(f.alpha.getOperation(result.operationId).intent.addressSnapshot.line1, 'Synthetic Street');
  const replay = f.alpha.createShipment('ninja-alpha', 'same-key', { weightGrams: 500, addressSnapshot: parcel().addressSnapshot, orderRef: 'synthetic-order' });
  assert.equal(replay.replayed, true); assert.equal(replay.operationId, result.operationId);
  assert.throws(() => f.alpha.createShipment('ninja-alpha', 'same-key', input), code('IDEMPOTENCY_CONFLICT'));
  assert.notEqual(f.beta.createShipment('ninja-beta', 'same-key', parcel()).operationId, result.operationId);
  assert.throws(() => f.alpha.createShipment('ninja-beta', 'x', parcel()), code('NOT_FOUND'));
  assert.throws(() => f.beta.getOperation(result.operationId), code('NOT_FOUND'));
  assert.throws(() => f.beta.beginAttempt(result.outboxId), code('NOT_FOUND'));
  assert.throws(() => f.store.run("INSERT INTO integration_demo_intent(company_id,id,connection_id,kind,snapshot_json) VALUES ('synthetic-alpha','forged','ninja-beta','SHIPMENT','{}')"));
});

test('intent, operation and outbox all roll back if outbox persistence fails', t => {
  const f = fixture(t, store => ({ ...store, run(sql, ...args) { if (sql.startsWith('INSERT INTO integration_demo_outbox')) throw new Error('synthetic fault'); return store.run(sql, ...args); } }));
  assert.throws(() => f.alpha.createShipment('ninja-alpha', 'failure', parcel()), /synthetic fault/);
  for (const table of ['intent','operation','outbox']) assert.equal(f.store.get(`SELECT count(*) n FROM integration_demo_${table}`).n, 0);
});

test('unknown outcomes require reconciliation; expired and stale leases cannot finalize or resend', t => {
  const f = fixture(t), op = f.alpha.createShipment('ninja-alpha', 'uncertain', parcel()), attempt = f.alpha.beginAttempt(op.outboxId);
  assert.throws(() => f.alpha.beginAttempt(op.outboxId), code('INVALID_STATE'));
  assert.equal(f.alpha.finishAttempt(op.outboxId, attempt.leaseToken, 'UNKNOWN').state, 'RECONCILE');
  assert.throws(() => f.alpha.beginAttempt(op.outboxId), code('INVALID_STATE'));
  assert.throws(() => f.beta.recordReconciliation(op.outboxId, 'ABSENT'), code('NOT_FOUND'));
  assert.throws(() => f.alpha.recordReconciliation(op.outboxId, 'ABSENT'), code('PROVIDER_LOOKUP_REQUIRED'));
  assert.throws(() => f.alpha.finishAttempt(op.outboxId, attempt.leaseToken, 'ACKNOWLEDGED'), code('STALE_ATTEMPT'));
  assert.throws(() => f.alpha.recordReconciliation(op.outboxId, 'FOUND'), code('PROVIDER_LOOKUP_REQUIRED'));
  assert.equal(f.alpha.getOperation(op.operationId).state, 'RECONCILE');
  assert.throws(() => f.alpha.beginAttempt(op.outboxId), code('INVALID_STATE'));
  const expired = f.alpha.createShipment('ninja-alpha', 'expired', parcel()); f.alpha.beginAttempt(expired.outboxId); f.advance(30001);
  assert.equal(f.alpha.beginAttempt(expired.outboxId).state, 'RECONCILE');
});

test('known safe retries stop at three attempts and foreign lease tokens cannot change the operation', t => {
  const f = fixture(t), op = f.alpha.createShipment('ninja-alpha', 'retry', parcel());
  for (let i = 1; i <= 3; i++) {
    const attempt = f.alpha.beginAttempt(op.outboxId);
    assert.throws(() => f.beta.finishAttempt(op.outboxId, attempt.leaseToken, 'ACKNOWLEDGED'), code('NOT_FOUND'));
    assert.equal(f.alpha.finishAttempt(op.outboxId, attempt.leaseToken, 'SAFE_RETRY').state, i === 3 ? 'FAILED' : 'RETRY');
  }
  assert.throws(() => f.alpha.beginAttempt(op.outboxId), code('INVALID_STATE'));
});

test('inbox verifies account binding, deduplicates, rejects changed events and retains older events without regression', t => {
  const f = fixture(t), event = { accountId: 'synthetic-alpha', eventId: 'e1', subjectId: 'synthetic-shipment', sequence: 2, status: 'DELIVERED' };
  assert.throws(() => f.alpha.receiveSyntheticEvent('ninja-alpha', { ...event, accountId: 'synthetic-beta' }), code('NOT_FOUND'));
  assert.throws(() => f.beta.receiveSyntheticEvent('ninja-alpha', event), code('NOT_FOUND'));
  assert.deepEqual(f.alpha.receiveSyntheticEvent('ninja-alpha', event), { duplicate: false, applied: true });
  assert.deepEqual(f.alpha.receiveSyntheticEvent('ninja-alpha', { ...event }), { duplicate: true, applied: true });
  assert.throws(() => f.alpha.receiveSyntheticEvent('ninja-alpha', { ...event, status: 'IN_TRANSIT' }), code('EVENT_CONFLICT'));
  assert.deepEqual(f.alpha.receiveSyntheticEvent('ninja-alpha', { ...event, eventId: 'e0', sequence: 1, status: 'IN_TRANSIT' }), { duplicate: false, applied: false });
  assert.equal(f.alpha.getProjection('ninja-alpha', 'synthetic-shipment').status, 'DELIVERED');
  assert.throws(() => f.beta.getProjection('ninja-alpha', 'synthetic-shipment'), code('NOT_FOUND'));
  assert.equal(f.store.get('SELECT count(*) n FROM integration_demo_inbox').n, 2);
});

test('inbox and projection roll back together, without touching an order or payment ledger', t => {
  const f = fixture(t, store => ({ ...store, run(sql, ...args) { if (sql.startsWith('INSERT INTO integration_demo_projection')) throw new Error('synthetic projection fault'); return store.run(sql, ...args); } }));
  f.store.exec("CREATE TABLE payment_fixture(balance INTEGER); INSERT INTO payment_fixture VALUES(123); CREATE TABLE order_fixture(status TEXT); INSERT INTO order_fixture VALUES('CONFIRMED');");
  const event = { accountId: 'synthetic-alpha', eventId: 'e1', subjectId: 'shipment', sequence: 1, status: 'DELIVERED' };
  assert.throws(() => f.alpha.receiveSyntheticEvent('ninja-alpha', event), /synthetic projection fault/);
  assert.equal(f.store.get('SELECT count(*) n FROM integration_demo_inbox').n, 0);
  assert.equal(f.store.get('SELECT balance FROM payment_fixture').balance, 123); assert.equal(f.store.get('SELECT status FROM order_fixture').status, 'CONFIRMED');
});

test('legacy caller consent and approval flags cannot authorize a queued message', t => {
  const f = fixture(t); f.alpha.addConnection({ id: 'wa', provider: 'WHATSAPP_CLOUD', environment: 'SYNTHETIC', accountId: 'synthetic-wa' });
  const input = { recipient: 'synthetic-recipient', kind: 'TEXT', body: 'Fictional message', consent: { optIn: true, at: f.now(), version: 'synthetic-consent-v1' }, lastInboundAt: f.now() };
  for (const changed of [input, { ...input, consent: { ...input.consent, optIn: false } }, { ...input, kind: 'TEMPLATE', templateApproved: true, template: 'synthetic-template' }]) {
    assert.throws(() => f.alpha.createMessage('wa', 'legacy', changed), code('TRUSTED_CONSENT_REQUIRED'));
  }
  assert.equal(f.store.get('SELECT count(*) n FROM integration_demo_operation').n, 0);
  assert.throws(() => messagingPolicy({ ...input, lastInboundAt: f.now() + 1 }, f.now()), code('MESSAGE_WINDOW_CLOSED'));
});

test('Ninja contract locations are fixed, and signatures use bounded raw bytes with exact encoding', () => {
  assert.equal(ninjaContractLocation('SANDBOX','MY').createShipment, 'https://api-sandbox.ninjavan.co/sg/4.2/orders');
  assert.equal(ninjaContractLocation('PRODUCTION','MY').oauth, 'https://api.ninjavan.co/my/2.0/oauth/access_token');
  assert.throws(() => ninjaContractLocation('https://attacker.invalid','MY'), code('INVALID_INPUT'));
  const raw = Buffer.from('{ "tracking_id": "synthetic-123" }'), secret = 'fictional-signature-key';
  const signature = createHmac('sha256', secret).update(raw).digest('base64');
  assert.equal(verifyNinjaSignature(raw, signature, secret), true);
  for (const [body, sig, key] of [[Buffer.from(JSON.stringify(JSON.parse(raw))),signature,secret], [raw,signature,'different-fiction'], [raw,'bad',secret], [Buffer.alloc(65537),signature,secret], [raw,signature,'']]) assert.equal(verifyNinjaSignature(body, sig, key), false);
});

test('status copy covers seven locales and cached shell never embeds a connection credential', () => {
  const source = readFileSync(new URL('../public/seller/integrations.js', import.meta.url), 'utf8');
  for (const locale of ['en','ms','zh-Hans','vi','th','ja','ko']) assert.match(source, new RegExp(`(?:['"]?${locale}['"]?): \\[`));
  assert.match(source, /cache: 'no-store'/); assert.match(source, /csrfToken\(\) === identity/);
  const worker = readFileSync(new URL('../public/seller/sw.js', import.meta.url), 'utf8'); assert.match(worker, /\/seller\/integrations\.js/);
  assert.doesNotMatch(source, /localStorage|indexedDB|authorization|secretReference|access_token/);
});
