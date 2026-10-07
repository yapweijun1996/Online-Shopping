import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { advanceOutboxStatus, parseWhatsAppWebhook, senderHash } from '../src/whatsapp-webhook.js';
import { parseNinjaWebhook } from '../src/ninja-webhook.js';
import { planMessage } from '../src/message-plan.js';
import { verifyMetaSignature, verifyNinjaSignature } from '../src/integration-contracts.js';

const wamid = (n) => `wamid.HBgMNjAxMjM0NTY3ODkwFQIAEhgg${n}`;
const metaBody = (messages = [], statuses = [], extra = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1055' }, messages, statuses, ...extra } }] }] });

test('buyer replies become text, unsupported media or other, with clean bodies', () => {
  const parsed = parseWhatsAppWebhook(metaBody([
    { id: wamid('a'), from: '60123456789', timestamp: '1791360000', type: 'text', text: { body: 'Hi\u0000 there\u0007\nline two' } },
    { id: wamid('b'), from: '60123456789', timestamp: '1791360060', type: 'image', image: { id: 'x' } },
    { id: wamid('c'), from: '60123456789', timestamp: '1791360120', type: 'location' },
  ]));
  assert.deepEqual(parsed.phoneNumberIds, ['1055']);
  assert.deepEqual(parsed.messages.map((m) => [m.kind, m.body]), [['TEXT', 'Hi there\nline two'], ['MEDIA_UNSUPPORTED', null], ['OTHER', null]]);
  assert.equal(parsed.messages[0].receivedAt, '2026-10-07T08:00:00.000Z');
  assert.equal(parsed.messages[0].from, '60123456789');
  assert.equal(parsed.skipped, 0);
});

test('a very long reply is cut to 4096 characters', () => {
  const parsed = parseWhatsAppWebhook(metaBody([{ id: wamid('a'), from: '60123456789', timestamp: '1791360000', type: 'text', text: { body: 'x'.repeat(9000) } }]));
  assert.equal(parsed.messages[0].body.length, 4096);
});

test('delivery receipts are normalized and carry the provider error code', () => {
  const parsed = parseWhatsAppWebhook(metaBody([], [
    { id: wamid('a'), status: 'sent', timestamp: '1791360000', recipient_id: '60123456789' },
    { id: wamid('a'), status: 'delivered', timestamp: '1791360010', recipient_id: '60123456789' },
    { id: wamid('a'), status: 'read', timestamp: '1791360020', recipient_id: '60123456789' },
    { id: wamid('b'), status: 'failed', timestamp: '1791360030', recipient_id: '60123456789', errors: [{ code: 131026, title: 'Undeliverable' }] },
    { id: wamid('c'), status: 'mystery', timestamp: '1791360040' },
  ]));
  assert.deepEqual(parsed.statuses.map((s) => s.status), ['SENT', 'DELIVERED', 'READ', 'FAILED', 'UNKNOWN']);
  assert.equal(parsed.statuses[3].errorCode, 131026);
});

test('malformed payloads and items are skipped, never trusted', () => {
  for (const bad of [null, 'x', [], {}, { object: 'page', entry: [] }, { object: 'whatsapp_business_account' }, { object: 'whatsapp_business_account', entry: 'x' }]) {
    assert.deepEqual(parseWhatsAppWebhook(bad), { phoneNumberIds: [], messages: [], statuses: [], skipped: 0 });
  }
  const parsed = parseWhatsAppWebhook(metaBody([
    { id: 'not-a-wamid', from: '60123456789', timestamp: '1791360000', type: 'text', text: { body: 'x' } },
    { id: wamid('a'), from: '+60 123', timestamp: '1791360000', type: 'text', text: { body: 'x' } },
    { id: wamid('b'), from: '60123456789', timestamp: 'yesterday', type: 'text', text: { body: 'x' } },
    { id: wamid('c'), from: '60123456789', timestamp: '1791360000', type: 'text', text: { body: 'ok' } },
  ], [{ id: wamid('d'), timestamp: '1791360000' }, 'junk']));
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.skipped, 5);
  const other = parseWhatsAppWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'account_update', value: {} }] }] });
  assert.deepEqual(other.messages, []);
  const flood = parseWhatsAppWebhook(metaBody(Array.from({ length: 500 }, (_, i) => ({ id: wamid(`m${i}`), from: '60123456789', timestamp: '1791360000', type: 'text', text: { body: 'x' } }))));
  assert.equal(flood.messages.length, 200, 'bounded work per delivery');
});

test('the sender is indexed by a keyed hash, not the number', () => {
  const key = randomBytes(32);
  const hash = senderHash(key, '60123456789');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, senderHash(key, '60123456789'));
  assert.notEqual(hash, senderHash(randomBytes(32), '60123456789'));
  assert.ok(!hash.includes('60123456789'));
  assert.throws(() => senderHash(Buffer.alloc(4), '60123456789'), /keyed sender hash/);
  assert.throws(() => senderHash(key, 'abc'), /keyed sender hash/);
});

