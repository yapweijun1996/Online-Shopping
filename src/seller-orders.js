import { ApiError } from './http.js';
import { FieldError, boundedText } from './validation.js';
import { shopIdOf } from './tenant.js';

const orderColumns = `id, order_no, buyer_name, buyer_phone, buyer_email, whatsapp_opt_in,
  whatsapp_consent_at, whatsapp_consent_version, locale, status, revision, currency,
  total_minor, submitted_at, updated_at, tracking_carrier, tracking_no`;
const queueColumns = 'id, order_no, buyer_name, status, revision, currency, total_minor, submitted_at, updated_at, tracking_carrier, tracking_no';
const statuses = new Set(['SUBMITTED', 'CONFIRMED', 'REJECTED', 'SHIPPED', 'DELIVERED', 'CANCELLED']);
// Each seller action moves an order from one status to the next; cancelling is possible until it ships.
const transitions = {
  confirm: { from: 'SUBMITTED', to: 'CONFIRMED' },
  reject: { from: 'SUBMITTED', to: 'REJECTED' },
  ship: { from: 'CONFIRMED', to: 'SHIPPED' },
  deliver: { from: 'SHIPPED', to: 'DELIVERED' },
  cancel: { from: 'CONFIRMED', to: 'CANCELLED' },
};

function listNumber(params, key, fallback, maximum) {
  const value = params.get(key);
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > maximum) {
    throw new FieldError(key, 'Enter a valid list range.');
  }
  return Number(value);
}

function summary(row) {
  return {
    ...(row.order_no.startsWith('DEMO-') ? { simulation: true } : {}),
    id: row.id, orderNo: row.order_no, buyerName: row.buyer_name,
    status: row.status, revision: row.revision, currency: row.currency,
    totalMinor: row.total_minor, submittedAt: row.submitted_at, updatedAt: row.updated_at,
    ...(row.tracking_carrier ? { trackingCarrier: row.tracking_carrier, trackingNo: row.tracking_no } : {}),
  };
}

/* Number of orders waiting for a decision, used for the seller's new-order alert. */
export function pendingOrderSummary(database) {
  const shopId = shopIdOf(database);
  const { pending } = database.get("SELECT COUNT(*) AS pending FROM shop_order WHERE shop_id = ? AND status = 'SUBMITTED'", shopId);
  const latest = database.get("SELECT MAX(submitted_at) AS at FROM shop_order WHERE shop_id = ? AND status = 'SUBMITTED'", shopId).at;
  return { pending, latestSubmittedAt: latest };
}

export function listSellerOrders(database, params) {
  const status = params.get('status') || '';
  if (status && !statuses.has(status)) throw new FieldError('status', 'Choose a valid order status.');
  const search = boundedText(params.get('search'), 'search', 40, false);
  const limit = listNumber(params, 'limit', 20, 100);
  const offset = listNumber(params, 'offset', 0, 10_000);
  if (limit < 1) throw new FieldError('limit', 'Enter a valid list range.');
  const rows = database.all(`SELECT ${queueColumns} FROM shop_order
    WHERE shop_id = ? AND (? = '' OR status = ?) AND (? = '' OR instr(lower(order_no), lower(?)) > 0)
    ORDER BY submitted_at DESC, id DESC LIMIT ? OFFSET ?`, shopIdOf(database), status, status, search, search, limit + 1, offset);
  return { items: rows.slice(0, limit).map(summary), nextOffset: rows.length > limit ? offset + limit : null };
}

function readSellerOrder(database, id) {
  const row = database.get(`SELECT ${orderColumns} FROM shop_order WHERE shop_id = ? AND id = ?`, shopIdOf(database), id);
  if (!row) return null;
  const deliveries = database.all(`SELECT id, position, recipient_name, recipient_phone,
    address_line1, address_line2, address_city, address_region, address_postcode, address_country
    FROM delivery WHERE order_id = ? ORDER BY position`, id).map((delivery) => ({
    id: delivery.id,
    position: delivery.position,
    recipient: { fullName: delivery.recipient_name, phone: delivery.recipient_phone },
    address: {
      line1: delivery.address_line1, line2: delivery.address_line2,
      city: delivery.address_city, region: delivery.address_region,
      postcode: delivery.address_postcode, country: delivery.address_country,
    },
    items: database.all(`SELECT product_id, sku_snapshot, name_snapshot, price_minor,
      quantity, line_total_minor, currency FROM order_item WHERE delivery_id = ? ORDER BY position`, delivery.id).map((item) => ({
        productId: item.product_id, sku: item.sku_snapshot, name: item.name_snapshot,
        priceMinor: item.price_minor, quantity: item.quantity,
        lineTotalMinor: item.line_total_minor, currency: item.currency,
      })),
  }));
  const events = database.all(`SELECT event_type, actor_type, actor_id, previous_status,
    status, reason, occurred_at FROM order_event WHERE order_id = ? ORDER BY id`, id)
    .map((event) => ({
      type: event.event_type, actorType: event.actor_type, actorId: event.actor_id,
      previousStatus: event.previous_status, status: event.status,
      reason: event.reason, occurredAt: event.occurred_at,
    }));
  return {
    ...summary(row), locale: row.locale,
    buyer: {
      fullName: row.buyer_name, whatsappPhone: row.buyer_phone, email: row.buyer_email,
      whatsappOrderContactOptIn: Boolean(row.whatsapp_opt_in),
      whatsappConsentAt: row.whatsapp_consent_at,
      whatsappConsentVersion: row.whatsapp_consent_version,
    },
    deliveries, events,
  };
}

