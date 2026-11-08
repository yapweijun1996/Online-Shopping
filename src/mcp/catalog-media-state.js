import { assertNoProtectedRichDetail } from '../product-detail.js';
import { createHash } from 'node:crypto';
import { ApiError } from '../http.js';
import { validateProductInput } from '../product-input.js';
import { hasProductSkuConflict } from '../products.js';
import { hasVariantLabel } from '../options.js';
import { plannedListingIdentity } from '../listings.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { catalogMetadataColumns, catalogUpdateChangesSchema } from './catalog-tools.js';
import { readMediaUnionSnapshot } from './media-resources.js';
import { valid } from './tools.js';

export const CATALOG_STATE_LIMITS = Object.freeze({ members:300, metadataBytes:8388608, mappings:1800,
  values:1806, types:1806, categories:301, pageSize:200, recordBytes:65536 });
const columns=catalogMetadataColumns(), patchSchema=catalogUpdateChangesSchema();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const large=()=>{throw new ApiError(503,'CATALOG_REVIEW_TOO_LARGE','The catalog review exceeds its safe metadata limit.');};
const invalid=()=>{throw new ApiError(400,'CATALOG_STATE_INPUT','Invalid normalized catalog intent.');};
const unsupported=()=>{throw new ApiError(409,'CATALOG_DEPENDENCY_CHANGED','The catalog dependencies changed.');};
const sha=value=>createHash('sha256').update(value).digest('hex');
const frozen=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;};
function json(value){try{return canonicalOperationJson(value);}catch{large();}}
function shape(value,keys){
 if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>{
  const descriptor=Object.getOwnPropertyDescriptor(value,key);return !descriptor?.enumerable||!Object.hasOwn(descriptor,'value');
 }))invalid();
}
function args(value){
 shape(value,['productId','changes','plannedIdentity']);
 if(typeof value.productId!=='string'||!uuid.test(value.productId))invalid();
 let changes;try{
  changes=JSON.parse(canonicalOperationJson(value.changes));
  if(!valid(changes,patchSchema)||!Object.keys(changes).length||canonicalOperationJson(validateProductInput(changes,['MYR','SGD'],{partial:true}))!==canonicalOperationJson(changes))invalid();
 }catch{invalid();}
 let identity=null;try{if(value.plannedIdentity!==null)identity=plannedListingIdentity(value.plannedIdentity);}catch{invalid();}
 if(identity&&identity.productId!==value.productId)invalid();
 return frozen({productId:value.productId,changes,plannedIdentity:identity});
}
const size=(read,column)=>read.dialect==='postgres'?`octet_length(CAST(${column} AS TEXT))`:`length(CAST(${column} AS BLOB))`;
const number=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)large();return n;};
const fields=value=>value.split(',').map(key=>key.trim());
// Six UTF8 input bytes per byte is a conservative JSON escaping bound. Fixed
// nullable/key/tag syntax is counted separately for every row, across all tables.
function overhead(table,selection){return Buffer.byteLength(json({kind:table,row:Object.fromEntries(fields(selection).map(key=>[key,null]))}))+32;}
async function stats(read,table,selection,where,params,cap){
 const bytes=fields(selection).map(key=>`COALESCE(${size(read,key)},0)`).join(' + ');
 const row=await read.get(`SELECT COUNT(*) AS n, COALESCE(SUM(${bytes}),0) AS bytes, COALESCE(MAX(${bytes}),0) AS row_bytes FROM ${table} WHERE ${where}`,...params);
 const n=number(row.n),raw=number(row.bytes);if(n>cap)large();
 if(n&&overhead(table,selection)+6*number(row.row_bytes)>CATALOG_STATE_LIMITS.recordBytes)large();
 const bound=n*overhead(table,selection)+6*raw;if(!Number.isSafeInteger(bound))large();
 return {table,selection,where,params,n,bound};
}
async function materialize(read,part){
 const rows=[],order=part.table==='product_option'?'product_id, option_type_id':part.table==='general_code'?'code':part.table==='company_setting'?'id':'id';
 for(let offset=0;offset<part.n;offset+=CATALOG_STATE_LIMITS.pageSize){
  const limit=Math.min(CATALOG_STATE_LIMITS.pageSize,part.n-offset),page=await read.all(`SELECT ${part.selection} FROM ${part.table} WHERE ${part.where} ORDER BY ${order} LIMIT ? OFFSET ?`,...part.params,limit,offset);
  if(page.length!==limit)unsupported();rows.push(...page);
 }
 return rows;
}

