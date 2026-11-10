import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudProjection, invalidCredentialField } from '../public/seller/whatsapp-cloud-state.js';
const connection = { status: 'CONNECTED' };
const all = { checkedAt: '2026-11-10T00:00:00Z', checks: ['phoneOwnership', 'appSubscription', 'appSecret', 'templates'].map(id => ({ id, status: 'PASS' })), templates: [{ name: 'example', language: 'en', status: 'APPROVED' }] };
test('no connection, unavailable, malformed and absent evidence cannot become PASS', () => {
  for (const readiness of [null, {}, { checks: [] }, { checks: all.checks, templates: [] }, { checks: [{ id: 'appSecret', status: 'saved' }] }]) {
    const state = cloudProjection(connection, readiness); assert.equal(state.templateStatus, 'UNKNOWN'); assert.equal(state.webhookStatus, readiness?.checks === all.checks ? 'PASS' : 'UNKNOWN');
  }
  assert.equal(cloudProjection(null, all).connectionStatus, 'DISCONNECTED'); assert.equal(cloudProjection(connection, all, 'unavailable').webhookStatus, 'UNKNOWN'); assert.equal(cloudProjection({ status: 'unexpected' }, all).connected, false);
});
test('each check is independent, contradictory duplicates unknown, template counts use returned evidence only', () => {
  assert.equal(cloudProjection(connection, all).webhookStatus, 'PASS');
  const partial = { ...all, checks: all.checks.filter(check => check.id !== 'appSecret'), templates: [{ status: 'PENDING' }, { status: 'MISSING' }, { status: 'invented' }] };
  assert.equal(cloudProjection(connection, partial).templateStatus, 'UNKNOWN');
  assert.equal(cloudProjection({ status: 'NOT_CONFIGURED' }, all).connectionStatus, 'DISCONNECTED');
  for (const templates of [[{ status: 'APPROVED' }], [...all.templates, ...all.templates]]) assert.equal(cloudProjection(connection, { ...all, templates }).templateStatus, 'UNKNOWN');
  assert.equal(cloudProjection(connection, partial).checks.appSecret, 'UNKNOWN'); assert.deepEqual(cloudProjection(connection, partial).counts, { APPROVED: 0, PENDING: 1, REJECTED: 0, MISSING: 1, UNKNOWN: 1 });
  assert.equal(cloudProjection(connection, { ...all, checks: [...all.checks, { id: 'appSecret', status: 'FAIL' }] }).checks.appSecret, 'UNKNOWN');
  assert.equal(cloudProjection(connection, { ...all, checks: all.checks.map(check => check.id === 'phoneOwnership' ? { ...check, status: 'FAIL' } : check) }).webhookStatus, 'FAIL');
});
test('rotation and environment selection cannot reuse readiness implicitly; timestamps require actual valid result', () => {
  assert.equal(cloudProjection(connection, null).webhookStatus, 'UNKNOWN'); assert.equal(cloudProjection(null, all).checkedAt, null); assert.equal(cloudProjection(connection, { ...all, checkedAt: 'invalid' }).checkedAt, null); assert.equal(cloudProjection(connection, all).checkedAt, all.checkedAt);
  assert.equal(cloudProjection({ status: 'DISCONNECTED' }, all).templateStatus, 'UNKNOWN');
});
test('four-field validation preserves raw strings and matches server bounds without trimming', () => {
  const values = { accessToken: 'a'.repeat(20), appSecret: 'b'.repeat(16), phoneNumberId: '0000012345', businessAccountId: '12345' }; assert.equal(invalidCredentialField(values), null);
  for (const [name, value] of [['accessToken', ' '+values.accessToken], ['appSecret', 'b'.repeat(129)], ['phoneNumberId', 12345], ['businessAccountId', '１２３４５']]) assert.equal(invalidCredentialField({ ...values, [name]: value }), name);
});
