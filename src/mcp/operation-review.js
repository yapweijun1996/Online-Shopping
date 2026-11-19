'use strict';

// First-party seller UI. All proposal
// content is untrusted and is rendered only as text.
const statusNode = document.querySelector('#status');
const reviewSection = document.querySelector('#review');
const form = document.querySelector('#decision');
const resultDialog = document.querySelector('#result-dialog');
const expiryChip = document.querySelector('#expiry-chip');
function syncDecisionHeight() {
  document.documentElement.style.setProperty('--decision-height', `${form.getBoundingClientRect().height}px`);
}
new ResizeObserver(syncDecisionHeight).observe(form, { box: 'border-box' });
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
let mediaReview = null, mediaComplete = false, imageUrl = null, imageJob = null;
const imageNode = document.querySelector('#media-image');
const acknowledgedImages = new Set();
const thumbnailUrls = new Map();
const thumbnails = new Map();
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
    expiryChip.textContent = 'Expired';
    expiryChip.classList.add('expiry-warning');
    for (const control of form.elements) control.disabled = true;
    imageRetry.disabled = true;
    for (const control of document.querySelectorAll('.media-reference')) control.disabled = true;
  }
  return expired;
}
function scheduleExpiry() {
  clearTimeout(expiryTimer);
  if (expiresAt === null || checkExpiry()) return;
  const remaining = expiresAt - Date.now();
  expiryChip.textContent = remaining < 60000
    ? 'Expires in less than 1 min'
    : `Expires in ${Math.ceil(remaining / 60000)} min`;
  const warningThreshold = 120000;
  expiryChip.classList.toggle('expiry-warning', remaining < warningThreshold);
  const untilWarning = remaining >= warningThreshold ? remaining - warningThreshold + 1 : Infinity;
  expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, untilWarning, 30000));
}
function updateReviewControls() {
  const disabled = checkExpiry() || decisionPending || !csrf || !previewHash || !challenge;
  for (const control of form.elements) control.disabled = disabled;
  document.querySelector('#approve').disabled = disabled || Boolean(mediaReview && !mediaComplete);
  imageRetry.disabled = disabled;
  for (const control of document.querySelectorAll('.media-reference')) control.disabled = disabled || !mediaComplete;
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
  const categoryValue = row.category && typeof row.category === 'object' ? row.category : row.categoryCode ?? row.category;
  const category = categoryValue && typeof categoryValue === 'object'
    ? `${summaryText(row.category.label)} (${summaryText(row.category.code)})${row.category.active === false ? ' (inactive)' : ''}`
    : summaryText(categoryValue);
  return [
    ['Name', summaryText(row.name), row.name],
    ['SKU', summaryText(row.sku), row.sku],
    ['Price', price, [row.priceMinor ?? null, row.currency ?? null]],
    ['Stock', row.stockQuantity === null ? 'Unlimited' : summaryText(row.stockQuantity), row.stockQuantity],
    ['Availability', row.active === true ? 'Listed' : row.active === false ? 'Not listed' : 'Not provided', row.active],
    ['Category', category, categoryValue],
    ['Description', summaryText(row.description), row.description],
    ['Options', optionText, options],
    ['Variant group', summaryText(row.variantGroup), row.variantGroup],
    ['Variant label', summaryText(row.variantLabel), row.variantLabel],
  ];
}
function renderBusinessSummary(value) {
  const titles = {
    'catalog.preview_create': 'Review product creation',
    'catalog.preview_update': 'Review product changes',
    'company.preview_update': 'Review company changes',
    'inventory.preview_adjustment': 'Review stock adjustment',
    'orders.preview_decision': 'Review order decision',
    'media.prepare_upload': 'Review image update',
    'media.preview_layout': 'Review image layout',
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
    const heading = document.createElement('h3');
    heading.textContent = summaryText(product.after?.name ?? product.before?.name ?? product.after?.sku);
    if (products.length > 1 && product.after?.sku) {
      heading.textContent += ` · ${summaryText(product.after.sku)}`;
    }
    article.append(heading);
    const unchanged = document.createElement('details');
    const unchangedLabel = document.createElement('summary');
    unchanged.className = 'unchanged-fields';
    unchanged.append(unchangedLabel);
    let changedCount = 0, unchangedCount = 0;
    for (const [fieldIndex, [label, text, raw]] of after.entries()) {
      const previous = before?.[fieldIndex][1];
      if (before && previous === text && canonical(before[fieldIndex][2]) === canonical(raw)) {
        unchanged.append(summaryField(label, [['Current value', text]]));
        unchangedCount++;
      } else {
        const values = before ? [['Before', previous], ['After', text]] : [['New value', text]];
        article.append(summaryField(label, values, Boolean(before)));
        changedCount++;
      }
    }
    if (!changedCount) {
      const message = document.createElement('p');
      message.textContent = 'No changes to the fields shown here.';
      article.append(message);
    }
    if (unchangedCount) {
      unchangedLabel.textContent = `Unchanged fields (${unchangedCount})`;
      article.append(unchanged);
    }
    root.append(article);
  }
  document.querySelector('#business-summary').hidden = root.childElementCount === 0;
}

