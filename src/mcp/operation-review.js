'use strict';

// First-party seller UI. All proposal
// content is untrusted and is rendered only as text.
const statusNode = document.querySelector('#status');
const reviewSection = document.querySelector('#review');
const form = document.querySelector('#decision');
const path = /^\/(?:([a-z0-9]{3,30})\/)?oauth\/operation\/?$/.exec(location.pathname);
const base = path?.[1] ? `/${path[1]}` : '';
const reviewParams = new URL(location.href).searchParams;
let operationIds = reviewParams.has('operationIds') ? reviewParams.get('operationIds').split(',') : [reviewParams.get('operationId')];
let id = operationIds[0], batchIndex = 0, finishEnabled = false, finishJob = null;
const reviewedProposals = [];
const finishKey = `seller-mcp-finish:${operationIds.join(',')}`;
let earliestExpiry = Infinity, savedProgressRead = false;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
document.querySelector('#seller-link').href = `${base}/seller/`;
let csrf = null;
let previewHash = null;
let challenge = null;
let currencyAcknowledgementRequired = false;
let mediaReview = null, mediaComplete = false, imageUrl = null, selectedImage = null, imageJob = null;
const mediaAck = document.querySelector('#media-ack');
const imageNode = document.querySelector('#media-image');
const imageAck = document.querySelector('#media-image-ack');
const reviewedImages = new Set();
const currencyAck = document.querySelector('#currency-ack');
const imageStatus = document.querySelector('#media-image-status');
const imageRetry = document.querySelector('#media-image-retry');
let retryImage = null;
let expiryTimer = null, expiresAt = null, expired = false, decisionPending = false;
const visible = (value) => value.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
  (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);

function checkExpiry() {
  if (!expired && expiresAt !== null && Date.now() >= expiresAt) {
    expired = true; clearTimeout(expiryTimer); expiryTimer = null;
    const message = 'Proposal expired. Ask the connected app for a new preview.';
    document.querySelector('#pending-state').textContent = message;
    statusNode.textContent = message;
    for (const control of form.querySelectorAll('input, button')) control.disabled = true;
    imageAck.disabled = true; imageRetry.disabled = true;
    for (const control of document.querySelectorAll('.media-reference')) control.disabled = true;
  }
  return expired;
}
function scheduleExpiry() {
  clearTimeout(expiryTimer);
  if (expiresAt === null || checkExpiry()) return;
  expiryTimer = setTimeout(scheduleExpiry, Math.min(expiresAt - Date.now(), 2147483647));
}
function updateReviewControls() {
  const disabled = checkExpiry() || decisionPending || !csrf || !previewHash || !challenge;
  for (const control of form.querySelectorAll('input, button')) control.disabled = disabled;
  document.querySelector('#approve').disabled = disabled || Boolean(mediaReview && !mediaComplete);
  for(const selector of ['#approve-finish','#review-next'])document.querySelector(selector).disabled=disabled || Boolean(mediaReview && !mediaComplete);
  imageAck.disabled = disabled || !selectedImage || reviewedImages.has(selectedImage.item.itemKey);
  imageRetry.disabled = disabled;
  for (const control of document.querySelectorAll('.media-reference')) control.disabled = disabled;
}
function reviewStatus(message) {
  if (!checkExpiry()) statusNode.textContent = message;
}

function summaryText(value) {
  if (value === undefined) return 'Not provided';
  if (value === null) return 'None';
  return visible(typeof value === 'string' ? value || 'Empty' : JSON.stringify(value));
}
function catalogSummaryFields(row, optionReview) {
  if (!row || typeof row !== 'object') return null;
  let price = 'Not provided';
  if (Number.isSafeInteger(row.priceMinor)) {
    price = ['MYR', 'SGD'].includes(row.currency)
      ? `${row.currency} ${(row.priceMinor / 100).toFixed(2)}`
      : `${row.priceMinor} minor units (${typeof row.currency === 'string' && row.currency ? visible(row.currency) + '; scale not provided' : 'currency not provided'})`;
  }
  const options = optionReview ?? row.options;
  const optionText = !Array.isArray(options) ? 'Not provided' : !options.length ? 'None'
    : options.every(option => typeof option.typeName === 'string' && typeof option.valueLabel === 'string')
      ? visible(options.map(option => `${option.typeName}: ${option.valueLabel}${option.typeActive === false || option.valueActive === false ? ' (inactive)' : ''}`).join('; '))
      : `${options.length} selection(s); labels not provided — see complete proposal`;
  const category = row.category && typeof row.category === 'object'
    ? `${summaryText(row.category.label)} (${summaryText(row.category.code)})${row.category.active === false ? ' (inactive)' : ''}`
    : summaryText(row.categoryCode ?? row.category);
  return [
    ['Name', summaryText(row.name)], ['SKU', summaryText(row.sku)], ['Price', price],
    ['Stock', row.stockQuantity === null ? 'Unlimited' : summaryText(row.stockQuantity)],
    ['Availability', row.active === true ? 'Listed' : row.active === false ? 'Not listed' : 'Not provided'],
    ['Category', category], ['Description', summaryText(row.description)], ['Options', optionText],
    ['Variant group', summaryText(row.variantGroup)], ['Variant label', summaryText(row.variantLabel)],
  ];
}
function renderBusinessSummary(value) {
  const titles = {
    'catalog.preview_create': 'Review product creation',
    'catalog.preview_update': 'Review product changes',
    'company.preview_update': 'Review company changes',
    'inventory.preview_adjustment': 'Review stock adjustment',
    'orders.preview_decision': 'Review order decision',
  };
  const title = titles[value.toolName] || 'Review proposed seller operation';
  document.querySelector('#operation-heading').textContent = title;
  document.title = `${title} · Seller Studio`;
  if (!['catalog.preview_create', 'catalog.preview_update'].includes(value.toolName)) return;
  const proposal = value.proposal, root = document.querySelector('#summary-fields');
  const products = Array.isArray(proposal.catalogReview?.products) ? proposal.catalogReview.products
    : [{ before: proposal.before, after: proposal.after }];
  root.replaceChildren();
  for (const [index, product] of products.entries()) {
    const before = catalogSummaryFields(product.before, proposal.optionReview?.before);
    const after = catalogSummaryFields(product.after, proposal.optionReview?.after);
    if (!after) continue;
    const article = document.createElement('article'); article.className = 'summary-product';
    if (products.length > 1) {
      const heading = document.createElement('h3');
      heading.textContent = `Affected product ${index + 1} · ${summaryText(product.after?.sku)}`; article.append(heading);
    }
    const grid = document.createElement('dl'); grid.className = `summary-grid${before ? ' has-before' : ''}`;
    const append = (tag, text, className = '') => {
      const node = document.createElement(tag); node.textContent = text; node.className = className; grid.append(node);
    };
    append('dt', 'Field', 'column-title');
    if (before) append('dd', 'Before', 'column-title');
    append('dd', before ? 'After' : 'New product', 'column-title');
    for (const [fieldIndex, [label, text]] of after.entries()) {
      append('dt', label);
      if (before) append('dd', before[fieldIndex][1]);
      append('dd', text, before && before[fieldIndex][1] !== text ? 'changed' : '');
    }
    article.append(grid); root.append(article);
  }
  document.querySelector('#business-summary').hidden = root.childElementCount === 0;
}