// Internal source-owned definitions only. COUNT/SUM/MAX across every dependency
// completes before any selected text is materialized. No public SQL interface.
export async function readBoundedCatalogMetadata(read,definitions,reserve=0){
 const parts=[];let upper=reserve;
 if(!Number.isSafeInteger(upper)||upper<0||upper>CATALOG_STATE_LIMITS.metadataBytes)large();
 for(const definition of definitions){const part=await stats(read,...definition);upper+=part.bound;if(upper>CATALOG_STATE_LIMITS.metadataBytes)large();parts.push(part);}
 const rows={};for(const part of parts)rows[part.table]=await materialize(read,part);
 return {parts,rows};
}

/** Current facts only. Caller already holds the platform -> tenant read/writer fence. */
export async function readCatalogMediaMetadata(read,input){
 const intent=args(input),{productId,changes,plannedIdentity:identity}=intent;
 const source=await read.get(`SELECT id,substr(listing_id,1,37) AS listing_id,substr(variant_group,1,41) AS variant_group,
  substr(sku,1,41) AS sku,substr(variant_label,1,81) AS variant_label FROM product WHERE id=?`,productId);
 if(!source)return null;
 if(!uuid.test(source.listing_id||'')||typeof source.sku!=='string'||source.sku.length>40||
  !(source.variant_group===null||typeof source.variant_group==='string'&&/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(source.variant_group))||
  !(source.variant_label===null||typeof source.variant_label==='string'&&source.variant_label.length<=80))unsupported();
 const group=Object.hasOwn(changes,'variantGroup')?changes.variantGroup:source.variant_group;
 const moved=Object.hasOwn(changes,'variantGroup')&&group!==source.variant_group;
 const target=group?await read.get('SELECT substr(id,1,37) AS id,code FROM listing WHERE code=?',group):null;
 if(target&&!uuid.test(target.id||''))unsupported();
 if(!moved&&group&&target?.id!==source.listing_id)unsupported();
 if(identity&&identity.targetCode!==group)invalid();
 const targetId=moved?(target?.id??null):source.listing_id;
 const listingIds=[...new Set([source.listing_id,...(targetId?[targetId]:[])])].sort();
 await assertNoProtectedRichDetail(read,listingIds);
 const placeholders=listingIds.map(()=>'?').join(','),scope=`listing_id IN (${placeholders})`;
 const groups=[...new Set([source.variant_group,group].filter(value=>value!==null))];
 if(groups.length&&await read.get(`SELECT 1 AS found FROM product WHERE variant_group IN (${groups.map(()=>'?').join(',')}) AND (listing_id IS NULL OR listing_id NOT IN (${placeholders})) LIMIT 1`,...groups,...listingIds))unsupported();
 const productIds=`SELECT id FROM product WHERE ${scope}`;
 const mappings=`SELECT option_value_id FROM product_option WHERE product_id IN (${productIds})`;
 const typeMappings=`SELECT option_type_id FROM product_option WHERE product_id IN (${productIds})`;
 const proposed=changes.options??[];
 const valuesQuery=mappings+proposed.map(()=> ' UNION SELECT ?').join('');
 const typesQuery=typeMappings+proposed.map(()=> ' UNION SELECT ?').join('');
 const categoryQuery=`SELECT category FROM product WHERE ${scope} UNION SELECT category FROM listing WHERE id IN (${placeholders})`+
  (Object.hasOwn(changes,'category')?' UNION SELECT ?':'');
 const definitions=[
  ['product',columns.product,scope,listingIds,CATALOG_STATE_LIMITS.members],
  ['listing',columns.listing,`id IN (${placeholders})`,listingIds,2],
  ['general_code',columns.general_code,`type='PRODUCT_CATEGORY' AND code IN (${categoryQuery})`,[...listingIds,...listingIds,...(Object.hasOwn(changes,'category')?[changes.category]:[])],CATALOG_STATE_LIMITS.categories],
  ['product_option','product_id, option_type_id, option_value_id',`product_id IN (${productIds})`,listingIds,CATALOG_STATE_LIMITS.mappings],
  ['option_type',columns.option_type,`id IN (${typesQuery})`,[...listingIds,...proposed.map(value=>value.typeId)],CATALOG_STATE_LIMITS.types],
  ['option_value',columns.option_value,`id IN (${valuesQuery})`,[...listingIds,...proposed.map(value=>value.valueId)],CATALOG_STATE_LIMITS.values],
  ['company_setting','default_currency','id=1',[],1],
 ];
 // Predicate/header values have fixed UUID/code/SKU/label bounds; this reserve
 // covers their JSON framing, including worst-case UTF8/escaping, before reads.
 const {parts,rows}=await readBoundedCatalogMetadata(read,definitions,Buffer.byteLength(json(intent))+4096);
 if(rows.product.length===0||rows.listing.length!==listingIds.length||rows.company_setting.length!==1||
  listingIds.some(id=>!rows.product.some(row=>row.listing_id===id)))unsupported();
 const planned=identity?await read.get('SELECT id,substr(code,1,41) AS code FROM listing WHERE id=?',identity.newListingId):null;
 if(planned&&!(planned.code===null||typeof planned.code==='string'&&planned.code.length<=40))unsupported();
 const sku=Object.hasOwn(changes,'sku')?changes.sku:source.sku;
 const label=Object.hasOwn(changes,'variantLabel')?changes.variantLabel:source.variant_label;
 const predicates={targetCode:{code:group,listingId:target?.id??null},membershipChanges:moved,
  sku:{value:sku,excludedProductId:productId,conflict:await hasProductSkuConflict(read,sku,productId)},
  label:{group,value:label,excludedProductId:productId,conflict:await hasVariantLabel(read,group,label,productId)},
  plannedCreation:identity?{context:identity,actualSourceListingId:source.listing_id,lookup:{queriedId:identity.newListingId,existing:planned??null}}:null};
 const selector={sourceListingId:source.listing_id,targetListingId:targetId,listingIds};
 const intentHash=sha(json(intent)),state=createHash('sha256');let used=0;
 const add=record=>{const text=json(record),bytes=Buffer.byteLength(text);used+=bytes;if(used>CATALOG_STATE_LIMITS.metadataBytes)large();state.update(String(bytes)+':').update(text);};
 add({kind:'CATALOG_MEDIA_METADATA',version:1,productId,intentHash,selector,predicates});
 for(const part of parts)for(const row of rows[part.table])add({kind:part.table,row});
 return frozen({version:1,productId,intentHash,selector,predicates,plannedIdentity:identity,revision:state.digest('hex'),rows});
}

