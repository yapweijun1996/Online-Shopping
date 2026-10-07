// The documents of one order, derived from its append-only history. Nothing is stored: an order has at most
// one Sales Order Confirmation, so its number is the Sales Order number under the SOC prefix (OS-00000006 ->
// SOC-00000006). A separately numbered series would need its own sequence table.
const digits = (orderNo) => orderNo.replace(/^(?:OS|DEMO)-/, '');
export const confirmationNumber = (orderNo) => `SOC-${digits(orderNo)}`;

export function documentTrail(orderNo, events, { carrier = null, trackingNo = null } = {}) {
  const first = (status) => events.find((event) => event.status === status) || null;
  const who = (event) => ({ actorType: event.actorType, actorId: event.actorId ?? null });
  const submitted = first('SUBMITTED'), rejected = first('REJECTED'), confirmed = first('CONFIRMED');
  const shipped = first('SHIPPED'), delivered = first('DELIVERED'), voided = first('CANCELLED');
  const trail = [];
  if (submitted) {
    trail.push({ type: 'SALES_ORDER', number: orderNo, state: rejected ? 'REJECTED' : 'ISSUED', issuedAt: submitted.occurredAt, ...who(submitted),
      ...(rejected ? { endedAt: rejected.occurredAt, endedBy: who(rejected), reason: rejected.reason } : {}) });
  }
  if (confirmed) {
    trail.push({ type: 'SALES_ORDER_CONFIRMATION', number: confirmationNumber(orderNo), state: voided ? 'VOID' : 'ACTIVE', issuedAt: confirmed.occurredAt, ...who(confirmed),
      ...(voided ? { endedAt: voided.occurredAt, endedBy: who(voided), reason: voided.reason } : {}) });
  }
  if (shipped) trail.push({ type: 'SHIPMENT', number: trackingNo, carrier, state: 'ACTIVE', issuedAt: shipped.occurredAt, ...who(shipped) });
  if (delivered) trail.push({ type: 'DELIVERY', number: null, state: 'ACTIVE', issuedAt: delivered.occurredAt, ...who(delivered) });
  return trail;
}
