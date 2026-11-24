'use strict';

// First-party seller UI. All proposal
// content is untrusted and is rendered only as text.
const language = window.operationReviewLanguage;
const t = language?.t ?? ((message, values = {}) => message.replace(/\{(\w+)\}/g, (match, key) => String(values[key] ?? match)));
const reviewLocale = language?.reviewLocale ?? (() => 'en');
language?.applyReviewLanguage();

const statusNode = document.querySelector('#status');
const proposalRetry = document.querySelector('#proposal-retry');
const sellerLink = document.querySelector('#seller-link');
const reviewSection = document.querySelector('#review');
const form = document.querySelector('#decision');
const resultDialog = document.querySelector('#result-dialog');
const expiryChip = document.querySelector('#expiry-chip');
const expiryState = document.querySelector('#pending-state');
const checkStatus = document.querySelector('#check-status');
const imageDialog = document.querySelector('#image-dialog');
const imageZoom = document.querySelector('#image-zoom');
const terminalStatuses = new Set(['APPROVED', 'COMMITTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'CONFLICT', 'FAILED']);
function syncDecisionHeight() {
  document.documentElement.style.setProperty('--decision-height', `${form.getBoundingClientRect().height}px`);
}
new ResizeObserver(syncDecisionHeight).observe(form, { box: 'border-box' });
const path = /^\/(?:([a-z0-9]{3,30})\/)?oauth\/operation\/?$/.exec(location.pathname);
const base = path?.[1] ? `/${path[1]}` : '';
const id = new URL(location.href).searchParams.get('operationId');
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
sellerLink.href = `${base}/seller/`;
let csrf = null;
let previewHash = null;
let challenge = null;
let currencyAcknowledgementRequired = false;
let clientName = '', galleryConfirmation = false, terminalStatus = null, approvalSummary = null;
let unknownDecision = false, reviewLoading = false;
let mediaReview = null, mediaComplete = false, imageUrl = null, imageJob = null;
const imageNode = document.querySelector('#media-image');
const imageViewer = document.querySelector('#media-viewer');
const acknowledgedImages = new Set();
const thumbnailUrls = new Map();
const thumbnails = new Map();
const imageCards = new Map(), objectUrls = new Map();
let verificationInProgress = false;
let zoomItems = [], zoomIndex = 0, zoomTrigger = null;
const currencyAck = document.querySelector('#currency-ack');
const imageStatus = document.querySelector('#media-image-status');
const imageRetry = document.querySelector('#media-image-retry');
let retryImage = null;
let expiryTimer = null, expiresAt = null, expired = false, decisionPending = false;
const visible = (value) => value.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
  (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);

document.querySelector('#review-language').addEventListener('change', event => {
  if (!language?.setReviewLocale) return;
  language.setReviewLocale(event.currentTarget.value);
  location.reload();
});

function setState(message) {
  expiryState.textContent = message;
  document.querySelector('#technical-state').textContent = message;
}

function checkExpiry() {
  if (!expired && expiresAt !== null && Date.now() >= expiresAt) {
    expired = true; clearTimeout(expiryTimer); expiryTimer = null;
    const message = t('Proposal expired. Ask the connected app for a new preview.');
    setState(message);
    statusNode.textContent = message;
    expiryChip.textContent = t('Expired');
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
    ? t('Expires in less than 1 min')
    : t('Expires in {minutes} min', { minutes: Math.ceil(remaining / 60000) });
  const warningThreshold = 120000;
  expiryChip.classList.toggle('expiry-warning', remaining < warningThreshold);
  const untilWarning = remaining >= warningThreshold ? remaining - warningThreshold + 1 : Infinity;
  expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, untilWarning, 30000));
}
function updateReviewControls() {
  const disabled = checkExpiry() || decisionPending || unknownDecision || reviewLoading || !csrf || !previewHash || !challenge;
  for (const control of form.elements) control.disabled = disabled;
  document.querySelector('#approve').disabled = disabled || Boolean(mediaReview && !mediaComplete);
  document.querySelector('#review-language').disabled = decisionPending || reviewLoading;
  checkStatus.disabled = reviewLoading;
  imageRetry.disabled = disabled || verificationInProgress;
  for (const control of document.querySelectorAll('.media-reference')) {
    control.disabled = expired || !objectUrls.has(control.dataset.assetKey);
  }
  for (const control of document.querySelectorAll('.media-card-retry')) control.disabled = disabled || verificationInProgress;
}
function reviewStatus(message) {
  if (!checkExpiry() && !decisionPending) statusNode.textContent = message;
}

function summaryText(value) {
  if (value === undefined) return t('Not provided');
  if (value === null) return t('None');
  return visible(typeof value === 'string' ? value || t('Empty') : JSON.stringify(value));
}
function catalogSummaryFields(row, optionReview) {
  if (!row || typeof row !== 'object') return null;
  let price = t('Not provided');
  if (Number.isSafeInteger(row.priceMinor)) {
    price = ['MYR', 'SGD'].includes(row.currency)
      ? `${row.currency} ${(row.priceMinor / 100).toFixed(2)}`
      : t('{price} minor units ({currency})', { price: row.priceMinor,
        currency: typeof row.currency === 'string' && row.currency
          ? t('{currency} · scale not provided', { currency: visible(row.currency) })
          : t('Currency not provided') });
  }
  const options = optionReview ?? row.options;
  const optionText = !Array.isArray(options) ? t('Not provided') : !options.length ? t('None')
    : options.every(option => typeof option.typeName === 'string' && typeof option.valueLabel === 'string')
      ? visible(options.map(option => `${option.typeName}: ${option.valueLabel}${option.typeActive === false || option.valueActive === false ? ` (${t('Inactive')})` : ''}`).join('; '))
      : t('{count} selections without labels. See the complete proposal.', { count: options.length });
  const categoryValue = row.category && typeof row.category === 'object' ? row.category : row.categoryCode ?? row.category;
  const category = categoryValue && typeof categoryValue === 'object'
    ? `${summaryText(row.category.label)} (${summaryText(row.category.code)})${row.category.active === false ? ` (${t('Inactive')})` : ''}`
    : summaryText(categoryValue);
  return [
    ['Name', summaryText(row.name), row.name],
    ['SKU', summaryText(row.sku), row.sku],
    ['Price', price, [row.priceMinor ?? null, row.currency ?? null]],
    ['Stock', row.stockQuantity === null ? t('Unlimited') : summaryText(row.stockQuantity), row.stockQuantity],
    ['Availability', row.active === true ? t('Listed') : row.active === false ? t('Not listed') : t('Not provided'), row.active],
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
    'media.prepare_upload': value.proposal.targetSlot === 'GALLERY' ? 'Review gallery photo addition' : 'Review main photo change',
    'media.preview_layout': 'Review image layout',
  };
  const title = t(titles[value.toolName] || 'Review proposed seller operation');
  setTitle(title);
  const product = value.proposal.product ?? value.proposal.after;
  const labels = value.mediaReview?.labels;
  const name = value.resourceType === 'inventory' ? value.proposal.before?.product?.name
    : (value.resourceType === 'product' || value.toolName === 'catalog.preview_create')
      ? product?.name ?? value.proposal.before?.name ??
        (Array.isArray(labels) ? labels.find(label => label?.productId === value.resourceId)?.name : null)
      : null;
  approvalSummary = { toolName: value.toolName, targetSlot: value.proposal.targetSlot,
    productName: typeof name === 'string' ? visible(name) : '' };
  if (product && typeof product.name === 'string' && typeof product.sku === 'string') {
    const node = document.querySelector('#operation-product');
    node.textContent = `${visible(product.name)} · ${visible(product.sku)}`;
    node.hidden = false;
  }
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
        unchanged.append(summaryField(label, [[t('Current value'), text]]));
        unchangedCount++;
      } else {
        const values = before ? [[t('Before'), previous], [t('After'), text]] : [[t('New value'), text]];
        article.append(summaryField(label, values, Boolean(before)));
        changedCount++;
      }
    }
    if (!changedCount) {
      const message = document.createElement('p');
      message.textContent = t('No changes to the fields shown here.');
      article.append(message);
    }
    if (unchangedCount) {
      unchangedLabel.textContent = t('Unchanged fields ({count})', { count: unchangedCount });
      article.append(unchanged);
    }
    root.append(article);
  }
  document.querySelector('#business-summary').hidden = root.childElementCount === 0;
}

