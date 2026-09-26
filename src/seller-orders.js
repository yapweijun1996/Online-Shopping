import { ApiError } from './http.js';
import { FieldError, boundedText } from './validation.js';

const orderColumns = `id, order_no, buyer_name, buyer_phone, buyer_email, whatsapp_opt_in,
  whatsapp_consent_at, whatsapp_consent_version, locale, status, revision, currency,
  total_minor, submitted_at, updated_at`;
const queueColumns = 'id, order_no, buyer_name, status, revision, currency, total_minor, submitted_at, updated_at';
const statuses = new Set(['SUBMITTED', 'CONFIRMED', 'REJECTED']);

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
    id: row.id, orderNo: row.order_no, buyerName: row.buyer_name,
    status: row.status, revision: row.revision, currency: row.currency,
    totalMinor: row.total_minor, submittedAt: row.submitted_at, updatedAt: row.updated_at,
  };
}

export function listSellerOrders(database, params) {
  const status = params.get('status') || '';
  if (status && !statuses.has(status)) throw new FieldError('status', 'Choose a valid order status.');
  const search = boundedText(params.get('search'), 'search', 40, false);
  const limit = listNumber(params, 'limit', 20, 100);
  const offset = listNumber(params, 'offset', 0, 10_000);
  if (limit < 1) throw new FieldError('limit', 'Enter a valid list range.');
  const rows = database.all(`SELECT ${queueColumns} FROM shop_order
    WHERE (? = '' OR status = ?) AND (? = '' OR instr(lower(order_no), lower(?)) > 0)
    ORDER BY submitted_at DESC, id DESC LIMIT ? OFFSET ?`, status, status, search, search, limit + 1, offset);
  return { items: rows.slice(0, limit).map(summary), nextOffset: rows.length > limit ? offset + limit : null };
}

function readSellerOrder(database, id) {
  const row = database.get(`SELECT ${orderColumns} FROM shop_order WHERE id = ?`, id);
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
  if (action === 'confirm') {
    if (Object.keys(input).some((key) => key !== 'expectedRevision')) {
      throw new FieldError('decision', 'Unexpected confirmation field.');
    }
    return { status: 'CONFIRMED', reason: null };
  }
  if (Object.keys(input).some((key) => !['expectedRevision', 'reason'].includes(key))) {
    throw new FieldError('decision', 'Unexpected rejection field.');
  }
  return { status: 'REJECTED', reason: boundedText(input.reason, 'reason', 500) };
}

export function decideSellerOrder(database, id, action, input, actorId) {
  if (!['confirm', 'reject'].includes(action)) throw new TypeError('Invalid order action.');
  const decision = validateDecision(action, input);
  const now = new Date().toISOString();
  database.transaction(() => {
    const current = database.get('SELECT status, revision FROM shop_order WHERE id = ?', id);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    if (current.status !== 'SUBMITTED' || current.revision !== input.expectedRevision) {
      throw new ApiError(409, 'STALE_REVISION', 'The order changed. Reload and try again.');
    }
    const changed = database.get(`UPDATE shop_order SET status = ?, revision = revision + 1,
      updated_at = ? WHERE id = ? AND status = 'SUBMITTED' AND revision = ? RETURNING id`,
    decision.status, now, id, input.expectedRevision);
    if (!changed) {
      throw new ApiError(409, 'STALE_REVISION', 'The order changed. Reload and try again.');
    }
    database.run(`INSERT INTO order_event
      (order_id, event_type, actor_type, actor_id, previous_status, status, reason, occurred_at)
      VALUES (?, ?, 'SELLER', ?, 'SUBMITTED', ?, ?, ?)`, id, decision.status, actorId, decision.status, decision.reason, now);
  });
  return getSellerOrder(database, id);
}
