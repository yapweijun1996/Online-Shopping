import { assertNoProtectedRichDetail } from '../product-detail.js';
import { createHash } from 'node:crypto';
import { ApiError } from '../http.js';
import { decodeProductImage, decodeThumbnail } from '../product-image.js';
import { galleryRole, productGallery } from '../product-gallery.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { mediaAssetKey } from './media-manifest.js';
import { MEDIA_LIMITS } from './media-schema.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const mimes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const metadataLimit = MEDIA_LIMITS.records * MEDIA_LIMITS.pageBytes;
const rawMetadataLimit = metadataLimit;
const galleryRowsLimit = MEDIA_LIMITS.products * MEDIA_LIMITS.newAssets;
const sourceRowsLimit = MEDIA_LIMITS.products + galleryRowsLimit;
const missing = () => { throw new ApiError(404, 'MEDIA_RESOURCE_NOT_FOUND', 'Media resource not found.'); };
const unsupported = () => { throw new ApiError(409, 'MEDIA_RESOURCE_UNSUPPORTED', 'Media resource needs a supported explicit layout.'); };
const changed = () => { throw new ApiError(409, 'MEDIA_RESOURCE_CHANGED', 'Media resource changed. Reopen its review.'); };
const limited = () => { throw new ApiError(503, 'MEDIA_RESOURCE_LIMIT', 'Media resource exceeds its safe review limit.'); };
const hash = data => createHash('sha256').update(data).digest('hex');
const length = (read, column, text = false) => read.dialect === 'postgres' ? `octet_length(${column})` : `length(${text ? `CAST(${column} AS BLOB)` : column})`;
const textSize = (read, fields) => fields.map(field => `COALESCE(${length(read, field, true)},0)`).join(' + ');
function count(value) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) unsupported(); return n; }
function id(value) { if (typeof value !== 'string' || !uuid.test(value)) unsupported(); return value; }
function text(value, max, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > max) unsupported();
  return value;
}
function instant(value) { text(value, 24); if (value.length !== 24 || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) unsupported(); return value; }
function frozen(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }
function sourceKey(value) { return value.source_kind + ':' + value.source_product_id + ':' + value.source_id; }
function mainSource(productId) { return { source_kind: 'PRODUCT_MAIN', source_id: productId, source_product_id: productId }; }
function gallerySource(productId, galleryId) { return { source_kind: 'GALLERY', source_id: galleryId, source_product_id: productId }; }
function sourceRow(identity, mime, bytes, thumbnailMime, thumbnailBytes) {
  const full = bytes === null ? null : count(bytes), thumb = thumbnailBytes === null ? null : count(thumbnailBytes);
  if ((mime === null) !== (full === null) || (thumbnailMime === null) !== (thumb === null)) unsupported();
  if (full === null) { if (thumb !== null) unsupported(); return null; }
  if (!mimes.has(mime) || full < 1) unsupported();
  if (full > MEDIA_LIMITS.sourceBytes || (thumb !== null && thumb > MEDIA_LIMITS.thumbnailBytes)) limited();
  if (thumb !== null && (!mimes.has(thumbnailMime) || thumb < 1)) unsupported();
  return { ...identity, stage_id: null, mime, byte_length: full, thumbnail: thumb === null ? null : { mime: thumbnailMime, byte_length: thumb } };
}
function layout(value) {
  if (value === null) return null;
  let rows; try { rows = JSON.parse(value); } catch { unsupported(); }
  if (!Array.isArray(rows) || rows.length > MEDIA_LIMITS.oldAssets || rows.some(ref => ref !== 'main' && (typeof ref !== 'string' || !uuid.test(ref))) || new Set(rows).size !== rows.length) unsupported();
  return rows;
}
function stream(records) {
  const state = createHash('sha256'); let bytes = 0;
  for (const record of records) {
    const json = canonicalOperationJson(record); bytes += Buffer.byteLength(json);
    if (bytes > metadataLimit) limited();
    state.update(String(Buffer.byteLength(json)) + ':').update(json);
  }
  return state.digest('hex');
}
async function collect(read, productId, targetListingId = null, expectedCapture = null) {
  id(productId);
  const target = await read.get('SELECT id, substr(listing_id,1,37) AS listing_id FROM product WHERE id = ?', productId);
  if (!target) missing(); id(target.listing_id);
  if (targetListingId !== null) id(targetListingId);
  const listingIds = [...new Set([target.listing_id, ...(targetListingId === null ? [] : [targetListingId])])].sort();
  await assertNoProtectedRichDetail(read, listingIds);
  const capture = listingIds.length > 1 ? { sourceListingId: target.listing_id, listingIds } : null;
  if (expectedCapture && canonicalOperationJson(capture) !== canonicalOperationJson(expectedCapture)) changed();
  if (capture && !await read.get('SELECT id FROM listing WHERE id = ?', targetListingId)) { if (expectedCapture) changed(); missing(); }
  const scope = listingIds.length === 1 ? '= ?' : 'IN (?,?)';
  const stats = await read.get(`SELECT COUNT(*) AS n, COALESCE(SUM(${textSize(read, ['p.id','p.listing_id','p.sku','p.name','p.category','p.variant_group','p.variant_label','p.created_at','p.gallery_layout_json','c.label'])}),0) AS metadata_bytes,
    COALESCE(SUM(COALESCE(${length(read, 'p.image_data')},0) + COALESCE(${length(read, 'p.thumb_data')},0)),0) AS byte_count,
    COUNT(p.image_data) AS sources FROM product p LEFT JOIN general_code c ON c.type = 'PRODUCT_CATEGORY' AND c.code = p.category WHERE p.listing_id ${scope}`, ...listingIds);
  if (count(stats.n) > MEDIA_LIMITS.products || count(stats.metadata_bytes) > rawMetadataLimit || count(stats.byte_count) > MEDIA_LIMITS.oldBytes) limited();
  const galleryStats = await read.get(`SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(${length(read, 'g.data')},0) + COALESCE(${length(read, 'g.thumb_data')},0)),0) AS byte_count,
    COALESCE(SUM(${textSize(read, ['g.id','g.product_id','g.created_at'])}),0) AS metadata_bytes
    FROM product_gallery_image g JOIN product p ON p.id = g.product_id WHERE p.listing_id ${scope}`, ...listingIds);
  const physicalBytes = count(stats.byte_count) + count(galleryStats.byte_count);
  if (physicalBytes > MEDIA_LIMITS.oldBytes || count(stats.sources) + count(galleryStats.n) > sourceRowsLimit || count(stats.metadata_bytes) + count(galleryStats.metadata_bytes) > rawMetadataLimit) limited();
  const listings = await read.all(`SELECT id, code, name FROM listing WHERE id ${scope} AND ${textSize(read, ['code','name'])} <= ? ORDER BY id LIMIT ?`, ...listingIds, rawMetadataLimit, MEDIA_LIMITS.listings + 1);
  if (capture && listings.length !== listingIds.length) { if (expectedCapture) changed(); unsupported(); }
  if (!listings.length) unsupported(); if (listings.length > MEDIA_LIMITS.listings) limited();
  for (const listing of listings) { id(listing.id); text(listing.code, 80, true); text(listing.name, 120); }
  const rows = await read.all(`SELECT p.id,p.listing_id,p.sku,p.name,p.category,c.label AS category_label,c.active AS category_active,p.variant_group,p.variant_label,p.active,p.created_at,p.gallery_layout_json,
    p.image_mime,p.thumb_mime,${length(read, 'p.image_data')} AS image_bytes,${length(read, 'p.thumb_data')} AS thumb_bytes
    FROM product p LEFT JOIN general_code c ON c.type = 'PRODUCT_CATEGORY' AND c.code = p.category WHERE p.listing_id ${scope} ORDER BY p.id LIMIT ?`, ...listingIds, MEDIA_LIMITS.products + 1);
  if (rows.length !== count(stats.n) || rows.length > MEDIA_LIMITS.products) changed();
  // Existing manifest graphs cannot describe a non-null empty listing.
  if (capture && listingIds.some(listingId => !rows.some(row => row.listing_id === listingId))) unsupported();
  const products = [], sources = [];
  for (const row of rows) {
    id(row.id); id(row.listing_id); text(row.sku, 40); text(row.name, 120); text(row.category, 80); text(row.category_label, 80); text(row.variant_group, 40, true); text(row.variant_label, 80, true); instant(row.created_at);
    if (![0,1].includes(row.active) || ![0,1].includes(row.category_active)) unsupported();
    const source = sourceRow(mainSource(row.id), row.image_mime, row.image_bytes, row.thumb_mime, row.thumb_bytes);
    if (source) sources.push(source);
    products.push({ productId: row.id, listingId: row.listing_id, sku: row.sku, name: row.name, category: { code: row.category, label: row.category_label, active: row.category_active === 1 },
      variantGroup: row.variant_group, variantLabel: row.variant_label, active: row.active === 1, createdAt: row.created_at, layout: layout(row.gallery_layout_json), mainSource: source ? sourceKey(source) : null });
  }
  const gallery = await read.all(`SELECT g.id,g.product_id,g.position,g.mime,g.thumb_mime,g.created_at,${length(read, 'g.data')} AS image_bytes,${length(read, 'g.thumb_data')} AS thumb_bytes
    FROM product_gallery_image g JOIN product p ON p.id = g.product_id WHERE p.listing_id ${scope} ORDER BY g.product_id,g.position,g.id LIMIT ?`, ...listingIds, galleryRowsLimit + 1);
  if (gallery.length !== count(galleryStats.n)) changed();
  const galleries = [];
  for (const row of gallery) {
    id(row.id); id(row.product_id); instant(row.created_at);
    if (!Number.isSafeInteger(row.position) || row.position < 1 || row.position > 10) unsupported();
    const source = sourceRow(gallerySource(row.product_id, row.id), row.mime, row.image_bytes, row.thumb_mime, row.thumb_bytes);
    if (!source) unsupported(); sources.push(source);
    galleries.push({ galleryId: row.id, productId: row.product_id, position: row.position, createdAt: row.created_at, source: sourceKey(source) });
  }
  sources.sort((a,b) => sourceKey(a) < sourceKey(b) ? -1 : sourceKey(a) > sourceKey(b) ? 1 : 0);
  for (const product of products) for (const ref of product.layout || []) {
    if (ref === 'main') { if (!product.mainSource) unsupported(); }
    else if (!galleries.some(row => row.productId === product.productId && row.galleryId === ref)) unsupported();
  }
  const records = [{ kind: 'MEDIA_RESOURCE_SNAPSHOT', version: capture ? 2 : 1, targetId: productId, ...(capture ? { capture } : {}) }, ...listings.map(value => ({ listing: value })), ...products.map(value => ({ product: value })), ...galleries.map(value => ({ gallery: value })),
    ...sources.map(value => ({ source: { ...value, thumbnail: value.thumbnail && { ...value.thumbnail } } }))];
  return { targetId: productId, capture, listings, products, galleries, sources, graphReadBytes: { oldBytes: physicalBytes, newBytes: 0 }, structureRevision: stream(records), records };
}
async function bytes(read, source, thumbnail = false) {
  const table = source.source_kind === 'PRODUCT_MAIN' ? 'product' : 'product_gallery_image', field = thumbnail ? 'thumb_data' : source.source_kind === 'PRODUCT_MAIN' ? 'image_data' : 'data';
  const predicate = source.source_kind === 'PRODUCT_MAIN' ? 'id = ?' : 'id = ? AND product_id = ?', values = source.source_kind === 'PRODUCT_MAIN' ? [source.source_id] : [source.source_id, source.source_product_id];
  const expected = thumbnail ? source.thumbnail : source;
  if (!expected) missing();
  // Length predicate prevents a newly oversized source being returned after preflight.
  const row = await read.get(`SELECT ${field} AS media_bytes FROM ${table} WHERE ${predicate} AND ${length(read, field)} = ? LIMIT 1`, ...values, expected.byte_length);
  if (!row) changed();
  const data = row.media_bytes;
  if (!(data instanceof Uint8Array) || data.byteLength !== expected.byte_length) changed();
  try { (thumbnail ? decodeThumbnail : decodeProductImage)('data:' + expected.mime + ';base64,' + Buffer.from(data).toString('base64')); } catch { unsupported(); }
  return data;
}
function manifestAsset(source) {
  return { source_kind: source.source_kind, source_id: source.source_id, source_product_id: source.source_product_id, stage_id: null,
    byte_sha256: source.byte_sha256, mime: source.mime, byte_length: source.byte_length };
}
// Caller holds the platform/tenant lifecycle and shared store transaction.
// Metadata only leaves this function; content buffers are hashed sequentially.
async function snapshot(read, productId, targetListingId = null) {
  const graph = await collect(read, productId, targetListingId), assets = new Map();
  for (const source of graph.sources) {
    source.byte_sha256 = hash(await bytes(read, source));
    if (source.thumbnail) source.thumbnail.byte_sha256 = hash(await bytes(read, source, true));
    source.assetKey = mediaAssetKey(source.mime, source.byte_sha256);
    source.width = null; source.height = null; source.dimensionsVerified = false;
    if (!assets.has(source.assetKey)) assets.set(source.assetKey, manifestAsset(source));
    if (assets.size > MEDIA_LIMITS.oldAssets) limited();
  }
  const bySource = new Map(graph.sources.map(source => [sourceKey(source), source])), beforeProducts = [], beforeListings = [], views = [];
  for (const product of graph.products) {
    const own = product.mainSource && bySource.get(product.mainSource), role = await galleryRole(read, { id: product.productId, listingId: product.listingId });
    const visible = await productGallery(read, { id: product.productId, listingId: product.listingId, sku: product.sku, name: product.name, imageUrl: own ? 'main:' + product.productId : null }, true, 'manual');
    const refs = visible.galleryItems.map(item => {
      const identity = item.id === 'main' ? mainSource(product.productId) : gallerySource(visible.galleryHolderId || product.productId, item.id);
      const source = bySource.get(sourceKey(identity)); if (!source) unsupported();
      return { id: item.id, assetKey: source.assetKey, source: sourceKey(source), shared: item.shared === true };
    });
    const shared = visible.galleryShared === true, galleryKeys = refs.filter(item => !shared || item.shared).map(item => item.assetKey);
    if (galleryKeys.length > MEDIA_LIMITS.newAssets || refs.length > MEDIA_LIMITS.newAssets + 1) unsupported();
    beforeProducts.push({ productId: product.productId, listingId: product.listingId, role, mainAssetKey: own?.assetKey || null });
    if (role !== 'variant') beforeListings.push({ listingId: product.listingId, holderId: shared ? product.productId : null, galleryAssetKeys: galleryKeys });
    views.push({ productId: product.productId, role, holderId: visible.galleryHolderId || null, visible: refs,
      current: { id: product.productId, listingId: product.listingId, imageUrl: visible.imageUrl ? 'view:' + refs[0]?.assetKey : null, images: refs.map(item => item.assetKey),
        galleryItems: refs.map(item => ({ id: item.id, shared: item.shared })), galleryReferenceItems: [], ...(shared ? { galleryShared: true, galleryHolderId: visible.galleryHolderId } : {}) } });
  }
  if (beforeProducts.length + beforeListings.length > MEDIA_LIMITS.records) limited();
  const revision = stream([...graph.records, ...graph.sources.map(source => ({ asset: source })), ...views.map(view => ({ view }))]);
  return frozen({ version: graph.capture ? 2 : 1, targetId: productId, ...(graph.capture ? { capture: graph.capture } : {}), revision, structureRevision: graph.structureRevision, listings: graph.listings, products: graph.products,
    galleries: graph.galleries, sources: graph.sources, assets: [...assets.values()], views, before: { products: beforeProducts, listings: beforeListings }, graphReadBytes: graph.graphReadBytes });
}
// Preserve the existing single-listing shape and revision framing byte for byte.
export async function readMediaSnapshot(read, productId) { return snapshot(read, productId); }