test('receipts arrive out of order and never move a message backwards', () => {
  assert.equal(advanceOutboxStatus('SENDING', 'SENT'), 'ACCEPTED');
  assert.equal(advanceOutboxStatus('ACCEPTED', 'DELIVERED'), 'DELIVERED');
  assert.equal(advanceOutboxStatus('DELIVERED', 'READ'), 'READ');
  assert.equal(advanceOutboxStatus('READ', 'DELIVERED'), 'READ', 'late delivered after read');
  assert.equal(advanceOutboxStatus('DELIVERED', 'SENT'), 'DELIVERED');
  assert.equal(advanceOutboxStatus('ACCEPTED', 'FAILED'), 'FAILED');
  assert.equal(advanceOutboxStatus('DELIVERED', 'FAILED'), 'DELIVERED', 'a delivered message is not failed later');
  assert.equal(advanceOutboxStatus('RECONCILE', 'DELIVERED'), 'DELIVERED', 'a receipt resolves an unknown outcome');
  assert.equal(advanceOutboxStatus('ACCEPTED', 'UNKNOWN'), 'ACCEPTED');
});

test('Meta and Ninja Van signatures still gate the raw body before any parsing', () => {
  const secret = 'app-secret-value-123';
  const raw = Buffer.from(JSON.stringify(metaBody()));
  const good = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(verifyMetaSignature(raw, good, secret), true);
  assert.equal(verifyMetaSignature(raw, good, 'other'), false);
  assert.equal(verifyMetaSignature(Buffer.from(raw.toString() + ' '), good, secret), false);
  const ninjaRaw = Buffer.from('{"tracking_id":"NV1","status":"Delivered","timestamp":"2026-10-07T01:02:03+0000"}');
  const ninjaGood = createHmac('sha256', 'ninja-secret').update(ninjaRaw).digest('base64');
  assert.equal(verifyNinjaSignature(ninjaRaw, ninjaGood, 'ninja-secret'), true);
  assert.equal(verifyNinjaSignature(ninjaRaw, ninjaGood, 'wrong'), false);
});

test('a Ninja Van status webhook becomes one normalized, deduplicatable event', () => {
  const body = { tracking_id: 'NVMYTEST123', status: 'Delivered', timestamp: '2026-10-07T01:02:03+0000', shipper_order_ref_no: 'OS-00000006' };
  const event = parseNinjaWebhook(body);
  assert.deepEqual([event.trackingNo, event.status, event.rawStatus, event.requiresReconciliation, event.at], ['NVMYTEST123', 'DELIVERED', 'Delivered', false, '2026-10-07T01:02:03.000Z']);
  assert.equal(event.dedupeKey, parseNinjaWebhook({ ...body }).dedupeKey, 'a retry has the same key');
  assert.notEqual(event.dedupeKey, parseNinjaWebhook({ ...body, status: 'Returned to Sender' }).dedupeKey);
  const unknown = parseNinjaWebhook({ ...body, status: 'Brand New Status' });
  assert.equal(unknown.status, 'UNKNOWN'); assert.equal(unknown.requiresReconciliation, true);
  assert.equal(parseNinjaWebhook({ ...body, timestamp: '2026-10-07T01:02:03+00:00' }).at, '2026-10-07T01:02:03.000Z');
  for (const bad of [null, 'x', [], {}, { ...body, tracking_id: 'bad id!' }, { ...body, tracking_id: 'x'.repeat(200) }, { ...body, status: 5 }, { ...body, timestamp: 'now' }, { ...body, status: 'x'.repeat(81) }]) {
    assert.equal(parseNinjaWebhook(bad), null);
  }
});

test('only four order moments send a message, only to opted-in buyers, once per order and kind', () => {
  assert.deepEqual(planMessage({ orderId: 'o1', status: 'CONFIRMED', buyerOptedIn: true }), { kind: 'ORDER_CONFIRMED', template: 'order_confirmed', idempotencyKey: 'o1:ORDER_CONFIRMED' });
  assert.equal(planMessage({ orderId: 'o1', status: 'SUBMITTED', buyerOptedIn: true }).template, 'order_submitted');
  assert.equal(planMessage({ orderId: 'o1', status: 'REJECTED', buyerOptedIn: true }).kind, 'ORDER_REJECTED');
  assert.equal(planMessage({ orderId: 'o1', status: 'SHIPPED', buyerOptedIn: true }).kind, 'ORDER_SHIPPED');
  assert.equal(planMessage({ orderId: 'o1', status: 'CONFIRMED', buyerOptedIn: false }), null, 'no consent, no message');
  assert.equal(planMessage({ orderId: 'o1', status: 'CONFIRMED' }), null);
  for (const status of ['DELIVERED', 'CANCELLED', 'UNKNOWN']) assert.equal(planMessage({ orderId: 'o1', status, buyerOptedIn: true }), null, status);
  assert.equal(planMessage({ orderId: '', status: 'CONFIRMED', buyerOptedIn: true }), null);
  assert.equal(planMessage({ orderId: 'o1', status: 'CONFIRMED', buyerOptedIn: true }).idempotencyKey, planMessage({ orderId: 'o1', status: 'CONFIRMED', buyerOptedIn: true }).idempotencyKey);
});
