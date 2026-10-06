import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../worker-runtime/db.js';
import { createSyntheticMessagingAuthority } from '../src/integration-consent.js';
import { createOfflineMetaIngress } from '../src/integration-ingress.js';
import { verifyMetaSignature } from '../src/integration-contracts.js';
import { buildWhatsAppMessageRequest, buildTrustedWhatsAppMessageRequest } from '../src/integration-requests.js';
import { createFixtureIntegrationTransport, createSyntheticProviderAdapter } from '../src/integration-adapters.js';
import { trustFixture, trustBinding, syntheticKey, syntheticApp, signed, metaPayload, inboundText, statusEvent } from './helpers/integration-trust-fixture.js';

const code = expected => error => error.code === expected;
const intent = () => ({ recipient: '+60123456789', kind: 'TEXT', body: 'Synthetic order update only' });
const reference = f => ({ orderId: f.orderId, purpose: 'ORDER_CONTACT', recipient: intent().recipient });
const accepted = id => createFixtureIntegrationTransport([{ status: 200, body: { messaging_product: 'whatsapp', messages: [{ id }] } }]);
const count = (f, table) => f.store.get(`SELECT count(*) n FROM integration_demo_${table}`).n;
const projection = (f, id = 'wamid.SYNTHETIC001') => f.store.get('SELECT * FROM integration_demo_message_projection WHERE company_id=? AND connection_id=? AND subject_id=?', f.b.companyId, f.b.connectionId, id);

test('caller flags, copied proof, fake authority and implicit mode cannot grant message consent', t => {
  const f = trustFixture(t, { openWindow: true }), scope = f.ledger.forCompany(f.b.companyId);
  assert.throws(() => createSyntheticMessagingAuthority(f.store), code('SYNTHETIC_ONLY'));
  const raw = buildWhatsAppMessageRequest(f.b, { ...intent(), phoneNumberId: '000000000000011', apiVersion: 'v25.0', consent: { optIn: true, at: f.now(), version: 'order-contact-v2' }, lastInboundAt: f.now() });
  assert.throws(() => scope.queueProviderRequest(f.b.connectionId, 'caller', raw), code('TRUSTED_CONSENT_REQUIRED'));
  const proof = f.authority.resolve(f.b, { ...reference(f), kind: 'TEXT' });
  assert.throws(() => buildTrustedWhatsAppMessageRequest(f.b, intent(), structuredClone(proof)), code('TRUSTED_CONSENT_REQUIRED'));
  assert.throws(() => buildTrustedWhatsAppMessageRequest(f.b, { ...intent(), consent: true }, proof), code('INVALID_INPUT'));
  assert.throws(() => createSyntheticProviderAdapter({ ledger: f.ledger, ...f.b, messagingAuthority: { resolve: () => proof } }), code('TRUSTED_CONSENT_REQUIRED'));
  assert.equal(count(f, 'operation'), 0);
});

test('server order consent binds company, account, connection, buyer recipient and existing purpose', t => {
  const f = trustFixture(t, { openWindow: true });
  const proof = f.authority.resolve(f.b, { ...reference(f), kind: 'TEXT', consent: { optIn: false } });
  assert.equal(proof.policy.consent.version, 'order-contact-v2'); assert.equal(proof.phoneNumberId, '000000000000011');
  assert.equal(proof.policy.consent.at, Date.parse(f.store.get('SELECT whatsapp_consent_at FROM shop_order WHERE id=?', f.orderId).whatsapp_consent_at));
  for (const b of [trustBinding('WHATSAPP_CLOUD','beta'), { ...f.b, accountId: 'synthetic-wrong' }, { ...f.b, connectionId: 'ninja_van' }]) assert.throws(() => f.authority.resolve(b, { ...reference(f), kind: 'TEXT' }), code('NOT_FOUND'));
  assert.throws(() => f.authority.resolve(f.b, { ...reference(f), recipient: '+60129876543', kind: 'TEXT' }), code('NOT_FOUND'));
  assert.throws(() => f.authority.resolve(f.b, { ...reference(f), purpose: 'MARKETING', kind: 'TEXT' }), code('PURPOSE_DISABLED'));
  assert.throws(() => f.authority.registerOrder(trustBinding('WHATSAPP_CLOUD','beta'), f.orderId));
});

