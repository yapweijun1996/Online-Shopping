import { createHash, randomUUID } from 'node:crypto';
import manifest from './public-demo-gallery.json' with { type: 'json' };
import { ApiError } from './http.js';
import { FieldError } from './validation.js';
import { decodeProductImage } from './product-image.js';

const hash = data => createHash('sha256').update(data).digest('hex');
const version = date => Date.parse(date).toString(36);
function staticMedia(id) {
  const match = /^static:(DEMO-\d{3}):([1-5])$/.exec(id);
  const media = match && manifest.products[match[1]]?.media[Number(match[2])];
  return media && { id, ...media };
}

// A saved layout owns order and primary identity. Static references retain their
// original files; neither reads nor migration rewrite existing product assets.
export function productGallery(store, product, seller, mode = 'manual') {
  const row = store.get('SELECT image_data, gallery_layout_json FROM product WHERE id = ?', product.id);
  const uploads = store.all('SELECT id, mime, data, created_at FROM product_gallery_image WHERE product_id = ? ORDER BY position', product.id);
  const media = new Map();
  if (product.imageUrl) media.set('main', { id: 'main', src: product.imageUrl });
  for (const entry of uploads) media.set(entry.id, { id: entry.id,
    src: `/api/v1/${seller ? 'seller/' : ''}products/${product.id}/gallery/${entry.id}${seller ? '' : `?v=${version(entry.created_at)}`}` });
  let ids;
  if (row.gallery_layout_json !== null) {
    ids = JSON.parse(row.gallery_layout_json);
    for (const id of ids) { const item = staticMedia(id); if (item) media.set(id, item); }
  } else {
    const entry = manifest.products[product.sku];
    const staticIds = mode === 'public-demo' && entry && product.name === entry.name && row.image_data &&
      hash(row.image_data) === entry.heroSha256 ? entry.media.slice(1).map((_, index) => `static:${product.sku}:${index + 1}`) : [];
    for (const id of staticIds) media.set(id, staticMedia(id));
    ids = [...(product.imageUrl ? ['main'] : []), ...staticIds, ...uploads.map(item => item.id)];
  }
  const items = ids.map(id => media.get(id)).filter(Boolean);
  return { ...product, imageUrl: items[0]?.src || null, images: items.map(item => item.src),
    imageMedia: items, galleryItems: items };
}

export function saveProductGallery(store, productId, requested, current) {
  if (!Array.isArray(requested) || requested.length > 20) throw new FieldError('gallery', 'Choose up to ten images.');
  const allowed = new Map(current.galleryItems.map(item => [item.id, item]));
  const original = store.get('SELECT image_data FROM product WHERE id = ?', productId);
  if (original.image_data) allowed.set('main', { id: 'main' });
  const uploads = store.all('SELECT * FROM product_gallery_image WHERE product_id = ? ORDER BY position', productId);
  const uploadById = new Map(uploads.map(item => [item.id, item]));
  const fingerprint = new Map(uploads.map(item => [hash(item.data), item.id]));
  if (original.image_data) fingerprint.set(hash(original.image_data), 'main');
  const selected = [], seen = new Set(), pending = new Map();
  for (const entry of requested) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 1) {
      throw new FieldError('gallery', 'Choose an existing image or upload a new image.');
    }
    let id = entry.id;
    if (Object.hasOwn(entry, 'imageDataUrl')) {
      const image = decodeProductImage(entry.imageDataUrl);
      if (!image) throw new FieldError('gallery', 'Choose an image.');
      const digest = hash(image.data);
      id = fingerprint.get(digest);
      if (!id) {
        id = randomUUID(); fingerprint.set(digest, id);
        pending.set(id, { id, mime: image.mime, data: image.data, created_at: new Date().toISOString() });
      }
    } else if (typeof id !== 'string' || !allowed.has(id)) {
      // Client URLs, another product's static IDs and cross-store upload IDs are
      // never resolved by a global lookup or fetched from the network.
      throw new FieldError('gallery', 'This image does not belong to this product.');
    }
    if (!seen.has(id)) { seen.add(id); selected.push(id); }
  }
  if (selected.length > 10) throw new FieldError('gallery', 'A product supports ten images in total.');
  if (selected.includes('main') && !original.image_data) throw new FieldError('gallery', 'Add a main image first.');
  // Reinsert only the selected uploads with their original IDs and bytes. The
  // enclosing product transaction rolls metadata, images and layout back together.
  store.run('DELETE FROM product_gallery_image WHERE product_id = ?', productId);
  let position = 0;
  for (const id of selected) {
    const image = pending.get(id) || uploadById.get(id);
    if (image) store.run('INSERT INTO product_gallery_image(id, product_id, position, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, productId, ++position, image.mime, image.data, image.created_at);
  }
  store.run('UPDATE product SET gallery_layout_json = ? WHERE id = ?', JSON.stringify(selected), productId);
}

export function requireGalleryRevision(current, expected) {
  if (typeof expected !== 'string' || expected !== current.updatedAt) {
    throw new ApiError(409, 'PRODUCT_CHANGED', 'This product changed. Reopen it before saving gallery changes.');
  }
}
