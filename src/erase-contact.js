// Seller-initiated erasure of one order's buyer contact and delivery data (DEC-07 / SEL-05). The order number, items,
// amounts, status and event history stay; only personal fields change. The moment and the account are kept on the order.
import { ApiError } from './http.js';
import { FieldError } from './validation.js';
import { createHash } from 'node:crypto';

// One-way, domain-separated suppression marker, not a reusable threading hash.
export const erasedSenderMarker = (hash) => `erased:${createHash('sha256').update(`whatsapp-erasure:${hash}`).digest('hex')}`;

// Orders still in progress need their contact data to be fulfilled, so only finished orders can be erased.
export const ERASABLE_STATUSES = ['REJECTED', 'DELIVERED', 'CANCELLED'];
const ERASED = 'Erased';

export async function eraseOrderContact(database, id, input, actorId, qr = null) {
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
    if (!qr && (await database.get('SELECT peer_key_sealed FROM whatsapp_qr_session WHERE id = 1'))?.peer_key_sealed) {
      throw new ApiError(503, 'INTEGRATIONS_UNAVAILABLE', 'Contact erasure requires the integration keys.');
    }
    if (qr) {
      // Take the same session lock as ingress before reading or suppressing peers.
      await qr.sellerTransaction(async () => {
        const buyer = await database.get('SELECT buyer_phone FROM shop_order WHERE id = ?', id);
        const deliveries = await database.all('SELECT recipient_phone FROM delivery WHERE order_id = ?', id);
        for (const phone of [buyer.buyer_phone, ...deliveries.map(row => row.recipient_phone)].filter(Boolean)) {
          const hash = await qr.phoneHash(phone);
          if (!hash) continue;
          await database.run('UPDATE message_thread SET suppressed_at = ?, display_name = NULL, peer_sealed = NULL, updated_at = ? WHERE phone_hash = ?', now, now, hash);
          await database.run('UPDATE message_thread_message SET body = NULL WHERE thread_id IN (SELECT id FROM message_thread WHERE phone_hash = ?)', hash);
        }
      });
    }
    const changed = await database.get(`UPDATE shop_order SET buyer_name = ?, buyer_phone = '', buyer_email = NULL, whatsapp_opt_in = 0,
        whatsapp_consent_at = NULL, whatsapp_consent_version = NULL, revision = revision + 1, updated_at = ?, contact_erased_at = ?, contact_erased_by = ?
      WHERE id = ? AND status = ? AND revision = ? AND contact_erased_at IS NULL RETURNING id`,
    ERASED, now, now, actorId, id, order.status, input.expectedRevision);
    if (!changed) throw new ApiError(409, 'STALE_REVISION', 'The order changed. Reload and try again.');
    await database.run(`UPDATE delivery SET recipient_name = ?, recipient_phone = '', address_line1 = ?, address_line2 = NULL,
      address_city = NULL, address_region = NULL, address_postcode = '' WHERE order_id = ?`, ERASED, ERASED, id);
    const contacts = await database.all(`SELECT connection_id, recipient_hash AS hash FROM message_outbox WHERE order_id = ?
      UNION SELECT connection_id, from_hash AS hash FROM message_inbound WHERE order_id = ?`, id, id);
    for (const contact of contacts) {
      if (contact.hash.startsWith('erased:')) continue;
      const marker = erasedSenderMarker(contact.hash);
      // Include unmatched replies and other message copies for this same connection/sender.
      await database.run('UPDATE message_inbound SET body = NULL, from_hash = ? WHERE connection_id = ? AND from_hash = ?',
        marker, contact.connection_id, contact.hash);
      await database.run('UPDATE message_outbox SET recipient_hash = ? WHERE connection_id = ? AND recipient_hash = ?',
        marker, contact.connection_id, contact.hash);
    }
    await database.run('UPDATE message_inbound SET body = NULL WHERE order_id = ?', id);
    await database.run(`UPDATE message_outbox SET status = 'FAILED', next_attempt_at = NULL, last_error = 'Not sent: contact data erased', updated_at = ?
      WHERE order_id = ? AND status IN ('QUEUED', 'SENDING')`, now, id);
  });
}
