// Seller-initiated erasure of one order's buyer contact and delivery data (DEC-07 / SEL-05). The order number, items,
// amounts, status and event history stay; only personal fields change. The moment and the account are kept on the order.
import { ApiError } from './http.js';
import { FieldError } from './validation.js';

// Orders still in progress need their contact data to be fulfilled, so only finished orders can be erased.
export const ERASABLE_STATUSES = ['REJECTED', 'DELIVERED', 'CANCELLED'];
const ERASED = 'Erased';

export async function eraseOrderContact(database, id, input, actorId) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['expectedRevision', 'confirmOrderNo'].includes(key))) {
    throw new FieldError('erase', 'Unexpected erase field.');
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new FieldError('expectedRevision', 'Supply the current order revision.');
  if (typeof input.confirmOrderNo !== 'string') throw new FieldError('confirmOrderNo', 'Type the order number to confirm.');
  const now = new Date().toISOString();
  await database.transaction(async () => {
    const order = await database.get('SELECT order_no, status, revision, contact_erased_at FROM shop_order WHERE id = ?', id);
    if (!order) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    if (input.confirmOrderNo.trim().toLowerCase() !== order.order_no.toLowerCase()) throw new FieldError('confirmOrderNo', 'The order number does not match.');
    if (order.contact_erased_at) throw new ApiError(409, 'ALREADY_ERASED', 'This order\'s contact data was already erased.');
    if (!ERASABLE_STATUSES.includes(order.status)) throw new ApiError(409, 'ORDER_NOT_FINISHED', 'Contact data can be erased once the order is rejected, delivered or cancelled.');
    const changed = await database.get(`UPDATE shop_order SET buyer_name = ?, buyer_phone = '', buyer_email = NULL, whatsapp_opt_in = 0,
        whatsapp_consent_at = NULL, whatsapp_consent_version = NULL, revision = revision + 1, updated_at = ?, contact_erased_at = ?, contact_erased_by = ?
      WHERE id = ? AND status = ? AND revision = ? AND contact_erased_at IS NULL RETURNING id`,
    ERASED, now, now, actorId, id, order.status, input.expectedRevision);
    if (!changed) throw new ApiError(409, 'STALE_REVISION', 'The order changed. Reload and try again.');
    await database.run(`UPDATE delivery SET recipient_name = ?, recipient_phone = '', address_line1 = ?, address_line2 = NULL,
      address_city = NULL, address_region = NULL, address_postcode = '' WHERE order_id = ?`, ERASED, ERASED, id);
    // Buyer replies are personal text; the keyed sender hash cannot be reversed to a number and stays for threading.
    await database.run('UPDATE message_inbound SET body = NULL WHERE order_id = ?', id);
    await database.run(`UPDATE message_outbox SET status = 'FAILED', next_attempt_at = NULL, last_error = 'Not sent: contact data erased', updated_at = ?
      WHERE order_id = ? AND status IN ('QUEUED', 'SENDING')`, now, id);
  });
}