async function load() {
  const params = new URL(location.href).searchParams;
  if (!path || [...params.keys()].some(key => !['operationId', 'operationIds', 'utm_source'].includes(key)) ||
      (params.has('operationIds') ? params.has('operationId') || params.getAll('operationIds').length !== 1 : params.getAll('operationId').length !== 1) || operationIds.length > 5 || new Set(operationIds).size !== operationIds.length || !operationIds.every(value=>idPattern.test(value||'')) || params.getAll('utm_source').length > 1 ||
      (params.has('utm_source') && !/^[A-Za-z0-9._~-]{1,128}$/.test(params.get('utm_source')))) throw new Error('Invalid operation.');
  const sessionResponse = await fetch(`${base}/api/v1/seller/session`, { credentials: 'same-origin', cache: 'no-store' });
  if (sessionResponse.status === 401) {
    const link = document.querySelector('#seller-link');
    link.href = `${base}/seller/?${reviewParams.has('operationIds') ? 'reviewOperations='+operationIds.join(',') : 'reviewOperation='+id}`;
    link.textContent = 'Sign in to review this proposal';
    throw new Error('Sign in required.');
  }
  if (!sessionResponse.ok) throw new Error('Sign in required.');
  const session = await sessionResponse.json();
  if (typeof session.csrfToken !== 'string' || !session.csrfToken) throw new Error('Invalid session.');
  csrf=session.csrfToken;
  if(batchIndex===0 && !savedProgressRead){
    savedProgressRead=true;
    let saved=null;try{saved=sessionStorage.getItem(finishKey);}catch{/* Storage is optional. */}
    if(saved && idPattern.test(saved)){
      const progress=await fetch(`${base}/api/v1/seller/mcp/finishes/${saved}`,{credentials:'same-origin',cache:'no-store'});
      if(progress.ok){
        const value=await progress.json();
        if(value.jobId!==saved || !Array.isArray(value.items))throw new Error('Invalid progress.');
        finishJob=saved;
        const pending=value.items.filter(item=>item.operationState==='PENDING_APPROVAL').map(item=>item.operationId);
        if(!pending.length){showFinish(value);return;}
        if(pending.length>5 || new Set(pending).size!==pending.length || !pending.every(value=>idPattern.test(value||'')))throw new Error('Invalid progress.');
        // A lost approval request never becomes approval. Rebuild every pending
        // review/challenge and require exact-image acknowledgment again.
        operationIds=pending;id=operationIds[0];
      }
    }
  }
  const response = await fetch(`${base}/api/v1/seller/mcp/operations/${id}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('Proposal unavailable.');
  const value = await response.json();
  if (typeof value.currencyAcknowledgementRequired !== 'boolean' ||
      (value.currencyAcknowledgementRequired ? typeof value.currencyWarning !== 'string' || !value.currencyWarning : value.currencyWarning !== null) ||
      typeof value.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.challenge) || value.operationId !== id || typeof value.previewHash !== 'string' || !hashPattern.test(value.previewHash) ||
      typeof value.shopName !== 'string' || typeof value.accountName !== 'string' || typeof value.clientName !== 'string' ||
      typeof value.clientId !== 'string' ||
      typeof value.toolName !== 'string' || typeof value.resourceType !== 'string' ||
      !(value.resourceId === null || typeof value.resourceId === 'string') || !['LOW', 'MEDIUM', 'HIGH'].includes(value.risk) ||
      typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
      !value.proposal || typeof value.proposal !== 'object' || Array.isArray(value.proposal)) {
    throw new Error('Invalid proposal.');
  }
  finishEnabled=value.finishEnabled === true && ['catalog.preview_create','catalog.preview_update','media.prepare_upload','media.preview_layout'].includes(value.toolName);
  if(operationIds.length>1 && !finishEnabled)throw new Error('Batch finish unavailable.');
  renderBusinessSummary(value);
  document.querySelector('#operation-id').textContent = id;
  csrf = session.csrfToken;
  previewHash = value.previewHash;
  challenge = value.challenge;
  mediaReview = value.mediaReview || null;
  currencyAcknowledgementRequired = value.currencyAcknowledgementRequired;
  currencyAck.checked = false;
  document.querySelector('#currency-warning').hidden = !currencyAcknowledgementRequired;
  document.querySelector('#currency-warning-text').textContent = value.currencyWarning || '';
  document.querySelector('#shop').textContent = visible(value.shopName);
  document.querySelector('#account').textContent = visible(value.accountName);
  document.querySelector('#client').textContent = visible(value.clientName);
  document.querySelector('#client-id').textContent = visible(value.clientId);
  document.querySelector('#tool').textContent = visible(value.toolName);
  document.querySelector('#target').textContent = visible(`${value.resourceType}: ${value.resourceId || 'new resource'}`);
  document.querySelector('#risk').textContent = value.risk;
  const expiryDate = new Date(value.expiresAt), expiryNode = document.querySelector('#expires');
  expiryNode.textContent = expiryDate.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' });
  expiryNode.title = `${expiryDate.toISOString()} (UTC)`;
  document.querySelector('#fingerprint').textContent = value.previewHash;
  document.querySelector('#proposal').textContent = visible(JSON.stringify(value.proposal, null, 2));
  reviewSection.hidden = false;
  earliestExpiry=Math.min(earliestExpiry,expiryDate.getTime());
  expiresAt = earliestExpiry;
  document.querySelector('#pending-state').textContent = 'Pending your decision — not applied';
  const last=batchIndex===operationIds.length-1;
  document.querySelector('#metadata-warning').hidden=!finishEnabled;
  document.querySelector('#metadata-ack').checked=false;
  document.querySelector('#approve').hidden=finishEnabled;
  document.querySelector('#approve-finish').hidden=!finishEnabled || !last;
  document.querySelector('#review-next').hidden=!finishEnabled || last;
  document.querySelector('#batch-progress').hidden=operationIds.length<2;
  document.querySelector('#batch-progress').textContent=`Review ${batchIndex+1} of ${operationIds.length}. Approval applies only to the exact reviewed content.`;
  if(finishEnabled)document.querySelector('#decision-help').textContent='Approve & Finish approves and applies this exact content, then checks the product. A changed or expired proposal stops for a new review.';
  scheduleExpiry(); updateReviewControls();
  reviewStatus('Review the complete proposal, then explicitly approve or reject it.');
  if (mediaReview) {
    document.querySelector('#media-review').hidden = false;
    document.querySelector('#media-warning').hidden = false; mediaAck.checked = false;
    if (!checkExpiry()) await loadMedia(value.toolName, value.proposal, value.resourceId, value.resourceType, value.risk)
      .catch(() => { reviewStatus('Image verification failed. Reload this review or reject the proposal.'); });
  }
}

const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value)
  ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
async function mediaPost(action, item, extra = {}, signal) {
  if (checkExpiry()) throw new Error('Proposal expired.');
  return fetch(`${base}/api/v1/seller/mcp/operations/${id}/media/${action}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ operationId: id, previewHash, challenge,
      kind: item.kind, itemKey: item.itemKey, ...extra }), signal });
}
async function receiveMedia(item, signal) {
  const response = await mediaPost('delivery', item, {}, signal);
  if (!response.ok || response.headers.get('x-media-sha256') !== item.hash || response.headers.get('x-media-manifest') !== mediaReview.descriptor.manifestRoot ||
      response.headers.get('x-media-item') !== item.kind + ':' + item.itemKey) throw new Error('Image delivery failed.');
  const nonce = response.headers.get('x-media-nonce'), bytes = await response.arrayBuffer();
  if ((!/^[A-Za-z0-9_-]{43}$/.test(nonce || '') && !(reviewedImages.has(item.itemKey) && response.headers.get('x-media-acknowledged') === 'true')) ||
      bytes.byteLength > (item.kind === 'PAGE' ? 16384 : 524288) || await sha256(bytes) !== item.hash) throw new Error('Image checksum failed.');
  return { bytes, nonce, mime: response.headers.get('content-type') };
}
async function acknowledgeMedia(item, nonce) {
  const response = await mediaPost('ack', item, { expectedHash: item.hash, nonce });
  if (!response.ok) throw new Error('Image confirmation failed.');
  const result = await response.json();
  if (result.operationId !== id || result.itemKey !== item.itemKey || result.kind !== item.kind || result.acknowledged !== true) throw new Error('Image confirmation failed.');
}
async function loadMedia(toolName, proposal, resourceId, resourceType, risk) {
  const { descriptor, items, labels } = mediaReview;
  const catalog = descriptor?.policyId === 'catalog-media-v1';
  const create = catalog && toolName === 'catalog.preview_create', parent=create&&Object.hasOwn(proposal,'creationMedia');
  if(parent)catalogParentImages(proposal.creationMedia);
  if (catalog) {
    const binding = proposal.reviewBinding;
    const identity = create ? catalogCreationIdentity(proposal.creationIdentity) : null;
    const preimage = create ? {version:2,kind:'catalog-media-create',resourceType:'catalog',resourceId:'catalog',creationIdentity:identity,
      baseRevision:binding?.baseRevision,reviewProjectionHash:binding?.reviewProjectionHash} :
      {version:2,kind:'catalog-media-update',productId:resourceId,baseRevision:binding?.baseRevision,reviewProjectionHash:binding?.reviewProjectionHash};
    if (!exactKeys(binding, ['version','baseRevision','reviewProjectionHash']) || binding.version !== 1 ||
        (create ? resourceId !== 'catalog' || resourceType !== 'catalog' || risk !== 'HIGH' : !idPattern.test(resourceId || '')) || ![binding.baseRevision,binding.reviewProjectionHash].every(value => hashPattern.test(value || '')) ||
        new TextEncoder().encode(canonical(proposal)).length > 49152 ||
        await sha256(new TextEncoder().encode(canonical(preimage))) !== descriptor.graphRevision) throw new Error('Invalid catalog revision binding.');
  }
  if (!descriptor || (catalog ? !['catalog.preview_update','catalog.preview_create'].includes(toolName) : !['media-upload-v1', 'media-layout-v1'].includes(descriptor.policyId)) ||
      ![descriptor.manifestRoot, descriptor.graphRevision, descriptor.codecDigest].every(value => hashPattern.test(value || '')) ||
      !Number.isInteger(descriptor.pageCount) || descriptor.pageCount < 1 || descriptor.pageCount > 16 ||
      !Number.isInteger(descriptor.assetCount) || descriptor.assetCount < 0 || descriptor.assetCount > 42 ||
      !Number.isInteger(descriptor.effectCount) || descriptor.effectCount < 1 || descriptor.effectCount + descriptor.assetCount > 512 ||
      !Array.isArray(items) || items.length !== descriptor.pageCount + descriptor.assetCount || !Array.isArray(labels) || labels.length > 300) throw new Error('Invalid image manifest.');
  const identities = new Set();
  for (const item of items) {
    if (!['PAGE', 'ASSET'].includes(item.kind) || !hashPattern.test(item.hash || '') ||
        (item.kind === 'PAGE' ? item.itemKey !== String(item.pageIndex) || item.assetKey !== null : item.itemKey !== item.assetKey || item.pageIndex !== null || !hashPattern.test(item.assetKey || '')) ||
        identities.has(item.kind + ':' + item.itemKey)) throw new Error('Invalid image identity.');
    identities.add(item.kind + ':' + item.itemKey);
  }
  const pages = items.filter(item => item.kind === 'PAGE').sort((a, b) => a.pageIndex - b.pageIndex), records = [], pageDigests = [];
  if (pages.length !== descriptor.pageCount) throw new Error('Incomplete image pages.');
  let header;
  for (const [index, item] of pages.entries()) {
    const packet = await receiveMedia(item), text = new TextDecoder('utf-8', { fatal: true }).decode(packet.bytes), body = JSON.parse(text);
    if (canonical(body) !== text || Object.keys(body).sort().join(',') !== 'codecDigest,graphBytes,graphRevision,pageIndex,records,toolName,version' ||
        item.pageIndex !== index || body.pageIndex !== index || body.version !== (parent?2:1) || body.toolName !== toolName || body.graphRevision !== descriptor.graphRevision ||
        body.codecDigest !== descriptor.codecDigest || !Array.isArray(body.records) || body.records.length < 1 || body.records.length > 32) throw new Error('Invalid image page.');
    const common = canonical({ version:body.version,graphBytes: body.graphBytes, graphRevision: body.graphRevision, codecDigest: body.codecDigest, toolName: body.toolName });
    if (header && header !== common) throw new Error('Mismatched image page.'); header = common;
    records.push(...body.records); if (records.length > 512) throw new Error('Image graph too large.');
    pageDigests.push({ index, hash: item.hash, recordCount: body.records.length });
    await acknowledgeMedia(item, packet.nonce);
  }
  const common = JSON.parse(header), root = { version: common.version, policyId: descriptor.policyId, codecDigest: descriptor.codecDigest,
    graphRevision: descriptor.graphRevision, graphBytes: common.graphBytes, pages: pageDigests, assetCount: descriptor.assetCount, effectCount: descriptor.effectCount };
  if (await sha256(new TextEncoder().encode(canonical(root))) !== descriptor.manifestRoot) throw new Error('Image manifest root failed.');
  const assets = records.filter(value => value.kind === 'ASSET'), effects = records.filter(value => ['PRODUCT', 'LISTING'].includes(value.kind));
  if (assets.length !== descriptor.assetCount || effects.length !== descriptor.effectCount || assets.length + effects.length !== records.length) throw new Error('Incomplete image effects.');
  if (catalog && !parent && (common.graphBytes?.newBytes !== 0 || assets.some(asset => !['PRODUCT_MAIN','GALLERY'].includes(asset.source_kind) ||
      !Array.isArray(asset.stage_refs) || asset.stage_refs.length !== 0))) throw new Error('Invalid catalog image source.');
  mediaReview.assets = new Map(assets.map(value => [value.asset_key, value]));
  mediaReview.assetItems = items.filter(value => value.kind === 'ASSET');
  if (mediaReview.assets.size !== assets.length || mediaReview.assetItems.length !== assets.length) throw new Error('Duplicate image.');
  for (const item of mediaReview.assetItems) {
    const asset = mediaReview.assets.get(item.assetKey);
    if (!asset || asset.byte_sha256 !== item.hash || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime) ||
        !Number.isInteger(asset.byte_length) || asset.byte_length < 1 || asset.byte_length > 524288 ||
        await sha256(new TextEncoder().encode(canonical({ mime: asset.mime, byteSha256: asset.byte_sha256 }))) !== item.assetKey) throw new Error('Invalid image asset.');
  }
  if (catalog) renderCatalogMediaEffects(effects, proposal.reviewLabels, create ? proposal : null);
  else renderMediaEffects(effects, labels);
  const empty = mediaReview.assetItems.length === 0;
  document.querySelector('#media-viewer').hidden = empty;
  document.querySelector('#media-empty').hidden = !empty;
  updateMediaProgress();
  if (mediaReview.assetItems.length) await showMediaImage(mediaReview.assetItems[0]);
}
function updateMediaProgress() {
  mediaComplete = reviewedImages.size === mediaReview.assetItems.length;
  document.querySelector('#media-progress').textContent = `${reviewedImages.size} of ${mediaReview.assetItems.length} unique exact images reviewed. All ordered before and after effects are shown below.`;
  updateReviewControls();
}
function releaseMediaImage() {
  if (imageJob) imageJob.abort(); imageJob = null;
  imageNode.hidden = true; imageNode.removeAttribute('src');
  if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null;
  selectedImage = null; imageAck.disabled = true;
  document.querySelector('#media-image-details').textContent = '';
}
async function showMediaImage(item) {
  if (checkExpiry() || decisionPending || !csrf) return;
  releaseMediaImage();
  retryImage = item; imageRetry.hidden = true;
  imageStatus.textContent = 'Loading and verifying the exact image…';
  const job = new AbortController(); imageJob = job;
  try {
    const packet = await receiveMedia(item, job.signal), asset = mediaReview.assets.get(item.assetKey);
    if (job.signal.aborted || checkExpiry()) return;
    if (!asset || packet.mime !== asset.mime || packet.bytes.byteLength !== asset.byte_length) throw new Error('Image type failed.');
    imageUrl = URL.createObjectURL(new Blob([packet.bytes], { type: asset.mime })); imageNode.src = imageUrl;
    await imageNode.decode();
    if (job.signal.aborted || checkExpiry()) return;
    imageNode.hidden = false;
    document.querySelector('#media-image-details').textContent = `${asset.mime} · ${asset.byte_length} bytes · SHA256 ${item.hash}`;
    selectedImage = { item, nonce: packet.nonce }; updateReviewControls();
    imageStatus.textContent = reviewedImages.has(item.itemKey)
      ? 'Exact image verified and already reviewed.' : 'Exact image verified. Inspect it, then confirm below.';
    if (statusNode.textContent.startsWith('Image verification failed')) {
      reviewStatus('Review the complete proposal, then explicitly approve or reject it.');
    }
  } catch {
    if (job.signal.aborted || checkExpiry()) return;
    releaseMediaImage();
    imageStatus.textContent = 'Image verification failed. This image cannot be acknowledged. Retry to load and verify it again.';
    reviewStatus('Image verification failed. Retry the image, reload this review or reject the proposal.');
    imageRetry.hidden = false;
  }
}
imageRetry.addEventListener('click', () => { if (retryImage) void showMediaImage(retryImage); });
function renderMediaEffects(effects, labels) {
  const names = new Map();
  for (const label of labels) {
    if (!idPattern.test(label.productId || '') || typeof label.sku !== 'string' || typeof label.name !== 'string' || names.has(label.productId)) throw new Error('Invalid image labels.');
    names.set(label.productId, visible(`${label.sku} · ${label.name} (${label.productId})`));
  }
  const root = document.querySelector('#media-effects'); root.replaceChildren();
  function reference(key) {
    if (key === null) return document.createTextNode('No own main image');
    const item = mediaReview.assetItems.find(value => value.assetKey === key); if (!item) throw new Error('Missing image reference.');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'media-reference'; button.textContent = key;
    button.addEventListener('click', () => showMediaImage(item).catch(() => { reviewStatus('Image unavailable. Reload the review.'); })); return button;
  }
  for (const effect of effects) {
    const article = document.createElement('article'), heading = document.createElement('h3');
    if (effect.kind === 'PRODUCT' && !names.has(effect.productId)) throw new Error('Missing product label.');
    heading.textContent = effect.kind === 'PRODUCT' ? names.get(effect.productId) : `Shared listing ${effect.listingId}`; article.append(heading);
    for (const side of ['before', 'after']) {
      const state = effect[side], line = document.createElement('div'); line.className = 'media-state';
      const title = document.createElement('strong'); title.textContent = side === 'before' ? 'Before' : 'After'; line.append(title);
      const detail = document.createElement('div');
      if (effect.kind === 'PRODUCT') {
        const role = document.createElement('p'); role.textContent = `Role: ${state.role}; listing: ${state.listingId}; own main:`; detail.append(role, reference(state.mainAssetKey));
      } else {
        const holder = document.createElement('p'); holder.textContent = state.holderId ? `Gallery holder: ${names.get(state.holderId) || state.holderId}` : 'Single-product gallery'; detail.append(holder);
        const ordered = document.createElement('ol');
        for (const key of state.galleryAssetKeys) { const item = document.createElement('li'); item.append(reference(key)); ordered.append(item); }
        detail.append(ordered); if (!state.galleryAssetKeys.length) detail.append(document.createTextNode('Empty gallery'));
      }
      line.append(detail); article.append(line);
    }
    root.append(article);
  }
}

