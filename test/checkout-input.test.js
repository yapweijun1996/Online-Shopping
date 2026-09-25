import assert from 'node:assert/strict';
import test from 'node:test';
import { FieldError, validateBuyer, validateRecipient } from '../src/checkout-input.js';

const buyer = { fullName: ' Example Buyer ', whatsappPhone: '+60 12-345 6789', email: ' buyer@example.test ' };

test('buyer and recipient contacts validate independently of one another', () => {
  assert.deepEqual(validateBuyer(buyer, false), {
    fullName: 'Example Buyer', whatsappPhone: '+60123456789', email: 'buyer@example.test',
    whatsappOrderContactOptIn: false,
  });
  assert.deepEqual(validateRecipient({ fullName: ' Example Recipient ', phone: '+65 8123 4567' }, 2), {
    fullName: 'Example Recipient', phone: '+6581234567',
  });
});

test('contact validation identifies the field without echoing personal values', () => {
  for (const [value, consent, field] of [
    [{ ...buyer, fullName: '\nBuyer' }, true, 'buyer.fullName'],
    [{ ...buyer, whatsappPhone: '+66 8123 4567' }, true, 'buyer.whatsappPhone'],
    [{ ...buyer, email: 'invalid' }, true, 'buyer.email'],
    [buyer, 'true', 'whatsappOrderContactOptIn'],
  ]) {
    assert.throws(() => validateBuyer(value, consent), (error) => error instanceof FieldError && error.field === field && !error.message.includes('example.test'));
  }
  assert.throws(() => validateRecipient({ fullName: 'Recipient', phone: 'bad' }, 3),
    (error) => error instanceof FieldError && error.field === 'deliveries.3.recipient.phone');
});
