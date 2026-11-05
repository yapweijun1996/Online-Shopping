import { randomUUID, createHash } from 'node:crypto';
import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';
import { validateProductInput } from '../product-input.js';
import { updateProduct, applyPlannedProductUpdate } from '../products.js';
import { plannedListingIdentity } from '../listings.js';
import { trackUpdate } from '../product-history.js';
import { withInventoryContext } from '../inventory.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { catalogUpdateTool, catalogUpdateChangesSchema } from './catalog-tools.js';
import { prepareCatalogMediaUpdate, readCatalogMediaUpdateState, readCatalogMediaUpdateAfter, CATALOG_UPDATE_WARNING_CODES } from './catalog-media-update-state.js';
import { buildCatalogUpdateReviewManifest } from './catalog-media-review-manifest.js';
import { catalogReviewLabels } from './catalog-media-review-wire.js';
import { loadOldMediaAsset } from './media-resources.js';
import { mediaContext } from './media-storage.js';
import { readMediaFrame } from './media-frame-storage.js';
import { validateMediaDescriptor } from './media-policy.js';
import { valid } from './tools.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const json = canonicalOperationJson, same = (a, b) => json(a) === json(b);
const invalid = () => { throw new ApiError(400, 'CATALOG_UPDATE_INPUT', 'Invalid catalog update.'); };
const changed = () => { throw new ApiError(409, 'CATALOG_DEPENDENCY_CHANGED', 'The catalog dependencies changed.'); };
const large = () => { throw new ApiError(503, 'CATALOG_REVIEW_TOO_LARGE', 'The complete catalog review exceeds its safe limit.'); };
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
const refFields = ['source_kind', 'source_id', 'source_product_id', 'stage_id', 'byte_sha256', 'mime', 'byte_length'];
const usedRefs = prepared => prepared.manifest.assets.map(source => Object.fromEntries(refFields.map(key => [key, source[key]])));
function shape(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length ||
    keys.some(key => { const d = Object.getOwnPropertyDescriptor(value, key); return !d?.enumerable || !Object.hasOwn(d, 'value'); })) invalid();
}
function input(value) {
  try { json(value); } catch { invalid(); }
  shape(value, ['id', 'changes']);
  if (!uuid.test(value.id || '') || !valid(value.changes, catalogUpdateChangesSchema()) || !Object.keys(value.changes).length) invalid();
}
const requestHash = args => createHash('sha256').update(json(args)).digest('hex');
function proposalBytes(value) {
  let text;
  try { text = json(value); } catch { large(); }
  if (Buffer.byteLength(text) > 48 * 1024) large();
  return text;
}
async function controlled(work) {
  try { return await work(); }
  catch (error) { if (error instanceof FieldError) invalid(); throw error; }
}