function setTitle(title) {
  document.querySelector('#operation-heading').textContent = title;
  document.title = `${title} · ${t('Seller Studio')}`;
}

function summaryField(label, values, changed = false) {
  const field = document.createElement('section');
  field.className = 'summary-field';
  const heading = document.createElement('h4');
  heading.textContent = t(label);
  if (changed) {
    const badge = document.createElement('span');
    badge.className = 'chip changed-badge';
    badge.textContent = t('Changed');
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
  if (toolName === 'media.prepare_upload') return proposal.targetSlot === 'GALLERY' ? 'Approve gallery addition' : 'Approve main photo change';
  if (toolName === 'media.preview_layout') return 'Approve image change';
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
  if (sessionResponse.status === 401) throw new Error('Sign in required.');
  if (!sessionResponse.ok) throw new Error('Session unavailable.');
  const session = await sessionResponse.json();
  if (typeof session.csrfToken !== 'string' || !session.csrfToken) throw new Error('Invalid session.');
  const response = await fetch(`${base}/api/v1/seller/mcp/operations/${id}`, { credentials: 'same-origin', cache: 'no-store' })
    .catch(() => { throw new Error('Temporary proposal failure.'); });
  if (response.status === 401) throw new Error('Sign in required.');
  if (response.status >= 500) throw new Error('Temporary proposal failure.');
  if (!response.ok) throw new Error('Proposal unavailable.');
  const value = await response.json();
  if (value.operationId === id && terminalStatuses.has(value.status) && typeof value.clientName === 'string' &&
      (exactKeys(value, ['operationId', 'status', 'clientName']) ||
        (value.confirmsCurrentGallery === true && exactKeys(value, ['operationId', 'status', 'clientName', 'confirmsCurrentGallery'])))) {
    clientName = value.clientName;
    galleryConfirmation = value.confirmsCurrentGallery === true;
    return showTerminalState(value.status);
  }
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
  resetReview();
  renderBusinessSummary(value);
  document.querySelector('#approve').textContent = t(approvalLabel(value.toolName, value.proposal));
  document.querySelector('#operation-id').textContent = id;
  csrf = session.csrfToken;
  previewHash = value.previewHash;
  challenge = value.challenge;
  mediaReview = value.mediaReview || null;
  currencyAcknowledgementRequired = value.currencyAcknowledgementRequired;
  clientName = value.clientName;
  currencyAck.checked = false;
  document.querySelector('#currency-warning').hidden = !currencyAcknowledgementRequired;
  document.querySelector('#currency-warning-text').textContent = value.currencyWarning ? t(value.currencyWarning) : '';
  document.querySelector('#shop').textContent = visible(value.shopName);
  document.querySelector('#account').textContent = visible(value.accountName);
  document.querySelector('#client').textContent = visible(value.clientName);
  document.querySelector('#request-summary').textContent = t('Requested by {app} for {shop} as {account}', {
    app: visible(value.clientName), shop: visible(value.shopName), account: visible(value.accountName)
  });
  document.querySelector('#client-id').textContent = visible(value.clientId);
  document.querySelector('#tool').textContent = visible(value.toolName);
  document.querySelector('#target').textContent = `${visible(value.resourceType)}: ${value.resourceId ? visible(value.resourceId) : t('New resource')}`;
  document.querySelector('#risk').textContent = t(value.risk);
  const expiryDate = new Date(value.expiresAt), expiryNode = document.querySelector('#expires');
  const dateLocale = reviewLocale() === 'zh-CN' ? 'zh-CN' :
    navigator.languages.find(locale => /^en(?:-|$)/i.test(locale)) ?? 'en-SG';
  expiryNode.textContent = expiryDate.toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'long' });
  expiryNode.title = `${expiryDate.toISOString()} (UTC)`;
  document.querySelector('#fingerprint').textContent = value.previewHash;
  document.querySelector('#proposal').textContent = visible(JSON.stringify(value.proposal, null, 2));
  statusNode.textContent = '';
  form.querySelector('.decision-note').append(statusNode);
  reviewSection.hidden = false;
  syncDecisionHeight();
  expiresAt = expiryDate.getTime();
  form.hidden = false;
  statusNode.classList.remove('visually-hidden');
  expiryChip.hidden = false;
  document.querySelector('.request-context').hidden = false;
  document.querySelector('#technical-details').hidden = false;
  setState(t('Pending your decision'));
  checkStatus.hidden = true;
  reviewLoading = false;
  scheduleExpiry(); updateReviewControls();
  if (mediaReview) {
    document.querySelector('#media-review').hidden = false;
    if (document.querySelector('#business-summary').hidden) document.querySelector('#media-title').textContent = t('Photo changes');
    if (!checkExpiry()) void loadMedia(value.toolName, value.proposal, value.resourceId, value.resourceType, value.risk)
      .catch(() => { if (csrf) reviewStatus(t('Image verification failed. Reload this review or reject the proposal.')); });
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
    const change = imageChangeSummary(toolName, proposal, effects);
    renderMediaEffects(effects, labels, proposal, change);
    renderImageChangeSummary(change);
  }
  document.querySelector('#media-effect-records').textContent = visible(JSON.stringify(effects, null, 2));
  document.querySelector('#media-technical').hidden = false;
  const empty = mediaReview.assetItems.length === 0;
  imageViewer.hidden = empty;
  document.querySelector('#media-empty').hidden = !empty;
  updateMediaProgress();
  await verifyRemainingImages();
}
function updateMediaProgress() {
  mediaComplete = acknowledgedImages.size === mediaReview.assetItems.length;
  const total = mediaReview.assetItems.length;
  document.querySelector('#media-progress').textContent = total
    ? t('Images verified {done}/{total}', { done: acknowledgedImages.size, total }) : '';
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
  if (verificationInProgress) return;
  verificationInProgress = true;
  updateReviewControls();
  try {
    for (const item of mediaReview.assetItems) {
      if (!acknowledgedImages.has(item.itemKey) && !await showMediaImage(item)) return;
    }
  } finally {
    verificationInProgress = false;
    updateReviewControls();
  }
}
async function showMediaImage(item) {
  if (checkExpiry() || !csrf) return false;
  releaseMediaImage();
  retryImage = item; imageRetry.hidden = true;
  markCardFailure(item.assetKey, false);
  imageStatus.textContent = t('Loading and verifying the exact image…');
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
    // Give the decoded image time to render if the viewer is open.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (job.signal.aborted || checkExpiry()) return false;
    await acknowledgeMedia(item, packet, job.signal);
    if (job.signal.aborted || checkExpiry()) return false;
    acknowledgedImages.add(item.itemKey);
    const previews = thumbnails.get(item.assetKey);
    if (previews && !previews[0].hasAttribute('src')) {
      thumbnailUrls.set(imageUrl, previews);
      objectUrls.set(item.assetKey, imageUrl);
      for (const thumbnail of previews) {
        thumbnail.src = imageUrl;
        thumbnail.hidden = false;
      }
    }
    updateMediaProgress();
    for (const card of imageCards.get(item.assetKey) ?? []) card.status.textContent = '';
    imageStatus.textContent = t('Exact image verified.');
    if (statusNode.textContent === t('Image verification failed. Retry the image, reload this review or reject the proposal.')) {
      reviewStatus('');
    }
    return true;
  } catch {
    if (job.signal.aborted || checkExpiry()) return false;
    releaseMediaImage();
    imageStatus.textContent = t('Image verification failed. Retry to load and verify it again.');
    reviewStatus(t('Image verification failed. Retry the image, reload this review or reject the proposal.'));
    markCardFailure(item.assetKey, true);
    imageRetry.hidden = imageCards.has(item.assetKey);
    return false;
  }
}
imageRetry.addEventListener('click', () => {
  if (retryImage) void verifyRemainingImages();
});

