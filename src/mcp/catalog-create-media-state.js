import { createHash } from 'node:crypto';
import { ApiError } from '../http.js';
import { validateProductInput } from '../product-input.js';
import { preparePlannedProductCreate } from '../products.js';
import { plannedProductCreationIdentity, planProductCreationListing } from '../listings.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { CATALOG_LIMITS, catalogMetadataColumns, describeOptions } from './catalog-tools.js';
import { CATALOG_STATE_LIMITS, readBoundedCatalogMetadata } from './catalog-media-state.js';
import { readMediaSnapshot } from './media-resources.js';
import { MEDIA_LIMITS } from './media-schema.js';

const changed=()=>{throw new ApiError(409,'CATALOG_CREATE_MEDIA_CHANGED','The planned catalog creation changed.');};
const large=()=>{throw new ApiError(503,'CATALOG_REVIEW_TOO_LARGE','The catalog review exceeds its safe metadata limit.');};
const invalid=()=>{throw new ApiError(400,'CATALOG_CREATE_MEDIA_INPUT','Invalid normalized catalog creation.');};
const sha=value=>createHash('sha256').update(value).digest('hex');
const json=canonicalOperationJson;
const keys=['sku','name','description','category','priceMinor','currency','active','variantGroup','variantLabel','stockQuantity','options'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pairSort=values=>[...values].sort((a,b)=>a.typeId<b.typeId?-1:a.typeId>b.typeId?1:0);
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
function shape(value,allowed,exact=false){
 if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).some(key=>{
  const field=Object.getOwnPropertyDescriptor(value,key);return !allowed.includes(key)||!field?.enumerable||!Object.hasOwn(field,'value');
 })||exact&&Reflect.ownKeys(value).length!==allowed.length)invalid();
}
function intent(value){
 shape(value,['normalizedInput','creationIdentity'],true);shape(value.normalizedInput,keys);
 let input;
 try{
  input=JSON.parse(json(value.normalizedInput));
  if(Buffer.byteLength(json(input))>CATALOG_STATE_LIMITS.recordBytes||json(validateProductInput(input,['MYR','SGD']))!==json(input))invalid();
  if(input.options!==undefined&&(!Array.isArray(input.options)||input.options.length>6))invalid();
  for(const pair of input.options??[]){shape(pair,['typeId','valueId'],true);if(!uuid.test(pair.typeId)||!uuid.test(pair.valueId))invalid();}
 }catch{invalid();}
 return freeze({normalizedInput:input,creationIdentity:plannedProductCreationIdentity(value.creationIdentity)});
}
function definitions(){
 const columns=catalogMetadataColumns();
 return [
  ['product',columns.product,'1=1',[],CATALOG_LIMITS.products],
  ['listing',columns.listing,'1=1',[],CATALOG_LIMITS.products],
  ['general_code',columns.general_code,"type='PRODUCT_CATEGORY'",[],CATALOG_LIMITS.dictionaryRows],
  ['option_type',columns.option_type,'1=1',[],CATALOG_LIMITS.dictionaryRows],
  ['option_value',columns.option_value,'1=1',[],CATALOG_LIMITS.dictionaryRows],
  ['product_option','product_id, option_type_id, option_value_id','1=1',[],CATALOG_LIMITS.products*6],
  ['company_setting','default_currency','id=1',[],1],
 ];
}

/** Raw current facts, not a new plan. Caller holds the platform -> tenant fence.
 * Appearing IDs/code and disabled dictionaries change the revision without
 * running preparation, adopting a target or swallowing validation errors. */
