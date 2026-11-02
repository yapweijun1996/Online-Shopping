// Internal notes on an order, written by the seller's team and never shown to the buyer. Append-only: no edit, no delete.
import { randomUUID } from 'node:crypto';
import { ApiError } from './http.js';
import { FieldError } from './validation.js';

export const MAX_NOTES_PER_ORDER = 50;

export const listOrderNotes = async (database, orderId) => (await database.all(
  'SELECT id, author, body, created_at FROM order_note WHERE order_id = ? ORDER BY created_at, id', orderId))
  .map((row) => ({ id: row.id, author: row.author, body: row.body, createdAt: row.created_at }));

export async function addOrderNote(database, orderId, input, author) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'body')) throw new FieldError('note', 'Send only the note text.');
  // Unlike other text fields a note may have several lines, so line breaks are allowed and other control characters are not.
  const body = typeof input.body === 'string' ? input.body.replaceAll('\r\n', '\n').trim().normalize('NFC') : '';
  if (!body || body.length > 1000 || /[\p{Cc}]/u.test(body.replaceAll('\n', ''))) throw new FieldError('body', 'Enter a note of 1 to 1000 characters.');
  return database.transaction(async () => {
    if (!await database.get('SELECT 1 AS found FROM shop_order WHERE id = ?', orderId)) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    const { n } = await database.get('SELECT COUNT(*) AS n FROM order_note WHERE order_id = ?', orderId);
    if (Number(n) >= MAX_NOTES_PER_ORDER) throw new ApiError(409, 'TOO_MANY_NOTES', `An order can hold ${MAX_NOTES_PER_ORDER} notes.`);
    const note = { id: randomUUID(), author, body, createdAt: new Date().toISOString() };
    await database.run('INSERT INTO order_note(id, order_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)', note.id, orderId, author, body, note.createdAt);
    return note;
  });
}
