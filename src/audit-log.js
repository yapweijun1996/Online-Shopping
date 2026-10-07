import { FieldError, boundedText } from './validation.js';
import { listNumber, statuses } from './seller-orders.js';

const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const actorTypes = new Set(['SELLER', 'GUEST']);

function instant(params, key) {
  const value = params.get(key);
  if (!value) return null;
  if (!isoInstant.test(value) || Number.isNaN(Date.parse(value))) throw new FieldError(key, 'Enter a valid date.');
  return value;
}

/* Every order event, newest first, for the Audit log page. Read-only: events are only ever appended. */
export async function listAuditEvents(database, params) {
  const requested = (params.get('status') || '').split(',').filter(Boolean);
  if (requested.length > statuses.size || requested.some((value) => !statuses.has(value)) || new Set(requested).size !== requested.length) {
    throw new FieldError('status', 'Choose a valid order status.');
  }
  const actor = params.get('actor') || '';
  if (actor && !actorTypes.has(actor)) throw new FieldError('actor', 'Choose a valid actor.');
  const search = boundedText(params.get('search'), 'search', 40, false);
  const from = instant(params, 'from'), to = instant(params, 'to');
  const limit = listNumber(params, 'limit', 30, 100);
  const offset = listNumber(params, 'offset', 0, 10_000);
  if (limit < 1) throw new FieldError('limit', 'Enter a valid list range.');
  const clauses = [], values = [];
  if (requested.length) { clauses.push(`e.status IN (${requested.map(() => '?').join(', ')})`); values.push(...requested); }
  if (actor) { clauses.push('e.actor_type = ?'); values.push(actor); }
  if (search) { clauses.push('instr(lower(o.order_no), lower(?)) > 0'); values.push(search); }
  if (from) { clauses.push('e.occurred_at >= ?'); values.push(from); }
  if (to) { clauses.push('e.occurred_at < ?'); values.push(to); }
  const rows = await database.all(`SELECT e.id, e.order_id, o.order_no, o.status AS order_status, e.event_type, e.previous_status,
      e.status, e.actor_type, e.actor_id, e.reason, e.occurred_at
    FROM order_event e JOIN shop_order o ON o.id = e.order_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY e.id DESC LIMIT ? OFFSET ?`, ...values, limit + 1, offset);
  return {
    items: rows.slice(0, limit).map((row) => ({
      id: row.id, orderId: row.order_id, orderNo: row.order_no, orderStatus: row.order_status,
      type: row.event_type, previousStatus: row.previous_status, status: row.status,
      actorType: row.actor_type, actorId: row.actor_id, reason: row.reason, occurredAt: row.occurred_at,
    })),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}
