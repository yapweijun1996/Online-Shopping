import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ApiError } from './http.js';
import { FieldError } from './validation.js';

const context = new AsyncLocalStorage();
const fallback = Object.freeze({ source: 'PRODUCT', actorKind: 'INTERNAL', actorId: 'business-service', clientId: null, grantId: null, operationId: null, correlationId: null });
const sources = ['PRODUCT', 'CSV', 'DEMO', 'OPERATOR', 'MCP_CATALOG'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bounded = value => typeof value === 'string' && value.length >= 1 && value.length <= 128;

// Trusted server call sites only; never a request body/proposal. All values are
// copied scalars in an immutable, module-private async scope.
function runContext(trusted, work, adjustment = false) {
  if (!trusted || typeof trusted !== 'object' || Array.isArray(trusted) || Object.keys(trusted).some(key => !Object.hasOwn(fallback, key))) throw new TypeError('Invalid trusted inventory context.');
  const next = { ...(context.getStore() || fallback), ...trusted };
  if ((!sources.includes(next.source) && !(adjustment && next.source === 'MCP_ADJUST')) || !['SELLER', 'SYSTEM', 'OPERATOR', 'INTERNAL'].includes(next.actorKind) || !bounded(next.actorId) || (next.actorKind === 'SELLER' && !uuid.test(next.actorId)) ||
      (next.actorKind === 'INTERNAL' && next.actorId !== 'business-service') || (next.actorKind === 'SYSTEM' && next.actorId !== 'demo-seed') ||
      (next.actorKind === 'OPERATOR' && !['seed-demo-shop', 'replace-catalog'].includes(next.actorId)) ||
      ['clientId', 'grantId'].some(key => next[key] !== null && !bounded(next[key])) ||
      ['operationId', 'correlationId'].some(key => next[key] !== null && (typeof next[key] !== 'string' || !uuid.test(next[key])))) throw new TypeError('Invalid trusted inventory context.');
  return context.run(Object.freeze(next), work);
}

export const withInventoryContext = (trusted, work) => runContext(trusted, work);

// Authenticated legacy services supply the exact current username. Unknown
// direct callers keep the fixed INTERNAL label; never persist their raw text.
export async function withInventorySeller(store, username, work) {
  if (context.getStore()?.actorKind !== undefined && context.getStore().actorKind !== 'INTERNAL') return work();
  const seller = typeof username === 'string' ? await store.get('SELECT id FROM seller_account WHERE username = ?', username) : null;
  return seller ? withInventoryContext({ actorKind: 'SELLER', actorId: seller.id }, work) : work();
}

export function planStockQuantity(before, after, { hasConfirmed = false } = {}) {
  if (!quantity(before)) throw new ApiError(503, 'INVENTORY_UNAVAILABLE', 'Inventory data is unavailable.');
  if (!quantity(after)) throw new FieldError('stockQuantity', 'Enter an integer from 0 to 1000000, or null for unlimited.');
  if ((before === null) !== (after === null) && hasConfirmed) {
    const error = new ApiError(409, 'STOCK_TRACKING_CONFLICT', 'Ship or cancel confirmed orders before changing stock tracking.');
    error.field = 'stockQuantity'; throw error;
  }
  return { changed: before !== after, kind: before === null ? 'TRACKING_ENABLED' : after === null ? 'TRACKING_DISABLED' : 'SET',
    delta: before === null || after === null ? null : after - before };
}
export async function assertStockTrackingChange(store, productId, before, after) {
  const hasConfirmed = (before === null) !== (after === null) && Boolean(await store.get(`SELECT 1 AS found FROM order_item i JOIN delivery d ON d.id=i.delivery_id
    JOIN shop_order o ON o.id=d.order_id WHERE i.product_id=? AND o.status='CONFIRMED' LIMIT 1`, productId));
  return planStockQuantity(before, after, { hasConfirmed });
}
const reasonFor = (ctx, initial) => initial ? ({ CSV: 'CSV_CREATE', DEMO: 'DEMO_CREATE', OPERATOR: 'OPERATOR_CREATE' }[ctx.source] || 'PRODUCT_CREATE')
  : ({ CSV: 'CSV_SET', OPERATOR: 'OPERATOR_SET' }[ctx.source] || 'PRODUCT_SET');
const quantity = value => value === null || Number.isInteger(value) && value >= 0 && value <= 1000000;

// The same physical order-stock plan is used for preview and the actual writer.
export function planOrderStock(before, delta, sku = '') {
  if (!quantity(before) || !Number.isSafeInteger(delta) || delta === 0) throw new TypeError('Invalid internal order movement.');
  if (before === null) return { after: null, changed: false, delta: null };
  const after = before + delta;
  if (after < 0) { const error = new ApiError(409, 'INSUFFICIENT_STOCK', `Not enough stock for ${sku}.`); error.field = 'stock'; throw error; }
  if (after > 1000000) { const error = new ApiError(409, 'STOCK_LIMIT_CONFLICT', 'Returning this order would exceed the stock limit.'); error.field = 'stock'; throw error; }
  return { after, ...planStockQuantity(before, after) };
}

async function write(store, productId, requested, { initialize = false, order = null, updatedAt = null, adjustmentReason = null } = {}) {
  return store.transaction(async () => {
    const current = await store.get('SELECT stock_quantity,updated_at,sku FROM product WHERE id=?', productId);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
    const before = current.stock_quantity;
    const orderPlan = order ? planOrderStock(before, requested, current.sku) : null;
    if (order && !orderPlan.changed) return null;
    const after = order ? orderPlan.after : requested;
    if (!quantity(after)) throw new TypeError('Invalid internal stock quantity.');
    const planned = initialize ? null : await assertStockTrackingChange(store, productId, before, after);
    const at = updatedAt || new Date(Math.max(Date.now(), Date.parse(current.updated_at) + 1)).toISOString();
    let revision;
    if (initialize) {
      await store.run("INSERT INTO inventory_coverage(product_id,origin,started_at,baseline_quantity) VALUES(?,'CREATED',?,?)", productId, at, after);
      await store.run('INSERT INTO inventory_state(product_id,revision) VALUES(?,0)', productId); revision = 0;
    } else {
      const state = await store.get('SELECT revision FROM inventory_state WHERE product_id=?', productId);
      if (!state) throw new ApiError(503, 'INVENTORY_UNAVAILABLE', 'Inventory coverage is unavailable.');
      if (!planned.changed) return null;
      revision = state.revision;
    }
    if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) throw new ApiError(409, 'STOCK_REVISION_LIMIT', 'The stock revision limit was reached.');
    const nextRevision = revision + 1, id = randomUUID(), ctx = context.getStore() || fallback;
    const kind = initialize ? 'INITIALIZED' : order ? (requested < 0 ? 'ORDER_CONFIRMED' : 'ORDER_CANCELLED')
      : planned.kind;
    const reason = order ? (requested < 0 ? 'ORDER_CONFIRM' : 'ORDER_CANCEL') : ctx.source === 'MCP_ADJUST' ? adjustmentReason : reasonFor(ctx, initialize);
    if (ctx.source === 'MCP_ADJUST' && !INVENTORY_ADJUSTMENT_REASONS.includes(reason)) throw new TypeError('Invalid trusted adjustment reason.');
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

export const INVENTORY_ADJUSTMENT_REASONS = Object.freeze(['COUNT_CORRECTION','RECEIPT','DAMAGE','OTHER']);
// Only the validated stored adjustment and current engine context reach this
// business primitive. No note is accepted, persisted or returned here.
export function applyInventoryAdjustment(store, normalized, trustedContext) {
  if (!normalized || Object.keys(normalized).sort().join(',') !== 'productId,reasonCode,stockQuantity' || !uuid.test(normalized.productId || '') ||
      !quantity(normalized.stockQuantity) || !INVENTORY_ADJUSTMENT_REASONS.includes(normalized.reasonCode) || !trustedContext || !uuid.test(trustedContext.grantId || '') ||
      !['accountId','clientId','grantId','operationId','correlationId'].every(key=>bounded(trustedContext[key]))) throw new TypeError('Invalid trusted inventory adjustment.');
  return runContext({ source: 'MCP_ADJUST', actorKind: 'SELLER', actorId: trustedContext.accountId, clientId: trustedContext.clientId,
    grantId: trustedContext.grantId, operationId: trustedContext.operationId, correlationId: trustedContext.correlationId },
  () => write(store, normalized.productId, normalized.stockQuantity, { adjustmentReason: normalized.reasonCode }), true);
}