test('another Store cannot authorize queue or execution even with identical fictional company/account IDs', t => {
  const source = trustFixture(t, { openWindow: true }), target = trustFixture(t, { openWindow: true });
  target.authority.revoke(target.b, target.orderId);
  const foreign = source.prepare(), scope = target.ledger.forCompany(target.b.companyId), transport = accepted('wamid.SYNTHETIC_FOREIGN');
  assert.throws(() => target.authority.assertReference(target.b, { ...foreign.input.authorizationRef, recipient: foreign.input.recipient }), code('NOT_FOUND'));
  assert.throws(() => scope.queueProviderRequest(target.b.connectionId, 'foreign-proof', foreign), code('TRUSTED_CONSENT_REQUIRED'));
  assert.throws(() => createSyntheticProviderAdapter({ ledger: target.ledger, ...target.b, transport, messagingAuthority: source.authority }), code('TRUSTED_CONSENT_REQUIRED'));
  assert.throws(() => createSyntheticProviderAdapter({ ledger: { ...source.ledger }, ...source.b, transport, messagingAuthority: source.authority }), code('TRUSTED_CONSENT_REQUIRED'));
  assert.equal(count(target, 'operation'), 0); assert.equal(transport.requests().length, 0);
});

test('changed phone bindings block stale new queues, pending dispatch and completed replay', async t => {
  const f = trustFixture(t, { openWindow: true }), scope = f.ledger.forCompany(f.b.companyId), prepared = f.prepare();
  const done = scope.queueProviderRequest(f.b.connectionId, 'phone-done', prepared), transport = accepted('wamid.SYNTHETIC_PHONE'), adapter = f.adapter(transport, f.b);
  assert.equal((await adapter.execute(done.operationId)).state, 'DONE');
  const waiting = scope.queueProviderRequest(f.b.connectionId, 'phone-waiting', prepared);
  f.store.run('UPDATE integration_demo_phone_binding SET phone_id=? WHERE company_id=? AND connection_id=?', '000000000000019', f.b.companyId, f.b.connectionId);
  assert.throws(() => scope.queueProviderRequest(f.b.connectionId, 'phone-new', prepared), code('MESSAGE_BINDING_CHANGED'));
  assert.throws(() => scope.queueProviderRequest(f.b.connectionId, 'phone-done', prepared), code('MESSAGE_BINDING_CHANGED'));
  await assert.rejects(adapter.execute(waiting.operationId), code('MESSAGE_BINDING_CHANGED'));
  await assert.rejects(adapter.execute(done.operationId), code('MESSAGE_BINDING_CHANGED'));
  assert.equal(scope.getOperation(waiting.operationId).state, 'PENDING'); assert.equal(transport.requests().length, 1);
  const currentPhoneStatus = metaPayload({ statuses: [statusEvent(f.now(), 'delivered', 'wamid.SYNTHETIC_PHONE')] }, { phoneId: '000000000000019' });
  assert.equal(f.ingress.receive(signed(currentPhoneStatus)).quarantined, 1); assert.equal(projection(f, 'wamid.SYNTHETIC_PHONE'), undefined);
});

test('signed inbound never grants consent to email-only or historical opt-out orders', t => {
  const f = trustFixture(t, { openWindow: true }), orderId = f.makeOrder({ phone: '', optIn: false }); f.authority.registerOrder(f.b, orderId);
  assert.throws(() => f.authority.resolve(f.b, { orderId, purpose: 'ORDER_CONTACT', recipient: '+60123456789', kind: 'TEXT', consent: { optIn: true } }), code('NOT_FOUND'));
  f.store.run('UPDATE shop_order SET whatsapp_opt_in=0,whatsapp_consent_at=NULL,whatsapp_consent_version=NULL WHERE id=?', f.orderId);
  assert.throws(() => f.authority.resolve(f.b, { ...reference(f), kind: 'TEXT', consent: { optIn: true } }), code('CONSENT_REQUIRED'));
});

