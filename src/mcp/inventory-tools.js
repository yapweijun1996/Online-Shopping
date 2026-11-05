import { RESERVATION_HOURS } from '../stock-reservation.js';
import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';
import { inventorySummary, inventoryMovements, inventorySnapshot, prepareInventoryAdjustment, planInventoryAdjustment, commitInventoryAdjustment } from '../inventory-reads.js';
import { INVENTORY_ADJUSTMENT_REASONS } from '../inventory.js';
import { valid } from './tools.js';
import { canonicalOperationJson } from './operation-envelope.js';
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const text=(max,min=0,extra={})=>({type:'string',minLength:min,maxLength:max,...extra});
const int=(min=0,max=Number.MAX_SAFE_INTEGER)=>({type:'integer',minimum:min,maximum:max});
const nullable=schema=>({anyOf:[schema,{type:'null'}]});
const enumeration=values=>text(40,1,{enum:[...values]});
const constant=value=>text(value.length,value.length,{const:value});
const uuid=text(36,36,{pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'}),revision=text(64,64,{pattern:'^[0-9a-f]{64}$'}),quantity=nullable(int(0,1000000));
const instant=text(24,24),bool={type:'boolean'};
const coverage=object({origin:enumeration(['MIGRATED','CREATED']),startedAt:instant,baselineQuantity:quantity,writerCoverage:constant('APPLICATION_WRITERS'),preCoverageHistoryAvailable:{type:'boolean',const:false}});
const product=object({id:uuid,sku:text(40),name:text(120),categoryCode:text(80),active:bool});
const summarySchema=object({product,stockRevision:int(),onHand:quantity,coverage,revision,held:int(0,1000000),available:quantity,shortfall:int(0,1000000),
 activeHoldOrders:int(0,10000),confirmedOrders:int(0,10000),reservationHours:int(RESERVATION_HOURS,RESERVATION_HOURS),asOf:instant});
const kinds=enumeration(['INITIALIZED','SET','TRACKING_ENABLED','TRACKING_DISABLED','ORDER_CONFIRMED','ORDER_CANCELLED']);
const reasons=enumeration(['PRODUCT_CREATE','PRODUCT_SET','CSV_CREATE','CSV_SET','DEMO_CREATE','OPERATOR_CREATE','OPERATOR_SET','ORDER_CONFIRM','ORDER_CANCEL',...INVENTORY_ADJUSTMENT_REASONS]);
const movementSchema=object({id:uuid,productId:uuid,stockRevision:int(1),kind:kinds,source:enumeration(['PRODUCT','CSV','DEMO','OPERATOR','MCP_CATALOG','MCP_ADJUST','ORDER']),reasonCode:reasons,
 beforeQuantity:quantity,afterQuantity:quantity,deltaQuantity:nullable(int(-1000000,1000000)),occurredAt:instant});
const movementsSchema=object({productId:uuid,stockRevision:int(),coverage,items:{type:'array',minItems:0,maxItems:100,items:movementSchema},nextBeforeRevision:nullable(int(1))});
const inputSchema=object({productId:uuid,expectedRevision:revision,stockQuantity:quantity,reasonCode:enumeration(INVENTORY_ADJUSTMENT_REASONS),note:text(500)},['productId','expectedRevision','stockQuantity','reasonCode']);
const normalizedSchema=object({productId:uuid,stockQuantity:quantity,reasonCode:enumeration(INVENTORY_ADJUSTMENT_REASONS)});
const afterSchema=object({onHand:quantity,stockRevision:int(1),held:int(0,1000000),available:quantity,shortfall:int(0,1000000),tracking:enumeration(['FINITE','UNLIMITED'])});
const proposalSchema=object({before:summarySchema,after:afterSchema,normalized:normalizedSchema,note:nullable(text(500))});
const receiptSchema=object({productId:uuid,movementId:uuid,stockRevision:int(1),revision});
function proposalValid(proposal){
 if(!valid(proposal,proposalSchema)||proposal.note!==null&&(proposal.note.length===0||proposal.note.trim()!==proposal.note))return false;
 try{return canonicalOperationJson(planInventoryAdjustment(proposal.before,{...proposal.normalized,expectedRevision:proposal.before.revision,...(proposal.note===null?{}:{note:proposal.note})}))===canonicalOperationJson(proposal);}catch{return false;}
}
function checkedRead(name,inputSchema,outputSchema,read){return{kind:'read',name,scope:'inventory.read',capability:'catalog.write',inputSchema,outputSchema,
 async read(query,args){let result;try{result=await read(query,args);}catch(error){if(error?.status===404)throw new ApiError(400,'INVALID_INPUT','Product not found.');throw error;}if(!valid(result,outputSchema))throw new ApiError(503,'INVENTORY_UNAVAILABLE','Inventory data is unavailable.');return result;}};}
export const inventorySummaryTool=()=>checkedRead('inventory.summary',object({productId:uuid}),summarySchema,inventorySummary);
export const inventoryMovementsTool=()=>checkedRead('inventory.movements',object({productId:uuid,beforeRevision:int(1),limit:int(1,100)},['productId']),movementsSchema,inventoryMovements);
export function inventoryAdjustmentTool(){return{previewName:'inventory.preview_adjustment',commitName:'inventory.commit_adjustment',scope:'inventory.adjust',capability:'catalog.write',inputSchema,receiptSchema,
 adapter:{resourceType:'inventory',
  async preview(read,args){
   if(!valid(args,inputSchema))throw new ApiError(400,'INVALID_INPUT','Invalid inventory adjustment.');let proposal;
   try{proposal=await prepareInventoryAdjustment(read,args);}catch(error){if(error instanceof FieldError||error?.status===404)throw new ApiError(400,'INVALID_INPUT','Invalid inventory adjustment.');throw error;}
   if(!proposalValid(proposal))throw new TypeError('Invalid inventory proposal.');return{resourceId:args.productId,expectedRevision:proposal.before.revision,proposal};
  },
  async currentRevision(read,envelope){
   if(!proposalValid(envelope.proposal)||envelope.resourceId!==envelope.proposal.normalized.productId)throw new TypeError('Invalid stored inventory proposal.');
   try{return{exists:true,revision:(await inventorySnapshot(read,envelope.resourceId)).revision};}catch(error){if(error?.status===404)return{exists:false,revision:null};throw error;}
  },
  async apply(store,proposal,context){if(!proposalValid(proposal))throw new TypeError('Invalid stored inventory proposal.');return commitInventoryAdjustment(store,proposal,context);},
  validResult:value=>valid(value,receiptSchema),toReceipt:value=>({productId:value.productId,movementId:value.movementId,stockRevision:value.stockRevision,revision:value.revision}),validReceipt:value=>valid(value,receiptSchema),
 }};}
