import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';
import { statuses } from '../seller-orders.js';
import { stockAvailability } from '../stock-reservation.js';
import { prepareOrderDecision,orderDecisionSnapshot,planOrderDecision,storedDecisionInput,commitOrderDecision } from '../order-decisions.js';
import { valid } from './tools.js';
import { canonicalOperationJson } from './operation-envelope.js';
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const text=(max,min=0,extra={})=>({type:'string',minLength:min,maxLength:max,...extra});
const int=(min=0,max=Number.MAX_SAFE_INTEGER)=>({type:'integer',minimum:min,maximum:max});
const nullable=schema=>({anyOf:[schema,{type:'null'}]});
const enumeration=values=>text(40,1,{enum:[...values]});
const uuid=text(36,36,{pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'}),hash=text(64,64,{pattern:'^[0-9a-f]{64}$'}),instant=text(24,24);
const status=enumeration(statuses),currency=enumeration(['MYR','SGD']),quantity=nullable(int(0,1000000)),action=enumeration(['confirm','reject','cancel','ship','deliver']);
// Wire text is bounded before the shared existing trim/NFC/domain validator.
// Normalized proposal fields retain the actual500/40/60 domain limits.
const inputSchema=object({orderId:uuid,expectedRevision:int(1),decision:object({action,reason:text(4096),carrier:text(4096),trackingNo:nullable(text(4096))},['action'])},['orderId','decision']);
const beforeSchema=object({id:uuid,orderNo:text(80,1),status,revision:int(1),currency,totalMinor:int(),submittedAt:instant,updatedAt:instant});
const afterSchema=object({id:uuid,orderNo:text(80,1),status,revision:int(1),currency,totalMinor:int()});
const itemSchema=object({deliveryPosition:int(),itemPosition:int(),productId:uuid,sku:text(40),name:text(120),priceMinor:int(),quantity:int(1,100),lineTotalMinor:int(),currency});
const effectSchema=object({productId:uuid,currentSku:text(40),currentName:text(120),quantity:int(1,10000),stockRevisionBefore:int(),stockRevisionAfter:int(),onHandBefore:quantity,onHandAfter:quantity,
 heldBefore:int(0,1000000),heldAfter:int(0,1000000),availableBefore:quantity,availableAfter:quantity,shortfallBefore:int(0,1000000),shortfallAfter:int(0,1000000),confirmedBefore:int(0,10000),confirmedAfter:int(0,10000),movement:enumeration(['NONE','DEDUCT','RESTORE'])});
const decisionSchema=object({action,reason:nullable(text(500)),carrier:nullable(text(40)),trackingNo:nullable(text(60))});
const proposalSchema=object({before:beforeSchema,after:afterSchema,resourceRevision:hash,items:{type:'array',minItems:1,maxItems:100,items:itemSchema},stockEffects:{type:'array',minItems:1,maxItems:50,items:effectSchema},decision:decisionSchema,asOf:instant});
const receiptSchema=object({orderId:uuid,orderNo:text(80,1),status,revision:int(1),resourceRevision:hash});
function proposalValid(proposal){
 if(!valid(proposal,proposalSchema))return false;
 try{
  const ids=[...new Set(proposal.items.map(item=>item.productId))].sort();if(JSON.stringify(ids)!==JSON.stringify(proposal.stockEffects.map(effect=>effect.productId)))return false;
  const positions=new Set();let total=0;for(const item of proposal.items){const key=item.deliveryPosition+':'+item.itemPosition;if(positions.has(key)||item.currency!==proposal.before.currency||!Number.isSafeInteger(item.priceMinor*item.quantity)||item.priceMinor*item.quantity!==item.lineTotalMinor)return false;positions.add(key);total+=item.lineTotalMinor;if(!Number.isSafeInteger(total))return false;}if(total!==proposal.before.totalMinor)return false;
  const stocks=proposal.stockEffects.map(effect=>{const expected=stockAvailability(effect.onHandBefore,effect.heldBefore);if(expected.availableQuantity!==effect.availableBefore||expected.reservationShortfall!==effect.shortfallBefore)throw new TypeError('Invalid stock review.');return{product:{id:effect.productId,sku:effect.currentSku,name:effect.currentName},onHand:effect.onHandBefore,stockRevision:effect.stockRevisionBefore,held:effect.heldBefore,available:effect.availableBefore,shortfall:effect.shortfallBefore,confirmedOrders:effect.confirmedBefore};});
  const {expectedRevision,...fields}=storedDecisionInput(proposal.decision,proposal.before.revision),snapshot={order:proposal.before,items:proposal.items,stocks,revision:proposal.resourceRevision,asOf:proposal.asOf};
  const checked=planOrderDecision(snapshot,{orderId:proposal.before.id,expectedRevision,decision:{action:proposal.decision.action,...fields}});
  return canonicalOperationJson(checked)===canonicalOperationJson(proposal);
 }catch{return false;}
}
export function orderDecisionTool(){return{previewName:'orders.preview_decision',commitName:'orders.commit_decision',scope:'orders.decide',capability:'orders.decide',inputSchema,receiptSchema,
 adapter:{resourceType:'order',
  async preview(read,args){
   if(!valid(args,inputSchema))throw new ApiError(400,'INVALID_INPUT','Invalid order decision.');let draft;
   try{draft=await prepareOrderDecision(read,args);}catch(error){if(error instanceof FieldError||error?.status===404)throw new ApiError(400,'INVALID_INPUT','Invalid order decision.');throw error;}
   try{canonicalOperationJson(draft.proposal);}catch{throw new ApiError(503,'ORDER_DECISION_LIMIT','The complete order review exceeds its bounded resource limit.');}
   if(!proposalValid(draft.proposal))throw new TypeError('Invalid order proposal.');return{resourceId:args.orderId,expectedRevision:draft.revision,proposal:draft.proposal};
  },
  async currentRevision(read,envelope){
   if(!proposalValid(envelope.proposal)||envelope.resourceId!==envelope.proposal.before.id||envelope.expectedRevision!==envelope.proposal.resourceRevision)throw new TypeError('Invalid stored order proposal.');
   try{return{exists:true,revision:(await orderDecisionSnapshot(read,envelope.resourceId)).revision};}catch(error){if(error?.status===404)return{exists:false,revision:null};throw error;}
  },
  async apply(store,proposal,context){if(!proposalValid(proposal))throw new TypeError('Invalid stored order proposal.');return commitOrderDecision(store,proposal,context);},
  validResult:value=>valid(value,receiptSchema),toReceipt:value=>({orderId:value.orderId,orderNo:value.orderNo,status:value.status,revision:value.revision,resourceRevision:value.resourceRevision}),validReceipt:value=>valid(value,receiptSchema),
 }};}