test('revocation blocks new queue and pending execution while completed facts and historical snapshots remain', async t => {
  const f = trustFixture(t, { openWindow: true }), scope = f.ledger.forCompany(f.b.companyId), prepared = f.prepare();
  const before = f.store.all('SELECT * FROM shop_order');
  const done = scope.queueProviderRequest(f.b.connectionId, 'done', prepared), transport = accepted('wamid.SYNTHETIC001'), adapter = f.adapter(transport, f.b);
  assert.equal((await adapter.execute(done.operationId)).state, 'DONE');
  const waiting = scope.queueProviderRequest(f.b.connectionId, 'waiting', prepared); f.authority.revoke(f.b, f.orderId);
  assert.throws(() => scope.queueProviderRequest(f.b.connectionId, 'new', prepared), code('CONSENT_REQUIRED'));
  await assert.rejects(adapter.execute(waiting.operationId), code('CONSENT_REQUIRED'));
  assert.equal(scope.getOperation(waiting.operationId).state, 'PENDING'); assert.equal(transport.requests().length, 1);
  assert.equal(scope.queueProviderRequest(f.b.connectionId, 'done', prepared).replayed, true);
  assert.equal((await adapter.execute(done.operationId)).replayed, true);
  assert.deepEqual(f.store.all('SELECT * FROM shop_order'), before); assert.equal(count(f, 'consent_revocation'), 1);
});

test('template approval and shape are read from the current account-bound server fixture record', async t => {
  const f = trustFixture(t), input = { recipient: '+60123456789', kind: 'TEMPLATE', template: 'synthetic_order_update', language: 'en_US', parameters: ['SYNTHETIC001'] };
  assert.throws(() => f.prepare(input), code('APPROVED_TEMPLATE_REQUIRED'));
  f.authority.setTemplateApproval(f.b, { name: input.template, language: input.language, parameterCount: 1, approved: true });
  assert.throws(() => f.prepare({ ...input, parameters: ['one','two'] }), code('APPROVED_TEMPLATE_REQUIRED'));
  const prepared = f.prepare(input), scope = f.ledger.forCompany(f.b.companyId), queued = scope.queueProviderRequest(f.b.connectionId, 'template', prepared);
  f.authority.setTemplateApproval(f.b, { name: input.template, language: input.language, parameterCount: 1, approved: false });
  const transport = accepted('wamid.SYNTHETIC_TEMPLATE');
  await assert.rejects(f.adapter(transport, f.b).execute(queued.operationId), code('APPROVED_TEMPLATE_REQUIRED')); assert.equal(transport.requests().length, 0);
});

test('revocation during lease acquisition is rechecked before transmission and records a policy block', async t => {
  let onLease;
  const f = trustFixture(t, { openWindow: true, wrap: store => ({ ...store, run(sql, ...args) {
    store.run(sql, ...args); if (onLease && sql.startsWith("UPDATE integration_demo_outbox SET state = 'LEASED'")) onLease();
  } }) });
  const scope = f.ledger.forCompany(f.b.companyId), queued = scope.queueProviderRequest(f.b.connectionId,'lease-revocation',f.prepare());
  onLease = () => f.authority.revoke(f.b,f.orderId);
  const transport = accepted('wamid.SYNTHETIC_RACE');
  const result = await f.adapter(transport,f.b).execute(queued.operationId);
  assert.equal(result.state,'FAILED'); assert.equal(result.result.category,'POLICY_BLOCKED');
  assert.equal(result.result.errorCode,'CONSENT_REQUIRED'); assert.equal(transport.requests().length,0);
});

test('phone replacement during lease acquisition prevents transmission', async t => {
  let onLease;
  const f = trustFixture(t, { openWindow: true, wrap: store => ({ ...store, run(sql, ...args) {
    store.run(sql, ...args); if (onLease && sql.startsWith("UPDATE integration_demo_outbox SET state = 'LEASED'")) onLease();
  } }) });
  const scope = f.ledger.forCompany(f.b.companyId), queued = scope.queueProviderRequest(f.b.connectionId, 'phone-lease', f.prepare());
  onLease = () => f.store.run('UPDATE integration_demo_phone_binding SET phone_id=? WHERE company_id=? AND connection_id=?', '000000000000019', f.b.companyId, f.b.connectionId);
  const transport = accepted('wamid.SYNTHETIC_PHONE_RACE'), result = await f.adapter(transport, f.b).execute(queued.operationId);
  assert.equal(result.state, 'FAILED'); assert.equal(result.result.category, 'POLICY_BLOCKED');
  assert.equal(result.result.errorCode, 'MESSAGE_BINDING_CHANGED'); assert.equal(transport.requests().length, 0);
});

