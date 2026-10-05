// Documents consume authenticated immutable order snapshots, never current catalog prices.
export function orderDocumentModel(order, kind = 'summary') {
  if (!order || !['summary', 'packing'].includes(kind) || !['SUBMITTED', 'CONFIRMED', 'REJECTED', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(order.status) ||
      !['MYR', 'SGD'].includes(order.currency) || !Number.isSafeInteger(order.totalMinor) || order.totalMinor < 0 ||
      !Number.isSafeInteger(order.revision) || order.revision < 1 || !Array.isArray(order.deliveries) || !order.deliveries.length) {
    throw new TypeError('Invalid order snapshot');
  }
  if (kind === 'packing' && order.status !== 'CONFIRMED') throw new TypeError('Only confirmed orders can be packed');
  let total = 0;
  const deliveries = order.deliveries.map(delivery => {
    if (!delivery.recipient || !delivery.address || !Array.isArray(delivery.items) || !delivery.items.length) throw new TypeError('Invalid destination');
    let quantity = 0;
    const items = delivery.items.map(item => {
      if (item.currency !== order.currency || !Number.isSafeInteger(item.quantity) || item.quantity < 1 ||
          !Number.isSafeInteger(item.priceMinor) || item.priceMinor < 0 ||
          !Number.isSafeInteger(item.lineTotalMinor) || item.lineTotalMinor !== item.priceMinor * item.quantity) throw new TypeError('Invalid line snapshot');
      total += item.lineTotalMinor; quantity += item.quantity;
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(quantity)) throw new TypeError('Invalid totals');
      return { sku: String(item.sku || ''), name: String(item.name || ''), quantity: item.quantity,
        priceMinor: item.priceMinor, lineTotalMinor: item.lineTotalMinor };
    });
    return { recipient: { fullName: delivery.recipient.fullName, phone: delivery.recipient.phone }, address: Object.fromEntries(['line1','line2','city','region','postcode','country'].map(key => [key, delivery.address[key] || ''])), items, quantity };
  });
  if (total !== order.totalMinor) throw new TypeError('Order total does not match snapshots');
  return { kind, orderNo: String(order.orderNo), status: order.status, revision: order.revision,
    simulation: order.simulation === true, currency: order.currency, totalMinor: total,
    submittedAt: order.submittedAt, updatedAt: order.updatedAt, buyer: { ...order.buyer }, deliveries,
    rejectionReason: order.status === 'REJECTED' ? order.events?.findLast(event => event.status === 'REJECTED')?.reason || '' : '' };
}