/** Closed stored proposal parser; integrity data only, never authorization. */
export function parseCatalogMediaUpdateProposal(value) {
  const text = proposalBytes(value);
  shape(value, ['kind', 'productId', 'normalizedInput', 'plannedIdentity', 'catalogReview', 'reviewLabels', 'reviewBinding', 'media']);
  if (value.kind !== 'update' || !uuid.test(value.productId || '') || !valid(value.normalizedInput, catalogUpdateChangesSchema()) || !Object.keys(value.normalizedInput).length) invalid();
  let normalized;
  try { normalized = validateProductInput(value.normalizedInput, ['MYR', 'SGD'], { partial: true }); } catch { invalid(); }
  if (!same(normalized, value.normalizedInput)) invalid();
  if (value.plannedIdentity !== null && plannedListingIdentity(value.plannedIdentity).productId !== value.productId) invalid();
  const labels = catalogReviewLabels(value.reviewLabels), seen = new Set();
  if (!labels.some(row => row.productId === value.productId)) invalid();
  shape(value.catalogReview, ['products', 'listings', 'warnings']);
  if (!Array.isArray(value.catalogReview.warnings) || value.catalogReview.warnings.length > CATALOG_UPDATE_WARNING_CODES.length ||
      new Set(value.catalogReview.warnings).size !== value.catalogReview.warnings.length || value.catalogReview.warnings.some(code => !CATALOG_UPDATE_WARNING_CODES.includes(code))) invalid();
  if (!Array.isArray(value.catalogReview.products) || !value.catalogReview.products.length || value.catalogReview.products.length > 300 ||
      !Array.isArray(value.catalogReview.listings) || value.catalogReview.listings.length > 2) invalid();
  const metadataKeys = ['id', 'listingId', 'sku', 'name', 'description', 'categoryCode', 'priceMinor', 'currency', 'active',
    'stockQuantity', 'variantGroup', 'variantLabel', 'createdAt', 'category', 'options'];
  for (const effect of value.catalogReview.products) {
    shape(effect, ['productId', 'before', 'after']);
    const label = labels.find(row => row.productId === effect.productId);
    if (!label || seen.has(effect.productId)) invalid(); seen.add(effect.productId);
    for (const side of ['before', 'after']) {
      const row = effect[side]; shape(row, metadataKeys);
      if (row.id !== effect.productId || !uuid.test(row.listingId || '') || !same({ sku: row.sku, name: row.name }, label[side])) invalid();
      shape(row.category, ['code', 'label', 'active']);
      if (row.category.code !== row.categoryCode || !Array.isArray(row.options) || row.options.length > 1800) invalid();
      for (const option of row.options) shape(option, ['typeId', 'valueId', 'typeName', 'typeCode', 'valueLabel', 'valueCode', 'typeActive', 'valueActive']);
    }
  }
  if (!seen.has(value.productId)) invalid(); seen.clear();
  for (const effect of value.catalogReview.listings) {
    shape(effect, ['listingId', 'before', 'after']);
    if (!uuid.test(effect.listingId || '') || seen.has(effect.listingId) || effect.before === null && effect.after === null) invalid(); seen.add(effect.listingId);
    for (const side of ['before', 'after']) if (effect[side] !== null) {
      shape(effect[side], ['id', 'code', 'name', 'description', 'categoryCode']);
      if (effect[side].id !== effect.listingId) invalid();
    }
  }
  shape(value.reviewBinding, ['version', 'baseRevision', 'reviewProjectionHash']);
  if (value.reviewBinding.version !== 1 || ![value.reviewBinding.baseRevision, value.reviewBinding.reviewProjectionHash].every(item => hashPattern.test(item || ''))) invalid();
  validateMediaDescriptor(value.media, 'catalog.preview_update');
  return frozen(JSON.parse(text));
}

/** Shared live read for prepare/currentRevision/first-party review. No native
 * work, tenant selection, approval or business mutation occurs here. */
export async function readCatalogMediaUpdateReview(read, inputValue, codecDigest) {
  shape(inputValue, ['productId', 'normalizedInput', 'plannedIdentity']);
  if (!hashPattern.test(codecDigest || '')) invalid();
  const state = await controlled(() => readCatalogMediaUpdateState(read, { productId: inputValue.productId,
    changes: inputValue.normalizedInput, plannedIdentity: inputValue.plannedIdentity }));
  if (!same(state.normalizedPatch, inputValue.normalizedInput)) invalid();
  const labels = catalogReviewLabels(state.catalog.products.map(row => ({ productId: row.productId,
    before: { sku: row.before.sku, name: row.before.name }, after: { sku: row.after.sku, name: row.after.name } })));
  const built = buildCatalogUpdateReviewManifest({ snapshot: state.state.mediaSnapshot, beforeGraph: state.beforeGraph,
    projection: state.projection, reviewLabels: labels, plannedIdentity: state.plannedIdentity,
    baseRevision: state.baseRevision, codecDigest });
  const proposal = parseCatalogMediaUpdateProposal({ kind: 'update', productId: state.productId,
    normalizedInput: state.normalizedPatch, plannedIdentity: state.plannedIdentity, catalogReview: state.review,
    reviewLabels: labels, reviewBinding: built.reviewBinding, media: built.manifest.descriptor });
  return { ...state, ...built, reviewLabels: labels, proposal };
}

