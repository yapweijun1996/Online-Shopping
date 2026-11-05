import { createHash } from 'node:crypto';
import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';
import { prepareProductCreate, prepareProductUpdate, requireUniqueProductSku, requireUniqueVariantLabel, createProduct, updateProduct } from '../products.js';
import { prepareProductOptions, requireGroupOptions } from '../options.js';
import { trackCreate, trackUpdate } from '../product-history.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { valid } from './tools.js';

export const CATALOG_LIMITS = Object.freeze({ products: 10000, dictionaryRows: 10000, members: 300, proposalBytes: 48 * 1024, revisionBytes: 8 * 1024 * 1024 });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = maxLength => ({ type: 'string', minLength: 0, maxLength });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const uuid = { type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const revision = { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]{64}$' };
const choices = { type: 'array', minItems: 0, maxItems: 6, items: object({ typeId: uuid, valueId: uuid }) };
const fields = { sku: text(4096), name: text(4096), description: text(4096), category: text(4096),
  priceMinor: { type: 'integer', minimum: 1, maximum: 1000000000 }, currency: { type: 'string', minLength: 3, maxLength: 3, enum: ['MYR', 'SGD'] },
  active: { type: 'boolean' }, variantGroup: nullable(text(4096)), variantLabel: nullable(text(4096)), options: choices };
const initialStock = nullable({ type: 'integer', minimum: 0, maximum: 1000000 });
const createSchema = object({ ...fields, stockQuantity: initialStock }, ['sku', 'name', 'description', 'category', 'priceMinor', 'active']);
const patchSchema = object(fields, []);
const updateSchema = object({ id: uuid, changes: patchSchema });
const receiptSchema = object({ productId: uuid, listingId: uuid, revision });
const metadataSchema = object({ id: nullable(uuid), listingId: nullable(uuid), sku: text(40), name: text(120), description: text(2000),
  categoryCode: text(80), priceMinor: fields.priceMinor, currency: fields.currency, active: fields.active, stockQuantity: initialStock,
  variantGroup: nullable(text(40)), variantLabel: nullable(text(80)), options: choices });
const optionReviewSchema = { type: 'array', minItems: 0, maxItems: 6, items: object({ typeId: uuid, valueId: uuid,
  typeName: text(60), typeCode: text(40), valueLabel: text(80), valueCode: text(40), typeActive: { type: 'boolean' }, valueActive: { type: 'boolean' } }) };
const sharedSchema = object({ name: text(120), description: text(2000), category: text(80) });
const effectSchema = object({ before: sharedSchema, after: sharedSchema, members: {
  type: 'array', minItems: 1, maxItems: CATALOG_LIMITS.members, items: object({ id: uuid, sku: text(40) }),
}, changedFields: { type: 'array', minItems: 1, maxItems: 3, items: { enum: ['name', 'description', 'category'] } },
memberOverrides: { type: 'array', minItems: 0, maxItems: CATALOG_LIMITS.members, items: object({ id: uuid, before: sharedSchema, after: sharedSchema }) } });
const productColumns = 'id, sku, name, description, category, price_minor, currency, active, variant_group, variant_label, stock_quantity, listing_id, image_mime, gallery_layout_json, created_at, updated_at';
const listingColumns = 'id, code, name, description, category, translations_json, created_at, updated_at';
const typeColumns = 'id, code, name, translations_json, display, position, active, created_at, updated_at';
const valueColumns = 'id, option_type_id, code, label, translations_json, swatch_color, position, active, created_at, updated_at';
const categoryColumns = 'code, label, active, created_at, updated_at';
const tooLarge = () => { throw new ApiError(503, 'CATALOG_REVIEW_TOO_LARGE', 'The catalog review exceeds its safe metadata limit.'); };
const unsupported = () => { throw new ApiError(400, 'CATALOG_PHASE_DEPENDENCY', 'This change requires the separately reviewed media or inventory operation.'); };
const notFound = () => { throw new ApiError(404, 'NOT_FOUND', 'Product not found.'); };
const pairSort = list => [...list].sort((a, b) => a.typeId < b.typeId ? -1 : a.typeId > b.typeId ? 1 : 0);
const shared = value => ({ name: value.name, description: value.description, category: value.categoryCode });

const fingerprint = () => ({ state: createHash('sha256'), bytes: 0 });
function addRecord(hash, row) {
  const json = canonicalOperationJson(row), bytes = Buffer.byteLength(json);
  hash.bytes += bytes; if (hash.bytes > CATALOG_LIMITS.revisionBytes) tooLarge();
  hash.state.update(String(bytes) + ':'); hash.state.update(json);
}
function addRows(hash, name, rows) {
  hash.state.update(JSON.stringify(name) + '\n');
  for (const row of rows) addRecord(hash, row);
}
async function currency(read) {
  const row = await read.get('SELECT default_currency FROM company_setting WHERE id = 1');
  if (!row) throw new TypeError('Company currency is unavailable.');
  return row;
}
// Server-owned identifiers only. Pages and per-table caps keep revision memory
// bounded; canonicalization is per record, never a multi-megabyte JSON envelope.
async function scan(read, hash, name, columns, keys, cap, predicate = '') {
  let count = 0, last = null;
  addRows(hash, name, []);
  while (true) {
    const limit = Math.min(200, cap + 1 - count), params = [];
    let cursor = '';
    if (last) {
      cursor = keys.length === 1 ? `${keys[0]} > ?` : `(${keys[0]} > ? OR (${keys[0]} = ? AND ${keys[1]} > ?))`;
      params.push(last[keys[0]]);
      if (keys.length === 2) params.push(last[keys[0]], last[keys[1]]);
    }
    const where = [predicate, cursor].filter(Boolean).join(' AND ');
    const rows = await read.all(`SELECT ${columns} FROM ${name}${where ? ' WHERE ' + where : ''} ORDER BY ${keys.join(', ')} LIMIT ?`, ...params, limit);
    count += rows.length; if (count > cap) tooLarge();
    // No per-page delimiter: the digest is independent of page boundaries.
    for (const row of rows) addRecord(hash, row);
    if (rows.length < limit) return count;
    last = rows.at(-1);
  }
}
export async function catalogCreateRevision(read) {
  const hash = fingerprint(); addRows(hash, 'companyCurrency', [await currency(read)]);
  const products = await scan(read, hash, 'product', productColumns, ['id'], CATALOG_LIMITS.products);
  await scan(read, hash, 'listing', listingColumns, ['id'], CATALOG_LIMITS.products);
  await scan(read, hash, 'general_code', categoryColumns, ['code'], CATALOG_LIMITS.dictionaryRows, "type = 'PRODUCT_CATEGORY'");
  await scan(read, hash, 'option_type', typeColumns, ['id'], CATALOG_LIMITS.dictionaryRows);
  await scan(read, hash, 'option_value', valueColumns, ['id'], CATALOG_LIMITS.dictionaryRows);
  await scan(read, hash, 'product_option', 'product_id, option_type_id, option_value_id', ['product_id', 'option_type_id'], CATALOG_LIMITS.products * 6);
  return { revision: hash.state.digest('hex'), products };
}
async function rowsFor(read, table, columns, key, ids, cap, predicate = '') {
  const unique = [...new Set(ids)].sort(), rows = [];
  for (let i = 0; i < unique.length; i += 200) {
    const part = unique.slice(i, i + 200), limit = cap + 1 - rows.length;
    rows.push(...await read.all(`SELECT ${columns} FROM ${table} WHERE ${predicate ? predicate + ' AND ' : ''}${key} IN (${part.map(() => '?').join(', ')}) ORDER BY ${key}, ${table === 'product_option' ? 'option_type_id' : table === 'product_gallery_image' ? 'id' : key} LIMIT ?`, ...part, limit));
    if (rows.length > cap) tooLarge();
  }
  let bytes = 0;
  return rows.map(row => {
    const json = canonicalOperationJson(row); bytes += Buffer.byteLength(json); if (bytes > CATALOG_LIMITS.revisionBytes) tooLarge();
    return { row, json };
  }).sort((a, b) => a.json < b.json ? -1 : a.json > b.json ? 1 : 0).map(entry => entry.row);
}
async function component(read, id, patch = {}) {
  const target = await read.get(`SELECT ${productColumns} FROM product WHERE id = ?`, id);
  if (!target) return null;
  const members = await read.all(`SELECT ${productColumns} FROM product WHERE listing_id = ? OR variant_group = ? ORDER BY id LIMIT ?`,
    target.listing_id, target.variant_group, CATALOG_LIMITS.members + 1);
  if (members.length > CATALOG_LIMITS.members) tooLarge();
  const ids = members.map(row => row.id);
  const mappings = await rowsFor(read, 'product_option', 'product_id, option_type_id, option_value_id', 'product_id', ids, CATALOG_LIMITS.members * 6);
  const proposedOptions = patch.options || [];
  const values = await rowsFor(read, 'option_value', valueColumns, 'id', [...mappings.map(row => row.option_value_id), ...proposedOptions.map(item => item.valueId)], CATALOG_LIMITS.members * 6 + 6);
  const types = await rowsFor(read, 'option_type', typeColumns, 'id', [...mappings.map(row => row.option_type_id), ...proposedOptions.map(item => item.typeId)], CATALOG_LIMITS.members * 6 + 6);
  const listings = await rowsFor(read, 'listing', listingColumns, 'id', members.map(row => row.listing_id), CATALOG_LIMITS.members);
  const categories = await rowsFor(read, 'general_code', categoryColumns, 'code', [...members.map(row => row.category), ...(patch.category ? [patch.category] : [])], CATALOG_LIMITS.members + 1, "type = 'PRODUCT_CATEGORY'");
  const galleries = await rowsFor(read, 'product_gallery_image', 'id, product_id, position, mime, created_at, thumb_mime', 'product_id', ids, CATALOG_LIMITS.members * 10);
  const sku = patch.sku ?? target.sku;
  const uniqueness = await read.all('SELECT id, sku FROM product WHERE sku = ? ORDER BY id LIMIT 2', sku);
  const parts = { companyCurrency: [await currency(read)], members, listings, categories, mappings, values, types, galleries, skuPredicate: [{ sku }], uniqueness };
  const hash = fingerprint(); for (const [name, rows] of Object.entries(parts)) addRows(hash, name, rows);
  return { target, members, mappings, listings, types, values, revision: hash.state.digest('hex') };
}
export async function catalogUpdateRevision(read, id, patch = {}) { return (await component(read, id, patch))?.revision ?? null; }
async function describeOptions(read, options, known = null) {
  const types = known?.types ?? await rowsFor(read, 'option_type', typeColumns, 'id', options.map(item => item.typeId), 6);
  const values = known?.values ?? await rowsFor(read, 'option_value', valueColumns, 'id', options.map(item => item.valueId), 6);
  const byType = new Map(types.map(row => [row.id, row])), byValue = new Map(values.map(row => [row.id, row]));
  return pairSort(options).map(item => {
    const type = byType.get(item.typeId), value = byValue.get(item.valueId);
    if (!type || !value || value.option_type_id !== type.id) throw new TypeError('Option review metadata is unavailable.');
    return { ...item, typeName: type.name, typeCode: type.code, valueLabel: value.label, valueCode: value.code,
      typeActive: Boolean(type.active), valueActive: Boolean(value.active) };
  });
}
function metadata(row, options) {
  return { id: row.id, listingId: row.listing_id, sku: row.sku, name: row.name, description: row.description,
    categoryCode: row.category, priceMinor: row.price_minor, currency: row.currency, active: Boolean(row.active),
    stockQuantity: row.stock_quantity, variantGroup: row.variant_group, variantLabel: row.variant_label, options: pairSort(options) };
}
function fromService(product) {
  return { id: product.id, listingId: product.listingId, sku: product.sku, name: product.name, description: product.description,
    categoryCode: product.categoryCode, priceMinor: product.priceMinor, currency: product.currency, active: product.active,
    stockQuantity: product.stockQuantity, variantGroup: product.variantGroup, variantLabel: product.variantLabel,
    options: pairSort((product.options || []).map(item => ({ typeId: item.type.id, valueId: item.value.id }))) };
}
async function guardHolder(read, target, patch) {
  if (!Object.hasOwn(patch, 'sku') || patch.sku === target.sku) return;
  const before = await read.get('SELECT id FROM product WHERE listing_id = ? ORDER BY created_at, sku, id LIMIT 1', target.listing_id);
  const after = await read.get('SELECT id FROM product WHERE listing_id = ? ORDER BY created_at, CASE WHEN id = ? THEN ? ELSE sku END, id LIMIT 1', target.listing_id, target.id, patch.sku);
  if (before?.id !== after?.id) unsupported();
}
function checkedProposal(proposal, kind) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) || Object.keys(proposal).sort().join(',') !== 'after,before,initialStock,kind,listingEffect,normalizedInput,optionReview' || proposal.kind !== kind ||
      !valid(proposal.normalizedInput, kind === 'create' ? createSchema : patchSchema) ||
      !valid(proposal.after, metadataSchema) || (kind === 'create' ? proposal.before !== null : !valid(proposal.before, metadataSchema))) throw new TypeError('Invalid stored catalog proposal.');
  if (!valid(proposal.optionReview, object({ before: optionReviewSchema, after: optionReviewSchema })) ||
      canonicalOperationJson(pairSort(proposal.optionReview.before.map(({ typeId, valueId }) => ({ typeId, valueId })))) !== canonicalOperationJson(proposal.before?.options || []) ||
      canonicalOperationJson(pairSort(proposal.optionReview.after.map(({ typeId, valueId }) => ({ typeId, valueId })))) !== canonicalOperationJson(proposal.after.options)) {
    throw new TypeError('Invalid stored option review.');
  }
  if (kind === 'create') {
    if (proposal.after.id !== null || !valid(proposal.initialStock, object({ quantity: initialStock, unlimited: { type: 'boolean' } })) ||
        proposal.initialStock.quantity !== proposal.after.stockQuantity || proposal.initialStock.unlimited !== (proposal.after.stockQuantity === null) || proposal.listingEffect !== null) {
      throw new TypeError('Invalid stored create proposal.');
    }
  } else {
    const affectsListing = ['name', 'description', 'category'].some(key => Object.hasOwn(proposal.normalizedInput, key));
    if (!valid(proposal.before.id, uuid) || !valid(proposal.before.listingId, uuid) || proposal.initialStock !== null ||
        proposal.before.id !== proposal.after.id || proposal.before.listingId !== proposal.after.listingId ||
        proposal.before.stockQuantity !== proposal.after.stockQuantity || proposal.before.variantGroup !== proposal.after.variantGroup ||
        (affectsListing ? !valid(proposal.listingEffect, effectSchema) : proposal.listingEffect !== null)) throw new TypeError('Invalid stored update proposal.');
    if (affectsListing) {
      const effect = proposal.listingEffect;
      const changedFields = ['name', 'description', 'category'].filter(key => Object.hasOwn(proposal.normalizedInput, key));
      const expectedAfter = { ...effect.before, ...Object.fromEntries(changedFields.map(key => [key, proposal.normalizedInput[key]])) };
      const ids = new Set(effect.members.map(row => row.id)), overrideIds = effect.memberOverrides.map(row => row.id);
      const target = effect.memberOverrides.find(row => row.id === proposal.before.id);
      const targetBefore = target?.before ?? effect.before, targetAfter = target?.after ?? effect.after;
      if (canonicalOperationJson(effect.changedFields) !== canonicalOperationJson(changedFields) ||
          canonicalOperationJson(effect.after) !== canonicalOperationJson(expectedAfter) || ids.size !== effect.members.length ||
          !ids.has(proposal.before.id) || new Set(overrideIds).size !== overrideIds.length || overrideIds.some(id => !ids.has(id)) ||
          canonicalOperationJson(targetBefore) !== canonicalOperationJson(shared(proposal.before)) ||
          canonicalOperationJson(targetAfter) !== canonicalOperationJson(shared(proposal.after)) || effect.memberOverrides.some(row =>
            canonicalOperationJson(row.after) !== canonicalOperationJson({ ...row.before, ...Object.fromEntries(changedFields.map(key => [key, proposal.normalizedInput[key]])) }))) {
        throw new TypeError('Invalid stored listing effect.');
      }
    }
  }
  const json = canonicalOperationJson(proposal); if (Buffer.byteLength(json) > CATALOG_LIMITS.proposalBytes) tooLarge();
  return proposal;
}
async function draftCreate(read, input) {
  const normalized = await prepareProductCreate(read, input);
  await requireUniqueProductSku(read, normalized.sku);
  await requireUniqueVariantLabel(read, normalized.variantGroup, normalized.variantLabel);
  if (normalized.variantGroup && await read.get('SELECT id FROM product WHERE variant_group = ? LIMIT 1', normalized.variantGroup)) unsupported();
  const listing = normalized.variantGroup && await read.get('SELECT id, name, description, category FROM listing WHERE code = ?', normalized.variantGroup);
  const selected = await prepareProductOptions(read, null, normalized.variantGroup, normalized.options || [], { newProduct: true });
  await requireGroupOptions(read, null, normalized.variantGroup, selected.options.length > 0);
  const normalizedInput = { ...normalized, stockQuantity: normalized.stockQuantity ?? null,
    ...(selected.options.length ? { options: selected.options, variantLabel: selected.label } : {}) };
  const after = { id: null, listingId: listing?.id || null, sku: normalized.sku, name: listing?.name ?? normalized.name,
    description: listing?.description ?? normalized.description, categoryCode: listing?.category ?? normalized.category,
    priceMinor: normalized.priceMinor, currency: normalized.currency, active: normalized.active, stockQuantity: normalizedInput.stockQuantity,
    variantGroup: normalized.variantGroup || null, variantLabel: selected.label || normalized.variantLabel || null, options: pairSort(selected.options) };
  const root = await catalogCreateRevision(read); if (root.products >= CATALOG_LIMITS.products) tooLarge();
  return { resourceId: 'catalog', expectedRevision: root.revision, proposal: checkedProposal({ kind: 'create', before: null, after,
    initialStock: { quantity: after.stockQuantity, unlimited: after.stockQuantity === null }, listingEffect: null, normalizedInput,
    optionReview: { before: [], after: await describeOptions(read, after.options) } }, 'create') };
}
async function draftUpdate(read, input) {
  const first = await component(read, input.id);
  if (!first) throw new ApiError(400, 'NOT_FOUND', 'Product not found.');
  const currentOptions = first.mappings.filter(row => row.product_id === input.id).map(row => ({ typeId: row.option_type_id, valueId: row.option_value_id }));
  const before = metadata(first.target, currentOptions);
  const existing = { ...before, categoryCode: first.target.category, updatedAt: first.target.updated_at };
  const patch = await prepareProductUpdate(read, existing, input.changes);
  if (Object.hasOwn(patch, 'variantGroup') && patch.variantGroup !== first.target.variant_group) unsupported();
  if (currentOptions.length && Object.hasOwn(patch, 'variantLabel')) unsupported();
  await guardHolder(read, first.target, patch);
  if (Object.hasOwn(patch, 'sku')) await requireUniqueProductSku(read, patch.sku, input.id);
  if (Object.hasOwn(patch, 'variantLabel')) await requireUniqueVariantLabel(read, before.variantGroup, patch.variantLabel, input.id);
  let selected = { options: currentOptions, label: before.variantLabel };
  if (Object.hasOwn(patch, 'options')) {
    selected = await prepareProductOptions(read, input.id, before.variantGroup, patch.options);
    patch.options = selected.options;
  }
  await requireGroupOptions(read, input.id, before.variantGroup, selected.options.length > 0);
  const after = { ...before };
  for (const field of ['sku', 'name', 'description', 'priceMinor', 'currency', 'active', 'variantGroup', 'variantLabel']) if (Object.hasOwn(patch, field)) after[field] = patch[field];
  if (Object.hasOwn(patch, 'category')) after.categoryCode = patch.category;
  if (Object.hasOwn(patch, 'options')) { after.options = pairSort(selected.options); if (selected.label) after.variantLabel = selected.label; }
  const changedFields = ['name', 'description', 'category'].filter(key => Object.hasOwn(patch, key));
  let listingEffect = null;
  if (changedFields.length) {
    const listing = first.listings.find(row => row.id === before.listingId);
    if (!listing) throw new TypeError('Listing metadata is unavailable.');
    const listingBefore = { name: listing.name, description: listing.description, category: listing.category };
    const members = first.members.filter(row => row.listing_id === before.listingId);
    // Historical backfills may leave per-variant copies different from the
    // authoritative listing. Show those old values instead of assuming equality.
    listingEffect = { before: listingBefore, after: { ...listingBefore, ...Object.fromEntries(changedFields.map(key => [key, patch[key]])) }, changedFields,
      members: members.map(row => ({ id: row.id, sku: row.sku })),
      memberOverrides: members.filter(row => ['name', 'description', 'category'].some(key => row[key] !== listingBefore[key]))
        .map(row => ({ id: row.id, before: { name: row.name, description: row.description, category: row.category },
          after: { name: row.name, description: row.description, category: row.category, ...Object.fromEntries(changedFields.map(key => [key, patch[key]])) } })),
    };
  }
  const current = await component(read, input.id, patch);
  return { resourceId: input.id, expectedRevision: current.revision,
    proposal: checkedProposal({ kind: 'update', before, after, initialStock: null, listingEffect, normalizedInput: patch,
      optionReview: { before: await describeOptions(read, before.options, current), after: await describeOptions(read, after.options, current) } }, 'update') };
}
async function author(store, context) {
  const account = context && await store.get('SELECT username FROM seller_account WHERE id = ?', context.accountId);
  if (!account) throw new ApiError(403, 'FORBIDDEN', 'Catalog actor is unavailable.');
  return account.username;
}
function registration(kind) {
  const inputSchema = kind === 'create' ? createSchema : updateSchema;
  return { previewName: `catalog.preview_${kind}`, commitName: `catalog.commit_${kind}`, scope: 'catalog.write', capability: 'catalog.write', inputSchema, receiptSchema,
    adapter: { resourceType: kind === 'create' ? 'catalog' : 'product',
      async preview(read, args) {
        if (!valid(args, inputSchema)) throw new ApiError(400, 'INVALID_INPUT', 'Invalid catalog changes.');
        try { return kind === 'create' ? await draftCreate(read, args) : await draftUpdate(read, args); }
        catch (error) { if (error instanceof FieldError) throw new ApiError(400, 'INVALID_INPUT', 'Invalid catalog changes.'); throw error; }
      },
      async currentRevision(read, envelope) {
        checkedProposal(envelope.proposal, kind);
        if (kind === 'create') {
          if (envelope.resourceId !== 'catalog') throw new TypeError('Invalid catalog resource.');
          return { exists: true, revision: (await catalogCreateRevision(read)).revision };
        }
        if (envelope.proposal.before.id !== envelope.resourceId) throw new TypeError('Invalid product resource.');
        const current = await catalogUpdateRevision(read, envelope.resourceId, envelope.proposal.normalizedInput);
        return { exists: current !== null, revision: current };
      },
      async apply(store, proposal, context) {
        checkedProposal(proposal, kind);
        const actor = await author(store, context);
        const product = kind === 'create' ? await trackCreate(store, actor, () => createProduct(store, proposal.normalizedInput))
          : await trackUpdate(store, proposal.before.id, actor, () => updateProduct(store, proposal.before.id, proposal.normalizedInput));
        if (!product) notFound();
        const actual = fromService(product), expected = kind === 'create' ? { ...proposal.after, id: product.id, listingId: product.listingId } : proposal.after;
        if (canonicalOperationJson(actual) !== canonicalOperationJson(expected)) throw new TypeError('Catalog normalization changed during commit.');
        return { productId: product.id, listingId: product.listingId, revision: kind === 'create' ? (await catalogCreateRevision(store)).revision : await catalogUpdateRevision(store, product.id, proposal.normalizedInput) };
      },
      validResult: value => valid(value, receiptSchema), toReceipt: value => ({ productId: value.productId, listingId: value.listingId, revision: value.revision }),
      validReceipt: value => valid(value, receiptSchema),
    } };
}
// Importing descriptors activates no domain tool. Default wiring requires separate review.
export const catalogCreateTool = () => registration('create');
export const catalogUpdateTool = () => registration('update');
