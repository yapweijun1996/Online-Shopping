import { ApiError } from './http.js';
import { FieldError, boundedText } from './validation.js';
import { productCover } from './product-gallery.js';
import { documentTrail } from './document-trail.js';

const orderColumns = `id, order_no, buyer_name, buyer_phone, buyer_email, whatsapp_opt_in,
  whatsapp_consent_at, whatsapp_consent_version, locale, status, revision, currency,
  total_minor, submitted_at, updated_at, tracking_carrier, tracking_no, contact_erased_at, contact_erased_by`;
const queueColumns = 'id, order_no, buyer_name, status, revision, currency, total_minor, submitted_at, updated_at, tracking_carrier, tracking_no, contact_erased_at';
export const statuses = new Set(['SUBMITTED', 'CONFIRMED', 'REJECTED', 'SHIPPED', 'DELIVERED', 'CANCELLED']);
// Each seller action moves an order from one status to the next; cancelling is possible until it ships.
const transitions = {
  confirm: { from: 'SUBMITTED', to: 'CONFIRMED' },
  reject: { from: 'SUBMITTED', to: 'REJECTED' },
  ship: { from: 'CONFIRMED', to: 'SHIPPED' },
  deliver: { from: 'SHIPPED', to: 'DELIVERED' },
  cancel: { from: 'CONFIRMED', to: 'CANCELLED' },
};

export function listNumber(params, key, fallback, maximum) {
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
    ...(row.contact_erased_at ? { contactErased: true } : {}),
  };
}

/* Number of orders waiting for a decision, used for the seller's new-order alert. */
export async function pendingOrderSummary(database) {
  const { pending } = await database.get("SELECT COUNT(*) AS pending FROM shop_order WHERE status = 'SUBMITTED'");
  const latest = (await database.get("SELECT MAX(submitted_at) AS at FROM shop_order WHERE status = 'SUBMITTED'")).at;
  return { pending, latestSubmittedAt: latest };
}

/* First ordered product (name and cover) plus the item count for each order, so a list row says what was bought. */
async function orderPreviews(database, orderIds) {
  const previews = new Map();
  if (!orderIds.length) return previews;
  const lines = await database.all(`SELECT d.order_id, i.product_id, i.name_snapshot, i.quantity, p.image_mime
    FROM order_item i JOIN delivery d ON d.id = i.delivery_id JOIN product p ON p.id = i.product_id
    WHERE d.order_id IN (${orderIds.map(() => '?').join(', ')}) ORDER BY d.order_id, d.position, i.position`, ...orderIds);
  for (const line of lines) {
    const preview = previews.get(line.order_id);
    if (preview) { preview.itemCount += 1; continue; }
    previews.set(line.order_id, { itemCount: 1, name: line.name_snapshot, imageUrl: await productCover(database,
      { id: line.product_id, imageUrl: line.image_mime ? `/api/v1/seller/products/${line.product_id}/image` : null }, true) });
  }
  return previews;
}

const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const currencies = new Set(['MYR', 'SGD']);

function instantParam(params, key) {
  const value = params.get(key);
  if (!value) return null;
  if (!isoInstant.test(value) || Number.isNaN(Date.parse(value))) throw new FieldError(key, 'Enter a valid date.');
  return value;
}

function amountParam(params, key) {
  const value = params.get(key);
  if (!value) return null;
  if (!/^(0|[1-9]\d{0,11})$/.test(value)) throw new FieldError(key, 'Enter a valid amount.');
  return Number(value);
}

/* WHERE clause shared by the order list and the CSV export: status, order-number search, submitted date range
   (exact UTC instants, `to` exclusive), currency and total range in minor units. Values are always bound parameters. */