function summaryField(label, values, changed = false) {
  const field = document.createElement('section');
  field.className = 'summary-field';
  const heading = document.createElement('h4');
  heading.textContent = label;
  if (changed) {
    const badge = document.createElement('span');
    badge.className = 'chip changed-badge';
    badge.textContent = 'Changed';
    heading.append(' ', badge);
  }
  const comparison = document.createElement('dl');
  comparison.className = 'comparison';
  for (const [side, text] of values) {
    const entry = document.createElement('div');
    const term = document.createElement('dt'), value = document.createElement('dd');
    term.textContent = side;
    value.textContent = text;
    entry.append(term, value);
    comparison.append(entry);
  }
  field.append(heading, comparison);
  return field;
}

function approvalLabel(toolName, proposal) {
  if (['media.prepare_upload', 'media.preview_layout'].includes(toolName)) return 'Approve image change';
  if (toolName === 'catalog.preview_update') {
    if (proposal.normalizedInput) {
      const fields = Object.keys(proposal.normalizedInput);
      if (fields.length === 1 && fields[0] === 'description') return 'Approve description change';
    } else if (proposal.before && proposal.after) {
      const { description: before, ...otherBefore } = proposal.before;
      const { description: after, ...otherAfter } = proposal.after;
      if (before !== after && canonical(otherBefore) === canonical(otherAfter)) return 'Approve description change';
    }
  }
  return 'Approve change';
}

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
      typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
      !value.proposal || typeof value.proposal !== 'object' || Array.isArray(value.proposal)) {
    throw new Error('Invalid proposal.');
  }
  renderBusinessSummary(value);
  document.querySelector('#approve').textContent = approvalLabel(value.toolName, value.proposal);
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
  const requestSummary = document.querySelector('#request-summary');
  for (const [prefix, name] of [['Requested by ', value.clientName], [' for ', value.shopName], [' as ', value.accountName]]) {
    const emphasis = document.createElement('strong');
    emphasis.textContent = visible(name);
    requestSummary.append(prefix, emphasis);
  }
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
  syncDecisionHeight();
  expiresAt = expiryDate.getTime();
  document.querySelector('#pending-state').textContent = 'Pending your decision — not applied';
  scheduleExpiry(); updateReviewControls();
  reviewStatus('');
  if (mediaReview) {
    document.querySelector('#media-review').hidden = false;
    if (document.querySelector('#business-summary').hidden) document.querySelector('#media-title').textContent = 'What will change';
    if (!checkExpiry()) await loadMedia(value.toolName, value.proposal, value.resourceId, value.resourceType, value.risk)
      .catch(() => { if (csrf) reviewStatus('Image verification failed. Reload this review or reject the proposal.'); });
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
  const acknowledged = response.headers.get('x-media-acknowledged') === 'true';
  if ((!acknowledged && !/^[A-Za-z0-9_-]{43}$/.test(nonce || '')) ||
      bytes.byteLength > (item.kind === 'PAGE' ? 16384 : 524288) || await sha256(bytes) !== item.hash) throw new Error('Image checksum failed.');
  return { bytes, nonce, acknowledged, mime: response.headers.get('content-type') };
}
async function acknowledgeMedia(item, { nonce, acknowledged }, signal) {
  if (acknowledged) return;
  const response = await mediaPost('ack', item, { expectedHash: item.hash, nonce }, signal);
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
    await acknowledgeMedia(item, packet);
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
  else {
    renderMediaEffects(effects, labels, proposal);
    renderImageChangeSummary(toolName, proposal, effects);
  }
  document.querySelector('#media-effect-records').textContent = visible(JSON.stringify(effects, null, 2));
  document.querySelector('#media-technical').hidden = false;
  const empty = mediaReview.assetItems.length === 0;
  document.querySelector('#media-viewer').hidden = empty;
  document.querySelector('#media-empty').hidden = !empty;
  updateMediaProgress();
  await verifyRemainingImages();
}
function updateMediaProgress() {
  mediaComplete = acknowledgedImages.size === mediaReview.assetItems.length;
  const total = mediaReview.assetItems.length;
  document.querySelector('#media-progress').textContent = !total ? '' : mediaComplete
    ? `${total} ${total === 1 ? 'image' : 'images'} verified`
    : `Verifying images (${acknowledgedImages.size} of ${total})`;
  updateReviewControls();
}
function releaseMediaImage() {
  if (imageJob) imageJob.abort(); imageJob = null;
  imageNode.hidden = true; imageNode.removeAttribute('src');
  if (imageUrl && !thumbnailUrls.has(imageUrl)) URL.revokeObjectURL(imageUrl);
  imageUrl = null;
  document.querySelector('#media-image-details').textContent = '';
}
async function verifyRemainingImages() {
  for (const item of mediaReview.assetItems) {
    if (!acknowledgedImages.has(item.itemKey) && !await showMediaImage(item)) return;
  }
}
async function showMediaImage(item) {
  if (checkExpiry() || !csrf) return false;
  releaseMediaImage();
  retryImage = item; imageRetry.hidden = true;
  imageStatus.textContent = 'Loading and verifying the exact image…';
  const job = new AbortController(); imageJob = job;
  try {
    const packet = await receiveMedia(item, job.signal), asset = mediaReview.assets.get(item.assetKey);
    if (job.signal.aborted || checkExpiry()) return false;
    if (!asset || packet.mime !== asset.mime || packet.bytes.byteLength !== asset.byte_length) throw new Error('Image type failed.');
    imageUrl = URL.createObjectURL(new Blob([packet.bytes], { type: asset.mime })); imageNode.src = imageUrl;
    await imageNode.decode();
    if (job.signal.aborted || checkExpiry()) return false;
    imageNode.hidden = false;
    document.querySelector('#media-image-details').textContent = `${asset.mime} · ${asset.byte_length} bytes · SHA256 ${item.hash}`;
    // Let the decoded image render before acknowledging its delivery.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (job.signal.aborted || checkExpiry()) return false;
    await acknowledgeMedia(item, packet, job.signal);
    if (job.signal.aborted || checkExpiry()) return false;
    acknowledgedImages.add(item.itemKey);
    const previews = thumbnails.get(item.assetKey);
    if (previews && !previews[0].hasAttribute('src')) {
      thumbnailUrls.set(imageUrl, previews);
      for (const thumbnail of previews) {
        thumbnail.src = imageUrl;
        thumbnail.hidden = false;
      }
    }
    updateMediaProgress();
    imageStatus.textContent = 'Exact image verified.';
    if (statusNode.textContent.startsWith('Image verification failed')) {
      reviewStatus('');
    }
    return true;
  } catch {
    if (job.signal.aborted || checkExpiry()) return false;
    releaseMediaImage();
    imageStatus.textContent = 'Image verification failed. Retry to load and verify it again.';
    reviewStatus('Image verification failed. Retry the image, reload this review or reject the proposal.');
    imageRetry.hidden = false;
    return false;
  }
}
imageRetry.addEventListener('click', () => {
  if (!retryImage) return;
  if (mediaComplete) void showMediaImage(retryImage);
  else void verifyRemainingImages();
});
function mediaReference(key, label, side) {
  const item = mediaReview.assetItems.find(value => value.assetKey === key);
  if (!item) throw new Error('Missing image reference.');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'media-reference';
  button.disabled = true;
  button.textContent = label;
  button.setAttribute('aria-label', `${label} · ${side === 'before' ? 'Before' : 'After'}`);
  const thumbnail = document.createElement('img');
  thumbnail.alt = '';
  thumbnail.hidden = true;
  if (!thumbnails.has(key)) thumbnails.set(key, []);
  thumbnails.get(key).push(thumbnail);
  button.prepend(thumbnail);
  button.addEventListener('click', () => {
    showMediaImage(item).catch(() => { reviewStatus('Image unavailable. Reload the review.'); });
    document.querySelector('#media-viewer').focus();
  });
  return button;
}