export async function readCatalogCreateMediaMetadata(read,input){
 const request=intent(input),identity=request.creationIdentity;
 const {parts,rows}=await readBoundedCatalogMetadata(read,definitions(),Buffer.byteLength(json(request))+4096);
 if(rows.company_setting.length!==1)changed();
 const predicates={identity,productId:rows.product.find(row=>row.id===identity.productId)?.id??null,
  newListingId:identity.newListingId===null?null:rows.listing.find(row=>row.id===identity.newListingId)?.id??null,
  targetByCodeId:identity.targetCode===null?null:rows.listing.find(row=>row.code===identity.targetCode)?.id??null,
  targetById:identity.targetListingId===null?null:rows.listing.find(row=>row.id===identity.targetListingId)?.id??null};
 const state=createHash('sha256');let used=0;
 const add=value=>{const text=json(value),size=Buffer.byteLength(text);used+=size;if(used>CATALOG_STATE_LIMITS.metadataBytes)large();state.update(String(size)+':').update(text);};
 add({kind:'CATALOG_CREATE_MEDIA_METADATA',version:1,request,predicates});
 for(const part of parts)for(const row of rows[part.table])add({kind:part.table,row});
 return freeze({version:1,request,predicates,revision:state.digest('hex'),rows});
}

/** Private metadata only. EMPTY_BEFORE explicitly is not a DB media snapshot. */
export async function readCatalogCreateMediaState(read,input){
 const metadata=await readCatalogCreateMediaMetadata(read,input),{normalizedInput,creationIdentity:identity}=metadata.request;
 const {rows}=metadata;
 if(rows.product.length>=CATALOG_LIMITS.products)large();
 const existing=identity.targetListingId!==null;
 const targetMembers=existing?rows.product.filter(row=>row.listing_id===identity.targetListingId):[];
 if(targetMembers.length+1>MEDIA_LIMITS.products)large();
 if(existing&&(!targetMembers.length||targetMembers.some(row=>row.variant_group!==identity.targetCode))||
  identity.targetCode!==null&&rows.product.some(row=>row.variant_group===identity.targetCode&&row.listing_id!==identity.targetListingId))changed();
 const prepared=await preparePlannedProductCreate(read,normalizedInput,identity);
 const plan=await planProductCreationListing(read,prepared,identity),listingId=identity.targetListingId??identity.newListingId;
 let source;
 if(existing){
  const order=await read.all(`SELECT id,listing_id,sku,created_at FROM product WHERE listing_id=? ORDER BY created_at,sku,id LIMIT ${MEDIA_LIMITS.products+1}`,listingId);
  const byId=new Map(targetMembers.map(row=>[row.id,row]));
  if(order.length!==targetMembers.length||order.some(row=>{const old=byId.get(row.id);return !old||row.listing_id!==old.listing_id||row.sku!==old.sku||row.created_at!==old.created_at;}))changed();
  const anchorId=order[0].id,snapshot=await readMediaSnapshot(read,anchorId);
  if(snapshot.products.length!==order.length||snapshot.listings.length!==1||snapshot.listings[0].id!==listingId||snapshot.products.some(row=>!byId.has(row.productId)))changed();
  source={kind:'EXISTING_TARGET',anchorId,order:order.map(row=>({productId:row.id,sku:row.sku,createdAt:row.created_at})),snapshot};
 }else source={kind:'EMPTY_BEFORE',listingId};
 const options=pairSort(prepared.options??[]),after={id:identity.productId,listingId,sku:prepared.sku,
  name:plan.listing.name,description:plan.listing.description,categoryCode:plan.listing.category,
  priceMinor:prepared.priceMinor,currency:prepared.currency,active:prepared.active,stockQuantity:prepared.stockQuantity,
  variantGroup:prepared.variantGroup??null,variantLabel:prepared.variantLabel??null,options};
 const optionReview={before:[],after:await describeOptions(read,options,{types:rows.option_type,values:rows.option_value})};
 const mediaRevision=existing?source.snapshot.revision:sha(json({kind:'EMPTY_BEFORE',identity}));
 const revision=sha(json({version:1,kind:'catalog-media-create',catalogRevision:metadata.revision,mediaRevision,identity,prepared,after,optionReview,order:source.order??[]}));
 return freeze({version:1,revision,catalogRevision:metadata.revision,mediaRevision,creationIdentity:identity,
  normalizedInput,preparedInput:prepared,after,optionReview,source,metadata});
}
