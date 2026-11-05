import { inventoryOrderIndexDefinitionReady } from './inventory-schema.js';
import { createHash } from 'node:crypto';
import { ApiError } from './http.js';
import { FieldError } from './validation.js';
import { ORDER_TRANSITIONS,planSellerDecision,applySellerDecision } from './seller-orders.js';
import { planOrderStock,withInventoryContext } from './inventory.js';
import { inventorySnapshot,INVENTORY_READ_LIMITS } from './inventory-reads.js';
import { isActiveReservation,stockAvailability,reservationCutoffIso } from './stock-reservation.js';
export const ORDER_DECISION_LIMITS=Object.freeze({deliveries:10,lines:100,products:50,lineBytes:65536,stockLines:INVENTORY_READ_LIMITS.sourceLines,stockBytes:INVENTORY_READ_LIMITS.sourceBytes,proposalBytes:49152});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tooLarge=()=>{throw new ApiError(503,'ORDER_DECISION_LIMIT','The complete order review exceeds its bounded resource limit.');};
const unavailable=()=>{throw new ApiError(503,'ORDER_DECISION_UNAVAILABLE','Safe order decision data is unavailable.');};
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const text=(value,max)=>typeof value==='string'&&value.length<=max;
const instant=value=>text(value,24)&&value.length===24&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const safeInteger=(value,min=0)=>{if(typeof value!=='string'||!/^(0|[1-9]\d*)$/.test(value))unavailable();const n=Number(value);if(!integer(n,min))unavailable();return n;};
const byteLength=(read,field)=>read.dialect==='postgres'?`octet_length(CAST(${field} AS TEXT))`:`length(CAST(${field} AS BLOB))`;
async function affectedStockBudget(read,ids){
 if(!await inventoryOrderIndexDefinitionReady(read))unavailable();
 const placeholders=ids.map(()=>'?').join(','),cap=ORDER_DECISION_LIMITS.stockLines;
 const count=await read.get(`SELECT COUNT(*) AS n FROM (SELECT id FROM order_item WHERE product_id IN (${placeholders}) LIMIT ${cap+1}) affected_lines`,...ids);
 if(Number(count.n)>cap)tooLarge();
 const bytes=await read.get(`SELECT COALESCE(SUM(${['i.id','i.delivery_id','i.quantity','d.order_id','o.status','o.revision','o.submitted_at'].map(field=>byteLength(read,field)).join('+')}+128),0)+2 AS n
   FROM order_item i JOIN delivery d ON d.id=i.delivery_id JOIN shop_order o ON o.id=d.order_id WHERE i.product_id IN (${placeholders})`,...ids);
 if(!integer(Number(bytes.n))||Number(bytes.n)>ORDER_DECISION_LIMITS.stockBytes)tooLarge();
}
export async function orderDecisionSnapshot(read,id,asOf=Date.now()){
 if(typeof id!=='string'||!uuid.test(id))throw new FieldError('orderId','Choose a valid order.');
 if(!integer(asOf))throw new TypeError('Invalid internal order clock.');
 const headerBytes=await read.get(`SELECT ${['order_no','status','revision','currency','total_minor','submitted_at','updated_at'].map(field=>byteLength(read,field)).join('+')} AS n FROM shop_order WHERE id=?`,id);
 if(!headerBytes)throw new ApiError(404,'NOT_FOUND','Order not found.');if(Number(headerBytes.n)>1024)tooLarge();
 const row=await read.get(`SELECT id,order_no,status,CAST(revision AS TEXT) AS revision_text,currency,CAST(total_minor AS TEXT) AS total_text,submitted_at,updated_at FROM shop_order WHERE id=?`,id);
 if(!text(row.order_no,80)||!row.order_no.length||!['SUBMITTED','CONFIRMED','REJECTED','CANCELLED','SHIPPED','DELIVERED'].includes(row.status)||!['MYR','SGD'].includes(row.currency)||!instant(row.submitted_at)||!instant(row.updated_at))unavailable();
 const order={id:row.id,orderNo:row.order_no,status:row.status,revision:safeInteger(row.revision_text,1),currency:row.currency,totalMinor:safeInteger(row.total_text),submittedAt:row.submitted_at,updatedAt:row.updated_at};
 const deliveryCount=await read.get('SELECT COUNT(*) AS n FROM (SELECT id FROM delivery WHERE order_id=? LIMIT 11) order_destinations',id);
 if(Number(deliveryCount.n)>ORDER_DECISION_LIMITS.deliveries)tooLarge();if(Number(deliveryCount.n)<1)unavailable();
 const deliveries=await read.all('SELECT id,position FROM delivery WHERE order_id=? ORDER BY position,id LIMIT 11',id);
 if(deliveries.length!==Number(deliveryCount.n)||deliveries.some(d=>!uuid.test(d.id||'')||!integer(d.position)))unavailable();
 const deliveryById=new Map(deliveries.map(d=>[d.id,d.position])),parameters=deliveries.map(d=>d.id),placeholders=parameters.map(()=>'?').join(',');
 const count=await read.get(`SELECT COUNT(*) AS n FROM (SELECT id FROM order_item WHERE delivery_id IN (${placeholders}) LIMIT 101) order_lines`,...parameters);
 if(Number(count.n)>ORDER_DECISION_LIMITS.lines)tooLarge();if(Number(count.n)<1)unavailable();
 const bytes=await read.get(`SELECT COALESCE(SUM(${['id','delivery_id','position','product_id','sku_snapshot','name_snapshot','price_minor','quantity','line_total_minor','currency'].map(field=>byteLength(read,field)).join('+')}+160),0)+2 AS n FROM order_item WHERE delivery_id IN (${placeholders})`,...parameters);
 if(!integer(Number(bytes.n))||Number(bytes.n)>ORDER_DECISION_LIMITS.lineBytes)tooLarge();
 const lines=await read.all(`SELECT id,delivery_id,position,product_id,sku_snapshot,name_snapshot,CAST(price_minor AS TEXT) AS price_text,CAST(quantity AS TEXT) AS quantity_text,
   CAST(line_total_minor AS TEXT) AS total_text,currency FROM order_item WHERE delivery_id IN (${placeholders}) ORDER BY delivery_id,position,id LIMIT 101`,...parameters);
 if(lines.length!==Number(count.n))unavailable();lines.sort((a,b)=>deliveryById.get(a.delivery_id)-deliveryById.get(b.delivery_id)||a.position-b.position||a.id.localeCompare(b.id));
 let total=0;const items=lines.map(line=>{
   if(!uuid.test(line.id||'')||!uuid.test(line.product_id||'')||!deliveryById.has(line.delivery_id)||!integer(line.position)||!text(line.sku_snapshot,40)||!text(line.name_snapshot,120)||line.currency!==order.currency)unavailable();
   const priceMinor=safeInteger(line.price_text),quantity=safeInteger(line.quantity_text,1),lineTotalMinor=safeInteger(line.total_text);if(quantity>100||!Number.isSafeInteger(priceMinor*quantity)||priceMinor*quantity!==lineTotalMinor)unavailable();total+=lineTotalMinor;if(!integer(total))unavailable();
   return{deliveryPosition:deliveryById.get(line.delivery_id),itemPosition:line.position,productId:line.product_id,sku:line.sku_snapshot,name:line.name_snapshot,priceMinor,quantity,lineTotalMinor,currency:line.currency};
 });if(total!==order.totalMinor)unavailable();
 const ids=[...new Set(items.map(item=>item.productId))].sort();if(ids.length>ORDER_DECISION_LIMITS.products)tooLarge();await affectedStockBudget(read,ids);
 const stocks=[];for(const productId of ids){try{stocks.push(await inventorySnapshot(read,productId,asOf));}catch(error){if(error instanceof RangeError)unavailable();throw error;}}
 const revision=createHash('sha256').update(JSON.stringify(['order-decision-v1',order,deliveries,lines,stocks.map(stock=>[stock.product.id,stock.revision])])).digest('hex');
 return{order,items,stocks,revision,asOf:new Date(asOf).toISOString()};
}