function mediaComparison(headingText) {
  const article = document.createElement('article'), heading = document.createElement('h3');
  heading.textContent = headingText;
  const comparison = document.createElement('div');
  comparison.className = 'comparison media-comparison';
  article.append(heading, comparison);
  return { article, comparison };
}

function mediaSide(side, detail) {
  const line = document.createElement('div'), heading = document.createElement('h4');
  line.className = 'media-state';
  heading.textContent = side === 'before' ? 'Before' : 'After';
  line.append(heading, detail);
  return line;
}

function mediaNote(text) {
  const note = document.createElement('span');
  note.className = 'chip';
  note.textContent = text;
  return note;
}

function mediaPlacement(rendered, key, label, side) {
  if (key === null) return mediaNote('No photo selected');
  if (rendered[side].has(key)) return mediaNote(`${label} · preview shown above`);
  const preview = mediaReference(key, label, side);
  rendered[side].add(key);
  return preview;
}

function mediaListingProductId(effect, effects) {
  for (const side of ['after', 'before']) {
    const state = effect[side];
    if (!state) continue;
    if (state.holderId) return state.holderId;
    const member = effects.find(value => value.kind === 'PRODUCT' && value[side]?.listingId === effect.listingId);
    if (member) return member.productId;
  }
  return null;
}

