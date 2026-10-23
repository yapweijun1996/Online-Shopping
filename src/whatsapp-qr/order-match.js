export async function orderMatchesThread({ store, qr, session, thread, order, recipientPhones }) {
  if (!thread.phone_hash || thread.suppressed_at || !order || order.contact_erased_at) return false;
  recipientPhones ??= (await store.all('SELECT recipient_phone FROM delivery WHERE order_id = ? LIMIT 100', order.id)).map(row => row.recipient_phone);
  for (const phone of [order.buyer_phone, ...recipientPhones].filter(Boolean)) {
    if (await qr.phoneHash(phone, session) === thread.phone_hash) return true;
  }
  return false;
}
