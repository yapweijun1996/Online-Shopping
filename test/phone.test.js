import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContactPhone } from '../src/phone.js';

test('valid Malaysia and Singapore contact numbers normalize to E.164', () => {
  assert.equal(normalizeContactPhone('+60 12-345 6789'), '+60123456789');
  assert.equal(normalizeContactPhone('+65 8123 4567'), '+6581234567');
});

test('contact phone rejects unsupported countries, malformed numbers, and extensions', () => {
  for (const value of ['60123456789', '+601234', '+66 8123 4567', '+65 1234 5678',
    '+65 8123 4567 ext 1', '+65 8123 4567;foo', '+65 8123 4567'.repeat(4), null]) {
    assert.throws(() => normalizeContactPhone(value), /valid \+60 or \+65/);
  }
});


test('product chat uses wa.me with the validated seller number and no message payload', async () => {
  const { sellerChatURL } = await import('../public/shop/product-detail.js');
  for (const input of ['+60 12-345 6789', '+65 8123 4567']) {
    const phone = normalizeContactPhone(input).slice(1);
    const url = new URL(sellerChatURL(phone));
    assert.equal(url.origin, 'https://wa.me');
    assert.equal(url.pathname, `/${phone}`);
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
  }
  for (const input of [null, undefined, 60123456789, '', '0123456789', '+60123456789',
    '60 123456789', '1234567', '1234567890123456', '60123456789?text=private', '60123456789/path']) {
    assert.equal(sellerChatURL(input), null);
  }
});