function markCardFailure(key, failed) {
  for (const card of imageCards.get(key) ?? []) {
    card.retry.hidden = !failed;
    card.status.textContent = failed ? t('Verification failed') : '';
    if (failed) {
      const disclosure = card.retry.closest('.gallery-existing');
      if (disclosure) disclosure.open = true;
    }
  }
}

function mediaReference(key, label, side) {
  const item = mediaReview.assetItems.find(value => value.assetKey === key);
  if (!item) throw new Error('Missing image reference.');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'media-reference';
  button.disabled = true;
  button.textContent = label;
  button.dataset.assetKey = key;
  button.setAttribute('aria-label', side ? `${label} · ${t(side === 'before' ? 'Before' : side === 'current' ? 'Current' : 'After')}` : label);
  const thumbnail = document.createElement('img');
  thumbnail.alt = '';
  thumbnail.hidden = true;
  if (!thumbnails.has(key)) thumbnails.set(key, []);
  thumbnails.get(key).push(thumbnail);
  button.prepend(thumbnail);
  button.addEventListener('click', () => openZoom(button));
  const card = document.createElement('div');
  card.className = 'media-card';
  const status = document.createElement('p');
  status.className = 'media-card-status';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'secondary media-card-retry';
  retry.hidden = true;
  retry.textContent = t('Retry this photo');
  retry.setAttribute('aria-label', t('Retry {photo}', { photo: label }));
  retry.addEventListener('click', () => {
    if (retryImage?.assetKey === key) void verifyRemainingImages();
  });
  card.append(button, status, retry);
  if (!imageCards.has(key)) imageCards.set(key, []);
  imageCards.get(key).push({ status, retry });
  return card;
}