test('expired message leases enter UNKNOWN reconciliation even after consent is revoked', async t => {
  const f = trustFixture(t,{openWindow:true}), scope = f.ledger.forCompany(f.b.companyId);
  const queued = scope.queueProviderRequest(f.b.connectionId,'expired-revoked',f.prepare()); scope.beginAttempt(queued.operationId);
  f.authority.revoke(f.b,f.orderId); f.advance(86400000);
  const transport = accepted('wamid.SYNTHETIC_UNUSED');
  assert.equal((await f.adapter(transport,f.b).execute(queued.operationId)).state,'RECONCILE');
  assert.equal(f.store.get('SELECT result FROM integration_demo_reconciliation').result,'UNKNOWN'); assert.equal(transport.requests().length,0);
});

test('Meta signature validates exact bounded raw bytes, prefix and app key before parsing', t => {
  const f = trustFixture(t), sample = signed(' { "object" : "whatsapp_business_account", "entry" : [] } ');
  assert.equal(verifyMetaSignature(sample.rawBody, sample.signature, syntheticKey), true);
  assert.equal(verifyMetaSignature(Buffer.from(JSON.stringify(JSON.parse(sample.rawBody))), sample.signature, syntheticKey), false);
  for (const signature of ['', sample.signature.slice(7), sample.signature.replace('sha256=', 'sha1='), sample.signature+',duplicate']) assert.equal(verifyMetaSignature(sample.rawBody, signature, syntheticKey), false);
  assert.equal(verifyMetaSignature(sample.rawBody, sample.signature, 'synthetic-other-app-key'), false);
  assert.equal(verifyMetaSignature(Buffer.alloc(1024 * 1024 + 1), sample.signature, syntheticKey), false);
  assert.throws(() => f.ingress.receive({ rawBody: Buffer.from('{broken'), signature: sample.signature }), code('INVALID_SIGNATURE'));
  assert.equal(count(f, 'webhook_receipt'), 0);
});

test('signed batches derive each tenant exclusively from trusted app/WABA/phone mapping', t => {
  const f = trustFixture(t), alpha = metaPayload({ messages: [inboundText(f.now())] });
  const beta = metaPayload({ messages: [inboundText(f.now(), 'wamid.SYNTHETIC_BETA')] }, { wabaId: '000000000000002', phoneId: '000000000000012' });
  const batch = { object: alpha.object, entry: [...alpha.entry, ...beta.entry] };
  assert.equal(f.ingress.receive({ ...signed(batch), companyId: 'synthetic-forged', role: 'ADMIN' }).httpStatus, 200);
  assert.deepEqual(f.store.all('SELECT company_id FROM integration_demo_inbound_clock ORDER BY company_id').map(row => row.company_id), ['synthetic-alpha','synthetic-beta']);
  const bad = structuredClone(batch); bad.entry[1].id = '000000000000001';
  assert.throws(() => f.ingress.receive(signed(bad)), code('NOT_FOUND'));
  assert.equal(count(f, 'signed_inbox'), 2); assert.equal(count(f, 'webhook_receipt'), 1);
  assert.throws(() => createOfflineMetaIngress({ store: {}, authority: f.authority, mode: 'SYNTHETIC', appId: syntheticApp, appSecret: syntheticKey }), code('SYNTHETIC_ONLY'));
});