export function orderFilter(params, prefix = '') {
  const requested = (params.get('status') || '').split(',').filter(Boolean);
  if (requested.length > statuses.size || requested.some((value) => !statuses.has(value)) || new Set(requested).size !== requested.length) {
    throw new FieldError('status', 'Choose a valid order status.');
  }
  const search = boundedText(params.get('search'), 'search', 40, false);
  const currency = params.get('currency') || '';
  if (currency && !currencies.has(currency)) throw new FieldError('currency', 'Choose a valid currency.');
  const from = instantParam(params, 'from'), to = instantParam(params, 'to');
  const minTotal = amountParam(params, 'minTotal'), maxTotal = amountParam(params, 'maxTotal');
  if (minTotal !== null && maxTotal !== null && minTotal > maxTotal) throw new FieldError('minTotal', 'The minimum is above the maximum.');
  const clauses = [], values = [];
  if (requested.length) { clauses.push(`${prefix}status IN (${requested.map(() => '?').join(', ')})`); values.push(...requested); }
  if (search) { clauses.push(`instr(lower(${prefix}order_no), lower(?)) > 0`); values.push(search); }
  if (currency) { clauses.push(`${prefix}currency = ?`); values.push(currency); }
  if (from) { clauses.push(`${prefix}submitted_at >= ?`); values.push(from); }
  if (to) { clauses.push(`${prefix}submitted_at < ?`); values.push(to); }
  if (minTotal !== null) { clauses.push(`${prefix}total_minor >= ?`); values.push(minTotal); }
  if (maxTotal !== null) { clauses.push(`${prefix}total_minor <= ?`); values.push(maxTotal); }
  return { where: clauses.length ? clauses.join(' AND ') : '1 = 1', values };
}

export async function listSellerOrders(database, params) {
  const filter = orderFilter(params);
  const limit = listNumber(params, 'limit', 20, 100);
  const offset = listNumber(params, 'offset', 0, 10_000);
  if (limit < 1) throw new FieldError('limit', 'Enter a valid list range.');
  const rows = await database.all(`SELECT ${queueColumns} FROM shop_order
    WHERE ${filter.where} ORDER BY submitted_at DESC, id DESC LIMIT ? OFFSET ?`, ...filter.values, limit + 1, offset);
  const page = rows.slice(0, limit);
  const previews = await orderPreviews(database, page.map((row) => row.id));
  return { items: page.map((row) => ({ ...summary(row), ...(previews.get(row.id) ? { preview: previews.get(row.id) } : {}) })), nextOffset: rows.length > limit ? offset + limit : null };
}

async function readSellerOrder(database, id) {
  const row = await database.get(`SELECT ${orderColumns} FROM shop_order WHERE id = ?`, id);
  if (!row) return null;
  const deliveries = await Promise.all((await database.all(`SELECT id, position, recipient_name, recipient_phone,
    address_line1, address_line2, address_city, address_region, address_postcode, address_country
    FROM delivery WHERE order_id = ? ORDER BY position`, id)).map(async (delivery) => ({
    id: delivery.id,
    position: delivery.position,
    recipient: { fullName: delivery.recipient_name, phone: delivery.recipient_phone },
    address: {
      line1: delivery.address_line1, line2: delivery.address_line2,
      city: delivery.address_city, region: delivery.address_region,
      postcode: delivery.address_postcode, country: delivery.address_country,
    },
    items: await Promise.all((await database.all(`SELECT oi.product_id, oi.sku_snapshot, oi.name_snapshot, oi.price_minor,
      oi.quantity, oi.line_total_minor, oi.currency, p.image_mime FROM order_item oi
      JOIN product p ON p.id = oi.product_id WHERE oi.delivery_id = ? ORDER BY oi.position`, delivery.id)).map(async (item) => ({
        productId: item.product_id, sku: item.sku_snapshot, name: item.name_snapshot,
        priceMinor: item.price_minor, quantity: item.quantity,
        lineTotalMinor: item.line_total_minor, currency: item.currency,
        // The product's current cover, so staff can recognise what was ordered (null when it has no image).
        imageUrl: await productCover(database, { id: item.product_id, imageUrl: item.image_mime ? `/api/v1/seller/products/${item.product_id}/image` : null }, true),
      }))),
  })));
  const events = (await database.all(`SELECT event_type, actor_type, actor_id, previous_status,
    status, reason, occurred_at FROM order_event WHERE order_id = ? ORDER BY id`, id))
    .map((event) => ({
      type: event.event_type, actorType: event.actor_type, actorId: event.actor_id,
      previousStatus: event.previous_status, status: event.status,
      reason: event.reason, occurredAt: event.occurred_at,
    }));
  return {
    ...summary(row), locale: row.locale,
    ...(row.contact_erased_at ? { contactErasedAt: row.contact_erased_at, contactErasedBy: row.contact_erased_by } : {}),
    buyer: {
      fullName: row.buyer_name, whatsappPhone: row.buyer_phone, email: row.buyer_email,
      whatsappOrderContactOptIn: Boolean(row.whatsapp_opt_in),
      whatsappConsentAt: row.whatsapp_consent_at,
      whatsappConsentVersion: row.whatsapp_consent_version,
    },
    deliveries, events,
    documents: documentTrail(row.order_no, events, { carrier: row.tracking_carrier, trackingNo: row.tracking_no }),
  };
}