// Internal target ID comes from the trusted listing plan, never tenant authority.
// Both components share every physical/read/effect budget before any BLOB load.
export async function readMediaUnionSnapshot(read, productId, options = {}) {
  if (!options || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some(key => key !== 'targetListingId' ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'))) unsupported();
  return snapshot(read, productId, options.targetListingId ?? null);
}
function capturedTarget(value) {
  if (value.version === 1) { if (Object.hasOwn(value, 'capture')) changed(); return null; }
  const capture = value.capture;
  if (value.version !== 2 || !capture || Object.keys(capture).sort().join(',') !== 'listingIds,sourceListingId' ||
      !Array.isArray(capture.listingIds) || capture.listingIds.length !== 2 || new Set(capture.listingIds).size !== 2 ||
      !capture.listingIds.every(item => typeof item === 'string' && uuid.test(item)) ||
      !capture.listingIds.includes(capture.sourceListingId) || capture.listingIds.join(',') !== [...capture.listingIds].sort().join(',')) changed();
  return capture.listingIds.find(item => item !== capture.sourceListingId);
}
// Internal exact-source loader, not an authorization/tenant selector. The future
// coordinator owns current full-graph authority/revision/lease/pin checks.
export async function loadOldMediaAsset(read, snapshot, expected, { thumbnail = false } = {}) {
  if (!snapshot || ![1,2].includes(snapshot.version) || !sha.test(snapshot.structureRevision || '') || !Array.isArray(snapshot.sources)) changed();
  const targetListingId = capturedTarget(snapshot);
  const keys = ['source_kind','source_id','source_product_id','stage_id','byte_sha256','mime','byte_length'];
  if (!expected || typeof expected !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(expected)) ||
      Reflect.ownKeys(expected).length !== keys.length || keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(expected, key) || {}, 'value'))) changed();
  if (!['PRODUCT_MAIN','GALLERY'].includes(expected.source_kind) || !uuid.test(expected.source_id || '') || !uuid.test(expected.source_product_id || '') ||
      expected.stage_id !== null || !mimes.has(expected.mime) || !sha.test(expected.byte_sha256 || '') || !Number.isSafeInteger(expected.byte_length) ||
      expected.byte_length < 1 || expected.byte_length > MEDIA_LIMITS.sourceBytes || (expected.source_kind === 'PRODUCT_MAIN' && expected.source_id !== expected.source_product_id)) changed();
  const captured = snapshot.sources.find(source => sourceKey(source) === sourceKey(expected));
  if (!captured || canonicalOperationJson(manifestAsset(captured)) !== canonicalOperationJson(expected)) changed();
  const current = await collect(read, snapshot.targetId, targetListingId, snapshot.version === 2 ? snapshot.capture : null);
  if (current.structureRevision !== snapshot.structureRevision) changed();
  const source = current.sources.find(item => sourceKey(item) === sourceKey(captured)); if (!source) changed();
  const data = await bytes(read, source, thumbnail), identity = thumbnail ? captured.thumbnail : captured;
  if (!identity || hash(data) !== identity.byte_sha256) changed();
  return { data, mime: identity.mime, byte_length: identity.byte_length, byte_sha256: identity.byte_sha256 };
}
