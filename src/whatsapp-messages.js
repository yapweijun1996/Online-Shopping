// Seller-facing views of WhatsApp traffic: buyer replies, messages that need attention, and what the seller may do
// with them. Phone numbers are never returned (replies carry only a keyed hash in the database); bodies are plain text.
import { ApiError } from './http.js';
import { FieldError } from './validation.js';

const ATTENTION = ['RECONCILE', 'FAILED'];
const RESOLUTIONS = ['SENT', 'RESEND'];

const number = (params, name, fallback, max) => {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) throw new FieldError(name, 'Enter a valid list range.');
  return value;
};

const replyView = (row) => ({ id: row.id, orderId: row.order_id, orderNo: row.order_no ?? null, kind: row.kind, body: row.body,
  receivedAt: row.received_at, read: row.read_at !== null });
const messageView = (row) => ({ id: row.id, orderId: row.order_id, orderNo: row.order_no, kind: row.kind, status: row.status,
  lastError: row.last_error, attempts: row.attempts, createdAt: row.created_at, updatedAt: row.updated_at });

export async function messageSummary(store) {
  const unread = await store.get('SELECT COUNT(*) AS n FROM message_inbound WHERE read_at IS NULL');
  const counts = await store.all("SELECT status, COUNT(*) AS n FROM message_outbox WHERE status IN ('RECONCILE', 'FAILED') GROUP BY status");
  const count = (status) => counts.find((row) => row.status === status)?.n ?? 0;
  return { unreadReplies: unread.n, reconcile: count('RECONCILE'), failed: count('FAILED') };
}

export async function listReplies(store, params) {
  const limit = number(params, 'limit', 50, 100), offset = number(params, 'offset', 0, 10_000);
  if (limit < 1) throw new FieldError('limit', 'Enter a valid list range.');
  const unreadOnly = params.get('unread') === '1';
  const rows = await store.all(`SELECT i.id, i.order_id, o.order_no, i.kind, i.body, i.received_at, i.read_at
    FROM message_inbound i LEFT JOIN shop_order o ON o.id = i.order_id ${unreadOnly ? 'WHERE i.read_at IS NULL' : ''}
    ORDER BY i.received_at DESC, i.id DESC LIMIT ? OFFSET ?`, limit + 1, offset);
  return { items: rows.slice(0, limit).map(replyView), nextOffset: rows.length > limit ? offset + limit : null };
}

export async function markReplyRead(store, id) {
  if (!await store.get('SELECT id FROM message_inbound WHERE id = ?', id)) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  await store.run('UPDATE message_inbound SET read_at = ? WHERE id = ? AND read_at IS NULL', new Date().toISOString(), id);
  return replyView(await store.get(`SELECT i.id, i.order_id, o.order_no, i.kind, i.body, i.received_at, i.read_at
    FROM message_inbound i LEFT JOIN shop_order o ON o.id = i.order_id WHERE i.id = ?`, id));
}

export async function listAttentionMessages(store, params) {
  const limit = number(params, 'limit', 50, 100), offset = number(params, 'offset', 0, 10_000);
  if (limit < 1) throw new FieldError('limit', 'Enter a valid list range.');
  const rows = await store.all(`SELECT m.id, m.order_id, o.order_no, m.kind, m.status, m.last_error, m.attempts, m.created_at, m.updated_at
    FROM message_outbox m JOIN shop_order o ON o.id = m.order_id WHERE m.status IN ('RECONCILE', 'FAILED')
    ORDER BY m.updated_at DESC, m.id DESC LIMIT ? OFFSET ?`, limit + 1, offset);
  return { items: rows.slice(0, limit).map(messageView), nextOffset: rows.length > limit ? offset + limit : null };
}

/* What the seller knows from WhatsApp Manager decides: SENT marks an unknown outcome as delivered to Meta (RECONCILE
 * only); RESEND queues it again and accepts the risk of a duplicate (RECONCILE or FAILED). Never both for one row. */
export async function resolveMessage(store, id, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'resolution') || !RESOLUTIONS.includes(input.resolution)) {
    throw new FieldError('resolution', 'Choose SENT or RESEND.');
  }
  const now = new Date().toISOString();
  const changed = await store.transaction(async () => input.resolution === 'SENT'
    ? store.get(`UPDATE message_outbox SET status = 'ACCEPTED', last_error = 'Confirmed as sent by the seller', next_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'RECONCILE' RETURNING id`, now, id)
    : store.get(`UPDATE message_outbox SET status = 'QUEUED', attempts = 0, last_error = 'Queued again by the seller', next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('RECONCILE', 'FAILED') RETURNING id`, now, now, id));
  if (!changed) {
    if (!await store.get('SELECT id FROM message_outbox WHERE id = ?', id)) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    throw new ApiError(409, 'NOT_RESOLVABLE', 'This message cannot be resolved that way.');
  }
  return messageView(await store.get(`SELECT m.id, m.order_id, o.order_no, m.kind, m.status, m.last_error, m.attempts, m.created_at, m.updated_at
    FROM message_outbox m JOIN shop_order o ON o.id = m.order_id WHERE m.id = ?`, id));
}

/* Everything WhatsApp for one order, for its detail page. */
export async function orderMessages(store, orderId) {
  const replies = await store.all(`SELECT i.id, i.order_id, o.order_no, i.kind, i.body, i.received_at, i.read_at
    FROM message_inbound i LEFT JOIN shop_order o ON o.id = i.order_id WHERE i.order_id = ? ORDER BY i.received_at DESC, i.id DESC LIMIT 100`, orderId);
  const sent = await store.all(`SELECT m.id, m.order_id, o.order_no, m.kind, m.status, m.last_error, m.attempts, m.created_at, m.updated_at
    FROM message_outbox m JOIN shop_order o ON o.id = m.order_id WHERE m.order_id = ? ORDER BY m.created_at, m.kind LIMIT 20`, orderId);
  return { replies: replies.map(replyView), messages: sent.map(messageView) };
}
