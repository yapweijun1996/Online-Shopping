// Which WhatsApp message an order change calls for, and the key that makes sending it once-only.
// Only these four moments send anything; the first release never messages on its own initiative otherwise.
const PLAN = {
  SUBMITTED: { kind: 'ORDER_SUBMITTED', template: 'order_submitted' },
  CONFIRMED: { kind: 'ORDER_CONFIRMED', template: 'order_confirmed' },
  REJECTED: { kind: 'ORDER_REJECTED', template: 'order_rejected' },
  SHIPPED: { kind: 'ORDER_SHIPPED', template: 'order_shipped' },
};

/* Returns what to queue for an order that has just reached `status`, or null when nothing should be sent. */
export function planMessage({ orderId, status, buyerOptedIn }) {
  const plan = PLAN[status];
  if (!plan || buyerOptedIn !== true || typeof orderId !== 'string' || !orderId) return null;
  // One message of each kind per order (also enforced by the message_outbox unique key).
  return { ...plan, idempotencyKey: `${orderId}:${plan.kind}` };
}
