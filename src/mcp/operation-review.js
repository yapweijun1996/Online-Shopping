'use strict';

// First-party seller UI. All proposal
// content is untrusted and is rendered only as text.
const statusNode = document.querySelector('#status');
const reviewSection = document.querySelector('#review');
const form = document.querySelector('#decision');
const password = document.querySelector('#password');
const path = /^\/(?:([a-z0-9]{3,30})\/)?oauth\/operation\/?$/.exec(location.pathname);
const base = path?.[1] ? `/${path[1]}` : '';
const id = new URL(location.href).searchParams.get('operationId');
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
const visible = (value) => value.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
  (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);

async function load() {
  const params = new URL(location.href).searchParams;
  if (!path || [...params.keys()].some(key => !['operationId', 'utm_source'].includes(key)) ||
      params.getAll('operationId').length !== 1 || !idPattern.test(id || '') || params.getAll('utm_source').length > 1 ||
      (params.has('utm_source') && !/^[A-Za-z0-9._~-]{1,128}$/.test(params.get('utm_source')))) throw new Error('Invalid operation.');
  const sessionResponse = await fetch(`${base}/api/v1/seller/session`, { credentials: 'same-origin', cache: 'no-store' });
  if (sessionResponse.status === 401) {
    const link = document.querySelector('#seller-link');
    link.href = `${base}/seller/?reviewOperation=${id}`;
    link.textContent = 'Sign in to review this proposal';
    throw new Error('Sign in required.');
  }
  if (!sessionResponse.ok) throw new Error('Sign in required.');
  const session = await sessionResponse.json();
  if (typeof session.csrfToken !== 'string' || !session.csrfToken) throw new Error('Invalid session.');
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
      typeof value.expiresAt !== 'string' || !value.proposal || typeof value.proposal !== 'object' || Array.isArray(value.proposal)) {
    throw new Error('Invalid proposal.');
  }
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
  document.querySelector('#expires').textContent = value.expiresAt;
  document.querySelector('#fingerprint').textContent = value.previewHash;
  document.querySelector('#proposal').textContent = visible(JSON.stringify(value.proposal, null, 2));
  reviewSection.hidden = false;
  statusNode.textContent = 'Review the complete proposal, then explicitly approve or reject it.';
  if (mediaReview) {
    document.querySelector('#approve').disabled = true;
    document.querySelector('#media-review').hidden = false;
    document.querySelector('#media-warning').hidden = false; mediaAck.checked = false;
    await loadMedia(value.toolName, value.proposal, value.resourceId, value.resourceType, value.risk).catch(() => { statusNode.textContent = 'Image verification failed. Reload this review or reject the proposal.'; });
  }
}

const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value)
  ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