test('duplicates inside a batch and across retries do not duplicate windows or retain private text', t => {
  const f = trustFixture(t), message = inboundText(f.now(), 'wamid.SYNTHETIC_DUPLICATE', '60123456789', 'PRIVATE FICTIONAL BODY');
  const payload = metaPayload({ messages: [message,message] });
  assert.equal(f.ingress.receive(signed(payload)).duplicates, 1); assert.equal(f.ingress.receive(signed(payload)).duplicates, 2);
  assert.equal(count(f, 'signed_inbox'), 1); assert.equal(count(f, 'inbound_clock'), 1); assert.equal(count(f, 'webhook_receipt'), 1);
  assert.doesNotMatch(f.store.get('SELECT event_json FROM integration_demo_signed_inbox').event_json, /PRIVATE FICTIONAL BODY|profile|text/);
  const conflict = metaPayload({ messages: [inboundText(f.now(), 'wamid.SYNTHETIC_NEW'), { ...message, text: { body: 'Changed content' } }] });
  assert.throws(() => f.ingress.receive(signed(conflict)), code('EVENT_CONFLICT'));
  assert.equal(count(f, 'signed_inbox'), 1); assert.equal(count(f, 'webhook_receipt'), 1);
});

test('unsupported notification retries have stable identity without invented provider timestamps', t => {
  const f = trustFixture(t), request = signed(metaPayload({ errors: [{ code: 131051, message: 'PRIVATE FICTIONAL ERROR' }] }));
  const firstTime = f.now(); assert.equal(f.ingress.receive(request).quarantined, 1);
  f.advance(1000); const retry = f.ingress.receive(request);
  assert.equal(retry.httpStatus, 200); assert.equal(retry.duplicates, 1); assert.equal(retry.quarantined, 0);
  assert.equal(count(f, 'signed_inbox'), 1); assert.equal(count(f, 'webhook_receipt'), 1);
  const event = JSON.parse(f.store.get('SELECT event_json FROM integration_demo_signed_inbox').event_json);
  assert.equal(event.occurredAt, null); assert.doesNotMatch(JSON.stringify(event), /PRIVATE FICTIONAL ERROR/);
  assert.equal(f.store.get('SELECT received_at FROM integration_demo_webhook_receipt').received_at, firstTime);
});

test('unsupported opaque group status quarantines without starving valid individual events in its batch', t => {
  const f = trustFixture(t), group = { ...statusEvent(f.now(), 'delivered', 'wamid.SYNTHETIC_GROUP'), recipient_type: 'group', recipient_id: 'U3ludGhldGljR3JvdXA=' };
  const request = signed(metaPayload({ messages: [inboundText(f.now())], statuses: [group] })), first = f.ingress.receive(request);
  assert.equal(first.httpStatus, 200); assert.equal(first.received, 2); assert.equal(first.quarantined, 1);
  assert.equal(count(f, 'inbound_clock'), 1); assert.equal(count(f, 'signed_inbox'), 2);
  assert.equal(f.prepare().kind, 'MESSAGE'); f.advance(1000); assert.equal(f.ingress.receive(request).duplicates, 2);
  assert.equal(count(f, 'webhook_receipt'), 1);
});

test('future, unsupported and older inbound events cannot open or regress a service window', t => {
  const f = trustFixture(t);
  const future = metaPayload({ messages: [inboundText(f.now() + 1000, 'wamid.SYNTHETIC_FUTURE')] });
  assert.equal(f.ingress.receive(signed(future)).quarantined, 1); assert.equal(count(f, 'inbound_clock'), 0);
  assert.throws(() => f.prepare(), code('MESSAGE_WINDOW_CLOSED'));
  f.openWindow(); const latest = f.store.get('SELECT occurred_at FROM integration_demo_inbound_clock').occurred_at;
  f.ingress.receive(signed(metaPayload({ messages: [inboundText(f.now()-1000, 'wamid.SYNTHETIC_OLDER')] })));
  assert.equal(f.store.get('SELECT occurred_at FROM integration_demo_inbound_clock').occurred_at, latest);
  f.advance(86400000); assert.throws(() => f.prepare(), code('MESSAGE_WINDOW_CLOSED'));
  const unknown = { ...inboundText(f.now(), 'wamid.SYNTHETIC_UNKNOWN'), type: 'future_media_type' };
  assert.equal(f.ingress.receive(signed(metaPayload({ messages: [unknown] }))).quarantined, 1);
  assert.throws(() => f.prepare(), code('MESSAGE_WINDOW_CLOSED'));
});

