import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ApiError } from './http.js';

const context = new AsyncLocalStorage();
const fallback = Object.freeze({ source: 'PRODUCT', actorKind: 'INTERNAL', actorId: 'business-service', clientId: null, grantId: null, operationId: null, correlationId: null });
const sources = ['PRODUCT', 'CSV', 'DEMO', 'OPERATOR', 'MCP_CATALOG'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bounded = value => typeof value === 'string' && value.length >= 1 && value.length <= 128;

// Trusted server call sites only; never a request body/proposal. All values are
// copied scalars in an immutable, module-private async scope.
export function withInventoryContext(trusted, work) {
  if (!trusted || typeof trusted !== 'object' || Array.isArray(trusted) || Object.keys(trusted).some(key => !Object.hasOwn(fallback, key))) throw new TypeError('Invalid trusted inventory context.');
  const next = { ...(context.getStore() || fallback), ...trusted };
  if (!sources.includes(next.source) || !['SELLER', 'SYSTEM', 'OPERATOR', 'INTERNAL'].includes(next.actorKind) || !bounded(next.actorId) || (next.actorKind === 'SELLER' && !uuid.test(next.actorId)) ||
      (next.actorKind === 'INTERNAL' && next.actorId !== 'business-service') || (next.actorKind === 'SYSTEM' && next.actorId !== 'demo-seed') ||
      (next.actorKind === 'OPERATOR' && !['seed-demo-shop', 'replace-catalog'].includes(next.actorId)) ||
      ['clientId', 'grantId'].some(key => next[key] !== null && !bounded(next[key])) ||
      ['operationId', 'correlationId'].some(key => next[key] !== null && (typeof next[key] !== 'string' || !uuid.test(next[key])))) throw new TypeError('Invalid trusted inventory context.');
  return context.run(Object.freeze(next), work);
}

// Authenticated legacy services supply the exact current username. Unknown
// direct callers keep the fixed INTERNAL label; never persist their raw text.
export async function withInventorySeller(store, username, work) {
  if (context.getStore()?.actorKind !== undefined && context.getStore().actorKind !== 'INTERNAL') return work();
  const seller = typeof username === 'string' ? await store.get('SELECT id FROM seller_account WHERE username = ?', username) : null;
  return seller ? withInventoryContext({ actorKind: 'SELLER', actorId: seller.id }, work) : work();
}

export async function assertStockTrackingChange(store, productId, before, after) {
  if ((before === null) !== (after === null) && await store.get(`SELECT 1 AS found FROM order_item i JOIN delivery d ON d.id=i.delivery_id
    JOIN shop_order o ON o.id=d.order_id WHERE i.product_id=? AND o.status='CONFIRMED' LIMIT 1`, productId)) {
    const error = new ApiError(409, 'STOCK_TRACKING_CONFLICT', 'Ship or cancel confirmed orders before changing stock tracking.');
    error.field = 'stockQuantity'; throw error;
  }
}
const reasonFor = (ctx, initial) => initial ? ({ CSV: 'CSV_CREATE', DEMO: 'DEMO_CREATE', OPERATOR: 'OPERATOR_CREATE' }[ctx.source] || 'PRODUCT_CREATE')
  : ({ CSV: 'CSV_SET', OPERATOR: 'OPERATOR_SET' }[ctx.source] || 'PRODUCT_SET');
const quantity = value => value === null || Number.isInteger(value) && value >= 0 && value <= 1000000;

async function write(store, productId, requested, { initialize = false, order = null, updatedAt = null } = {}) {
  return store.transaction(async () => {
    const current = await store.get('SELECT stock_quantity,updated_at,sku FROM product WHERE id=?', productId);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
    const before = current.stock_quantity;
    if (order && before === null) return null;
    const after = order ? before + requested : requested;
    if (!quantity(after)) {
      if (order && after < 0) { const error = new ApiError(409, 'INSUFFICIENT_STOCK', `Not enough stock for ${current.sku}.`); error.field = 'stock'; throw error; }
      if (order && after > 1000000) { const error = new ApiError(409, 'STOCK_LIMIT_CONFLICT', 'Returning this order would exceed the stock limit.'); error.field = 'stock'; throw error; }
      throw new TypeError('Invalid internal stock quantity.');
    }
    if (!initialize) await assertStockTrackingChange(store, productId, before, after);
    const at = updatedAt || new Date(Math.max(Date.now(), Date.parse(current.updated_at) + 1)).toISOString();
    let revision;
    if (initialize) {
      await store.run("INSERT INTO inventory_coverage(product_id,origin,started_at,baseline_quantity) VALUES(?,'CREATED',?,?)", productId, at, after);
      await store.run('INSERT INTO inventory_state(product_id,revision) VALUES(?,0)', productId); revision = 0;
    } else {
      const state = await store.get('SELECT revision FROM inventory_state WHERE product_id=?', productId);
      if (!state) throw new ApiError(503, 'INVENTORY_UNAVAILABLE', 'Inventory coverage is unavailable.');
      if (before === after) return null;
      revision = state.revision;
    }
    if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) throw new ApiError(409, 'STOCK_REVISION_LIMIT', 'The stock revision limit was reached.');
    const nextRevision = revision + 1, id = randomUUID(), ctx = context.getStore() || fallback;
    const kind = initialize ? 'INITIALIZED' : order ? (requested < 0 ? 'ORDER_CONFIRMED' : 'ORDER_CANCELLED')
      : before === null ? 'TRACKING_ENABLED' : after === null ? 'TRACKING_DISABLED' : 'SET';
    const reason = order ? (requested < 0 ? 'ORDER_CONFIRM' : 'ORDER_CANCEL') : reasonFor(ctx, initialize);
    const sourceKey = initialize ? `product:${productId}:init` : order ? `order:${order.id}:${order.revision}:${productId}` : `stock:${id}`;
    await store.run('UPDATE product SET stock_quantity=?,updated_at=? WHERE id=?', after, at, productId);
    await store.run('UPDATE inventory_state SET revision=? WHERE product_id=?', nextRevision, productId);
    await store.run(`INSERT INTO inventory_movement(id,product_id,revision,source_key,kind,source,reason_code,before_quantity,after_quantity,delta_quantity,
      actor_kind,actor_id,client_id,grant_id,operation_id,correlation_id,order_id,order_revision,occurred_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, productId, nextRevision, sourceKey, kind, order ? 'ORDER' : ctx.source, reason, initialize ? null : before, after,
    initialize || before === null || after === null ? null : after - before, ctx.actorKind, ctx.actorId, ctx.clientId, ctx.grantId,
    ctx.operationId, ctx.correlationId, order?.id || null, order?.revision || null, at);
    return { movementId: id, stockRevision: nextRevision };
  });
}
export const initializeProductStock = (store, productId, stock, createdAt) => write(store, productId, stock, { initialize: true, updatedAt: createdAt });
export const setProductStock = (store, productId, stock, updatedAt = null) => write(store, productId, stock, { updatedAt });
export function moveOrderStock(store, productId, delta, orderId, orderRevision) {
  if (!Number.isSafeInteger(delta) || delta === 0 || typeof orderId !== 'string' || !Number.isSafeInteger(orderRevision) || orderRevision < 1) throw new TypeError('Invalid internal order movement.');
  return write(store, productId, delta, { order: { id: orderId, revision: orderRevision } });
}
