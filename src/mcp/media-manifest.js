import { MEDIA_LIMITS } from './media-schema.js';
import { MIME } from './media-codec-wire.js';
import { catalogProductLabels, catalogReviewLabels, catalogCreateEffects } from './catalog-media-review-wire.js';
import { freezeMedia, isMediaHash, isMediaUuid, makeMediaDescriptor, makeMediaPolicyRow, mediaDescriptorHash,
  mediaHash, mediaJson, mediaObject, mediaPolicyForTool, validateRetainedMediaPolicy } from './media-policy.js';

const invalid = () => { throw new TypeError('Invalid media manifest.'); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function shape(value, keys) {
  if (!value || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || keys.some(key => !own.includes(key)) ||
      own.some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) invalid();
}
function array(value, max) {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
}
const assetFields = ['source_kind', 'source_id', 'source_product_id', 'stage_id', 'byte_sha256', 'mime', 'byte_length'];
const sqlAssetFields = ['asset_key', ...assetFields, 'before_needed', 'after_needed'];
export function mediaAssetKey(mime, byteSha256) {
  if (!Object.values(MIME).includes(mime) || !isMediaHash(byteSha256)) invalid();
  return mediaHash(mediaJson({ mime, byteSha256 }));
}
function asset(value) {
  mediaObject(value, assetFields);
  if (!['PRODUCT_MAIN', 'GALLERY', 'STAGE'].includes(value.source_kind) || !isMediaUuid(value.source_id) ||
      !isMediaUuid(value.source_product_id) || !Number.isSafeInteger(value.byte_length) || value.byte_length < 1 ||
      value.byte_length > MEDIA_LIMITS.sourceBytes ||
      (value.source_kind === 'STAGE' ? value.stage_id !== value.source_id : value.stage_id !== null) ||
      (value.source_kind === 'PRODUCT_MAIN' && value.source_id !== value.source_product_id)) invalid();
  return { ...value, asset_key: mediaAssetKey(value.mime, value.byte_sha256) };
}
function effect(value, reserved, catalogTool = null) {
  const catalogUpdate=catalogTool==='catalog.preview_update',catalog=Boolean(catalogTool);
  if (!value || !['PRODUCT', 'LISTING'].includes(Object.getOwnPropertyDescriptor(value, 'kind')?.value)) invalid();
  const product = value.kind === 'PRODUCT', id = product ? 'productId' : 'listingId';
  mediaObject(value, ['kind', id, 'before', 'after', ...(product && catalog ? ['labels'] : [])]);
  if (product && catalogUpdate && (value.before === null || value.after === null)) invalid();
  if (!isMediaUuid(value[id]) || (product && value.after === null) || (!reserved && (value.before === null || value.after === null))) invalid();
  for (const side of ['before', 'after']) {
    const state = value[side]; if (state === null) continue;
    if (product) {
      mediaObject(state, ['listingId', 'role', 'mainAssetKey', ...(catalog ? ['ownMainVisible'] : [])]);
      if (!isMediaUuid(state.listingId) || !['single', 'holder', 'variant'].includes(state.role) ||
          !(state.mainAssetKey === null || isMediaHash(state.mainAssetKey))) invalid();
      if (catalog && (typeof state.ownMainVisible !== 'boolean' || state.mainAssetKey === null && state.ownMainVisible)) invalid();
    } else {
      mediaObject(state, ['holderId', 'galleryAssetKeys']);
      if (!(state.holderId === null || isMediaUuid(state.holderId))) invalid();
      array(state.galleryAssetKeys, 10);
      // Distinct legacy associations can contain identical pixels; preserve every ordered position.
      if (!state.galleryAssetKeys.every(isMediaHash)) invalid();
    }
  }
  if (value.before === null && value.after === null) invalid();
  if (product && catalog) catalogProductLabels(value.labels,catalogTool);
  if (!reserved && (product ? value.before.listingId !== value.after.listingId || value.before.role !== value.after.role
    : value.before.holderId !== value.after.holderId)) invalid();
  return JSON.parse(mediaJson(value));
}
function graph(effects, assets, aliases, creationParent=false) {
  const products = effects.filter(item => item.kind === 'PRODUCT'), listings = effects.filter(item => item.kind === 'LISTING');
  if (!products.length || products.length > MEDIA_LIMITS.products || !listings.length || listings.length > MEDIA_LIMITS.listings) invalid();
  const before = new Set(), after = new Set();
  const productIds = new Set(products.filter(item => creationParent || item.before !== null).map(item => item.productId));
  for (const candidate of aliases) if (!productIds.has(candidate.source_product_id)) invalid();
  for (const side of ['before', 'after']) {
    const used = side === 'before' ? before : after;
    const membership = new Map(listings.map(item => [item.listingId, []]));
    for (const item of products) {
      const state = item[side]; if (state === null) continue;
      if (!membership.has(state.listingId)) invalid();
      membership.get(state.listingId).push(item.productId);
      if (state.mainAssetKey !== null) {
        used.add(state.mainAssetKey);
        if (side === 'after' && assets.get(state.mainAssetKey)?.source_kind === 'STAGE' &&
            !aliases.some(alias => alias.source_kind === 'STAGE' && alias.asset_key === state.mainAssetKey && alias.source_product_id === item.productId)) invalid();
      }
    }
    for (const item of listings) {
      const state = item[side], members = membership.get(item.listingId);
      if (state === null ? members.length !== 0 : members.length === 0) invalid();
      if (state === null) continue;
      if (members.length === 1 ? state.holderId !== null : !members.includes(state.holderId)) invalid();
      for (const id of members) {
        const stateOfProduct = products.find(product => product.productId === id)[side];
        const role = members.length === 1 ? 'single' : state.holderId === id ? 'holder' : 'variant';
        if (stateOfProduct.role !== role) invalid();
      }
      for (const key of state.galleryAssetKeys) {
        used.add(key);
        if (side === 'after' && assets.get(key)?.source_kind === 'STAGE' &&
            !aliases.some(alias => alias.source_kind === 'STAGE' && alias.asset_key === key && alias.source_product_id === (state.holderId ?? members[0]))) invalid();
      }
    }
    for (const key of used) if (!assets.has(key)) invalid();
  }
  for (const candidate of aliases.filter(item => item.source_kind === 'STAGE')) {
    const ownMain = products.some(item => item.productId === candidate.source_product_id && item.after?.mainAssetKey === candidate.asset_key);
    const shared = listings.some(item => item.after?.galleryAssetKeys.includes(candidate.asset_key) &&
      (item.after.holderId ?? products.find(product => product.after?.listingId === item.listingId)?.productId) === candidate.source_product_id);
    if (!after.has(candidate.asset_key) || (!ownMain && !shared)) invalid();
  }
  for (const [key, value] of assets) {
    if (!before.has(key) && !after.has(key)) invalid();
    if (before.has(key) && value.source_kind === 'STAGE') invalid();
    value.before_needed = Number(before.has(key)); value.after_needed = Number(after.has(key));
  }
}
function pageHeader(input, index, version) {
  return { version, toolName: input.toolName, graphRevision: input.graphRevision, codecDigest: input.codecDigest,
    graphBytes: input.graphBytes, pageIndex: index };
}
/** Closed metadata only; real ownership/bytes/grants/revision/approval must be checked elsewhere. */
export function buildMediaManifest(input) { return build(input,1); }
export function buildCatalogParentMediaManifest(input) { return build(input,2); }
function build(input,version) {
  const creationParent=version===2;
  if(creationParent&&input?.toolName!=='catalog.preview_create')invalid();
  shape(input, ['toolName', 'graphRevision', 'codecDigest', 'graphBytes', 'assets', 'effects']);
  const policy = mediaPolicyForTool(input.toolName);
  if (input.toolName !== policy.previewTool || ![input.graphRevision, input.codecDigest].every(isMediaHash)) invalid();
  mediaObject(input.graphBytes, ['oldBytes', 'newBytes']);
  const { oldBytes, newBytes } = input.graphBytes;
  if (![oldBytes, newBytes].every(Number.isSafeInteger) || oldBytes < 0 || newBytes < 0 ||
      oldBytes > MEDIA_LIMITS.oldBytes || newBytes > MEDIA_LIMITS.newBytes || oldBytes + newBytes > MEDIA_LIMITS.graphBytes) invalid();
  array(input.assets, MEDIA_LIMITS.records); array(input.effects, MEDIA_LIMITS.records);
  const aliases = input.assets.map(asset), assets = new Map(), sources = new Map(), stages = new Map(), old = new Map();
  const catalogTool = ['catalog.preview_update','catalog.preview_create'].includes(input.toolName) && policy.policyId === 'catalog-media-v1' ? input.toolName : null;
  if (catalogTool && !creationParent && (newBytes !== 0 || aliases.some(value => value.source_kind === 'STAGE'))) invalid();
  if(creationParent&&(!aliases.some(value=>value.source_kind==='STAGE')||newBytes===0))invalid();
  const sourceOrder = value => `${value.source_kind === 'STAGE' ? '1' : '0'}:${value.source_kind}:${value.source_product_id}:${value.source_id}`;
  for (const value of aliases) {
    const source = `${value.source_kind}:${value.source_id}`, priorSource = sources.get(source);
    if (priorSource && mediaJson(priorSource) !== mediaJson(value)) invalid();
    sources.set(source, value);
    const previous = assets.get(value.asset_key);
    if (previous && previous.byte_length !== value.byte_length) invalid();
    if (!previous || compare(sourceOrder(value), sourceOrder(previous)) < 0) assets.set(value.asset_key, { ...value });
    if (value.source_kind === 'STAGE') {
      const priorStage = stages.get(value.stage_id);
      if (priorStage && mediaJson(priorStage) !== mediaJson(value)) invalid();
      stages.set(value.stage_id, value);
    } else old.set(value.asset_key, value.byte_length);
  }
  if (assets.size > MEDIA_LIMITS.assets || old.size > MEDIA_LIMITS.oldAssets || stages.size > MEDIA_LIMITS.newAssets ||
      [...old.values()].reduce((a, b) => a + b, 0) > oldBytes ||
      [...stages.values()].reduce((sum, value) => sum + value.byte_length, 0) > newBytes) invalid();
  const effects = input.effects.map(value => effect(value, policy.flow === 'RESERVED', catalogTool));
  if (catalogTool) catalogReviewLabels(effects.filter(value => value.kind === 'PRODUCT')
    .map(value => ({ productId: value.productId, ...value.labels })).sort((a,b) => compare(a.productId,b.productId)),catalogTool);
  if (catalogTool==='catalog.preview_create') catalogCreateEffects(effects,undefined,creationParent);
  const ids = effects.map(value => `${value.kind}:${value.productId ?? value.listingId}`);
  if (!effects.length || new Set(ids).size !== ids.length || effects.length + assets.size > MEDIA_LIMITS.records) invalid();
  graph(effects, assets, aliases,creationParent);
  const assetRecords = [...assets.values()].sort((a, b) => compare(a.asset_key, b.asset_key)).map(value => ({ kind: 'ASSET', ...value,
    stage_refs: [...stages.values()].filter(stage => stage.asset_key === value.asset_key).sort((a, b) => compare(a.stage_id, b.stage_id))
      .map(stage => ({ stage_id: stage.stage_id, source_product_id: stage.source_product_id, canonical_sha256: stage.byte_sha256 })) }));
  effects.sort((a, b) => compare(`${a.kind}:${a.productId ?? a.listingId}`, `${b.kind}:${b.productId ?? b.listingId}`));
  const records = [...assetRecords, ...effects], pages = []; let pending = [];
  const json = records => mediaJson({ ...pageHeader(input, pages.length,version), records });
  const flush = () => {
    const page_json = json(pending); pages.push({ page_index: pages.length, page_json,
      page_hash: mediaHash(page_json), record_count: pending.length }); pending = [];
  };
  for (const record of records) {
    let fits = pending.length < MEDIA_LIMITS.pageRecords;
    try { if (fits) json([...pending, record]); } catch { fits = false; }
    if (!fits) { if (!pending.length) invalid(); flush(); }
    json([...pending, record]); pending.push(record);
  }
  if (pending.length) flush();
  if (pages.length > MEDIA_LIMITS.pages || pages.reduce((sum, page) => sum + Buffer.byteLength(page.page_json), 0) > MEDIA_LIMITS.pages * MEDIA_LIMITS.pageBytes) invalid();
  const root = { version, policyId: policy.policyId, codecDigest: input.codecDigest, graphRevision: input.graphRevision,
    graphBytes: { ...input.graphBytes }, pages: pages.map(page => ({ index: page.page_index, hash: page.page_hash, recordCount: page.record_count })),
    assetCount: assets.size, effectCount: effects.length };
  const descriptor = makeMediaDescriptor(input.toolName, { manifestRoot: mediaHash(mediaJson(root)), graphRevision: input.graphRevision,
    codecDigest: input.codecDigest, pageCount: pages.length, assetCount: assets.size, effectCount: effects.length });
  return freezeMedia({ descriptor, descriptorHash: mediaDescriptorHash(descriptor), pages,
    assets: assetRecords.map(({ kind, stage_refs, ...row }) => row), effects,
    stages: [...stages.values()].sort((a, b) => compare(a.stage_id, b.stage_id)).map(value => ({ stage_id: value.stage_id,
      source_product_id: value.source_product_id, canonical_sha256: value.byte_sha256, codec_digest: input.codecDigest })) });
}
/** Exact schema31 row names; performs no database writes or authorization. */
function rowsFor(manifest, context) {
  const policy = makeMediaPolicyRow(context, manifest.descriptor);
  return freezeMedia({ policy, pages: manifest.pages.map(page => ({ operation_id: context.operationId, ...page, created_at: context.createdAt })),
    assets: manifest.assets.map(row => ({ operation_id: context.operationId, ...row })) });
}
/** Validate canonical ordered SQL metadata rows, including pages and deduplicated asset references. */
export function readMediaManifest(frame, operation, proposalDescriptor = undefined) {
  shape(frame, ['policy', 'pages', 'assets']);
  const descriptor = validateRetainedMediaPolicy(operation, frame.policy, proposalDescriptor);
  if (!descriptor) invalid();
  array(frame.pages, MEDIA_LIMITS.pages); array(frame.assets, MEDIA_LIMITS.assets);
  if (!frame.pages.length) invalid();
  const records = []; let header;
  for (const [index, page] of frame.pages.entries()) {
    mediaObject(page, ['operation_id', 'page_index', 'page_json', 'page_hash', 'record_count', 'created_at']);
    if (page.operation_id !== frame.policy.operation_id || page.created_at !== frame.policy.created_at || page.page_index !== index ||
        typeof page.page_json !== 'string' || Buffer.byteLength(page.page_json) > MEDIA_LIMITS.pageBytes || mediaHash(page.page_json) !== page.page_hash) invalid();
    let body;
    try { body = JSON.parse(page.page_json); } catch { invalid(); }
    if (mediaJson(body) !== page.page_json) invalid();
    shape(body, ['version', 'toolName', 'graphRevision', 'codecDigest', 'graphBytes', 'pageIndex', 'records']);
    array(body.records, MEDIA_LIMITS.pageRecords);
    if (![1,2].includes(body.version) || body.version===2&&operation.tool_name!=='catalog.preview_create' || body.pageIndex !== index || body.toolName !== operation.tool_name || body.records.length !== page.record_count) invalid();
    const { records: _records, pageIndex: _index, ...common } = body;
    if (header && mediaJson(header) !== mediaJson(common)) invalid(); header = common;
    records.push(...body.records);
    if (records.length > MEDIA_LIMITS.records) invalid();
  }
  const inputAssets = [], effects = [];
  for (const record of records) {
    if (record.kind !== 'ASSET') { effects.push(record); continue; }
    mediaObject(record, ['kind', ...sqlAssetFields, 'stage_refs']);
    inputAssets.push(Object.fromEntries(assetFields.map(key => [key, record[key]])));
    array(record.stage_refs, MEDIA_LIMITS.newAssets);
    for (const stage of record.stage_refs) {
      mediaObject(stage, ['stage_id', 'source_product_id', 'canonical_sha256']);
      inputAssets.push({ source_kind: 'STAGE', source_id: stage.stage_id, stage_id: stage.stage_id,
        source_product_id: stage.source_product_id, byte_sha256: stage.canonical_sha256, mime: record.mime, byte_length: record.byte_length });
    }
  }
  const rebuilt = build({ toolName: header.toolName, graphRevision: header.graphRevision, codecDigest: header.codecDigest,
    graphBytes: header.graphBytes, assets: inputAssets, effects },header.version);
  const expected = rowsFor(rebuilt, { operationId: frame.policy.operation_id, toolName: operation.tool_name,
    createdAt: frame.policy.created_at, expiresAt: frame.policy.expires_at });
  // Each bounded row is checked separately: a paged manifest can exceed the envelope64KiB cap.
  if (mediaJson(expected.policy) !== mediaJson(frame.policy) || expected.pages.length !== frame.pages.length || expected.assets.length !== frame.assets.length ||
      expected.pages.some((page, index) => mediaJson(page, Infinity) !== mediaJson(frame.pages[index], Infinity)) ||
      expected.assets.some((row, index) => mediaJson(row) !== mediaJson(frame.assets[index]))) invalid();
  return rebuilt;
}
export function mediaManifestRows(manifest, context) {
  shape(manifest, ['descriptor', 'descriptorHash', 'pages', 'assets', 'effects', 'stages']);
  array(manifest.pages, MEDIA_LIMITS.pages); array(manifest.assets, MEDIA_LIMITS.assets);
  array(manifest.effects, MEDIA_LIMITS.records); array(manifest.stages, MEDIA_LIMITS.newAssets);
  if (manifest.descriptorHash !== mediaDescriptorHash(manifest.descriptor)) invalid();
  const frame = rowsFor(manifest, context), policy = mediaPolicyForTool(context.toolName);
  const checked = readMediaManifest(frame, { id: context.operationId, tool_name: context.toolName,
    media_policy_id: policy.policyId, required_scope: policy.requiredScopes[0], required_capability: policy.capability,
    risk: policy.risk, created_at: context.createdAt, expires_at: context.expiresAt }, manifest.descriptor);
  for (const key of ['effects', 'stages']) {
    if (checked[key].length !== manifest[key].length || checked[key].some((row, i) => mediaJson(row) !== mediaJson(manifest[key][i]))) invalid();
  }
  return frame;
}