test('inbox, window and receipt commit atomically before ACK; injected failures return no ACK', t => {
  for (const table of ['signed_inbox','inbound_clock','webhook_receipt']) {
    let active = false;
    const f = trustFixture(t, { wrap: store => ({ ...store, run(sql, ...args) { if (active && sql.startsWith(`INSERT INTO integration_demo_${table}`)) throw new Error('synthetic commit fault'); return store.run(sql, ...args); } }) });
    const request = signed(metaPayload({ messages: [inboundText(f.now(),'wamid.SYNTHETIC_A'),inboundText(f.now(),'wamid.SYNTHETIC_B')] }));
    active = true; let ack;
    assert.throws(() => { ack = f.ingress.receive(request); }, /synthetic commit fault/); assert.equal(ack, undefined);
    for (const name of ['signed_inbox','inbound_clock','webhook_receipt']) assert.equal(count(f, name), 0);
    active = false; assert.equal(f.ingress.receive(request).httpStatus, 200); assert.equal(count(f,'signed_inbox'), 2);
  }
});

test('ACKed receipt, inbox and service window survive closing and reopening an isolated file Store', t => {
  const directory = mkdtempSync(path.join(tmpdir(),'shopping-signed-inbox-')); t.after(() => rmSync(directory,{recursive:true,force:true}));
  const file = path.join(directory,'synthetic.db'), f = trustFixture(t,{file}); f.openWindow(); f.close();
  const reopened = openDatabase(file); t.after(() => reopened.close());
  assert.equal(reopened.get('SELECT count(*) n FROM integration_demo_webhook_receipt').n,1);
  assert.equal(reopened.get('SELECT count(*) n FROM integration_demo_signed_inbox').n,1);
  assert.equal(reopened.get('SELECT count(*) n FROM integration_demo_inbound_clock').n,1);
});

test('a status arriving before accepted-response persistence waits for correlation and can be reprocessed offline', async t => {
  const f = trustFixture(t,{openWindow:true}), before = f.store.all('SELECT * FROM shop_order');
  f.ingress.receive(signed(metaPayload({statuses:[statusEvent(f.now(),'delivered')]})));
  assert.equal(f.store.get("SELECT disposition FROM integration_demo_signed_inbox WHERE disposition='WAITING_SUBJECT'").disposition,'WAITING_SUBJECT');
  assert.equal(projection(f), undefined);
  const scope = f.ledger.forCompany(f.b.companyId), queued = scope.queueProviderRequest(f.b.connectionId,'correlated',f.prepare());
  assert.equal((await f.adapter(accepted('wamid.SYNTHETIC001'),f.b).execute(queued.operationId)).state,'DONE');
  assert.equal(projection(f),undefined); assert.equal(f.ingress.reprocessWaiting().applied,1); assert.equal(projection(f).status,'DELIVERED');
  assert.deepEqual(f.store.all('SELECT * FROM shop_order'), before);
});

test('status correlation requires the exact original individual recipient, including delayed correlation', async t => {
  const f = trustFixture(t, { openWindow: true }), wrong = { ...statusEvent(f.now(), 'delivered'), recipient_id: '60129876543' };
  f.ingress.receive(signed(metaPayload({ statuses: [wrong] })));
  const scope = f.ledger.forCompany(f.b.companyId), queued = scope.queueProviderRequest(f.b.connectionId, 'recipient-status', f.prepare());
  await f.adapter(accepted('wamid.SYNTHETIC001'), f.b).execute(queued.operationId);
  assert.equal(f.ingress.reprocessWaiting().applied, 0); assert.equal(projection(f), undefined);
  assert.equal(f.store.get("SELECT disposition FROM integration_demo_signed_inbox WHERE disposition='QUARANTINED'").disposition, 'QUARANTINED');
  f.advance(1000); assert.equal(f.ingress.receive(signed(metaPayload({ statuses: [statusEvent(f.now(), 'delivered')] }))).quarantined, 0);
  assert.equal(projection(f).status, 'DELIVERED');
});

