import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './http.js';
import { FieldError } from './validation.js';
import { decodeProductImage } from './product-image.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = data => createHash('sha256').update(data).digest('hex');
const missing = () => { throw new ApiError(404, 'NOT_FOUND', 'Not found.'); };
const conflict = () => { throw new ApiError(409, 'DETAIL_CHANGED', 'The product detail or its variant membership changed. Reload before saving.'); };
const invalid = message => { throw new FieldError('document', message || 'Use the supported detail blocks.'); };
const empty = () => ({ version: 1, blocks: [] });
const shape = (value, required, optional = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
};
const text = (value, max, allowEmpty = true) => {
  if (typeof value !== 'string' || value.length > max || !allowEmpty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid('Detail text is empty, too long, or contains unsupported control characters.');
  return value;
};

export function normalizeDetailDocument(input) {
  shape(input, ['version', 'blocks']);
  if (input.version !== 1 || !Array.isArray(input.blocks) || input.blocks.length > 40) invalid('Use up to forty detail blocks.');
  let characters = 0, images = 0;
  const addText = (value, max, allowEmpty = true) => { const result = text(value, max, allowEmpty); characters += result.length; return result; };
  const blocks = input.blocks.map(block => {
    if (block?.type === 'heading') {
      shape(block, ['type','text']); return { type: 'heading', text: addText(block.text, 240) };
    }
    if (block?.type === 'paragraph') {
      shape(block, ['type','text'], ['bold']);
      if (Object.hasOwn(block, 'bold') && typeof block.bold !== 'boolean') invalid();
      return { type: 'paragraph', text: addText(block.text, 5000), ...(Object.hasOwn(block, 'bold') ? { bold: block.bold } : {}) };
    }
    if (block?.type === 'list') {
      shape(block, ['type','items']);
      if (!Array.isArray(block.items) || !block.items.length || block.items.length > 30) invalid();
      return { type: 'list', items: block.items.map(item => addText(item, 500)) };
    }
    if (block?.type === 'image') {
      shape(block, ['type','assetId','alt','caption']);
      if (!uuid.test(block.assetId || '') || ++images > 20) invalid('Choose up to twenty uploaded detail images.');
      return { type: 'image', assetId: block.assetId, alt: addText(block.alt, 500, false), caption: addText(block.caption, 1000) };
    }
    if (block?.type === 'specs') {
      shape(block, ['type','rows']);
      if (!Array.isArray(block.rows) || !block.rows.length || block.rows.length > 30) invalid();
      return { type: 'specs', rows: block.rows.map(row => {
        shape(row, ['label','value']);
        return { label: addText(row.label, 120), value: addText(row.value, 500) };
      }) };
    }
    invalid();
  });
  const document = { version: 1, blocks };
  if (characters > 50000 || JSON.stringify(document).length > 160000) invalid('The detail supports fifty thousand text characters.');
  return document;
}

async function productListing(store, productId, seller) {
  const row = await store.get('SELECT id, listing_id, active FROM product WHERE id = ?', productId);
  if (!row || !seller && row.active !== 1 || !row.listing_id) missing();
  return row.listing_id;
}
async function state(store, productId, seller) {
  const listingId = await productListing(store, productId, seller);
  const saved = await store.get('SELECT revision, document_json FROM listing_detail WHERE listing_id = ?', listingId);
  const members = await store.all('SELECT id FROM product WHERE listing_id = ? ORDER BY id LIMIT 1001', listingId);
  if (members.length > 1000) throw new ApiError(503, 'DETAIL_VARIANT_LIMIT', 'The listing exceeds the supported rich detail variant limit.');
  const revision = hash(JSON.stringify({ listingId, sequence: saved?.revision ?? 0, members: members.map(row => row.id) }));
  return { listingId, revision, sequence: saved?.revision ?? 0, document: saved ? normalizeDetailDocument(JSON.parse(saved.document_json)) : empty() };
}
const imageIds = document => [...new Set(document.blocks.filter(block => block.type === 'image').map(block => block.assetId))];
const assetDto = (row, productId, seller) => ({ id: row.id,
  src: `/api/v1/${seller ? 'seller/' : ''}products/${productId}/detail/images/${row.id}`, width: row.width, height: row.height });

export async function getProductDetail(store, productId, seller = false) {
  return store.transaction(async () => {
    const current = await state(store, productId, seller);
    const assets = [];
    for (const id of imageIds(current.document)) {
      const row = await store.get('SELECT id, width, height FROM listing_detail_image WHERE listing_id = ? AND id = ? AND committed = 1', current.listingId, id);
      if (!row) throw new ApiError(409, 'DETAIL_ASSET_MISSING', 'A saved detail image is unavailable.');
      assets.push(assetDto(row, productId, seller));
    }
    return { listingId: current.listingId, revision: current.revision, document: current.document, assets };
  });
}

// Staged images expire after one day. The quota and cleanup run under the same
// store writer lock; public handlers never expose or reference staged uploads.
async function cleanStaged(store, listingId, now) {
  await store.run('DELETE FROM listing_detail_image WHERE listing_id = ? AND committed = 0 AND created_at < ?',
    listingId, new Date(now - 86400000).toISOString());
}

export async function saveProductDetail(store, productId, input, actor) {
  shape(input, ['expectedRevision','document']);
  if (typeof input.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedRevision)) conflict();
  const document = normalizeDetailDocument(input.document);
  return store.transaction(async () => {
    const current = await state(store, productId, true);
    if (current.revision !== input.expectedRevision) conflict();
    await cleanStaged(store, current.listingId, Date.now());
    const selected = imageIds(document);
    for (const id of selected) {
      if (!await store.get('SELECT id FROM listing_detail_image WHERE listing_id = ? AND id = ?', current.listingId, id)) {
        invalid('This image expired or belongs to another product. Upload it again.');
      }
    }
    const listing = await store.get('SELECT updated_at FROM listing WHERE id = ?', current.listingId);
    const now = new Date(Math.max(Date.now(), Date.parse(listing.updated_at) + 1)).toISOString(), sequence = current.sequence + 1;
    if (!Number.isSafeInteger(sequence)) conflict();
    const serialized = JSON.stringify(document);
    if (current.sequence === 0) {
      await store.run('INSERT INTO listing_detail(listing_id, revision, document_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
        current.listingId, sequence, serialized, actor, now);
    } else {
      await store.run('UPDATE listing_detail SET revision = ?, document_json = ?, updated_by = ?, updated_at = ? WHERE listing_id = ? AND revision = ?',
        sequence, serialized, actor, now, current.listingId, current.sequence);
    }
    // Successful explicit saves are deletion authority for formerly committed
    // images only; other in-flight tabs retain their staged uploads to expiry.
    const committed = await store.all('SELECT id FROM listing_detail_image WHERE listing_id = ? AND committed = 1', current.listingId);
    for (const row of committed) if (!selected.includes(row.id)) await store.run('DELETE FROM listing_detail_image WHERE listing_id = ? AND id = ?', current.listingId, row.id);
    for (const id of selected) await store.run('UPDATE listing_detail_image SET committed = 1 WHERE listing_id = ? AND id = ?', current.listingId, id);
    await store.run('UPDATE listing SET updated_at = ? WHERE id = ?', now, current.listingId);
    // Store only revision and block counts, never image bytes or long detail text.
    const changes = JSON.stringify([{ field: 'richDetail', from: current.sequence, to: sequence }, { field: 'detailBlocks', from: current.document.blocks.length, to: document.blocks.length }]);
    await store.run("INSERT INTO product_event(id, product_id, actor, action, changes, created_at) VALUES (?, ?, ?, 'UPDATED', ?, ?)", randomUUID(), productId, actor, changes, now);
    return getProductDetail(store, productId, true);
  });
}