export function storedDecisionInput(decision,expectedRevision){
 return{expectedRevision,...(['reject','cancel'].includes(decision.action)?{reason:decision.reason}:{}),...(decision.action==='ship'?{carrier:decision.carrier,trackingNo:decision.trackingNo}: {})};
}
export function normalizeOrderDecision(order,action,fields){
 const planned=planSellerDecision(order,action,{...fields,expectedRevision:order.revision});
 return{action,reason:planned.reason,carrier:planned.tracking?.carrier??null,trackingNo:planned.tracking?.trackingNo??null};
}
function effectFor(snapshot,stock,action,quantity,cutoff){
 const moves=action==='confirm'?-quantity:action==='cancel'?quantity:0,physical=moves?planOrderStock(stock.onHand,moves,stock.product.sku):{after:stock.onHand,changed:false};
 const releasing=isActiveReservation(snapshot.order.status,snapshot.order.submittedAt,cutoff)&&['confirm','reject'].includes(action);
 const heldAfter=stock.held-(releasing?quantity:0),confirmedAfter=stock.confirmedOrders+(action==='confirm'?1:['cancel','ship'].includes(action)?-1:0);
 if(heldAfter<0||confirmedAfter<0)unavailable();
 const stockRevisionAfter=stock.stockRevision+(physical.changed?1:0);if(!integer(stockRevisionAfter))throw new ApiError(409,'STOCK_REVISION_LIMIT','The stock revision limit was reached.');
 const after=stockAvailability(physical.after,heldAfter);
 return{productId:stock.product.id,currentSku:stock.product.sku,currentName:stock.product.name,quantity,stockRevisionBefore:stock.stockRevision,stockRevisionAfter,
   onHandBefore:stock.onHand,onHandAfter:physical.after,heldBefore:stock.held,heldAfter,availableBefore:stock.available,availableAfter:after.availableQuantity,
   shortfallBefore:stock.shortfall,shortfallAfter:after.reservationShortfall,confirmedBefore:stock.confirmedOrders,confirmedAfter,movement:physical.changed?(moves<0?'DEDUCT':'RESTORE'):'NONE'};
}
function checkDecisionInput(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['orderId','expectedRevision','decision'].includes(key))||typeof input.orderId!=='string'||!uuid.test(input.orderId)||
   !input.decision||typeof input.decision!=='object'||Array.isArray(input.decision)||Object.keys(input.decision).some(key=>!['action','reason','carrier','trackingNo'].includes(key))||!Object.hasOwn(ORDER_TRANSITIONS,input.decision.action))throw new FieldError('decision','Choose a valid order decision.');
 if(input.expectedRevision!==undefined&&!integer(input.expectedRevision,1))throw new FieldError('expectedRevision','Supply a valid order revision.');
}
export function planOrderDecision(snapshot,input){
 checkDecisionInput(input);if(input.orderId!==snapshot.order.id)throw new FieldError('orderId','Choose a valid order.');
 if(input.expectedRevision!==undefined&&input.expectedRevision!==snapshot.order.revision)throw new ApiError(409,'STALE_REVISION','The order changed. Prepare a fresh review.');
 const {action,...fields}=input.decision,decision=normalizeOrderDecision(snapshot.order,action,fields);
 const nextRevision=snapshot.order.revision+1;if(!integer(nextRevision))throw new ApiError(409,'ORDER_REVISION_LIMIT','The order revision limit was reached.');
 const cutoff=reservationCutoffIso(Date.parse(snapshot.asOf)),quantity=new Map();for(const item of snapshot.items)quantity.set(item.productId,(quantity.get(item.productId)||0)+item.quantity);
 const proposal={before:snapshot.order,after:{id:snapshot.order.id,orderNo:snapshot.order.orderNo,status:ORDER_TRANSITIONS[action].to,revision:nextRevision,currency:snapshot.order.currency,totalMinor:snapshot.order.totalMinor},
   resourceRevision:snapshot.revision,items:snapshot.items,stockEffects:snapshot.stocks.map(stock=>effectFor(snapshot,stock,action,quantity.get(stock.product.id),cutoff)),decision,asOf:snapshot.asOf};
 if(Buffer.byteLength(JSON.stringify(proposal))>ORDER_DECISION_LIMITS.proposalBytes)tooLarge();return proposal;
}
export async function prepareOrderDecision(read,input){
 checkDecisionInput(input);const asOf=Date.now();
 // Fail action-specific fields/from-state before loading the complete graph.
 // Missing client INT uses this observed server INT, never a guessed default.
 const header=await read.get('SELECT status,CAST(revision AS TEXT) AS revision_text FROM shop_order WHERE id=?',input.orderId);
 if(!header)throw new ApiError(404,'NOT_FOUND','Order not found.');
 const current={status:header.status,revision:safeInteger(header.revision_text,1)},{action,...fields}=input.decision;
 planSellerDecision(current,action,{...fields,expectedRevision:input.expectedRevision??current.revision});
 const snapshot=await orderDecisionSnapshot(read,input.orderId,asOf);return{proposal:planOrderDecision(snapshot,input),revision:snapshot.revision};
}
export async function commitOrderDecision(store,proposal,trustedContext){
 return store.transaction(async()=>{
  const asOf=Date.now(),before=await orderDecisionSnapshot(store,proposal.before.id,asOf);
  if(before.revision!==proposal.resourceRevision)throw new ApiError(409,'STALE_REVISION','The order or its stock changed. Prepare a fresh review.');
  const {expectedRevision,...fields}=storedDecisionInput(proposal.decision,proposal.before.revision);
  const planned=planOrderDecision(before,{orderId:before.order.id,expectedRevision,decision:{action:proposal.decision.action,...fields}});
  const account=await store.get('SELECT username FROM seller_account WHERE id=?',trustedContext.accountId);if(!account)throw new ApiError(403,'FORBIDDEN','Operation authorization failed.');
  await withInventoryContext({source:'PRODUCT',actorKind:'SELLER',actorId:trustedContext.accountId,clientId:trustedContext.clientId,grantId:trustedContext.grantId,
    operationId:trustedContext.operationId,correlationId:trustedContext.correlationId},()=>applySellerDecision(store,before.order.id,planned.decision.action,storedDecisionInput(planned.decision,before.order.revision),account.username));
  const after=await orderDecisionSnapshot(store,before.order.id,asOf);
  if(after.order.status!==planned.after.status||after.order.revision!==planned.after.revision||after.order.currency!==before.order.currency||after.order.totalMinor!==before.order.totalMinor||
    JSON.stringify(after.items)!==JSON.stringify(before.items))throw new TypeError('Order normalization changed during commit.');
  const stocks=new Map(after.stocks.map(stock=>[stock.product.id,stock]));
  for(const effect of planned.stockEffects){const stock=stocks.get(effect.productId);if(!stock||stock.onHand!==effect.onHandAfter||stock.stockRevision!==effect.stockRevisionAfter||stock.held!==effect.heldAfter||stock.available!==effect.availableAfter||stock.shortfall!==effect.shortfallAfter||stock.confirmedOrders!==effect.confirmedAfter)throw new TypeError('Order stock effects changed during commit.');}
  return{orderId:after.order.id,orderNo:after.order.orderNo,status:after.order.status,revision:after.order.revision,resourceRevision:after.revision};
 });
}
