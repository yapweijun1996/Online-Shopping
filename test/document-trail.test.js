import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmationNumber, documentTrail } from '../src/document-trail.js';

const event = (status, at, actorType = 'SELLER', actorId = 'owner', reason = null) => ({ status, occurredAt: at, actorType, actorId, reason });
const buyer = (at) => event('SUBMITTED', at, 'GUEST', null);

test('a confirmation number is the order number under the SOC prefix', () => {
  assert.equal(confirmationNumber('OS-00000006'), 'SOC-00000006');
  assert.equal(confirmationNumber('DEMO-00000012'), 'SOC-00000012');
});

test('a pending order has only its Sales Order', () => {
  const trail = documentTrail('OS-00000001', [buyer('t1')]);
  assert.deepEqual(trail.map((doc) => [doc.type, doc.number, doc.state]), [['SALES_ORDER', 'OS-00000001', 'ISSUED']]);
  assert.equal(trail[0].actorType, 'GUEST');
});

test('a rejected order keeps its Sales Order, never gets a confirmation, and records why', () => {
  const trail = documentTrail('OS-00000002', [buyer('t1'), event('REJECTED', 't2', 'SELLER', 'owner', 'Out of stock')]);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].state, 'REJECTED');
  assert.equal(trail[0].reason, 'Out of stock');
  assert.deepEqual(trail[0].endedBy, { actorType: 'SELLER', actorId: 'owner' });
});

test('a confirmed, shipped and delivered order shows the whole chain with tracking', () => {
  const events = [buyer('t1'), event('CONFIRMED', 't2'), event('SHIPPED', 't3'), event('DELIVERED', 't4')];
  const trail = documentTrail('OS-00000003', events, { carrier: 'Ninja Van', trackingNo: 'NV123' });
  assert.deepEqual(trail.map((doc) => doc.type), ['SALES_ORDER', 'SALES_ORDER_CONFIRMATION', 'SHIPMENT', 'DELIVERY']);
  assert.equal(trail[1].number, 'SOC-00000003');
  assert.equal(trail[2].number, 'NV123');
  assert.equal(trail[2].carrier, 'Ninja Van');
  assert.deepEqual(trail.map((doc) => doc.issuedAt), ['t1', 't2', 't3', 't4']);
});

test('a voided confirmation stays in the trail with its number, time and reason', () => {
  const trail = documentTrail('OS-00000004', [buyer('t1'), event('CONFIRMED', 't2'), event('CANCELLED', 't3', 'SELLER', 'owner', 'Customer asked')]);
  const confirmation = trail.find((doc) => doc.type === 'SALES_ORDER_CONFIRMATION');
  assert.equal(confirmation.number, 'SOC-00000004');
  assert.equal(confirmation.state, 'VOID');
  assert.equal(confirmation.endedAt, 't3');
  assert.equal(confirmation.reason, 'Customer asked');
  assert.equal(trail[0].state, 'ISSUED', 'the Sales Order itself is not voided');
});
