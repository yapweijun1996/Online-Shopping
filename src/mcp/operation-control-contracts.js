import { OPERATION_SCOPE_POLICIES } from './operation-policy.js';
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const string=(minLength,maxLength)=>({type:'string',minLength,maxLength});
const uuid={...string(36,36),pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'};
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const nullable=value=>({anyOf:[{type:'null'},value]});
const state={type:'string',enum:['PREPARED','PENDING_APPROVAL','APPROVED','COMMITTED','REJECTED','EXPIRED','CANCELLED','CONFLICT','FAILED'],minLength:1,maxLength:32};
const instant=string(24,24);
const metadata=object({operationId:uuid,status:state,toolName:{...string(1,64),enum:Object.keys(OPERATION_SCOPE_POLICIES)},resourceType:{...string(1,16),enum:['company','catalog','product','inventory','order']},
  resourceId:string(1,128),risk:{...string(1,8),enum:['MEDIUM','HIGH']},createdAt:instant,expiresAt:instant,receiptExpiresAt:instant,
  proposalRedacted:{type:'boolean'},proposalExpired:{type:'boolean'},receiptAvailable:{type:'boolean'},inventoryReason:nullable({...string(1,32),enum:['COUNT_CORRECTION','RECEIPT','DAMAGE','OTHER']})});
const auditItem=object({id:uuid,at:instant,source:{...string(1,16),enum:['LIFECYCLE','MCP']},sequence:integer(1,Number.MAX_SAFE_INTEGER),
  toolName:{...string(1,64),enum:Object.keys(OPERATION_SCOPE_POLICIES)},event:{...string(1,32),enum:['PREPARE','REQUEST_APPROVAL','APPROVE','REJECT','COMMIT','CANCEL','EXPIRE','CONFLICT','FAIL','DENY','READ','CALL']},
  outcome:{...string(1,80)},actorAccount:uuid,actorClient:string(1,128),actorGrant:uuid,humanAccount:nullable(uuid),correlationId:uuid});
export const OPERATION_CONTROL_CONTRACTS={
  'operations.get':{description:'Read metadata for your own original-grant operation. Requires fresh operations.read consent and every underlying operation scope and current capability. Proposals and result bodies are excluded.',
    inputSchema:object({operationId:uuid}),outputSchema:metadata},
  'operations.cancel':{description:'Abort your own nonterminal operation without applying or undoing commerce. Requires fresh operations.cancel consent and every underlying operation scope and current capability. This low-risk abort needs no further human approval.',
    inputSchema:object({operationId:uuid}),outputSchema:object({operationId:uuid,status:state,replayed:{type:'boolean'}})},
  'operations.audit':{description:'Read bounded stable pages of retained lifecycle proofs and operation-linked typed MCP calls. Historical unlinked RPCs and upload staging calls are excluded. No proposals, private notes or image bytes are returned.',
    inputSchema:object({operationId:uuid,limit:integer(1,50),cursor:string(1,3072)},['operationId']),
    outputSchema:object({operationId:uuid,items:{type:'array',items:auditItem,minItems:0,maxItems:50},nextCursor:nullable(string(1,3072)),
      coverage:object({retentionDays:{type:'integer',minimum:90,maximum:90},historicalUnlinkedCallsIncluded:{type:'boolean',const:false},preOperationStagesIncluded:{type:'boolean',const:false},
        lifecycleAnchor:integer(0,Number.MAX_SAFE_INTEGER),callAnchor:integer(0,Number.MAX_SAFE_INTEGER),snapshotAt:instant})})},
};
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
freeze(OPERATION_CONTROL_CONTRACTS);
export const operationControlTools=()=>Object.entries(OPERATION_CONTROL_CONTRACTS).map(([name,contract])=>({kind:'control',name,scope:OPERATION_SCOPE_POLICIES[name].scope,inputSchema:contract.inputSchema,outputSchema:contract.outputSchema}));
