import { inventoryOrderIndexDefinitionReady } from './inventory-schema.js';
import { createHash } from 'node:crypto';
import { ApiError } from './http.js';
import { FieldError } from './validation.js';
import { RESERVATION_HOURS, stockAvailability } from './stock-reservation.js';
import { planStockQuantity, applyInventoryAdjustment, INVENTORY_ADJUSTMENT_REASONS } from './inventory.js';
import { trackStockUpdate } from './product-history.js';

export const INVENTORY_READ_LIMITS = Object.freeze({ sourceLines: 10000, sourceBytes: 4 * 1024 * 1024, page: 100, responseBytes: 65536 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const limit = () => { throw new ApiError(503, 'INVENTORY_LIMIT', 'Inventory exceeds its complete bounded read limit. Reduce movement page size or reconcile source coverage.'); };
const unavailable = () => { throw new ApiError(503, 'INVENTORY_UNAVAILABLE', 'Inventory data is unavailable.'); };
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const stock = value => value === null || integer(value,0,1000000);
const text = (value,max) => typeof value==='string'&&value.length<=max;
const instant = value => typeof value==='string'&&value.length===24&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const complete = value => { if(Buffer.byteLength(JSON.stringify(value))>INVENTORY_READ_LIMITS.responseBytes)limit();return value; };
function productId(value) { if(typeof value!=='string'||!uuid.test(value))throw new FieldError('productId','Choose a valid product.'); }
async function baseline(read,id) {
  productId(id);
  const row=await read.get(`SELECT p.id,p.sku,p.name,p.category,p.active,p.stock_quantity,s.revision,
    c.origin,c.started_at,c.baseline_quantity FROM product p LEFT JOIN inventory_state s ON s.product_id=p.id
    LEFT JOIN inventory_coverage c ON c.product_id=p.id WHERE p.id=?`,id);
  if(!row)throw new ApiError(404,'NOT_FOUND','Product not found.');
  if(!stock(row.stock_quantity)||!integer(row.revision)||!['MIGRATED','CREATED'].includes(row.origin)||!instant(row.started_at)||!stock(row.baseline_quantity)||
    !text(row.sku,40)||!text(row.name,120)||!text(row.category,80)||![0,1].includes(row.active))unavailable();
  return { product:{id:row.id,sku:row.sku,name:row.name,categoryCode:row.category,active:row.active===1},stockRevision:row.revision,onHand:row.stock_quantity,
    coverage:{origin:row.origin,startedAt:row.started_at,baselineQuantity:row.baseline_quantity,writerCoverage:'APPLICATION_WRITERS',preCoverageHistoryAvailable:false} };
}
// Internal trusted clock only. One fresh instant per service phase; callers must
// hold the tenant fence/transaction. No public request chooses this asOf value.
export async function inventorySnapshot(read,id,asOf=Date.now()) {
  if(!integer(asOf))throw new TypeError('Invalid server inventory clock.');
  const current=await baseline(read,id),cap=INVENTORY_READ_LIMITS.sourceLines;
  if (!await inventoryOrderIndexDefinitionReady(read)) unavailable();
  const count=await read.get(`SELECT COUNT(*) AS n FROM (SELECT id FROM order_item WHERE product_id=? LIMIT ${cap+1}) inventory_lines`,id);
  if(!integer(Number(count.n))||Number(count.n)>cap)limit();
  const byteLength = field => read.dialect === 'postgres' ? `octet_length(CAST(${field} AS TEXT))` : `length(CAST(${field} AS BLOB))`;
  const sourceBytes = await read.get(`SELECT COALESCE(SUM(${['i.id','i.delivery_id','i.quantity','d.order_id','o.status','o.revision','o.submitted_at'].map(byteLength).join('+')}+128),0)+2 AS n
    FROM order_item i JOIN delivery d ON d.id=i.delivery_id JOIN shop_order o ON o.id=d.order_id WHERE i.product_id=?`,id);
  if (!integer(Number(sourceBytes.n)) || Number(sourceBytes.n)>INVENTORY_READ_LIMITS.sourceBytes) limit();
  const rows=await read.all(`SELECT i.id,i.delivery_id,i.quantity,d.order_id,o.status,o.revision,o.submitted_at
    FROM order_item i JOIN delivery d ON d.id=i.delivery_id JOIN shop_order o ON o.id=d.order_id
    WHERE i.product_id=? ORDER BY i.id LIMIT ${cap+1}`,id);
  if(rows.length!==Number(count.n)||rows.length>cap)unavailable();
  if(Buffer.byteLength(JSON.stringify(rows))>INVENTORY_READ_LIMITS.sourceBytes)limit();
  const cutoff=new Date(asOf-RESERVATION_HOURS*3600000).toISOString(),facts=[],holds=new Set(),confirmed=new Set();let held=0;
  for(const row of rows){
    if(!uuid.test(row.id||'')||!uuid.test(row.delivery_id||'')||!uuid.test(row.order_id||'')||!integer(row.quantity,1,100)||!integer(row.revision,1)||
      !instant(row.submitted_at)||!['SUBMITTED','CONFIRMED','REJECTED','CANCELLED','SHIPPED','DELIVERED'].includes(row.status))unavailable();
    const holding=row.status==='SUBMITTED'&&row.submitted_at>cutoff;
    if(holding||row.status==='CONFIRMED')facts.push([row.id,row.delivery_id,row.order_id,row.quantity,row.status,row.revision,row.submitted_at]);
    if(holding){held+=row.quantity;holds.add(row.order_id);}if(row.status==='CONFIRMED')confirmed.add(row.order_id);
  }
  if(!integer(held))unavailable();
  const revision=createHash('sha256').update(JSON.stringify(['inventory-v1',current.product,current.stockRevision,current.onHand,current.coverage,facts])).digest('hex');
  const availability=stockAvailability(current.onHand,held);
  return complete({...current,revision,held,available:availability.availableQuantity,shortfall:availability.reservationShortfall,
    activeHoldOrders:holds.size,confirmedOrders:confirmed.size,reservationHours:RESERVATION_HOURS,asOf:new Date(asOf).toISOString()});
}
export const inventorySummary = (read,args) => inventorySnapshot(read,args.productId);

export async function inventoryMovements(read,args) {
  const current=await baseline(read,args.productId),pageSize=args.limit??50,before=args.beforeRevision??null;
  if(!integer(pageSize,1,INVENTORY_READ_LIMITS.page)||(before!==null&&!integer(before,1)))throw new FieldError('limit','Choose a valid movement page.');
  const rows=await read.all(`SELECT id,product_id,revision,kind,source,reason_code,before_quantity,after_quantity,delta_quantity,occurred_at
    FROM inventory_movement WHERE product_id=? AND revision<=?${before===null?'':' AND revision<?'} ORDER BY revision DESC LIMIT ?`,
  args.productId,current.stockRevision,...(before===null?[]:[before]),pageSize+1);
  const items=rows.slice(0,pageSize).map(row=>{
    if(!uuid.test(row.id||'')||row.product_id!==args.productId||!integer(row.revision,1)||!stock(row.before_quantity)||!stock(row.after_quantity)||
      !(row.delta_quantity===null||integer(row.delta_quantity,-1000000,1000000))||!instant(row.occurred_at))unavailable();
    return {id:row.id,productId:row.product_id,stockRevision:row.revision,kind:row.kind,source:row.source,reasonCode:row.reason_code,
      beforeQuantity:row.before_quantity,afterQuantity:row.after_quantity,deltaQuantity:row.delta_quantity,occurredAt:row.occurred_at};
  });
  return complete({productId:args.productId,stockRevision:current.stockRevision,coverage:current.coverage,items,
    nextBeforeRevision:rows.length>pageSize?items.at(-1).stockRevision:null});
}

export function planInventoryAdjustment(before,input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['productId','expectedRevision','stockQuantity','reasonCode','note'].includes(key))||
    input.productId!==before.product.id||!INVENTORY_ADJUSTMENT_REASONS.includes(input.reasonCode)||!Object.hasOwn(input,'stockQuantity')||
    (input.note!==undefined&&(!text(input.note,500))))throw new FieldError('input','Invalid inventory adjustment.');
  if(input.expectedRevision!==before.revision)throw new ApiError(409,'STALE_REVISION','Inventory changed. Read a fresh summary.');
  const planned=planStockQuantity(before.onHand,input.stockQuantity,{hasConfirmed:before.confirmedOrders>0});
  if(!planned.changed)throw new ApiError(409,'NO_STOCK_CHANGE','Choose a different stock quantity.');
  if(before.stockRevision>=Number.MAX_SAFE_INTEGER)throw new ApiError(409,'STOCK_REVISION_LIMIT','The stock revision limit was reached.');
  const availability=stockAvailability(input.stockQuantity,before.held);
  return {before,after:{onHand:input.stockQuantity,stockRevision:before.stockRevision+1,held:before.held,available:availability.availableQuantity,shortfall:availability.reservationShortfall,
    tracking:input.stockQuantity===null?'UNLIMITED':'FINITE'},normalized:{productId:input.productId,stockQuantity:input.stockQuantity,reasonCode:input.reasonCode},
    note:input.note?.trim()||null};
}
export async function prepareInventoryAdjustment(read,input) {
  return planInventoryAdjustment(await inventorySnapshot(read,input.productId),input);
}
export async function commitInventoryAdjustment(store,proposal,trustedContext) {
  return store.transaction(async()=>{
    // Fresh commit-phase time, never the preview's stored eligibility clock.
    const asOf=Date.now(),before=await inventorySnapshot(store,proposal.normalized.productId,asOf);
    planInventoryAdjustment(before,{...proposal.normalized,expectedRevision:proposal.before.revision});
    const account=await store.get('SELECT username FROM seller_account WHERE id=?',trustedContext.accountId);
    if(!account)throw new ApiError(403,'FORBIDDEN','Operation authorization failed.');
    const movement = await trackStockUpdate(store,proposal.normalized.productId,account.username,()=>applyInventoryAdjustment(store,proposal.normalized,trustedContext));
    if(!movement)throw new ApiError(409,'NO_STOCK_CHANGE','Choose a different stock quantity.');
    const after=await inventorySnapshot(store,proposal.normalized.productId,asOf);
    if(after.onHand!==proposal.normalized.stockQuantity||after.stockRevision!==before.stockRevision+1)throw new TypeError('Inventory normalization changed during commit.');
    return {productId:after.product.id,movementId:movement.movementId,stockRevision:movement.stockRevision,revision:after.revision};
  });
}
