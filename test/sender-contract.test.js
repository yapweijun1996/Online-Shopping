import test from 'node:test';
import assert from 'node:assert/strict';
import { senderLimits, senderInputLimits, senderCountryOptions } from '../public/shared/sender-fields.js';
import { senderFields } from '../src/sender-settings.js';

test('shared sender limits retain storage/export column order and formatted-phone distinction', () => {
  assert.deepEqual(Object.keys(senderFields), ['senderName', 'senderPhone', 'senderAddressLine1', 'senderAddressLine2', 'senderCity', 'senderState', 'senderPostcode', 'senderCountry']);
  assert.deepEqual(Object.values(senderFields).map(([column]) => column), ['sender_name', 'sender_phone', 'sender_address_line1', 'sender_address_line2', 'sender_city', 'sender_state', 'sender_postcode', 'sender_country']);
  for (const [name, [, max]] of Object.entries(senderFields)) assert.equal(max, senderLimits[name]);
  assert.equal(senderLimits.senderPhone, 15); assert.equal(senderInputLimits.senderPhone, 32);
});
test('country choices have localized names without an unassigned-code list; arbitrary code fallback remains a separate UI path', () => {
  const english = senderCountryOptions('en'), chinese = senderCountryOptions('zh-Hans');
  assert.equal(english.find(item => item.code === 'MY').name, 'Malaysia'); assert.equal(chinese.find(item => item.code === 'MY').name, '马来西亚');
  assert.ok(english.some(item => item.code === 'SG')); assert.equal(english.some(item => item.code === 'ZZ' || item.code === 'AA'), false); assert.ok(english.length < 400);
  assert.ok(english.every(item => /^[A-Z]{2}$/.test(item.code) && item.name !== item.code));
});