const exactKeys = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function catalogCreationIdentity(value) {
  if (!exactKeys(value,['version','productId','targetCode','targetListingId','newListingId']) || value.version !== 1 || !idPattern.test(value.productId || '') ||
      !(value.targetCode === null || typeof value.targetCode === 'string' && /^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(value.targetCode)) ||
      (value.targetListingId === null ? !idPattern.test(value.newListingId || '') : !idPattern.test(value.targetListingId || '') || value.newListingId !== null || value.targetCode === null)) throw new Error('Invalid creation identity.');
  return value;
}
function catalogCreateOptions(proposal) {
  const options = proposal.after?.options, review = proposal.optionReview;
  if (!exactKeys(review,['before','after']) || !Array.isArray(review.before) || review.before.length !== 0 || !Array.isArray(options) || options.length > 6 ||
      !Array.isArray(review.after) || review.after.length !== options.length) throw new Error('Invalid creation options.');
  const pairs = [], seen = new Set();
  for (const row of review.after) {
    if (!exactKeys(row,['typeId','valueId','typeName','typeCode','valueLabel','valueCode','typeActive','valueActive']) || !idPattern.test(row.typeId || '') || !idPattern.test(row.valueId || '') ||
        seen.has(row.typeId) || typeof row.typeActive !== 'boolean' || typeof row.valueActive !== 'boolean') throw new Error('Invalid creation option.');
    for (const [key,max] of [['typeName',60],['typeCode',60],['valueLabel',80],['valueCode',60]]) if (typeof row[key] !== 'string' || !row[key].isWellFormed() || row[key].length > max) throw new Error('Invalid literal option.');
    seen.add(row.typeId); pairs.push({typeId:row.typeId,valueId:row.valueId});
  }
  if (canonical(pairs) !== canonical(options)) throw new Error('Mismatched creation options.');
  return review.after;
}
function catalogLabels(rows, create = false) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 300 || new TextEncoder().encode(canonical(rows)).length > 49152) throw new Error('Invalid catalog labels.');
  const names = new Map(); let last = '';
  for (const row of rows) {
    if (!exactKeys(row, ['productId','before','after']) || !idPattern.test(row.productId || '') || row.productId <= last) throw new Error('Invalid catalog label identity.');
    for (const side of ['before','after']) {
      const label = row[side];
      if (create && side === 'before' && label === null) continue;
      if (!exactKeys(label,['sku','name']) || typeof label.sku !== 'string' || !label.sku.isWellFormed() || label.sku.length > 40 ||
          typeof label.name !== 'string' || !label.name.isWellFormed() || label.name.length > 120) throw new Error('Invalid literal label.');
    }
    names.set(row.productId, row); last = row.productId;
  }
  return names;
}
function catalogParentImages(value){
  if(!exactKeys(value,['version','draftId','intentHash','images'])||value.version!==1||!idPattern.test(value.draftId||'')||!hashPattern.test(value.intentHash||'')||!Array.isArray(value.images)||value.images.length<1||value.images.length>10)throw new Error('Invalid creation image binding.');
  const seen=new Set(),hashes=new Set();for(const [position,row]of value.images.entries()){
    if(!exactKeys(row,['stageId','productId','targetSlot','sourceSha256','canonicalSha256','thumbnailSha256','mime','byteLength','thumbnailBytes','width','height'])||!idPattern.test(row.stageId||'')||!idPattern.test(row.productId||'')||seen.has(row.stageId)||hashes.has(row.canonicalSha256)||row.targetSlot!==(position===0?'MAIN':'GALLERY')||![row.sourceSha256,row.canonicalSha256,row.thumbnailSha256].every(item=>hashPattern.test(item||''))||!['image/png','image/jpeg','image/webp'].includes(row.mime)||![row.byteLength,row.thumbnailBytes,row.width,row.height].every(Number.isInteger)||row.byteLength<1||row.byteLength>524288||row.thumbnailBytes<1||row.thumbnailBytes>81920||row.width<1||row.height<1||row.width>8192||row.height>8192||row.width*row.height>4194304)throw new Error('Invalid creation image.');seen.add(row.stageId);hashes.add(row.canonicalSha256);
  }return value.images;
}
function assertCatalogParentImages(proposal,products,listing,owners){
  const images=catalogParentImages(proposal.creationMedia),assets=[...mediaReview.assets.values()],refs=assets.flatMap(asset=>{if(!Array.isArray(asset.stage_refs))throw new Error('Invalid creation stages.');return asset.stage_refs.map(ref=>({asset,ref}));});
  if(refs.length!==images.length)throw new Error('Incomplete creation stages.');
  const fresh=products.find(row=>row.before===null),ordered=[];
  for(const [position,image]of images.entries()){
    const matches=refs.filter(({asset,ref})=>exactKeys(ref,['stage_id','source_product_id','canonical_sha256'])&&ref.stage_id===image.stageId&&ref.source_product_id===image.productId&&ref.canonical_sha256===image.canonicalSha256&&asset.byte_sha256===image.canonicalSha256&&asset.mime===image.mime&&asset.byte_length===image.byteLength);
    if(matches.length!==1)throw new Error('Mismatched creation image.');const key=matches[0].asset.asset_key;
    if(position===0?image.productId!==fresh.productId||fresh.after.mainAssetKey!==key||!fresh.after.ownMainVisible:image.productId!==(listing.after.holderId??fresh.productId))throw new Error('Invalid creation image owner.');if(position)ordered.push(key);
  }
  if(ordered.length&&canonical(listing.after.galleryAssetKeys.slice(-ordered.length))!==canonical(ordered))throw new Error('Mismatched creation gallery order.');
  for(const asset of assets){if(asset.source_kind==='STAGE'){if(!images.some(image=>asset.stage_id===image.stageId&&asset.source_id===image.stageId&&asset.source_product_id===image.productId&&asset.byte_sha256===image.canonicalSha256))throw new Error('Invalid draft image source.');}else if(!['PRODUCT_MAIN','GALLERY'].includes(asset.source_kind)||asset.stage_id!==null||!owners.has(asset.source_product_id))throw new Error('Invalid inherited image owner.');}
}
function renderCatalogMediaEffects(effects, labels, creationProposal = null) {
  const identity = creationProposal ? catalogCreationIdentity(creationProposal.creationIdentity) : null,parent=identity&&Object.hasOwn(creationProposal,'creationMedia');
  const names = catalogLabels(labels, Boolean(identity)), listings = new Map(), seen = new Set();
  for (const effect of effects) {
    if (!idPattern.test(effect.productId || effect.listingId || '')) throw new Error('Invalid catalog image identity.');
    if (effect.kind === 'LISTING') {
      if (!exactKeys(effect,['kind','listingId','before','after']) || listings.has(effect.listingId) || effect.before === null && effect.after === null) throw new Error('Invalid listing effect.');
      for (const side of ['before','after']) {
        const state = effect[side]; if (state === null) continue;
        if (!exactKeys(state,['holderId','galleryAssetKeys']) || !(state.holderId === null || idPattern.test(state.holderId || '')) ||
            !Array.isArray(state.galleryAssetKeys) || state.galleryAssetKeys.length > 10 || !state.galleryAssetKeys.every(key => hashPattern.test(key || ''))) throw new Error('Invalid listing state.');
      }
      listings.set(effect.listingId,effect);
    } else {
      if (!exactKeys(effect,['kind','productId','before','after','labels']) || seen.has(effect.productId) || !names.has(effect.productId) ||
          canonical(effect.labels) !== canonical({before:names.get(effect.productId).before,after:names.get(effect.productId).after})) throw new Error('Mismatched catalog labels.');
      for (const side of ['before','after']) {
        const state = effect[side];
        if (identity && side === 'before' && state === null && effect.productId === identity.productId && effect.labels.before === null) continue;
        if (!exactKeys(state,['listingId','role','mainAssetKey','ownMainVisible']) || !idPattern.test(state.listingId || '') ||
            !['single','holder','variant'].includes(state.role) || !(state.mainAssetKey === null || hashPattern.test(state.mainAssetKey || '')) ||
            typeof state.ownMainVisible !== 'boolean' || state.mainAssetKey === null && state.ownMainVisible) throw new Error('Invalid catalog product state.');
      }
      seen.add(effect.productId);
    }
  }
  if (seen.size !== names.size) throw new Error('Incomplete catalog labels.');
  if (identity) {
    const products = effects.filter(row => row.kind === 'PRODUCT'), fresh = products.find(row => row.productId === identity.productId), listing = [...listings.values()][0], after = creationProposal.after;
    if (listings.size !== 1 || !fresh || fresh.before !== null || fresh.labels.before !== null || !parent&&(fresh.after.mainAssetKey !== null || fresh.after.ownMainVisible !== false) ||
        !listing?.after || listing.listingId !== (identity.targetListingId ?? identity.newListingId) || (listing.before === null) !== (identity.targetListingId === null) ||
        creationProposal.before !== null || !after || after.id !== identity.productId || after.listingId !== listing.listingId || canonical({sku:after.sku,name:after.name}) !== canonical(fresh.labels.after)) throw new Error('Invalid CREATE effects.');
    for (const product of products) if (product.after.listingId !== listing.listingId || product !== fresh && (!product.before || product.before.listingId !== listing.listingId ||
        product.before.mainAssetKey !== product.after.mainAssetKey || canonical(product.labels.before) !== canonical(product.labels.after))) throw new Error('Unsupported existing-product change.');
    if (listing.before === null ? products.length !== 1 || fresh.after.role !== 'single' || listing.after.holderId !== null || !parent&&listing.after.galleryAssetKeys.length !== 0 : products.length < 2) throw new Error('Invalid CREATE membership.');
    const owners = new Set(products.filter(row => row.before !== null).map(row => row.productId));
    if (!parent&&[...mediaReview.assets.values()].some(row => row.stage_id !== null || !owners.has(row.source_product_id))) throw new Error('Invalid CREATE source owner.');
    catalogCreateOptions(creationProposal);if(parent)assertCatalogParentImages(creationProposal,products,listing,owners);
  }
  renderCatalogStates(effects,names,listings,creationProposal);
}
function renderCatalogStates(effects, names, listings, creationProposal = null) {
  const root = document.querySelector('#media-effects'); root.replaceChildren();
  const labelText = label => visible(`${label.sku} · ${label.name}`);
  function reference(key) {
    const item = mediaReview.assetItems.find(value => value.assetKey === key);
    if (!item) throw new Error('Missing catalog image reference.');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'media-reference'; button.textContent = key;
    button.addEventListener('click', () => showMediaImage(item).catch(() => { reviewStatus('Image unavailable. Reload the review.'); })); return button;
  }
  function ordered(keys) {
    if (keys.length > 11) throw new Error('Catalog visible gallery too large.');
    const list = document.createElement('ol'); list.className = 'media-visible-gallery';
    for (const key of keys) { const item = document.createElement('li'); item.append(reference(key)); list.append(item); }
    return list;
  }
  for (const effect of effects) {
    const article = document.createElement('article'), heading = document.createElement('h3');
    heading.textContent = effect.kind === 'PRODUCT' ? `Product ${effect.productId}` : `Shared listing ${effect.listingId}`; article.append(heading);
    for (const side of ['before','after']) {
      const state = effect[side], line = document.createElement('div'); line.className = 'media-state';
      const title = document.createElement('strong'); title.textContent = side === 'before' ? 'Before' : 'After'; line.append(title);
      const detail = document.createElement('div');
      if (state === null) {
        if (effect.kind !== 'LISTING' && !(creationProposal && side === 'before' && effect.productId === creationProposal.creationIdentity.productId)) throw new Error('Invalid absent product.');
        detail.textContent = effect.kind === 'PRODUCT' ? 'Not yet created.' : side === 'before' ? 'Did not exist before this change.' : 'Removed by this change.';
      } else if (effect.kind === 'PRODUCT') {
        const literal = document.createElement('p'); literal.textContent = labelText(names.get(effect.productId)[side]); detail.append(literal);
        if (creationProposal && side === 'after' && effect.productId === creationProposal.creationIdentity.productId) {
          const options = document.createElement('p'), rows = catalogCreateOptions(creationProposal);
          options.textContent = rows.length ? visible('Options: ' + rows.map(row => `${row.typeName}: ${row.valueLabel}`).join('; ')) : 'Options: none'; detail.append(options);
        }
        const role = document.createElement('p'); role.textContent = `Role: ${state.role}; listing: ${state.listingId}`; detail.append(role);
        const stored = document.createElement('p'); stored.textContent = state.mainAssetKey === null ? 'No stored own main image.' : 'Stored own main image: '; if (state.mainAssetKey !== null) stored.append(reference(state.mainAssetKey)); detail.append(stored);
        const visibility = document.createElement('p'); visibility.textContent = state.ownMainVisible ? 'Own main is visible in the shopper gallery.' : state.mainAssetKey === null ? 'Own main is absent.' : 'Stored own main is hidden in the shopper gallery.'; detail.append(visibility);
        const listing = listings.get(state.listingId)?.[side]; if (!listing) throw new Error('Missing catalog listing state.');
        if (state.role === 'single' && state.ownMainVisible && !listing.galleryAssetKeys.includes(state.mainAssetKey)) throw new Error('Missing visible own main.');
        detail.append(document.createTextNode('Shopper gallery in order:'),ordered(state.role === 'single' ? listing.galleryAssetKeys : [...(state.ownMainVisible ? [state.mainAssetKey] : []),...listing.galleryAssetKeys]));
      } else {
        const holder = document.createElement('p');
        if (state.holderId !== null && !names.has(state.holderId)) throw new Error('Missing holder label.');
        holder.textContent = state.holderId === null ? 'Single-product gallery' : `Gallery holder: ${labelText(names.get(state.holderId)[side])} (${state.holderId})`;
        detail.append(holder,ordered(state.galleryAssetKeys)); if (!state.galleryAssetKeys.length) detail.append(document.createTextNode('Empty gallery'));
      }
      line.append(detail); article.append(line);
    }
    root.append(article);
  }
}
imageAck.addEventListener('click', async () => {
  if (checkExpiry() || decisionPending || !selectedImage || imageAck.disabled) return;
  const current = selectedImage; imageAck.disabled = true;
  try {
    await acknowledgeMedia(current.item, current.nonce); reviewedImages.add(current.item.itemKey); updateMediaProgress();
    if (checkExpiry()) return;
    if (selectedImage === current) imageStatus.textContent = 'Exact image verified and reviewed.';
    const next = mediaReview.assetItems.find(item => !reviewedImages.has(item.itemKey)); if (next) await showMediaImage(next);
  } catch { reviewStatus('Image confirmation failed. Reload this review or reject the proposal.'); }
});
window.addEventListener('pagehide', releaseMediaImage);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (checkExpiry() || decisionPending) return;
  const decision = event.submitter?.value;
  if (!csrf || !previewHash || !challenge || !['approve', 'reject'].includes(decision)) return;
  if (decision === 'approve' && mediaReview && (!mediaComplete || !mediaAck.checked)) {
    statusNode.textContent = 'Review every exact image and check the image acknowledgment before approving.';
    mediaAck.focus(); return;
  }
  if (decision === 'approve' && currencyAcknowledgementRequired && !currencyAck.checked) {
    statusNode.textContent = 'Read the currency warning and check the acknowledgment before approving.';
    currencyAck.focus(); return;
  }
  decisionPending = true; updateReviewControls();
  try {
    const response = await fetch(`${base}/api/v1/seller/mcp/operations/${id}/approval`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ operationId: id, previewHash, challenge, decision,
        ...(currencyAcknowledgementRequired && decision === 'approve' ? { currencyAcknowledged: true } : {}),
        ...(mediaReview && decision === 'approve' ? { mediaReviewed: true } : {}),
      }),
    });
    if (!response.ok) throw new Error('Approval failed.');
    const result = await response.json();
    if (result.operationId !== id || result.status !== (decision === 'approve' ? 'APPROVED' : 'REJECTED')) throw new Error('Invalid result.');
    csrf = null; previewHash = null; challenge = null; form.hidden = true; releaseMediaImage();
    clearTimeout(expiryTimer); expiryTimer = null; expiresAt = null;
    document.querySelector('#pending-state').textContent = decision === 'approve' ? 'Approved — app commit still required' : 'Rejected — not applied';
    statusNode.textContent = decision === 'approve' ? 'Approved. The connected app must still commit this change.' : 'Rejected. The change was not applied.';
  } catch {
    reviewStatus('The decision could not be verified. Reload the proposal and try again.');
  } finally {
    decisionPending = false; updateReviewControls();
  }
});

