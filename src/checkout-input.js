import { normalizeContactPhone } from './phone.js';
import { FieldError, boundedText } from './validation.js';

function phone(value, field) {
  try { return normalizeContactPhone(value); }
  catch { throw new FieldError(field, 'Enter a valid +60 or +65 phone number.'); }
}

export function validateBuyer(buyer, whatsappOrderContactOptIn) {
  if (!buyer || typeof buyer !== 'object' || Array.isArray(buyer)) {
    throw new FieldError('buyer', 'Enter buyer details.');
  }
  const fullName = boundedText(buyer.fullName, 'buyer.fullName', 120);
  const whatsappPhone = phone(buyer.whatsappPhone, 'buyer.whatsappPhone');
  const email = boundedText(buyer.email, 'buyer.email', 254, false);
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.includes('..'))) {
    throw new FieldError('buyer.email', 'Enter a valid email address.');
  }
  if (typeof whatsappOrderContactOptIn !== 'boolean') {
    throw new FieldError('whatsappOrderContactOptIn', 'Choose whether to allow order contact by WhatsApp.');
  }
  return { fullName, whatsappPhone, email: email || null, whatsappOrderContactOptIn };
}

export function validateRecipient(recipient, deliveryIndex) {
  if (!Number.isSafeInteger(deliveryIndex) || deliveryIndex < 0) throw new TypeError('Invalid delivery index.');
  const field = `deliveries.${deliveryIndex}.recipient`;
  if (!recipient || typeof recipient !== 'object' || Array.isArray(recipient)) {
    throw new FieldError(field, 'Enter recipient details.');
  }
  return {
    fullName: boundedText(recipient.fullName, `${field}.fullName`, 120),
    phone: phone(recipient.phone, `${field}.phone`),
  };
}
