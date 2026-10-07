// Seller wording for an order status: a new order is Pending, a confirmed order that is called off is Void.
export function statusKey(status) {
  return { SUBMITTED: 'sellerStatusSubmitted', CONFIRMED: 'statusConfirmed', REJECTED: 'statusRejected', SHIPPED: 'statusShipped', DELIVERED: 'statusDelivered', CANCELLED: 'sellerStatusCancelled' }[status] || 'orderStatus';
}
