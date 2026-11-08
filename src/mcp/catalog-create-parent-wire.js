import { canonicalOperationJson } from './operation-envelope.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,sha=/^[0-9a-f]{64}$/;
const invalid=()=>{throw new TypeError('Invalid catalog creation parent binding.');};
function shape(value,keys){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))invalid();}
export function creationMediaBinding(value){
 shape(value,['version','draftId','intentHash','images']);
 if(value.version!==1||!uuid.test(value.draftId||'')||!sha.test(value.intentHash||'')||!Array.isArray(value.images)||value.images.length<1||value.images.length>10)invalid();
 const stages=new Set(),canonical=new Set();
 for(const [position,row]of value.images.entries()){
  shape(row,['stageId','productId','targetSlot','sourceSha256','canonicalSha256','thumbnailSha256','mime','byteLength','thumbnailBytes','width','height']);
  if(!uuid.test(row.stageId||'')||!uuid.test(row.productId||'')||stages.has(row.stageId)||canonical.has(row.canonicalSha256)||
   ![row.sourceSha256,row.canonicalSha256,row.thumbnailSha256].every(item=>sha.test(item||''))||row.targetSlot!==(position===0?'MAIN':'GALLERY')||
   !['image/png','image/jpeg','image/webp'].includes(row.mime)||![row.byteLength,row.thumbnailBytes,row.width,row.height].every(Number.isSafeInteger)||
   row.byteLength<1||row.byteLength>524288||row.thumbnailBytes<1||row.thumbnailBytes>81920||row.width<1||row.width>8192||row.height<1||row.height>8192||row.width*row.height>4194304)invalid();
  stages.add(row.stageId);canonical.add(row.canonicalSha256);
 }
 return value;
}
export const isCreationParent=proposal=>Boolean(proposal&&Object.hasOwn(proposal,'creationMedia'));
export function assertCreationParentManifest(proposal,manifest){
 const binding=creationMediaBinding(proposal.creationMedia),fresh=manifest.effects.find(row=>row.kind==='PRODUCT'&&row.before===null),listing=manifest.effects.find(row=>row.kind==='LISTING');
 if(!fresh||fresh.productId!==proposal.creationIdentity?.productId||!listing||manifest.stages.length!==binding.images.length||
  binding.images[0].productId!==fresh.productId||fresh.after.mainAssetKey===null)invalid();
 for(const [position,row]of binding.images.entries()){
  const stage=manifest.stages.find(item=>item.stage_id===row.stageId),asset=manifest.assets.find(item=>item.byte_sha256===row.canonicalSha256&&item.mime===row.mime);
  if(!stage||stage.source_product_id!==row.productId||stage.canonical_sha256!==row.canonicalSha256||!asset||asset.byte_length!==row.byteLength)invalid();
  if(position===0?fresh.after.mainAssetKey!==asset.asset_key:row.productId!==(listing.after.holderId??fresh.productId)||!listing.after.galleryAssetKeys.includes(asset.asset_key))invalid();
 }
 const ordered=binding.images.slice(1).map(row=>manifest.assets.find(asset=>asset.byte_sha256===row.canonicalSha256&&asset.mime===row.mime).asset_key);
 if(canonicalOperationJson(listing.after.galleryAssetKeys.slice(-ordered.length||listing.after.galleryAssetKeys.length))!==canonicalOperationJson(ordered))invalid();
 return binding;
}