test('out-of-order and equal-time status events preserve progress; failure conflicts and unknown statuses quarantine', async t => {
  const f = trustFixture(t,{openWindow:true}), scope = f.ledger.forCompany(f.b.companyId), queued = scope.queueProviderRequest(f.b.connectionId,'status',f.prepare());
  await f.adapter(accepted('wamid.SYNTHETIC001'),f.b).execute(queued.operationId);
  f.ingress.receive(signed(metaPayload({statuses:[statusEvent(f.now(),'delivered'),statusEvent(f.now(),'read'),statusEvent(f.now()-1000,'sent')]})));
  assert.equal(projection(f).status,'READ');
  f.advance(1000); const result = f.ingress.receive(signed(metaPayload({statuses:[statusEvent(f.now(),'failed'),statusEvent(f.now(),'future_status'),statusEvent(f.now(),'another_future_status')]})));
  assert.equal(result.quarantined,3); assert.equal(projection(f).status,'READ');
});

test('sent may progress to a later delivery failure while confirmed delivery contradictions quarantine', async t => {
  const f = trustFixture(t, { openWindow: true }), scope = f.ledger.forCompany(f.b.companyId);
  const queued = scope.queueProviderRequest(f.b.connectionId, 'sent-failure', f.prepare());
  await f.adapter(accepted('wamid.SYNTHETIC001'), f.b).execute(queued.operationId);
  f.ingress.receive(signed(metaPayload({ statuses: [statusEvent(f.now(), 'sent')] })));
  f.advance(1000); assert.equal(f.ingress.receive(signed(metaPayload({ statuses: [statusEvent(f.now(), 'failed')] }))).quarantined, 0);
  assert.equal(projection(f).status, 'FAILED');
  f.advance(1000); assert.equal(f.ingress.receive(signed(metaPayload({ statuses: [statusEvent(f.now(), 'read')] }))).quarantined, 1);
  assert.equal(projection(f).status, 'FAILED');
  const delivered = scope.queueProviderRequest(f.b.connectionId, 'delivered-failure', f.prepare());
  await f.adapter(accepted('wamid.SYNTHETIC_DELIVERED'), f.b).execute(delivered.operationId);
  f.ingress.receive(signed(metaPayload({ statuses: [statusEvent(f.now(), 'delivered', 'wamid.SYNTHETIC_DELIVERED')] })));
  f.advance(1000); assert.equal(f.ingress.receive(signed(metaPayload({ statuses: [statusEvent(f.now(), 'failed', 'wamid.SYNTHETIC_DELIVERED')] }))).quarantined, 1);
  assert.equal(projection(f, 'wamid.SYNTHETIC_DELIVERED').status, 'DELIVERED');
});

test('unverified provider lookup cannot resolve UNKNOWN, including after a signed uncorrelated status', async t => {
  const f = trustFixture(t,{openWindow:true}), scope = f.ledger.forCompany(f.b.companyId), queued = scope.queueProviderRequest(f.b.connectionId,'unknown',f.prepare());
  const transport = createFixtureIntegrationTransport([{networkFailure:'TIMEOUT'}]), adapter = f.adapter(transport,f.b);
  assert.equal((await adapter.execute(queued.operationId)).state,'RECONCILE');
  f.ingress.receive(signed(metaPayload({statuses:[statusEvent(f.now(),'delivered')]})));
  for (const result of ['FOUND','ABSENT']) assert.throws(() => scope.recordReconciliation(queued.operationId,result),code('PROVIDER_LOOKUP_REQUIRED'));
  assert.equal(f.store.get('SELECT result FROM integration_demo_reconciliation').result,'UNKNOWN');
  await assert.rejects(adapter.execute(queued.operationId),code('INVALID_STATE')); assert.equal(transport.requests().length,1);
});

test('malformed signed payloads and batch limits fail without writes; no startup route or public cache change exists', t => {
  const f = trustFixture(t);
  for (const payload of ['{broken',metaPayload({messages:{length:1}}),{object:'wrong',entry:[]},metaPayload({messages:Array.from({length:1001},(_,i)=>inboundText(f.now(),`wamid.SYNTHETIC_${i}`))})]) assert.throws(()=>f.ingress.receive(signed(payload)),code('INVALID_PAYLOAD'));
  assert.equal(count(f,'signed_inbox'),0); assert.equal(count(f,'webhook_receipt'),0);
  for (const file of ['app','server','db']) assert.doesNotMatch(readFileSync(new URL(`../src/${file}.js`,import.meta.url),'utf8'),/integration-consent|integration-ingress|integration-ledger/);
});
