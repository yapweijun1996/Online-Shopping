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

const supportedLocales = new Set(['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko']);
const productIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateAddress(address, deliveryIndex) {
  const field = `deliveries.${deliveryIndex}.address`;
  if (!address || typeof address !== 'object' || Array.isArray(address)) {
    throw new FieldError(field, 'Enter a destination address.');
  }
  const country = boundedText(address.country, `${field}.country`, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new FieldError(`${field}.country`, 'Enter a two-letter country code.');
  return {
    line1: boundedText(address.line1, `${field}.line1`, 160),
    line2: boundedText(address.line2, `${field}.line2`, 160, false) || null,
    city: boundedText(address.city, `${field}.city`, 80, false) || null,
    region: boundedText(address.region, `${field}.region`, 80, false) || null,
    postcode: boundedText(address.postcode, `${field}.postcode`, 20),
    country,
  };
}

export function validateOrderInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new FieldError('order', 'Enter order details.');
  }
  const buyer = validateBuyer(input.buyer, input.whatsappOrderContactOptIn);
  const locale = input.locale === undefined ? 'en' : input.locale;
  if (!supportedLocales.has(locale)) throw new FieldError('locale', 'Choose a supported language.');
  if (!Array.isArray(input.deliveries) || input.deliveries.length < 1 || input.deliveries.length > 10) {
    throw new FieldError('deliveries', 'Add 1 to 10 destinations.');
  }
  let itemCount = 0;
  const deliveries = input.deliveries.map((delivery, index) => {
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
      throw new FieldError(`deliveries.${index}`, 'Enter destination details.');
    }
    const field = `deliveries.${index}.items`;
    if (!Array.isArray(delivery.items) || delivery.items.length < 1 || delivery.items.length > 50) {
      throw new FieldError(field, 'Assign 1 to 50 items to each destination.');
    }
    itemCount += delivery.items.length;
    if (itemCount > 100) throw new FieldError('deliveries', 'Assign at most 100 item lines.');
    const seen = new Set();
    const items = delivery.items.map((item, itemIndex) => {
      const itemField = `${field}.${itemIndex}`;
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          typeof item.productId !== 'string' || !productIdPattern.test(item.productId)) {
        throw new FieldError(`${itemField}.productId`, 'Choose an available product.');
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) {
        throw new FieldError(`${itemField}.quantity`, 'Choose a quantity from 1 to 100.');
      }
      const productId = item.productId.toLowerCase();
      if (seen.has(productId)) throw new FieldError(`${itemField}.productId`, 'Assign a product once per destination.');
      seen.add(productId);
      return { productId, quantity: item.quantity };
    });
    return {
      recipient: validateRecipient(delivery.recipient, index),
      address: validateAddress(delivery.address, index),
      items,
    };
  });
  return { buyer, locale, deliveries };
}