async function mediaPost(action, item, extra = {}, signal) {
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
  const create = catalog && toolName === 'catalog.preview_create';
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
        item.pageIndex !== index || body.pageIndex !== index || body.version !== 1 || body.toolName !== toolName || body.graphRevision !== descriptor.graphRevision ||
        body.codecDigest !== descriptor.codecDigest || !Array.isArray(body.records) || body.records.length < 1 || body.records.length > 32) throw new Error('Invalid image page.');
    const common = canonical({ graphBytes: body.graphBytes, graphRevision: body.graphRevision, codecDigest: body.codecDigest, toolName: body.toolName });
    if (header && header !== common) throw new Error('Mismatched image page.'); header = common;
    records.push(...body.records); if (records.length > 512) throw new Error('Image graph too large.');
    pageDigests.push({ index, hash: item.hash, recordCount: body.records.length });
    await acknowledgeMedia(item, packet.nonce);
  }
  const common = JSON.parse(header), root = { version: 1, policyId: descriptor.policyId, codecDigest: descriptor.codecDigest,
    graphRevision: descriptor.graphRevision, graphBytes: common.graphBytes, pages: pageDigests, assetCount: descriptor.assetCount, effectCount: descriptor.effectCount };
  if (await sha256(new TextEncoder().encode(canonical(root))) !== descriptor.manifestRoot) throw new Error('Image manifest root failed.');
  const assets = records.filter(value => value.kind === 'ASSET'), effects = records.filter(value => ['PRODUCT', 'LISTING'].includes(value.kind));
  if (assets.length !== descriptor.assetCount || effects.length !== descriptor.effectCount || assets.length + effects.length !== records.length) throw new Error('Incomplete image effects.');
  if (catalog && (common.graphBytes?.newBytes !== 0 || assets.some(asset => !['PRODUCT_MAIN','GALLERY'].includes(asset.source_kind) ||
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
  updateMediaProgress();
  if (mediaReview.assetItems.length) await showMediaImage(mediaReview.assetItems[0]);
}
function updateMediaProgress() {
  mediaComplete = reviewedImages.size === mediaReview.assetItems.length;
  document.querySelector('#media-progress').textContent = `${reviewedImages.size} of ${mediaReview.assetItems.length} unique exact images reviewed. All ordered before and after effects are shown below.`;
  document.querySelector('#approve').disabled = !mediaComplete;
}
function releaseMediaImage() {
  if (imageJob) imageJob.abort(); imageJob = null;
  imageNode.removeAttribute('src'); if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null; selectedImage = null; imageAck.disabled = true;
}
async function showMediaImage(item) {
  releaseMediaImage(); imageAck.disabled = true;
  const job = new AbortController(); imageJob = job;
  const packet = await receiveMedia(item, job.signal), asset = mediaReview.assets.get(item.assetKey);
  if (job.signal.aborted) return;
  if (!asset || packet.mime !== asset.mime || packet.bytes.byteLength !== asset.byte_length) throw new Error('Image type failed.');
  imageUrl = URL.createObjectURL(new Blob([packet.bytes], { type: asset.mime })); imageNode.src = imageUrl;
  await imageNode.decode();
  if (job.signal.aborted) return;
  document.querySelector('#media-image-details').textContent = `${asset.mime} · ${asset.byte_length} bytes · SHA256 ${item.hash}`;
  selectedImage = { item, nonce: packet.nonce }; imageAck.disabled = reviewedImages.has(item.itemKey);
}
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
    button.addEventListener('click', () => showMediaImage(item).catch(() => { statusNode.textContent = 'Image unavailable. Reload the review.'; })); return button;
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
function renderCatalogMediaEffects(effects, labels, creationProposal = null) {
  const identity = creationProposal ? catalogCreationIdentity(creationProposal.creationIdentity) : null;
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
    if (listings.size !== 1 || !fresh || fresh.before !== null || fresh.labels.before !== null || fresh.after.mainAssetKey !== null || fresh.after.ownMainVisible !== false ||
        !listing?.after || listing.listingId !== (identity.targetListingId ?? identity.newListingId) || (listing.before === null) !== (identity.targetListingId === null) ||
        creationProposal.before !== null || !after || after.id !== identity.productId || after.listingId !== listing.listingId || canonical({sku:after.sku,name:after.name}) !== canonical(fresh.labels.after)) throw new Error('Invalid CREATE effects.');
    for (const product of products) if (product.after.listingId !== listing.listingId || product !== fresh && (!product.before || product.before.listingId !== listing.listingId ||
        product.before.mainAssetKey !== product.after.mainAssetKey || canonical(product.labels.before) !== canonical(product.labels.after))) throw new Error('Unsupported existing-product change.');
    if (listing.before === null ? products.length !== 1 || fresh.after.role !== 'single' || listing.after.holderId !== null || listing.after.galleryAssetKeys.length !== 0 : products.length < 2) throw new Error('Invalid CREATE membership.');
    const owners = new Set(products.filter(row => row.before !== null).map(row => row.productId));
    if ([...mediaReview.assets.values()].some(row => row.stage_id !== null || !owners.has(row.source_product_id))) throw new Error('Invalid CREATE source owner.');
    catalogCreateOptions(creationProposal);
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
    button.addEventListener('click', () => showMediaImage(item).catch(() => { statusNode.textContent = 'Image unavailable. Reload the review.'; })); return button;
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
  if (!selectedImage || imageAck.disabled) return;
  const current = selectedImage; imageAck.disabled = true;
  try {
    await acknowledgeMedia(current.item, current.nonce); reviewedImages.add(current.item.itemKey); updateMediaProgress();
    const next = mediaReview.assetItems.find(item => !reviewedImages.has(item.itemKey)); if (next) await showMediaImage(next);
  } catch { statusNode.textContent = 'Image confirmation failed. Reload this review or reject the proposal.'; }
});
window.addEventListener('pagehide', releaseMediaImage);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const decision = event.submitter?.value;
  if (!csrf || !previewHash || !challenge || !['approve', 'reject'].includes(decision) || !password.value) return;
  if (decision === 'approve' && mediaReview && (!mediaComplete || !mediaAck.checked)) {
    statusNode.textContent = 'Review every exact image and check the image acknowledgment before approving.';
    mediaAck.focus(); return;
  }
  if (decision === 'approve' && currencyAcknowledgementRequired && !currencyAck.checked) {
    statusNode.textContent = 'Read the currency warning and check the acknowledgment before approving.';
    currencyAck.focus(); return;
  }
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const response = await fetch(`${base}/api/v1/seller/mcp/operations/${id}/approval`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ operationId: id, previewHash, challenge, decision, password: password.value,
        ...(currencyAcknowledgementRequired && decision === 'approve' ? { currencyAcknowledged: true } : {}),
        ...(mediaReview && decision === 'approve' ? { mediaReviewed: true } : {}),
      }),
    });
    if (!response.ok) throw new Error('Approval failed.');
    const result = await response.json();
    if (result.operationId !== id || result.status !== (decision === 'approve' ? 'APPROVED' : 'REJECTED')) throw new Error('Invalid result.');
    csrf = null; previewHash = null; challenge = null; form.hidden = true; releaseMediaImage();
    statusNode.textContent = decision === 'approve' ? 'Approved. The connected app must still commit this change.' : 'Rejected. The change was not applied.';
  } catch {
    statusNode.textContent = 'The decision could not be verified. Reload the proposal and try again.';
    buttons.forEach((button) => { button.disabled = false; });
    if (mediaReview) document.querySelector('#approve').disabled = !mediaComplete;
  } finally {
    password.value = '';
  }
});

load().catch(error => {
  reviewSection.hidden = true;
  statusNode.textContent = error.message === 'Sign in required.'
    ? 'Sign in to Seller Studio to review this proposal. No change has been approved.'
    : 'The proposal is unavailable. Ask the connected app to prepare a new preview.';
});
