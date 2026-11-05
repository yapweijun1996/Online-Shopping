import { ApiError } from '../http.js';
import { validateProductInput } from '../product-input.js';
import { prepareProductUpdate, prepareProductOptionsAfter, requireUniqueProductSku } from '../products.js';
import { planMoveToListing, projectListingFields, plannedListingIdentity } from '../listings.js';
import { senderFields } from '../sender-settings.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { readCatalogMediaMetadata, readCatalogMediaState, readBoundedCatalogMetadata, CATALOG_STATE_LIMITS } from './catalog-media-state.js';
import { readCatalogMediaBeforeGraph, projectCatalogMediaMove } from './catalog-media-projection.js';
import { catalogUpdateChangesSchema, catalogMetadataColumns, describeOptions as describeProductOptions } from './catalog-tools.js';
import { readMediaUnionSnapshot } from './media-resources.js';
import { valid } from './tools.js';

export const CATALOG_UPDATE_LIMITS = Object.freeze({ reviewBytes: 48 * 1024, privateBytes: 8 * 1024 * 1024, normalizationSettingsBytes: 64 * 1024 });
export const CATALOG_UPDATE_WARNING_CODES = Object.freeze(['TARGET_LISTING_SHARED_FIELDS_ADOPTED', 'GROUP_CHANGE_CLEARS_OPTIONS', 'HOLDER_OR_VISIBLE_GALLERY_CHANGES']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => { throw new ApiError(400, 'CATALOG_UPDATE_INPUT', 'Invalid catalog update.'); };
const changed = () => { throw new ApiError(409, 'CATALOG_DEPENDENCY_CHANGED', 'The catalog dependencies changed.'); };
const large = () => { throw new ApiError(503, 'CATALOG_REVIEW_TOO_LARGE', 'The complete catalog review exceeds its safe limit.'); };
const json = canonicalOperationJson;
const equal = (a, b) => json(a) === json(b);
const sameRows = (a, b) => equal(Object.keys(a), Object.keys(b)) && Object.keys(a).every(table =>
  a[table].length === b[table].length && a[table].every((row, index) => equal(row, b[table][index])));
function boundedReview(value, cap) {
  let bytes = Buffer.byteLength('{"products":[],"listings":[]}');
  if (Object.hasOwn(value, 'warnings')) bytes += Buffer.byteLength(',"warnings":') + Buffer.byteLength(json(value.warnings));
  for (const key of ['products', 'listings']) for (const [index, row] of value[key].entries()) {
    bytes += Buffer.byteLength(json(row)) + (index ? 1 : 0);
    if (bytes > cap) large();
  }
}
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
function shape(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => { const d = Object.getOwnPropertyDescriptor(value, key); return !d?.enumerable || !Object.hasOwn(d, 'value'); })) invalid();
}
function input(value, identity = false) {
  shape(value, identity ? ['productId', 'changes', 'plannedIdentity'] : ['productId', 'changes']);
  if (typeof value.productId !== 'string' || !uuid.test(value.productId)) invalid();
  let raw;
  try { raw = JSON.parse(json(value.changes)); } catch { invalid(); }
  if (!valid(raw, catalogUpdateChangesSchema()) || !Object.keys(raw).length) invalid();
  return { productId: value.productId, changes: validateProductInput(raw, ['MYR', 'SGD'], { partial: true }) };
}

