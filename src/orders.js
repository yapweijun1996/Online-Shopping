import { createHash, randomUUID } from 'node:crypto';
import { validateOrderInput } from './checkout-input.js';
import { ApiError } from './http.js';
import { FieldError } from './validation.js';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function receipt(row) {
  return {
    orderNo: row.order_no,
    status: 'SUBMITTED',
    currency: row.currency,
    totalMinor: row.total_minor,
    submittedAt: row.submitted_at,
  };
}

export function createOrder(database, idempotencyKey, input) {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    throw new FieldError('Idempotency-Key', 'Supply a valid idempotency key.');
  }
  const order = validateOrderInput(input);
  const keyHash = digest(idempotencyKey);
  const requestHash = digest(JSON.stringify(order));

  return database.transaction(() => {
    const existing = database.get(`SELECT i.request_hash, o.order_no, o.currency, o.total_minor, o.submitted_at
      FROM checkout_idempotency i JOIN shop_order o ON o.id = i.order_id WHERE i.key_hash = ?`, keyHash);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This submission key was used for different order details.');
      }
      return { receipt: receipt(existing), replayed: true };
    }

    let totalMinor = 0;
    let currency = null;
    const snapshots = order.deliveries.map((delivery, deliveryIndex) => delivery.items.map((item, itemIndex) => {
      const product = database.get(`SELECT id, sku, name, price_minor, currency FROM product
        WHERE id = ? AND active = 1`, item.productId);
      if (!product) {
        const error = new ApiError(409, 'PRODUCT_UNAVAILABLE', 'A selected product is unavailable. Review the cart.');
        error.field = `deliveries.${deliveryIndex}.items.${itemIndex}.productId`;
        throw error;
      }
      if (currency && product.currency !== currency) {
        const error = new ApiError(409, 'MIXED_CURRENCY', 'Checkout one currency at a time. Review the cart.');
        error.field = `deliveries.${deliveryIndex}.items.${itemIndex}.productId`;
        throw error;
      }
      currency = product.currency;
      if (product.currency !== item.expectedCurrency) {
        const error = new ApiError(409, 'PRICE_CHANGED', 'A product price changed. Review the cart.');
        error.field = `deliveries.${deliveryIndex}.items.${itemIndex}.expectedCurrency`;
        throw error;
      }
      if (product.price_minor !== item.expectedPriceMinor) {
        const error = new ApiError(409, 'PRICE_CHANGED', 'A product price changed. Review the cart.');
        error.field = `deliveries.${deliveryIndex}.items.${itemIndex}.expectedPriceMinor`;
        throw error;
      }
      const lineTotalMinor = product.price_minor * item.quantity;
      totalMinor += lineTotalMinor;
      if (!Number.isSafeInteger(lineTotalMinor) || !Number.isSafeInteger(totalMinor)) {
        throw new FieldError('deliveries', 'Order total is too large.');
      }
      return { product, quantity: item.quantity, lineTotalMinor };
    }));

    const sequence = database.get('UPDATE order_sequence SET value = value + 1 WHERE id = 1 RETURNING value');
    const orderNo = `OS-${String(sequence.value).padStart(8, '0')}`;
    const id = randomUUID();
    const now = new Date().toISOString();
    database.run(`INSERT INTO shop_order
      (id, order_no, buyer_name, buyer_phone, buyer_email, whatsapp_opt_in, whatsapp_consent_at,
       whatsapp_consent_version, locale, status, revision, currency, total_minor, submitted_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 1, ?, ?, ?, ?)`,
      id, orderNo, order.buyer.fullName, order.buyer.whatsappPhone, order.buyer.email,
      Number(order.buyer.whatsappOrderContactOptIn), order.buyer.whatsappOrderContactOptIn ? now : null,
      order.buyer.whatsappOrderContactOptIn ? 'order-contact-v1' : null, order.locale, currency, totalMinor, now, now,
    );

    for (const [index, delivery] of order.deliveries.entries()) {
      const deliveryId = randomUUID();
      database.run(`INSERT INTO delivery
        (id, order_id, position, recipient_name, recipient_phone, address_line1, address_line2,
         address_city, address_region, address_postcode, address_country)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        deliveryId, id, index, delivery.recipient.fullName, delivery.recipient.phone,
        delivery.address.line1, delivery.address.line2, delivery.address.city, delivery.address.region,
        delivery.address.postcode, delivery.address.country,
      );
      for (const [itemIndex, snapshot] of snapshots[index].entries()) {
        database.run(`INSERT INTO order_item
          (id, delivery_id, position, product_id, sku_snapshot, name_snapshot, price_minor, quantity, line_total_minor, currency)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomUUID(), deliveryId, itemIndex, snapshot.product.id, snapshot.product.sku, snapshot.product.name,
          snapshot.product.price_minor, snapshot.quantity, snapshot.lineTotalMinor, snapshot.product.currency,
        );
      }
    }
    database.run(`INSERT INTO order_event
      (order_id, event_type, actor_type, actor_id, previous_status, status, reason, occurred_at)
      VALUES (?, 'SUBMITTED', 'GUEST', NULL, NULL, 'SUBMITTED', NULL, ?)`, id, now);
    database.run(`INSERT INTO checkout_idempotency(key_hash, request_hash, order_id, created_at)
      VALUES (?, ?, ?, ?)`, keyHash, requestHash, id, now);
    return { receipt: { orderNo, status: 'SUBMITTED', currency, totalMinor, submittedAt: now }, replayed: false };
  });
}