function renderImageChangeSummary(toolName, proposal, effects) {
  const summary = document.querySelector('#image-change-summary');
  if (toolName === 'media.prepare_upload') {
    if (proposal.targetSlot === 'MAIN') {
      const target = effects.find(effect => effect.kind === 'PRODUCT' && effect.productId === proposal.productId);
      const listing = effects.find(effect => effect.kind === 'LISTING' && effect.listingId === target?.after.listingId);
      const key = target?.after.mainAssetKey;
      summary.textContent = '1 image changes the main product photo.';
      if (key && key !== target.before.mainAssetKey && listing?.after.galleryAssetKeys.includes(key)) {
        summary.textContent = listing.before.galleryAssetKeys.includes(key)
          ? 'This image becomes the main product photo and remains in the gallery.'
          : 'This image becomes the main product photo and is added to the gallery.';
      }
    }
    if (proposal.targetSlot === 'GALLERY') summary.textContent = '1 image is added to the product gallery.';
  } else if (proposal.removeMain) {
    summary.textContent = 'The main product photo is removed.';
  } else {
    const positions = effects.filter(effect => effect.kind === 'LISTING').reduce((count, effect) => {
      const before = effect.before.galleryAssetKeys, after = effect.after.galleryAssetKeys;
      return count + before.filter((key, index) => key !== after[index]).length + Math.max(0, after.length - before.length);
    }, 0);
    if (positions) summary.textContent = positions === 1 ? '1 gallery photo position changes.' : `${positions} gallery photo positions change.`;
  }
  summary.hidden = !summary.textContent;
  syncDecisionHeight();
}