export function getSellerOrder(database, id) {
  return database.transaction(() => readSellerOrder(database, id));
}

function validateDecision(action, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new FieldError('expectedRevision', 'Supply the current order revision.');
  }
  const allowed = { confirm: [], deliver: [], reject: ['reason'], cancel: ['reason'], ship: ['carrier', 'trackingNo'] }[action];
  if (Object.keys(input).some((key) => key !== 'expectedRevision' && !allowed.includes(key))) {
    throw new FieldError('decision', 'Unexpected order action field.');
  }
  const { to } = transitions[action];
  if (action === 'reject' || action === 'cancel') return { status: to, reason: boundedText(input.reason, 'reason', 500), tracking: null };
  if (action === 'ship') {
    return {
      status: to, reason: null,
      tracking: { carrier: boundedText(input.carrier, 'carrier', 40), trackingNo: boundedText(input.trackingNo ?? '', 'trackingNo', 60, false) || null },
    };
  }
  return { status: to, reason: null, tracking: null };
}

/* Confirming an order takes its quantities from tracked stock; the transaction rolls back if any product is short. */
function deductStock(database, orderId) {
  const lines = database.all(`SELECT i.product_id, SUM(i.quantity) AS quantity, p.sku, p.stock_quantity
    FROM order_item i JOIN delivery d ON d.id = i.delivery_id JOIN product p ON p.id = i.product_id
    WHERE d.order_id = ? GROUP BY i.product_id, p.sku, p.stock_quantity`, orderId);
  for (const line of lines) {
    if (line.stock_quantity === null) continue;
    if (line.stock_quantity < line.quantity) {
      const error = new ApiError(409, 'INSUFFICIENT_STOCK', `Not enough stock for ${line.sku}.`);
      error.field = 'stock';
      throw error;
    }
    database.run('UPDATE product SET stock_quantity = stock_quantity - ? WHERE shop_id = ? AND id = ?', line.quantity, shopIdOf(database), line.product_id);
  }
}

/* Cancelling a confirmed order returns its quantities to tracked stock. */
function restoreStock(database, orderId) {
  database.run(`UPDATE product SET stock_quantity = stock_quantity + COALESCE((
      SELECT SUM(i.quantity) FROM order_item i JOIN delivery d ON d.id = i.delivery_id
      WHERE d.order_id = ? AND i.product_id = product.id), 0)
    WHERE shop_id = ? AND stock_quantity IS NOT NULL AND id IN (
      SELECT i.product_id FROM order_item i JOIN delivery d ON d.id = i.delivery_id WHERE d.order_id = ?)`, orderId, shopIdOf(database), orderId);
}

export function decideSellerOrder(database, id, action, input, actorId) {
  if (!Object.hasOwn(transitions, action)) throw new TypeError('Invalid order action.');
  const decision = validateDecision(action, input);
  const now = new Date().toISOString();
  database.transaction(() => {
    const current = database.get('SELECT status, revision FROM shop_order WHERE shop_id = ? AND id = ?', shopIdOf(database), id);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    const { from } = transitions[action];
    if (current.status !== from || current.revision !== input.expectedRevision) {
      throw new ApiError(409, 'STALE_REVISION', 'The order changed. Reload and try again.');
    }
    const tracking = decision.tracking;
    const changed = database.get(`UPDATE shop_order SET status = ?, revision = revision + 1, updated_at = ?
      ${tracking ? ', tracking_carrier = ?, tracking_no = ?' : ''}
      WHERE shop_id = ? AND id = ? AND status = ? AND revision = ? RETURNING id`,
    decision.status, now, ...(tracking ? [tracking.carrier, tracking.trackingNo] : []), shopIdOf(database), id, from, input.expectedRevision);
    if (!changed) {
      throw new ApiError(409, 'STALE_REVISION', 'The order changed. Reload and try again.');
    }
    if (decision.status === 'CONFIRMED') deductStock(database, id);
    if (decision.status === 'CANCELLED') restoreStock(database, id);
    database.run(`INSERT INTO order_event
      (order_id, event_type, actor_type, actor_id, previous_status, status, reason, occurred_at)
      VALUES (?, ?, 'SELLER', ?, ?, ?, ?, ?)`, id, decision.status, actorId, from, decision.status, decision.reason, now);
  });
  return getSellerOrder(database, id);
}