function mediaComparison(headingText) {
  const article = document.createElement('article'), heading = document.createElement('h3');
  heading.textContent = headingText;
  const comparison = document.createElement('div');
  comparison.className = 'comparison media-comparison';
  article.append(heading, comparison);
  return { article, comparison };
}

function mediaSide(side, detail, noPhoto) {
  const line = document.createElement('div'), heading = document.createElement('h4');
  line.className = 'media-state';
  if (noPhoto) line.classList.add('media-state-empty');
  heading.textContent = t(side === 'before' ? 'Before' : side === 'current' ? 'Current' : 'After');
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
  if (key === null) return mediaNote(t('No photo selected'));
  if (rendered[side].has(key)) return mediaNote(t('{photo} · preview shown above', { photo: label }));
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

function imageChangeSummary(toolName, proposal, effects) {
  const target = effects.find(effect => effect.kind === 'PRODUCT' && effect.productId === proposal.productId);
  const listing = effects.find(effect => effect.kind === 'LISTING' && effect.listingId === target?.after.listingId);
  const before = listing?.before.galleryAssetKeys, after = listing?.after.galleryAssetKeys;
  const mainBefore = target?.before.mainAssetKey, mainAfter = target?.after.mainAssetKey;
  if (toolName === 'media.preview_layout' && listing && proposal.confirmsCurrentGallery === true && !proposal.removeMain &&
      effects.every(effect => canonical(effect.before) === canonical(effect.after))) {
    return { kind: 'confirm', listing, main: mainAfter,
      title: t('Review current gallery'), approval: t('Confirm gallery photos'),
      impact: t('Current gallery: {count} photos. Confirming leaves the gallery and main photo as shown.', { count: before.length }),
      decision: t('Confirm the current selection.') };
  }
  const added = before && after && after.length > before.length && before.every((key, index) => key === after[index]);
  if (added && mainBefore === mainAfter && effects.every(effect => effect === listing || canonical(effect.before) === canonical(effect.after))) {
    const count = after.length - before.length, values = { count, before: before.length, after: after.length };
    return { kind: 'add', listing, main: mainAfter,
      title: count === 1 ? t('Add 1 gallery photo') : t('Add {count} gallery photos', values),
      approval: count === 1 ? t('Approve adding 1 photo') : t('Approve adding {count} photos', values),
      impact: t('Gallery goes from {before} to {after} photos · Main photo stays the same', values),
      decision: count === 1 ? t('Add one photo to the gallery. The main product photo stays the same.')
        : t('Add {count} photos to the gallery. The main product photo stays the same.', values) };
  }
  if (toolName === 'media.prepare_upload' && proposal.targetSlot === 'MAIN') {
    const replace = Boolean(mainBefore);
    const decision = replace ? t('Replace the main product photo.') : t('Set the main product photo.');
    let mentionGallery = '';
    if (mainAfter && mainAfter !== mainBefore && after?.includes(mainAfter)) {
      mentionGallery = before.includes(mainAfter) ? t('The new main photo is already in the gallery.')
        : t('The new main photo also appears in the gallery.');
    }
    return { kind: 'main', main: mainAfter, listing,
      title: replace ? t('Replace the main photo') : t('Set the main photo'),
      approval: t('Approve main photo change'),
      decision: mentionGallery ? `${decision} ${mentionGallery}` : decision };
  }
  const changes = [];
  if (proposal.removeMain) changes.push(t('The main product photo is removed.'));
  if (before && after) {
    const oldKeys = new Set(before), newKeys = new Set(after);
    const additions = after.filter(key => !oldKeys.has(key));
    const removals = before.filter(key => !newKeys.has(key));
    const afterRetained = after.filter(key => oldKeys.has(key));
    const orderChanges = before.filter(key => newKeys.has(key)).some((key, index) => key !== afterRetained[index]);
    if (additions.length) changes.push(additions.length === 1 ? t('1 gallery photo added.')
      : t('{count} gallery photos added.', { count: additions.length }));
    if (removals.length) changes.push(removals.length === 1 ? t('1 gallery photo removed.')
      : t('{count} gallery photos removed.', { count: removals.length }));
    if (orderChanges) changes.push(t('Existing gallery photos reordered.'));
  }
  return { kind: 'layout', ...(proposal.removeMain ? { title: t('Remove the main photo') } : {}), decision: changes.join(' ') };
}

function renderImageChangeSummary(change) {
  galleryConfirmation = change.kind === 'confirm';
  if (change.title) setTitle(change.title);
  if (change.approval) document.querySelector('#approve').textContent = change.approval;
  const summary = document.querySelector('#image-change-summary'), impact = document.querySelector('#image-impact');
  summary.textContent = change.decision;
  summary.hidden = !change.decision;
  impact.textContent = change.impact || change.decision;
  impact.hidden = !impact.textContent;
  if (galleryConfirmation) {
    document.querySelector('#media-title').textContent = t('Gallery photos');
    document.querySelector('.intro').textContent = t('Check the current gallery before confirming.');
  }
  const nextStep = document.querySelector('#decision-next');
  nextStep.hidden = galleryConfirmation;
  nextStep.textContent = t('The app must still apply the change after approval.');
  syncDecisionHeight();
}

function renderGallerySelection(root, change) {
  const { listing, main, kind } = change;
  const previous = listing.before.galleryAssetKeys, next = listing.after.galleryAssetKeys;
  const added = kind === 'add', firstNew = added ? previous.length : 0;
  const article = document.createElement('article');
  article.className = 'gallery-addition';
  const heading = document.createElement('h3');
  heading.textContent = added ? t('Photos to add') : t('Current gallery photos');
  article.append(heading);
  const rendered = { before: new Set(), after: new Set(), current: new Set() };
  const gallery = orderedGallery(next.slice(firstNew), added ? 'after' : 'current', rendered, firstNew, main);
  gallery.classList.add('gallery-additions');
  article.append(gallery);
  if (added && previous.length) {
    const existing = document.createElement('details'), label = document.createElement('summary');
    existing.className = 'gallery-existing';
    label.textContent = t('Existing photos ({count})', { count: previous.length });
    existing.append(label, orderedGallery(previous, 'current', rendered, 0, main));
    article.append(existing);
  }
  root.append(article);
}

function renderMediaEffects(effects, labels, proposal, change) {
  const names = new Map();
  for (const label of labels) {
    if (!idPattern.test(label.productId || '') || typeof label.sku !== 'string' || typeof label.name !== 'string' || names.has(label.productId)) throw new Error('Invalid image labels.');
    names.set(label.productId, label);
  }
  const root = document.querySelector('#media-effects'); root.replaceChildren();
  if (change.kind === 'add' || change.kind === 'confirm') {
    renderGallerySelection(root, change);
    return;
  }
  const rendered = { before: new Set(), after: new Set(), current: new Set() };
  const ordered = proposal.targetSlot === 'MAIN'
    ? effects.toSorted((a, b) => Number(b.productId === proposal.productId) - Number(a.productId === proposal.productId))
    : effects;
  const unchanged = document.createElement('details'), unchangedLabel = document.createElement('summary');
  unchanged.className = 'gallery-existing';
  unchangedLabel.textContent = t('Unchanged photos');
  unchanged.append(unchangedLabel);
  for (const effect of ordered) {
    const product = effect.kind === 'PRODUCT';
    if (product && !names.has(effect.productId)) throw new Error('Missing product label.');
    const label = names.get(product ? effect.productId : mediaListingProductId(effect, effects));
    const heading = product ? t('Main product photo · {name}', { name: visible(label.name) })
      : label ? t('Gallery · {name}', { name: visible(label.name) }) : t('Product gallery');
    const { article, comparison } = mediaComparison(heading);
    const same = canonical(effect.before) === canonical(effect.after);
    // A main photo already shown in the changed comparison serves as its gallery preview.
    if (effect === change.listing && change.kind === 'main' && !same) {
      const { before, after } = effect;
      const oldMain = effects.find(row => row.kind === 'PRODUCT' && row.productId === proposal.productId)?.before.mainAssetKey;
      if (oldMain && canonical(before.galleryAssetKeys.map(key => key === oldMain ? change.main : key)) === canonical(after.galleryAssetKeys)) {
        continue;
      }
    }
    for (const side of same ? ['current'] : ['before', 'after']) {
      const state = effect[side === 'current' ? 'after' : side], detail = document.createElement('div');
      if (product) {
        detail.append(mediaPlacement(rendered, state.mainAssetKey, t('Main product photo'), side));
      } else {
        const holderLabel = names.get(state.holderId);
        if (holderLabel) {
          const shared = document.createElement('p');
          shared.textContent = t('Shared photos from {name}', { name: visible(holderLabel.name) });
          detail.append(shared);
        }
        detail.append(state.galleryAssetKeys.length ? orderedGallery(state.galleryAssetKeys, side, rendered) : mediaNote(t('No photo selected')));
      }
      const noPhoto = product ? state.mainAssetKey === null : state.galleryAssetKeys.length === 0;
      comparison.append(mediaSide(side, detail, noPhoto));
    }
    (same ? unchanged : root).append(article);
  }
  if (unchanged.childElementCount > 1) root.append(unchanged);
}

function orderedGallery(keys, side, rendered, basePosition = 0, main = null) {
  const list = document.createElement('ol'); list.className = 'media-visible-gallery';
  list.setAttribute('role', 'list');
  for (const [index, key] of keys.entries()) {
    const item = document.createElement('li'), position = basePosition + index + 1;
    const label = key === main ? t('Main photo · Gallery photo {position}', { position })
      : t('Gallery photo {position}', { position });
    item.append(mediaPlacement(rendered, key, label, side));
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
    const heading = product ? t('Product photos · {name}', { name: visible(label.after.name) })
      : listingLabel ? t('Gallery · {name}', { name: visible(listingLabel.name) }) : t('Product gallery');
    const { article, comparison } = mediaComparison(heading);
    for (const side of ['before','after']) {
      const state = effect[side], detail = document.createElement('div');
      let noPhoto = false;
      if (state === null) {
        if (effect.kind !== 'LISTING' && !(creationProposal && side === 'before' && effect.productId === creationProposal.creationIdentity.productId)) throw new Error('Invalid absent product.');
        detail.textContent = effect.kind === 'PRODUCT' ? t('Not yet created.') : side === 'before' ? t('Did not exist before this change.') : t('Removed by this change.');
      } else if (effect.kind === 'PRODUCT') {
        const sideName = names.get(effect.productId)[side].name;
        if (sideName !== label.after.name) {
          const name = document.createElement('p');
          name.textContent = visible(sideName);
          detail.append(name);
        }
        if (creationProposal && side === 'after' && effect.productId === creationProposal.creationIdentity.productId) {
          const options = document.createElement('p'), rows = catalogCreateOptions(creationProposal);
          options.textContent = rows.length ? t('Options: {options}', { options: visible(rows.map(row => `${row.typeName}: ${row.valueLabel}`).join('; ')) }) : t('Options: none'); detail.append(options);
        }
        const main = document.createElement('p');
        main.append(mediaPlacement(rendered, state.mainAssetKey, t('Main product photo'), side));
        detail.append(main);
        if (state.mainAssetKey !== null && !state.ownMainVisible) {
          const note = document.createElement('p');
          note.textContent = t('The main photo is hidden from shoppers.');
          detail.append(note);
        }
        const listing = listings.get(state.listingId)?.[side]; if (!listing) throw new Error('Missing catalog listing state.');
        if (state.role === 'single' && state.ownMainVisible && !listing.galleryAssetKeys.includes(state.mainAssetKey)) throw new Error('Missing visible own main.');
        noPhoto = state.mainAssetKey === null && listing.galleryAssetKeys.length === 0;
        if (!noPhoto) {
          detail.append(document.createTextNode(t('Shopper gallery in order:')),ordered(state.role === 'single' ? listing.galleryAssetKeys : [...(state.ownMainVisible ? [state.mainAssetKey] : []),...listing.galleryAssetKeys], side));
        }
      } else {
        if (state.holderId !== null && !names.has(state.holderId)) throw new Error('Missing holder label.');
        if (state.holderId !== null) {
          const shared = document.createElement('p');
          shared.textContent = t('Shared photos from {name}', { name: visible(names.get(state.holderId)[side].name) });
          detail.append(shared);
        }
        noPhoto = state.galleryAssetKeys.length === 0;
        detail.append(state.galleryAssetKeys.length ? ordered(state.galleryAssetKeys, side) : mediaNote(t('No photo selected')));
      }
      comparison.append(mediaSide(side, detail, noPhoto));
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
  objectUrls.clear();
}
window.addEventListener('pagehide', event => {
  if (imageDialog.open) imageDialog.close();
  if (event.persisted) releaseMediaImage();
  else releaseMedia();
});

const zoomPrevious = document.querySelector('#image-prev');
const zoomNext = document.querySelector('#image-next');

function openZoom(trigger) {
  zoomTrigger = trigger;
  const seen = new Set();
  zoomItems = [...document.querySelectorAll('.media-reference')].filter(node => {
    const key = node.dataset.assetKey;
    if (!node.getClientRects().length || !objectUrls.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const position = zoomItems.findIndex(node => node.dataset.assetKey === trigger.dataset.assetKey);
  if (position < 0) return;
  zoomIndex = position;
  zoomItems[position] = trigger;
  renderZoom();
  imageDialog.showModal();
}
function renderZoom() {
  const photo = zoomItems[zoomIndex];
  imageZoom.src = objectUrls.get(photo.dataset.assetKey);
  imageZoom.alt = photo.getAttribute('aria-label');
  document.querySelector('#image-dialog-title').textContent = t('{photo} ({current} of {total})', {
    photo: imageZoom.alt, current: zoomIndex + 1, total: zoomItems.length
  });
  zoomPrevious.disabled = zoomIndex === 0;
  zoomNext.disabled = zoomIndex === zoomItems.length - 1;
}
function moveZoom(direction) {
  const next = zoomIndex + direction;
  if (next < 0 || next >= zoomItems.length) return;
  zoomIndex = next;
  renderZoom();
}
zoomPrevious.addEventListener('click', () => moveZoom(-1));
zoomNext.addEventListener('click', () => moveZoom(1));
document.querySelector('#image-close').addEventListener('click', () => imageDialog.close());
imageDialog.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  moveZoom(event.key === 'ArrowRight' ? 1 : -1);
});
imageDialog.addEventListener('close', () => {
  imageZoom.removeAttribute('src');
  if (!zoomTrigger?.disabled) zoomTrigger?.focus();
  else statusNode.focus();
  zoomTrigger = null;
});

function resetReview() {
  releaseMedia();
  acknowledgedImages.clear();
  thumbnails.clear();
  imageCards.clear();
  mediaReview = null;
  mediaComplete = false;
  retryImage = null;
  expired = false;
  terminalStatus = null;
  unknownDecision = false;
  expiresAt = null;
  clearTimeout(expiryTimer);
  expiryTimer = null;
  imageRetry.hidden = true;
  imageStatus.textContent = '';
  document.querySelector('#operation-product').hidden = true;
  document.querySelector('.intro').textContent = t('Check the proposed change before approving.');
  document.querySelector('#media-review').hidden = true;
  document.querySelector('#business-summary').hidden = true;
  document.querySelector('#image-change-summary').hidden = true;
  document.querySelector('#image-impact').hidden = true;
  imageViewer.open = false;
  galleryConfirmation = false;
  approvalSummary = null;
}

function outcomeCopy(state) {
  switch (state) {
    case 'APPROVED':
      return galleryConfirmation
        ? { state: t('Approved · Gallery confirmed'), title: t('Gallery approved'),
          detail: t('Your decision was recorded. The current gallery stays as shown.') }
        : { state: t('Approved · Waiting to be applied'), title: t('Approved'),
          detail: clientName ? t('Return to {app} to apply this change.', { app: visible(clientName) }) : t('Return to the requesting app to apply this change.') };
    case 'COMMITTED': return galleryConfirmation
      ? { state: t('Gallery confirmed'), title: t('Gallery confirmed'), detail: t('Your decision was recorded. The current gallery stays as shown.') }
      : { state: t('Applied'), title: t('Applied'), detail: t('The connected app finished applying the approved operation.') };
    case 'REJECTED': return { state: t('Rejected'), title: t('Rejected'), detail: t('No change was made.') };
    case 'EXPIRED': return { state: t('Expired'), title: t('Expired'), detail: t('Ask the connected app for a new preview.') };
    case 'CANCELLED': return { state: t('Cancelled'), title: t('Cancelled'), detail: t('No change was made.') };
    case 'CONFLICT': return { state: t('Proposal conflicts with a newer change'), title: t('Proposal changed'), detail: t('Ask the connected app for a new preview.') };
    case 'FAILED': return { state: t('Could not be applied'), title: t('Could not be applied'), detail: t('Return to the requesting app for details.') };
  }
}

async function showTerminalState(state, modal = false) {
  const fresh = reviewSection.hidden;
  const copy = outcomeCopy(state);
  csrf = null; previewHash = null; challenge = null;
  terminalStatus = state; unknownDecision = false;
  form.hidden = true;
  clearTimeout(expiryTimer); expiryTimer = null; expiresAt = null;
  expiryChip.hidden = true;
  document.querySelector('#currency-warning').hidden = true;
  if (fresh) {
    setTitle(t('Review result'));
    document.querySelector('.request-context').hidden = true;
    document.querySelector('#technical-details').hidden = true;
  }
  reviewSection.hidden = false;
  setState(copy.state);
  checkStatus.hidden = state !== 'APPROVED' || galleryConfirmation;
  proposalRetry.before(statusNode);
  statusNode.textContent = modal ? `${copy.state}. ${copy.detail}` : copy.detail;
  statusNode.classList.toggle('visually-hidden', modal);
  const summary = approvalSummary;
  approvalSummary = null;
  if (!modal) return;
  if (state === 'APPROVED') {
    try {
      const { showApprovalSuccess } = await import('../seller/approval-success.js');
      showApprovalSuccess({ ...summary, galleryConfirmation,
        preference: language?.preferredLocale?.() ?? navigator.language, onClose: restoreResultFocus });
      return;
    } catch { /* If the enhancement is unavailable, keep the confirmed outcome and show the plain result. */ }
  }
  document.querySelector('#result-title').textContent = copy.title;
  document.querySelector('#result-description').textContent = copy.detail;
  document.querySelector('#result-check').toggleAttribute('hidden', state !== 'APPROVED');
  resultDialog.showModal();
}

function restoreResultFocus() {
  // The submitter is now hidden; return to the visible result in the review instead.
  statusNode.classList.remove('visually-hidden');
  statusNode.focus();
}
document.querySelector('#result-close').addEventListener('click', () => resultDialog.close());
resultDialog.addEventListener('close', restoreResultFocus);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (checkExpiry() || decisionPending || unknownDecision || reviewLoading) return;
  const decision = event.submitter?.value;
  if (!csrf || !previewHash || !challenge || !['approve', 'reject'].includes(decision)) return;
  if (decision === 'approve' && mediaReview && !mediaComplete) return;
  if (decision === 'approve' && currencyAcknowledgementRequired && !currencyAck.checked) {
    statusNode.textContent = t('Read the currency warning and check the acknowledgment before approving.');
    currencyAck.focus(); return;
  }
  decisionPending = true; updateReviewControls();
  statusNode.textContent = t(decision === 'approve' ? 'Approving…' : 'Rejecting…');
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
    const state = decision === 'approve' ? 'APPROVED' : 'REJECTED';
    if (result.operationId !== id || result.status !== state) throw new Error('Invalid result.');
    if (decision === 'reject' && !mediaComplete) releaseMediaImage();
    await showTerminalState(state, true);
  } catch {
    unknownDecision = true;
    checkStatus.hidden = false;
    if (!checkExpiry()) {
      statusNode.textContent = t('We could not confirm the result. Check the status before trying again.');
      setState(t('Decision status unknown'));
    }
  } finally {
    decisionPending = false; updateReviewControls();
  }
});

async function loadReview() {
  if (reviewLoading || decisionPending) return;
  reviewLoading = true;
  updateReviewControls();
  proposalRetry.hidden = true;
  statusNode.textContent = t('Loading the proposal…');
  try {
    await load();
  } catch (error) {
    if (form.contains(statusNode)) proposalRetry.before(statusNode);
    if (error.message === 'Sign in required.') {
      reviewSection.hidden = true;
      sellerLink.href = `${base}/seller/?reviewOperation=${id}`;
      sellerLink.textContent = t('Sign in to review this proposal');
      statusNode.textContent = t('Sign in to Seller Studio to review this proposal.');
    } else if (error.message === 'Temporary proposal failure.' || error.message === 'Session unavailable.') {
      statusNode.textContent = t('The proposal is unavailable. Try again to load this preview.');
      proposalRetry.hidden = false;
    } else {
      if (terminalStatus === null && !unknownDecision) reviewSection.hidden = true;
      statusNode.textContent = t('The proposal is unavailable. Ask the connected app to prepare a new preview.');
    }
  } finally {
    reviewLoading = false;
    updateReviewControls();
  }
}

proposalRetry.addEventListener('click', loadReview);
checkStatus.addEventListener('click', () => {
  void loadReview().then(() => statusNode.focus());
});
void loadReview();