function renderMediaEffects(effects, labels, proposal) {
  const names = new Map();
  for (const label of labels) {
    if (!idPattern.test(label.productId || '') || typeof label.sku !== 'string' || typeof label.name !== 'string' || names.has(label.productId)) throw new Error('Invalid image labels.');
    names.set(label.productId, label);
  }
  const root = document.querySelector('#media-effects'); root.replaceChildren();
  const rendered = { before: new Set(), after: new Set() };
  const ordered = proposal.targetSlot === 'MAIN'
    ? effects.toSorted((a, b) => Number(b.productId === proposal.productId) - Number(a.productId === proposal.productId))
    : effects;
  for (const effect of ordered) {
    const product = effect.kind === 'PRODUCT';
    if (product && !names.has(effect.productId)) throw new Error('Missing product label.');
    const label = names.get(product ? effect.productId : mediaListingProductId(effect, effects));
    const heading = product ? `Main product photo · ${label.name}` : label ? `Gallery · ${label.name}` : 'Product gallery';
    const { article, comparison } = mediaComparison(visible(heading));
    for (const side of ['before', 'after']) {
      const state = effect[side], detail = document.createElement('div');
      if (product) {
        detail.append(mediaPlacement(rendered, state.mainAssetKey, 'Main product photo', side));
      } else {
        const holderLabel = names.get(state.holderId);
        if (holderLabel) {
          const shared = document.createElement('p');
          shared.textContent = `Shared photos from ${visible(holderLabel.name)}`;
          detail.append(shared);
        }
        detail.append(state.galleryAssetKeys.length ? orderedGallery(state.galleryAssetKeys, side, rendered) : mediaNote('No photo selected'));
      }
      comparison.append(mediaSide(side, detail));
    }
    root.append(article);
  }
}