// Dimensions come from the encoded image headers, not caller-supplied metadata.
// This shares existing byte/signature validation with product/gallery uploads;
// it is not a native full-pixel decoder or an image-safety attestation.
export function detailImageDimensions(image) {
  const data = image.data;
  let width = 0, height = 0;
  if (image.mime === 'image/png' && data.length >= 45 && data.readUInt32BE(8) === 13 && data.toString('ascii',12,16) === 'IHDR' && data.toString('ascii',data.length - 8,data.length - 4) === 'IEND') {
    let offset = 8, hasData = false, hasEnd = false;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset), kind = data.toString('ascii',offset + 4,offset + 8);
      if (length > data.length - offset - 12 || kind === 'acTL') break;
      if (kind === 'IDAT' && length) hasData = true;
      offset += 12 + length;
      if (kind === 'IEND') { hasEnd = length === 0 && offset === data.length; break; }
    }
    if (hasData && hasEnd) { width = data.readUInt32BE(16); height = data.readUInt32BE(20); }
  } else if (image.mime === 'image/jpeg' && data.length > 10 && data.readUInt16BE(data.length - 2) === 0xffd9) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 8) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else if (image.mime === 'image/webp' && data.length >= 30 && data.readUInt32LE(4) + 8 === data.length) {
    const type = data.toString('ascii',12,16);
    if (type === 'VP8X' && data.readUInt32LE(16) === 10 && !(data[20] & 2)) {
      width = 1 + data.readUIntLE(24,3); height = 1 + data.readUIntLE(27,3);
    } else if (type === 'VP8 ' && data.length >= 30 && data.subarray(23,26).equals(Buffer.from([0x9d,0x01,0x2a]))) {
      width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff;
    } else if (type === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  if (!width || !height || width > 32768 || height > 32768 || width * height > 40000000) {
    throw new FieldError('imageDataUrl', 'Use a valid static PNG, JPEG, or WebP image up to 32768 pixels per side and forty million pixels.');
  }
  return { width, height };
}

export async function stageProductDetailImage(store, productId, input) {
  shape(input, ['imageDataUrl']);
  const image = decodeProductImage(input.imageDataUrl);
  if (!image) throw new FieldError('imageDataUrl', 'Choose an image.');
  const dimensions = detailImageDimensions(image);
  return store.transaction(async () => {
    const listingId = await productListing(store, productId, true);
    await cleanStaged(store, listingId, Date.now());
    const quota = await store.get('SELECT COUNT(*) AS n, COALESCE(SUM(length(data)),0) AS bytes FROM listing_detail_image WHERE listing_id = ?', listingId);
    // A little headroom allows a complete replacement while the old document is
    // still live. Saving commits at most twenty referenced assets.
    if (Number(quota.n) >= 40 || Number(quota.bytes) + image.data.length > 20 * 1024 * 1024) throw new ApiError(409, 'DETAIL_IMAGE_LIMIT', 'Save or remove unused detail images before uploading more.');
    const id = randomUUID();
    await store.run('INSERT INTO listing_detail_image(id, listing_id, mime, data, width, height, sha256, committed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
      id, listingId, image.mime, image.data, dimensions.width, dimensions.height, hash(image.data), new Date().toISOString());
    return assetDto({ id, ...dimensions }, productId, true);
  });
}

export async function getProductDetailImage(store, productId, assetId, seller = false) {
  return store.transaction(async () => {
    const current = await state(store, productId, seller);
    const row = await store.get('SELECT mime, data, width, height, sha256, committed, created_at FROM listing_detail_image WHERE listing_id = ? AND id = ?', current.listingId, assetId);
    if (!row || !seller && (row.committed !== 1 || !imageIds(current.document).includes(assetId)) ||
        seller && row.committed === 0 && Date.parse(row.created_at) < Date.now() - 86400000) missing();
    if (hash(row.data) !== row.sha256) throw new ApiError(409, 'DETAIL_ASSET_MISSING', 'The detail image is unavailable.');
    return row;
  });
}

// Existing protected review graphs do not include rich-detail assets. Never
// pretend their main/gallery acknowledgments cover this new content.
export async function assertNoProtectedRichDetail(read, listingIds) {
  for (const id of new Set(listingIds.filter(Boolean))) {
    const detail = await read.get('SELECT document_json FROM listing_detail WHERE listing_id = ?', id);
    if (detail && JSON.parse(detail.document_json).blocks.length) throw new ApiError(409, 'CATALOG_RICH_DETAIL_UNSUPPORTED', 'This listing has rich detail. Edit it in Seller Studio; protected catalog review does not yet cover detail content.');
  }
}

export async function requireSafeDetailMembershipMove(store, sourceId, targetId) {
  if (sourceId === targetId) return;
  for (const id of new Set([sourceId,targetId].filter(Boolean))) {
    const detail = await store.get('SELECT document_json FROM listing_detail WHERE listing_id = ?', id);
    if (detail && JSON.parse(detail.document_json).blocks.length) throw new ApiError(409, 'DETAIL_MEMBERSHIP_CONFLICT', 'This move changes shared rich detail. Keep the current variant group, or save a copy and explicitly clear the affected detail before regrouping.');
  }
}

// Discard only private staged bytes. A concurrent successful document save wins
// first under the same writer lock, in which case discard cannot remove live media.
export async function discardProductDetailImage(store, productId, assetId) {
  return store.transaction(async () => {
    const listingId = await productListing(store, productId, true);
    const image = await store.get('SELECT committed FROM listing_detail_image WHERE listing_id = ? AND id = ?', listingId, assetId);
    if (!image) missing();
    if (image.committed !== 0) throw new ApiError(409, 'DETAIL_IMAGE_IN_USE', 'This image is saved in the detail. Remove it by saving the document.');
    await store.run('DELETE FROM listing_detail_image WHERE listing_id = ? AND id = ? AND committed = 0', listingId, assetId);
    return { deleted: true };
  });
}