load().catch(error => {
  reviewSection.hidden = true;
  statusNode.textContent = error.message === 'Sign in required.'
    ? 'Sign in to Seller Studio to review this proposal. No change has been approved.'
    : 'The proposal is unavailable. Ask the connected app to prepare a new preview.';
});

function reviewedProof(){
  if(checkExpiry() || !csrf || !previewHash || !challenge || !document.querySelector('#metadata-ack').checked ||
    mediaReview && (!mediaComplete || !mediaAck.checked)) {
    reviewStatus('Review all metadata and exact images, then check both acknowledgments.');return null;
  }
  return {operationId:id,previewHash,challenge,...(mediaReview?{mediaReviewed:true}:{})};
}
async function finishPost(suffix,input){
  const response=await fetch(`${base}/api/v1/seller/mcp/finishes${suffix}`,{method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(input)});
  if(!response.ok)throw new Error('Finish unavailable.');return response.json();
}
function showFinish(value){
  if(value.jobId!==finishJob || !Array.isArray(value.items))throw new Error('Invalid progress.');
  reviewSection.hidden=true;form.hidden=true;document.querySelector('#finish-progress').hidden=false;
  document.querySelector('#finish-summary').textContent=`${value.completed} of ${value.total} verified. ${value.status==='FINISHED'?'Finished.':value.status==='PARTIAL'?'Some items need a new review.':'Work is saved. Resume to continue.'}`;
  const list=document.querySelector('#finish-items');list.replaceChildren();
  for(const item of value.items){
    const line=document.createElement('li');line.textContent=`${item.operationId}: ${item.state}${item.error?' — '+item.error:''}`;
    if(item.receipt?.productId){const link=document.createElement('a');link.href=`${base}/seller/`;link.textContent=' Open Seller Studio';line.append(link);}
    if(item.state==='NEEDS_REVIEW'){
      const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='Revalidate and review again';
      button.addEventListener('click',async()=>{button.disabled=true;try{
        const result=await finishPost(`/${finishJob}/revalidate`,{operationId:item.operationId,idempotencyKey:`finish-revalidate-${finishJob}-${item.operationId}`});
        // A new review link cannot inherit old approval or image acknowledgments.
        location.assign(result.reviewUrl);
      }catch{statusNode.textContent='Fresh staging or a new proposal is required. No changed content was approved.';button.disabled=false;}});line.append(button);
    }
    list.append(line);
  }
  document.querySelector('#finish-resume').hidden=value.status==='FINISHED';
  statusNode.textContent=value.status==='FINISHED'?'Approved changes committed and verified.':'Progress saved. Items needing review will not be committed automatically.';
  clearTimeout(expiryTimer);expiresAt=null;releaseMediaImage();
}
document.querySelector('#review-next').addEventListener('click',async()=>{
  if(decisionPending)return;const proof=reviewedProof();if(!proof)return;
  reviewedProposals.push(proof);
  const line=document.createElement('li');line.textContent=document.querySelector('#summary-fields').textContent || document.querySelector('#operation-heading').textContent;
  document.querySelector('#batch-reviewed').append(line);document.querySelector('#batch-reviewed').hidden=false;
  releaseMediaImage();reviewedImages.clear();mediaComplete=false;mediaReview=null;selectedImage=null;retryImage=null;
  document.querySelector('#media-review').hidden=true;document.querySelector('#media-warning').hidden=true;
  batchIndex++;id=operationIds[batchIndex];decisionPending=true;
  try{await load();}catch{reviewSection.hidden=true;statusNode.textContent='The next proposal is unavailable. Prepare a fresh review; no approval was made.';}
  finally{decisionPending=false;updateReviewControls();}
});
document.querySelector('#approve-finish').addEventListener('click',async()=>{
  if(!finishEnabled || decisionPending)return;const proof=reviewedProof();if(!proof)return;
  decisionPending=true;updateReviewControls();
  try{
    const items=[...reviewedProposals,proof];
    const job=finishJob?{jobId:finishJob}:await finishPost('',{items:items.map(({operationId,previewHash})=>({operationId,previewHash})),idempotencyKey:`finish-${await sha256(new TextEncoder().encode(operationIds.join(',')))}`});
    finishJob=job.jobId;try{sessionStorage.setItem(finishKey,finishJob);}catch{/* Server progress remains durable. */}
    const pending=finishPost(`/${finishJob}/approve`,{items});
    statusNode.textContent='Approving and applying the reviewed content. Progress is saved.';
    let stopped=false;
    const poll=async()=>{if(stopped)return;try{const response=await fetch(`${base}/api/v1/seller/mcp/finishes/${finishJob}`,{credentials:'same-origin',cache:'no-store'});
      if(response.ok){const value=await response.json();if(stopped)return;document.querySelector('#finish-progress').hidden=false;
        document.querySelector('#finish-summary').textContent=`${value.completed} of ${value.total} verified. Applying reviewed content…`;}
      }catch{/* A failed progress read is not a failed commit. */}if(!stopped)setTimeout(poll,1000);};
    void poll();
    try{const result=await pending;showFinish(result);}finally{stopped=true;}
  }catch{statusNode.textContent='The result could not be confirmed. Reload to inspect saved progress. No retry approves changed content.';}
  finally{decisionPending=false;updateReviewControls();}
});
document.querySelector('#finish-resume').addEventListener('click',async event=>{
  event.currentTarget.disabled=true;
  try{showFinish(await finishPost(`/${finishJob}/resume`,{}));}catch{statusNode.textContent='Resume is unavailable. Sign in again or request a fresh review if approval expired.';}
  finally{event.currentTarget.disabled=false;}
});