// The shared normalizer reads the complete settings row for defaultCurrency.
// Bound that legacy read before it materializes unrelated seller-entered text.
export async function catalogNormalizationPreflight(read) {
  const columns = ['default_currency', 'seller_whatsapp_phone', 'mobile_hide_bars_on_scroll',
    'availability_text', 'shipping_text', 'returns_text', ...Object.values(senderFields).map(([column]) => column)];
  const size = column => read.dialect === 'postgres' ? `octet_length(CAST(${column} AS TEXT))` : `length(CAST(${column} AS BLOB))`;
  const row = await read.get(`SELECT ${columns.map(column => `COALESCE(${size(column)},0)`).join(' + ')} AS bytes FROM company_setting WHERE id=1`);
  if (!row) changed();
  if (!Number.isSafeInteger(Number(row.bytes)) || Number(row.bytes) > CATALOG_UPDATE_LIMITS.normalizationSettingsBytes) large();
}
function existingProduct(row) {
  return { id: row.id, listingId: row.listing_id, sku: row.sku, name: row.name, description: row.description,
    categoryCode: row.category, priceMinor: row.price_minor, currency: row.currency, active: row.active === 1,
    stockQuantity: row.stock_quantity, variantGroup: row.variant_group, variantLabel: row.variant_label,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
async function describeOptions(read, rows, pairs) {
  try { return await describeProductOptions(read, pairs, { types: rows.option_type, values: rows.option_value }); }
  catch (error) { if (error instanceof TypeError) changed(); throw error; }
}
async function productReview(read, rows, row) {
  const { updatedAt: _updatedAt, ...product } = existingProduct(row);
  const category = rows.general_code.find(value => value.code === row.category);
  if (!category) changed();
  const pairs = rows.product_option.filter(value => value.product_id === row.id)
    .map(value => ({ typeId: value.option_type_id, valueId: value.option_value_id }));
  return { ...product, category: { code: category.code, label: category.label, active: category.active === 1 },
    options: await describeOptions(read, rows, pairs) };
}
const listingReview = row => ({ id: row.id, code: row.code, name: row.name, description: row.description, categoryCode: row.category });

/** Metadata only: no identity allocation, BLOB reads, DML or prepared-write authority. */
export async function prepareCatalogMediaUpdate(read, value) {
  const args = input(value);
  let metadata = await readCatalogMediaMetadata(read, { ...args, plannedIdentity: null });
  if (!metadata) throw new ApiError(400, 'NOT_FOUND', 'Product not found.');
  const originalRows = metadata.rows;
  const source = originalRows.product.find(row => row.id === args.productId);
  if (!source) changed();
  const existing = existingProduct(source);
  await catalogNormalizationPreflight(read);
  const patch = await prepareProductUpdate(read, existing, args.changes);
  if (Object.hasOwn(patch, 'sku')) await requireUniqueProductSku(read, patch.sku, args.productId);
  // Shared preparation preserves provisional-label checks, KEEP and strict
  // group-change clearing without substituting the derived label into PATCH.
  const optionsAfter = await prepareProductOptionsAfter(read, existing, patch);
  if (!equal(patch, args.changes)) {
    metadata = await readCatalogMediaMetadata(read, { productId: args.productId, changes: patch, plannedIdentity: null });
    if (!metadata || !sameRows(metadata.rows, originalRows)) changed();
  }
  const moved = Object.hasOwn(patch, 'variantGroup') && (patch.variantGroup || null) !== (existing.variantGroup || null);
  const move = moved ? await planMoveToListing(read, existing.id, existing.listingId,
    { ...existing, ...patch, category: patch.category || existing.categoryCode }) : null;
  const targetPlan = move?.target ?? null;
  const before = [];
  for (const row of metadata.rows.product) before.push(await productReview(read, metadata.rows, row));
  const after = structuredClone(before), target = after.find(row => row.id === existing.id);
  for (const key of ['sku', 'name', 'description', 'priceMinor', 'currency', 'active', 'variantGroup', 'variantLabel']) {
    if (Object.hasOwn(patch, key)) target[key] = patch[key];
  }
  if (Object.hasOwn(patch, 'category')) target.categoryCode = patch.category;
  target.variantLabel = optionsAfter.variantLabelAfter;
  target.options = await describeOptions(read, metadata.rows, optionsAfter.optionsAfter);
  const listingsBefore = metadata.rows.listing.map(listingReview), listingsAfter = structuredClone(listingsBefore);
  if (move) {
    target.listingId = targetPlan.listing.id;
    const shared = projectListingFields({}, targetPlan.listing);
    Object.assign(target, { name: shared.name, description: shared.description, categoryCode: shared.category });
    if (targetPlan.create) listingsAfter.push({ id: null, code: targetPlan.code, name: shared.name,
      description: shared.description, categoryCode: shared.category });
    if (move.deletePrevious) listingsAfter.splice(listingsAfter.findIndex(row => row.id === existing.listingId), 1);
  } else {
    for (const row of after.filter(row => row.listingId === existing.listingId)) {
      const shared = projectListingFields({ name: row.name, description: row.description, category: row.categoryCode }, patch);
      Object.assign(row, { name: shared.name, description: shared.description, categoryCode: shared.category });
    }
    const listing = listingsAfter.find(row => row.id === existing.listingId);
    const shared = projectListingFields({ name: listing.name, description: listing.description, category: listing.categoryCode }, patch);
    Object.assign(listing, { name: shared.name, description: shared.description, categoryCode: shared.category });
  }
  for (const row of after) {
    const category = metadata.rows.general_code.find(value => value.code === row.categoryCode);
    if (!category) changed();
    row.category = { code: category.code, label: category.label, active: category.active === 1 };
  }
  const catalog = { products: before.map(row => ({ productId: row.id, before: row, after: after.find(value => value.id === row.id) })),
    listings: [...listingsBefore.map(row => row.id), ...(targetPlan?.create ? [null] : [])].map(id => ({ listingId: id,
      before: listingsBefore.find(row => row.id === id) ?? null, after: listingsAfter.find(row => row.id === id) ?? null })) };
  const warnings = [];
  if (move && !targetPlan.create) warnings.push(CATALOG_UPDATE_WARNING_CODES[0]);
  if (optionsAfter.groupAfter !== existing.variantGroup && before.find(row => row.id === existing.id).options.length > 0 &&
      optionsAfter.optionsAfter.length === 0) warnings.push(CATALOG_UPDATE_WARNING_CODES[1]);
  const review = { products: catalog.products.filter(row => row.productId === args.productId || !equal(row.before, row.after)),
    listings: catalog.listings.filter(row => !equal(row.before, row.after)), warnings };
  boundedReview(catalog, CATALOG_UPDATE_LIMITS.privateBytes);
  boundedReview(review, CATALOG_UPDATE_LIMITS.reviewBytes);
  return frozen({ version: 1, productId: args.productId, normalizedPatch: patch, metadata, targetPlan,
    needsPlannedIdentity: targetPlan?.create === true, optionsAfter, catalog, review });
}

/** Complete private current/projection state. Caller owns fences and authority. */
export async function readCatalogMediaUpdateState(read, value) {
  const args = input(value, true), prepared = await prepareCatalogMediaUpdate(read, args);
  let identity = null;
  try { if (value.plannedIdentity !== null) identity = plannedListingIdentity(value.plannedIdentity); } catch { invalid(); }
  if (prepared.needsPlannedIdentity !== Boolean(identity)) changed();
  if (identity && (identity.productId !== args.productId || identity.previousListingId !== prepared.metadata.selector.sourceListingId ||
      identity.targetCode !== prepared.targetPlan.code)) changed();
  if (identity && await read.get('SELECT id FROM listing WHERE id=?', identity.newListingId)) changed();
  const intent = { productId: args.productId, changes: prepared.normalizedPatch, plannedIdentity: identity };
  const metadata = await readCatalogMediaMetadata(read, intent);
  if (!metadata || !sameRows(metadata.rows, prepared.metadata.rows) || identity && metadata.predicates.plannedCreation.lookup.existing !== null) changed();
  if (!equal(metadata.selector, prepared.metadata.selector) ||
      ['targetCode', 'membershipChanges', 'sku', 'label'].some(key => !equal(metadata.predicates[key], prepared.metadata.predicates[key]))) changed();
  const state = await readCatalogMediaState(read, intent);
  if (!state || state.catalogRevision !== metadata.revision) changed();
  const before = await readCatalogMediaBeforeGraph(read, state.mediaSnapshot);
  const projection = await projectCatalogMediaMove(read, state.mediaSnapshot,
    { productId: args.productId, targetPlan: prepared.targetPlan, patch: prepared.normalizedPatch });
  const catalog = structuredClone(prepared.catalog), review = structuredClone(prepared.review);
  if (before.beforeViews.some(row => !equal(row, projection.afterViews.find(next => next.productId === row.productId)))) {
    review.warnings.push(CATALOG_UPDATE_WARNING_CODES[2]);
  }
  if (identity) for (const data of [catalog, review]) {
    for (const effect of data.products) if (effect.after.listingId === null) effect.after.listingId = identity.newListingId;
    for (const effect of data.listings) if (effect.listingId === null) {
      effect.listingId = identity.newListingId; effect.after.id = identity.newListingId;
    }
  }
  boundedReview(catalog, CATALOG_UPDATE_LIMITS.privateBytes);
  boundedReview(review, CATALOG_UPDATE_LIMITS.reviewBytes);
  return frozen({ version: 1, productId: args.productId, baseRevision: state.revision, plannedIdentity: identity,
    normalizedPatch: prepared.normalizedPatch, targetPlan: prepared.targetPlan, catalog, review, state, beforeGraph: before, projection });
}

/** Assert the actual result, including the surviving old source closure. Never
 * replan the stored intent against a deleted or already-moved source. */
export async function readCatalogMediaUpdateAfter(read, prepared) {
  const expected = prepared.catalog;
  const listingIds = expected.listings.filter(row => row.after !== null).map(row => row.listingId).sort();
  const allIds = expected.listings.map(row => row.listingId).sort();
  if (!listingIds.length || listingIds.length > 2 || new Set(allIds).size !== allIds.length || !allIds.every(id => uuid.test(id))) changed();
  const target = expected.products.find(row => row.productId === prepared.productId)?.after;
  const actualTarget = await read.get('SELECT id,listing_id FROM product WHERE id=?', prepared.productId);
  if (!target || actualTarget?.listing_id !== target.listingId) changed();
  const marks = values => values.map(() => '?').join(','), scope = `listing_id IN (${marks(listingIds)})`;
  const columns = catalogMetadataColumns(), oldRows = prepared.state.metadata.rows;
  const fixed = (table, selection, key, cap) => {
    const values = oldRows[table].map(row => row[key]);
    return [table, selection, values.length ? `${key} IN (${marks(values)})` : '1=0', values, cap];
  };
  const definitions = [
    ['product', columns.product, scope, listingIds, CATALOG_STATE_LIMITS.members],
    ['listing', columns.listing, `id IN (${marks(allIds)})`, allIds, 2],
    fixed('general_code', columns.general_code, 'code', CATALOG_STATE_LIMITS.categories),
    ['product_option', 'product_id,option_type_id,option_value_id', `product_id IN (SELECT id FROM product WHERE ${scope})`, listingIds, CATALOG_STATE_LIMITS.mappings],
    fixed('option_type', columns.option_type, 'id', CATALOG_STATE_LIMITS.types),
    fixed('option_value', columns.option_value, 'id', CATALOG_STATE_LIMITS.values),
    ['company_setting', 'default_currency', 'id=1', [], 1],
  ];
  definitions[2][2] = `type='PRODUCT_CATEGORY' AND (${definitions[2][2]})`;
  const { rows } = await readBoundedCatalogMetadata(read, definitions);
  for (const table of ['general_code', 'option_type', 'option_value', 'company_setting']) {
    if (!sameRows({ [table]: rows[table] }, { [table]: oldRows[table] })) changed();
  }
  if (rows.product.length !== expected.products.length || rows.listing.length !== listingIds.length) changed();
  for (const row of rows.product) {
    const desired = expected.products.find(value => value.productId === row.id)?.after;
    if (!desired || !equal(await productReview(read, rows, row), desired)) changed();
  }
  for (const row of rows.listing) {
    const desired = expected.listings.find(value => value.listingId === row.id)?.after;
    if (!desired || !equal(listingReview(row), desired)) changed();
  }
  const other = listingIds.find(id => id !== actualTarget.listing_id);
  const snapshot = await readMediaUnionSnapshot(read, prepared.productId, other ? { targetListingId: other } : {});
  await assertCatalogMediaPhysicalAfter(read, { before: prepared.state.mediaSnapshot,
    projection: prepared.projection, plannedIdentity: prepared.plannedIdentity }, snapshot);
  const current = await readCatalogMediaState(read, { productId: prepared.productId,
    changes: prepared.normalizedPatch, plannedIdentity: null });
  if (!current || !sameRows({ product: current.metadata.rows.product },
    { product: rows.product.filter(row => row.listing_id === actualTarget.listing_id) })) changed();
  return { snapshot, metadata: rows, revision: current.revision };
}

// Shared catalog physical after-check only. An absent CREATE before is actual
// empty resource collections, never a pretend database snapshot or read anchor.
export async function assertCatalogMediaPhysicalAfter(read, resources, snapshot) {
  shape(resources, ['before', 'projection', 'plannedIdentity']);
  const { before, projection, plannedIdentity } = resources;
  if (!before || !['sources', 'galleries', 'products'].every(key => Array.isArray(before[key]))) changed();
  const bind = id => id === null ? plannedIdentity?.newListingId : id;
  const recordSet = (actual, expected, key) => {
    if (actual.length !== expected.length || new Set(actual.map(row => row[key])).size !== expected.length) changed();
    for (const row of expected) {
      const found = actual.find(value => value[key] === row[key]);
      if (!found || !equal(found, row)) changed();
    }
  };
  recordSet(snapshot.before.products, projection.after.products.map(row => ({ ...row, listingId: bind(row.listingId) })), 'productId');
  recordSet(snapshot.before.listings, projection.after.listings.map(row => ({ ...row, listingId: bind(row.listingId) })), 'listingId');
  const sourceKey = row => `${row.source_kind}:${row.source_product_id}:${row.source_id}`;
  const sources = new Map(snapshot.sources.map(row => [sourceKey(row), row]));
  for (const row of before.sources) {
    const actual = sources.get(sourceKey(row));
    if (!actual) changed();
    for (const field of ['source_kind', 'source_id', 'source_product_id', 'stage_id', 'mime', 'byte_length', 'byte_sha256', 'thumbnail']) {
      if (!equal(actual[field], row[field])) changed();
    }
  }
  for (const row of before.galleries) {
    const actual = snapshot.galleries.find(value => value.galleryId === row.galleryId);
    if (!actual || !equal(actual, row)) changed();
  }
  const aliases = new Map(), copies = projection.physicalEffects.filter(row => row.kind === 'COPY_MAIN');
  if (snapshot.sources.length !== before.sources.length + copies.length || snapshot.galleries.length !== before.galleries.length + copies.length) changed();
  for (const copy of copies) {
    const gallery = snapshot.galleries.find(row => row.productId === copy.productId && row.position === copy.position);
    if (!gallery || before.galleries.some(row => row.galleryId === gallery.galleryId) || aliases.has(copy.ref)) changed();
    const actual = sources.get(`GALLERY:${copy.productId}:${gallery.galleryId}`);
    if (!actual || actual.stage_id !== null) changed();
    for (const field of ['mime', 'byte_length', 'byte_sha256']) if (actual[field] !== copy.source[field]) changed();
    if (!equal(actual.thumbnail, copy.thumbnail)) changed();
    aliases.set(copy.ref, gallery.galleryId);
  }
  const reference = id => aliases.get(id) ?? id;
  for (const product of before.products) {
    const actual = snapshot.products.find(row => row.productId === product.productId);
    const effect = projection.physicalEffects.find(row => row.kind === 'SET_LAYOUT' && row.productId === product.productId);
    const layout = effect ? effect.selected.map(reference) : product.layout;
    if (!actual || !equal(actual.layout, layout)) changed();
  }
  const views = projection.afterViews.map(row => ({ ...row, visible: row.visible.map(item => ({ ...item, id: reference(item.id) })) }));
  recordSet((await readCatalogMediaBeforeGraph(read, snapshot)).beforeViews, views, 'productId');
  if (snapshot.graphReadBytes.oldBytes !== projection.graphReadBytes.afterOldBytes) changed();
}
