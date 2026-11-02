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
  // Order events and contact erasures (kept as columns on the order) are listed together, newest first.
  const build = (column) => {
    const clauses = [], values = [];
    if (requested.length) { clauses.push(`${column.status} IN (${requested.map(() => '?').join(', ')})`); values.push(...requested); }
    if (actor) { clauses.push(column.actor); values.push(actor); }
    if (search) { clauses.push('instr(lower(o.order_no), lower(?)) > 0'); values.push(search); }
    if (from) { clauses.push(`${column.at} >= ?`); values.push(from); }
    if (to) { clauses.push(`${column.at} < ?`); values.push(to); }
    return { where: clauses.length ? `AND ${clauses.join(' AND ')}` : '', values };
  };
  const events = build({ status: 'e.status', actor: 'e.actor_type = ?', at: 'e.occurred_at' });
  const erasures = build({ status: 'o.status', actor: "'SELLER' = ?", at: 'o.contact_erased_at' });
  const rows = await database.all(`SELECT * FROM (
      SELECT CAST(e.id AS TEXT) AS id, e.order_id, o.order_no, o.status AS order_status, e.event_type, e.previous_status,
        e.status, e.actor_type, e.actor_id, e.reason, e.occurred_at, e.id AS seq
      FROM order_event e JOIN shop_order o ON o.id = e.order_id WHERE 1 = 1 ${events.where}
      UNION ALL
      SELECT 'erase-' || o.id AS id, o.id AS order_id, o.order_no, o.status AS order_status, 'CONTACT_ERASED' AS event_type, NULL AS previous_status,
        o.status AS status, 'SELLER' AS actor_type, o.contact_erased_by AS actor_id, NULL AS reason, o.contact_erased_at AS occurred_at, 0 AS seq
      FROM shop_order o WHERE o.contact_erased_at IS NOT NULL ${erasures.where}
    ) AS audit ORDER BY occurred_at DESC, seq DESC, id DESC LIMIT ? OFFSET ?`, ...events.values, ...erasures.values, limit + 1, offset);
  return {
    items: rows.slice(0, limit).map((row) => ({
      id: row.id, orderId: row.order_id, orderNo: row.order_no, orderStatus: row.order_status,
      type: row.event_type, previousStatus: row.previous_status, status: row.status,
      actorType: row.actor_type, actorId: row.actor_id, reason: row.reason, occurredAt: row.occurred_at,
    })),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}