function orderedGallery(keys, side, rendered) {
  const list = document.createElement('ol'); list.className = 'media-visible-gallery';
  list.setAttribute('role', 'list');
  for (const [index, key] of keys.entries()) {
    const item = document.createElement('li');
    item.append(mediaPlacement(rendered, key, `Gallery photo ${index + 1}`, side));
    list.append(item);
  }
  return list;
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
  const rendered = { before: new Set(), after: new Set() };
  function ordered(keys, side) {
    if (keys.length > 11) throw new Error('Catalog visible gallery too large.');
    return orderedGallery(keys, side, rendered);
  }
  for (const effect of effects) {
    const product = effect.kind === 'PRODUCT';
    const label = names.get(product ? effect.productId : mediaListingProductId(effect, effects));
    const listingLabel = label?.[effect.after ? 'after' : 'before'];
    const heading = product ? `Product photos · ${visible(label.after.name)}` : listingLabel ? `Gallery · ${visible(listingLabel.name)}` : 'Product gallery';
    const { article, comparison } = mediaComparison(heading);
    for (const side of ['before','after']) {
      const state = effect[side], detail = document.createElement('div');
      if (state === null) {
        if (effect.kind !== 'LISTING' && !(creationProposal && side === 'before' && effect.productId === creationProposal.creationIdentity.productId)) throw new Error('Invalid absent product.');
        detail.textContent = effect.kind === 'PRODUCT' ? 'Not yet created.' : side === 'before' ? 'Did not exist before this change.' : 'Removed by this change.';
      } else if (effect.kind === 'PRODUCT') {
        const sideName = names.get(effect.productId)[side].name;
        if (sideName !== label.after.name) {
          const name = document.createElement('p');
          name.textContent = visible(sideName);
          detail.append(name);
        }
        if (creationProposal && side === 'after' && effect.productId === creationProposal.creationIdentity.productId) {
          const options = document.createElement('p'), rows = catalogCreateOptions(creationProposal);
          options.textContent = rows.length ? visible('Options: ' + rows.map(row => `${row.typeName}: ${row.valueLabel}`).join('; ')) : 'Options: none'; detail.append(options);
        }
        const main = document.createElement('p');
        main.append(mediaPlacement(rendered, state.mainAssetKey, 'Main product photo', side));
        detail.append(main);
        if (state.mainAssetKey !== null && !state.ownMainVisible) {
          const note = document.createElement('p');
          note.textContent = 'The main photo is hidden from shoppers.';
          detail.append(note);
        }
        const listing = listings.get(state.listingId)?.[side]; if (!listing) throw new Error('Missing catalog listing state.');
        if (state.role === 'single' && state.ownMainVisible && !listing.galleryAssetKeys.includes(state.mainAssetKey)) throw new Error('Missing visible own main.');
        detail.append(document.createTextNode('Shopper gallery in order:'),ordered(state.role === 'single' ? listing.galleryAssetKeys : [...(state.ownMainVisible ? [state.mainAssetKey] : []),...listing.galleryAssetKeys], side));
      } else {
        if (state.holderId !== null && !names.has(state.holderId)) throw new Error('Missing holder label.');
        if (state.holderId !== null) {
          const shared = document.createElement('p');
          shared.textContent = `Shared photos from ${visible(names.get(state.holderId)[side].name)}`;
          detail.append(shared);
        }
        detail.append(state.galleryAssetKeys.length ? ordered(state.galleryAssetKeys, side) : mediaNote('No photo selected'));
      }
      comparison.append(mediaSide(side, detail));
    }
    root.append(article);
  }
}
function releaseMedia() {
  releaseMediaImage();
  for (const [url, previews] of thumbnailUrls) {
    for (const preview of previews) {
      preview.hidden = true;
      preview.removeAttribute('src');
    }
    URL.revokeObjectURL(url);
  }
  thumbnailUrls.clear();
}
window.addEventListener('pagehide', event => {
  if (event.persisted) releaseMediaImage();
  else releaseMedia();
});

document.querySelector('#result-done').addEventListener('click', () => resultDialog.close());
resultDialog.addEventListener('close', () => statusNode.focus());

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (checkExpiry() || decisionPending) return;
  const decision = event.submitter?.value;
  if (!csrf || !previewHash || !challenge || !['approve', 'reject'].includes(decision)) return;
  if (decision === 'approve' && mediaReview && !mediaComplete) return;
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
    const approved = decision === 'approve';
    if (result.operationId !== id || result.status !== (approved ? 'APPROVED' : 'REJECTED')) throw new Error('Invalid result.');
    csrf = null; previewHash = null; challenge = null; form.hidden = true; releaseMedia();
    clearTimeout(expiryTimer); expiryTimer = null; expiresAt = null;
    expiryChip.hidden = true;
    document.querySelector('#currency-warning').hidden = true;
    document.querySelector('#pending-state').textContent = approved ? 'Approved — app commit still required' : 'Rejected — not applied';
    statusNode.textContent = approved ? 'Approved. The connected app must still commit this change.' : 'Rejected. The change was not applied.';
    statusNode.classList.add('visually-hidden');
    document.querySelector('#result-title').textContent = approved ? 'Approved' : 'Rejected';
    document.querySelector('#result-description').textContent = approved
      ? 'The product has not changed yet. Return to Claude to apply this change.'
      : 'No change was made.';
    document.querySelector('#result-check').toggleAttribute('hidden', !approved);
    resultDialog.showModal();
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