export async function getSellerOrder(database, id) {
  return await database.transaction(async () => await readSellerOrder(database, id));
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
async function deductStock(database, orderId) {
  const lines = await database.all(`SELECT i.product_id, SUM(i.quantity) AS quantity, p.sku, p.stock_quantity
    FROM order_item i JOIN delivery d ON d.id = i.delivery_id JOIN product p ON p.id = i.product_id
    WHERE d.order_id = ? GROUP BY i.product_id, p.sku, p.stock_quantity`, orderId);
  for (const line of lines) {
    if (line.stock_quantity === null) continue;
    if (line.stock_quantity < line.quantity) {
      const error = new ApiError(409, 'INSUFFICIENT_STOCK', `Not enough stock for ${line.sku}.`);
      error.field = 'stock';
      throw error;
    }
    await database.run('UPDATE product SET stock_quantity = stock_quantity - ? WHERE id = ?', line.quantity, line.product_id);
  }
}

/* Cancelling a confirmed order returns its quantities to tracked stock. */
async function restoreStock(database, orderId) {
  await database.run(`UPDATE product SET stock_quantity = stock_quantity + COALESCE((
      SELECT SUM(i.quantity) FROM order_item i JOIN delivery d ON d.id = i.delivery_id
      WHERE d.order_id = ? AND i.product_id = product.id), 0)
    WHERE stock_quantity IS NOT NULL AND id IN (
      SELECT i.product_id FROM order_item i JOIN delivery d ON d.id = i.delivery_id WHERE d.order_id = ?)`, orderId, orderId);
}

export async function decideSellerOrder(database, id, action, input, actorId) {
  if (!Object.hasOwn(transitions, action)) throw new TypeError('Invalid order action.');
  const decision = validateDecision(action, input);
  const now = new Date().toISOString();
  await database.transaction(async () => {
    const current = await database.get('SELECT status, revision FROM shop_order WHERE id = ?', id);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    const { from } = transitions[action];
    if (current.status !== from || current.revision !== input.expectedRevision) {
      throw new ApiError(409, 'STALE_REVISION', 'The order changed. Reload and try again.');
    }
    const tracking = decision.tracking;
    const changed = await database.get(`UPDATE shop_order SET status = ?, revision = revision + 1, updated_at = ?
      ${tracking ? ', tracking_carrier = ?, tracking_no = ?' : ''}
      WHERE id = ? AND status = ? AND revision = ? RETURNING id`,
    decision.status, now, ...(tracking ? [tracking.carrier, tracking.trackingNo] : []), id, from, input.expectedRevision);
    if (!changed) {
      throw new ApiError(409, 'STALE_REVISION', 'The order changed. Reload and try again.');
    }
    if (decision.status === 'CONFIRMED') await deductStock(database, id);
    if (decision.status === 'CANCELLED') await restoreStock(database, id);
    await database.run(`INSERT INTO order_event
      (order_id, event_type, actor_type, actor_id, previous_status, status, reason, occurred_at)
      VALUES (?, ?, 'SELLER', ?, ?, ?, ?, ?)`, id, decision.status, actorId, from, decision.status, decision.reason, now);
  });
  return await getSellerOrder(database, id);
}

/* Adds a link to each ordered product's public page on the shop origin. */
export function withProductLinks(order, shopOrigin) {
  if (!order) return order;
  return { ...order, deliveries: order.deliveries.map((delivery) => ({ ...delivery, items: delivery.items.map((item) => ({
    ...item, productUrl: `${shopOrigin}/shop/#product/${item.productId.toLowerCase()}`,
  })) })) };
}
