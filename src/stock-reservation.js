/*
 * A submitted order holds its quantities until the seller decides it, so the last unit cannot be sold twice.
 * Nothing is stored: the held quantity is summed from SUBMITTED orders younger than the window, so a forgotten
 * order stops holding stock by itself. Confirming deducts the stock for real (see seller-orders.js).
 */
export const RESERVATION_HOURS = 48;

export const reservationCutoffIso = (now = Date.now()) => new Date(now - RESERVATION_HOURS * 3600 * 1000).toISOString();

/* SQL expression: units of the product named by `productRef` held by pending orders (cutoff is a generated ISO literal). */
export const reservedQuantitySql = (productRef, now) => `(SELECT COALESCE(SUM(i.quantity), 0) FROM order_item i
  JOIN delivery d ON d.id = i.delivery_id JOIN shop_order o ON o.id = d.order_id
  WHERE i.product_id = ${productRef} AND o.status = 'SUBMITTED' AND o.submitted_at > '${reservationCutoffIso(now)}')`;

export async function reservedQuantity(database, productId) {
  const row = await database.get(`SELECT ${reservedQuantitySql('?')} AS held`, productId);
  return Number(row.held);
}


// Read presentation only: a shortfall is observable even though available units
// are clamped at zero. This helper does not reject or mutate stock/order state.
export function stockAvailability(stockQuantity, reservedQuantity) {
  if ((stockQuantity !== null && (!Number.isSafeInteger(stockQuantity) || stockQuantity < 0)) ||
      !Number.isSafeInteger(reservedQuantity) || reservedQuantity < 0) throw new TypeError('Invalid stock quantities.');
  return { reservedQuantity, availableQuantity: stockQuantity === null ? null : Math.max(0, stockQuantity - reservedQuantity),
    reservationShortfall: stockQuantity === null ? 0 : Math.max(0, reservedQuantity - stockQuantity) };
}

// Compute the trusted phase cutoff once before projecting bounded row sets.
export const isActiveReservation = (status, submittedAt, cutoff = reservationCutoffIso()) => status === 'SUBMITTED' && submittedAt > cutoff;
