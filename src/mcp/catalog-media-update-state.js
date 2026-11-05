import { ApiError } from '../http.js';
import { validateProductInput } from '../product-input.js';
import { prepareProductUpdate, prepareProductOptionsAfter, requireUniqueProductSku } from '../products.js';
import { planMoveToListing, projectListingFields, plannedListingIdentity } from '../listings.js';
import { senderFields } from '../sender-settings.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { readCatalogMediaMetadata, readCatalogMediaState } from './catalog-media-state.js';
import { readCatalogMediaBeforeGraph, projectCatalogMediaMove } from './catalog-media-projection.js';
import { catalogUpdateChangesSchema, describeOptions as describeProductOptions } from './catalog-tools.js';
import { valid } from './tools.js';

export const CATALOG_UPDATE_LIMITS = Object.freeze({ reviewBytes: 48 * 1024, privateBytes: 8 * 1024 * 1024, normalizationSettingsBytes: 64 * 1024 });
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
async function normalizationPreflight(read) {
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
  await normalizationPreflight(read);
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
  const review = { products: catalog.products.filter(row => row.productId === args.productId || !equal(row.before, row.after)),
    listings: catalog.listings.filter(row => !equal(row.before, row.after)) };
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