const receipt = value => {
  try { shape(value, ['productId', 'listingId', 'revision']); }
  catch { return false; }
  return typeof value.productId === 'string' && uuid.test(value.productId) && typeof value.listingId === 'string' && uuid.test(value.listingId) &&
    typeof value.revision === 'string' && hashPattern.test(value.revision);
};
function assertContext(context, other) { if (!same(mediaContext(context), mediaContext(other))) changed(); }
function assertResolved(prepared, resources, codecDigest, context) {
  assertContext(context, resources.context);
  if (resources.productId !== prepared.productId || resources.revision !== prepared.revision || resources.codecDigest !== codecDigest ||
      !same(resources.normalizedInput, prepared.normalizedPatch) || !same(resources.plannedIdentity, prepared.plannedIdentity)) changed();
  const expected = usedRefs(prepared);
  if (!Array.isArray(resources.sources) || resources.sources.length !== expected.length || expected.some(ref => !resources.sources.some(source =>
    refFields.every(key => source[key] === ref[key]) && Number.isSafeInteger(source.width) && source.width > 0 && Number.isSafeInteger(source.height) && source.height > 0))) changed();
}

/** Constructor-only adapter. Its RESERVED marker is still rejected by the
 * current engine until a separately reviewed activation is supplied. */
export function catalogMediaUpdateAdapter(runtime) {
  if (typeof runtime?.codecDigest !== 'string' || !hashPattern.test(runtime.codecDigest) || typeof runtime.nativeSession !== 'function') throw new TypeError('Trusted catalog media runtime required.');
  const { codecDigest, nativeSession } = runtime;
  const media = Object.freeze({
    policyId: 'catalog-media-v1', codecDigest,
    async capture(read, args, context) {
      input(args); mediaContext(context);
      const metadata = await controlled(() => prepareCatalogMediaUpdate(read, { productId: args.id, changes: args.changes }));
      const plannedIdentity = metadata.needsPlannedIdentity ? { productId: args.id,
        previousListingId: metadata.metadata.selector.sourceListingId, targetCode: metadata.targetPlan.code, newListingId: randomUUID() } : null;
      const prepared = await readCatalogMediaUpdateReview(read, { productId: args.id,
        normalizedInput: metadata.normalizedPatch, plannedIdentity }, codecDigest);
      const old = [];
      for (const ref of usedRefs(prepared)) old.push({ ref, bytes: (await loadOldMediaAsset(read, prepared.state.mediaSnapshot, ref)).data });
      return { resourceId: args.id, expectedRevision: prepared.revision, resources: { context: mediaContext(context),
        productId: args.id, requestHash: requestHash(args), normalizedInput: prepared.normalizedPatch,
        plannedIdentity, revision: prepared.revision, codecDigest, old } };
    },
    async resolve(captured, options) {
      mediaContext(captured.context);
      if (captured.codecDigest !== codecDigest || !hashPattern.test(captured.revision || '') || !Array.isArray(captured.old) || captured.old.length > 32) changed();
      const native = nativeSession(options), sources = [];
      for (const asset of captured.old) {
        const decoded = await native.decode(asset.bytes, asset.ref.mime, asset.ref.byte_sha256);
        sources.push({ ...asset.ref, width: decoded.width, height: decoded.height });
      }
      return { context: captured.context, productId: captured.productId, requestHash: captured.requestHash,
        normalizedInput: captured.normalizedInput, plannedIdentity: captured.plannedIdentity,
        revision: captured.revision, codecDigest, sources };
    },
    async persistResources(_writer, envelope, resolved, context) {
      const proposal = parseCatalogMediaUpdateProposal(envelope.proposal);
      assertContext(context, resolved.context);
      if (envelope.resourceType !== 'product' || envelope.resourceId !== resolved.productId || envelope.expectedRevision !== resolved.revision ||
          proposal.media.codecDigest !== codecDigest || resolved.codecDigest !== codecDigest || !same(proposal.normalizedInput, resolved.normalizedInput) ||
          !same(proposal.plannedIdentity, resolved.plannedIdentity)) changed();
    },
    async consumeResources(_writer, envelope, context) {
      mediaContext(context); parseCatalogMediaUpdateProposal(envelope.proposal);
      // Existing-only UPDATE has neither uploaded stages nor a second lifecycle.
    },
  });
  return Object.freeze({ resourceType: 'product', media,
    async preview(read, args, resolved, context) {
      input(args);
      if (resolved.requestHash !== requestHash(args) || resolved.productId !== args.id) changed();
      const prepared = await readCatalogMediaUpdateReview(read, { productId: args.id,
        normalizedInput: resolved.normalizedInput, plannedIdentity: resolved.plannedIdentity }, codecDigest);
      assertResolved(prepared, resolved, codecDigest, context);
      const { media: _media, ...proposal } = prepared.proposal;
      return { resourceId: args.id, expectedRevision: prepared.revision, proposal, mediaManifest: prepared.manifest };
    },
    async currentRevision(read, envelope) {
      const value = parseCatalogMediaUpdateProposal(envelope.proposal);
      if (envelope.resourceId !== value.productId || envelope.resourceType !== 'product') invalid();
      if (value.media.codecDigest !== codecDigest) return { exists: true, revision: null };
      try {
        const current = await readCatalogMediaUpdateReview(read, { productId: value.productId,
          normalizedInput: value.normalizedInput, plannedIdentity: value.plannedIdentity }, codecDigest);
        return { exists: true, revision: current.revision };
      } catch (error) {
        if (error instanceof ApiError && [400, 404, 409].includes(error.status)) return { exists: error.code !== 'NOT_FOUND', revision: null };
        throw error;
      }
    },
    async apply(store, proposal, context) {
      const value = parseCatalogMediaUpdateProposal(proposal), identity = mediaContext(context.mediaContext);
      if (identity.accountId !== context.accountId || identity.clientId !== context.clientId || identity.grantId !== context.grantId ||
          !uuid.test(context.operationId || '') || !uuid.test(context.correlationId || '')) invalid();
      return store.transaction(async () => {
        const prepared = await readCatalogMediaUpdateReview(store, { productId: value.productId,
          normalizedInput: value.normalizedInput, plannedIdentity: value.plannedIdentity }, codecDigest);
        if (!same(prepared.proposal, value)) changed();
        const retained = await readMediaFrame(store, identity, context.operationId, value.media);
        if (!same(retained.descriptor, prepared.manifest.descriptor)) changed();
        const actor = await store.get('SELECT username FROM seller_account WHERE id=?', identity.accountId);
        if (!actor) invalid();
        const result = await withInventoryContext({ source: 'MCP_CATALOG', actorKind: 'SELLER', actorId: identity.accountId,
          clientId: identity.clientId, grantId: identity.grantId, operationId: context.operationId, correlationId: context.correlationId },
        () => trackUpdate(store, value.productId, actor.username, () => value.plannedIdentity ?
          applyPlannedProductUpdate(store, { id: value.productId, changes: value.normalizedInput }, value.plannedIdentity) :
          updateProduct(store, value.productId, value.normalizedInput)));
        if (!result) changed();
        const after = await readCatalogMediaUpdateAfter(store, prepared);
        return { productId: result.id, listingId: result.listingId, revision: after.revision };
      });
    },
    validResult: receipt, toReceipt: value => ({ productId: value.productId, listingId: value.listingId, revision: value.revision }), validReceipt: receipt,
  });
}

export function catalogMediaUpdateTool(runtime) {
  return Object.freeze({ ...catalogUpdateTool(), adapter: catalogMediaUpdateAdapter(runtime) });
}
