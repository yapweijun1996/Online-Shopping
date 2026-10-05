import { getShopSetup } from './shop-setup.js';
import { createHash, randomUUID } from 'node:crypto';
import { validateOrderInput } from './checkout-input.js';
import { ApiError } from './http.js';
import { FieldError } from './validation.js';
import { ORDER_RETENTION_MS, statusAccessKeyPattern } from '../public/shared/order-status.js';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

const orderNoPattern = /^(?:OS|DEMO)-\d{8,}$/;

export async function lookupOrderStatuses(database, input, now = Date.now()) {
  if (!Array.isArray(input?.orders) || input.orders.length < 1 || input.orders.length > 50 ||
      Object.keys(input).length !== 1) throw new FieldError('orders', 'Supply 1 to 50 order credentials.');
  const seen = new Set();
  const cutoff = new Date(now - ORDER_RETENTION_MS).toISOString();
  const items = [];
  for (const entry of input.orders) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).length !== 2 ||
        typeof entry.orderNo !== 'string' || !orderNoPattern.test(entry.orderNo) ||
        typeof entry.accessKey !== 'string' || !statusAccessKeyPattern.test(entry.accessKey) ||
        seen.has(entry.orderNo)) throw new FieldError('orders', 'Supply valid, unique order credentials.');
    seen.add(entry.orderNo);
    const row = await database.get(`SELECT o.order_no, o.status, o.updated_at, o.tracking_carrier, o.tracking_no FROM checkout_idempotency i
      JOIN shop_order o ON o.id = i.order_id
      WHERE i.key_hash = ? AND o.order_no = ? AND o.submitted_at > ?`,
    digest(entry.accessKey), entry.orderNo, cutoff);
    if (row) {
      items.push({ orderNo: row.order_no, status: row.status, updatedAt: row.updated_at,
        ...(row.tracking_carrier ? { trackingCarrier: row.tracking_carrier, trackingNo: row.tracking_no } : {}) });
    }
  }
  return { items };
}

function receipt(row) {
  return {
    orderNo: row.order_no,
    ...(row.order_no.startsWith('DEMO-') ? { simulation: true } : {}),
    status: 'SUBMITTED',
    currency: row.currency,
    totalMinor: row.total_minor,
    submittedAt: row.submitted_at,
  };
}

export async function createOrder(database, idempotencyKey, input) {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    throw new FieldError('Idempotency-Key', 'Supply a valid idempotency key.');
  }
  const simulation = (await getShopSetup(database)).mode === 'demo';
  const order = validateOrderInput(input, { simulation });
  const keyHash = digest(idempotencyKey);
  const requestHash = digest(JSON.stringify(order));

  return await database.transaction(async () => {
    const existing = await database.get(`SELECT i.request_hash, o.order_no, o.currency, o.total_minor, o.submitted_at
      FROM checkout_idempotency i JOIN shop_order o ON o.id = i.order_id WHERE i.key_hash = ?`, keyHash);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This submission key was used for different order details.');
      }
      return { receipt: receipt(existing), replayed: true };
    }

    let totalMinor = 0;
    let currency = null;
    const requested = new Map();
    const snapshots = await Promise.all(order.deliveries.map(async (delivery, deliveryIndex) => await Promise.all(delivery.items.map(async (item, itemIndex) => {
      const product = await database.get(`SELECT id, sku, name, price_minor, currency, stock_quantity FROM product
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
      // Stock is only deducted when the seller confirms, but an order the shop cannot cover is refused up front.
      requested.set(product.id, (requested.get(product.id) || 0) + item.quantity);
      if (product.stock_quantity !== null && requested.get(product.id) > product.stock_quantity) {
        const error = new ApiError(409, 'OUT_OF_STOCK', 'A selected product does not have enough stock. Review the cart.');
        error.field = `deliveries.${deliveryIndex}.items.${itemIndex}.quantity`;
        throw error;
      }
      const lineTotalMinor = product.price_minor * item.quantity;
      totalMinor += lineTotalMinor;
      if (!Number.isSafeInteger(lineTotalMinor) || !Number.isSafeInteger(totalMinor)) {
        throw new FieldError('deliveries', 'Order total is too large.');
      }
      return { product, quantity: item.quantity, lineTotalMinor };
    }))));

    const sequence = await database.get('UPDATE order_sequence SET value = value + 1 WHERE id = 1 RETURNING value');
    const orderNo = `${simulation ? 'DEMO' : 'OS'}-${String(sequence.value).padStart(8, '0')}`;
    const id = randomUUID();
    const now = new Date().toISOString();
    await database.run(`INSERT INTO shop_order
      (id, order_no, buyer_name, buyer_phone, buyer_email, whatsapp_opt_in, whatsapp_consent_at,
       whatsapp_consent_version, locale, status, revision, currency, total_minor, submitted_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 1, ?, ?, ?, ?)`,
      id, orderNo, order.buyer.fullName, order.buyer.whatsappPhone, order.buyer.email,
      Number(order.buyer.whatsappOrderContactOptIn), order.buyer.whatsappOrderContactOptIn ? now : null,
      order.buyer.whatsappOrderContactOptIn ? 'order-contact-v2' : null, order.locale, currency, totalMinor, now, now,
    );

    for (const [index, delivery] of order.deliveries.entries()) {
      const deliveryId = randomUUID();
      await database.run(`INSERT INTO delivery
        (id, order_id, position, recipient_name, recipient_phone, address_line1, address_line2,
         address_city, address_region, address_postcode, address_country)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        deliveryId, id, index, delivery.recipient.fullName, delivery.recipient.phone,
        delivery.address.line1, delivery.address.line2, delivery.address.city, delivery.address.region,
        delivery.address.postcode, delivery.address.country,
      );
      for (const [itemIndex, snapshot] of snapshots[index].entries()) {
        await database.run(`INSERT INTO order_item
          (id, delivery_id, position, product_id, sku_snapshot, name_snapshot, price_minor, quantity, line_total_minor, currency)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomUUID(), deliveryId, itemIndex, snapshot.product.id, snapshot.product.sku, snapshot.product.name,
          snapshot.product.price_minor, snapshot.quantity, snapshot.lineTotalMinor, snapshot.product.currency,
        );
      }
    }
    await database.run(`INSERT INTO order_event
      (order_id, event_type, actor_type, actor_id, previous_status, status, reason, occurred_at)
      VALUES (?, 'SUBMITTED', 'GUEST', NULL, NULL, 'SUBMITTED', NULL, ?)`, id, now);
    await database.run(`INSERT INTO checkout_idempotency(key_hash, request_hash, order_id, created_at)
      VALUES (?, ?, ?, ?)`, keyHash, requestHash, id, now);
    return { receipt: { ...(simulation ? { simulation: true } : {}), orderNo, status: 'SUBMITTED', currency, totalMinor, submittedAt: now }, replayed: false };
  });
}