/** One composite for adapter/review/currentRevision; this is integrity, not authority. */
export async function readCatalogMediaState(read,input){
 const metadata=await readCatalogMediaMetadata(read,input);if(!metadata)return null;
 const mediaSnapshot=await readMediaUnionSnapshot(read,metadata.productId,{targetListingId:metadata.selector.targetListingId});
 const actual=mediaSnapshot.version===2?mediaSnapshot.capture.listingIds:[mediaSnapshot.products.find(row=>row.productId===metadata.productId)?.listingId];
 if(json(actual)!==json(metadata.selector.listingIds))unsupported();
 const categories=new Map(metadata.rows.general_code.map(row=>[row.code,row])),sources=new Map(mediaSnapshot.sources.map(row=>[`${row.source_kind}:${row.source_product_id}:${row.source_id}`,row]));
 if(metadata.rows.product.length!==mediaSnapshot.products.length)unsupported();
 for(const [index,row] of metadata.rows.product.entries()){
  const media=mediaSnapshot.products[index],category=categories.get(row.category);let layout;
  if(!media)unsupported();
  try{layout=row.gallery_layout_json===null?null:JSON.parse(row.gallery_layout_json);}catch{unsupported();}
  const expected={productId:row.id,listingId:row.listing_id,sku:row.sku,name:row.name,variantGroup:row.variant_group,
   variantLabel:row.variant_label,active:row.active===1,createdAt:row.created_at,layout,
   category:category?{code:row.category,label:category.label,active:category.active===1}:null};
  const fields=Object.fromEntries(Object.keys(expected).map(key=>[key,media?.[key]]));
  if(json(fields)!==json(expected)||(media.mainSource?sources.get(media.mainSource)?.mime:null)!==row.image_mime)unsupported();
 }
 for(const row of metadata.rows.listing){
  const media=mediaSnapshot.listings.find(value=>value.id===row.id);
  if(!media||media.code!==row.code||media.name!==row.name)unsupported();
 }
 const revision=sha(json({version:1,kind:'catalog-media-update',productId:metadata.productId,intentHash:metadata.intentHash,
  catalogRevision:metadata.revision,mediaRevision:mediaSnapshot.revision}));
 return frozen({version:1,revision,catalogRevision:metadata.revision,mediaRevision:mediaSnapshot.revision,metadata,mediaSnapshot});
}
