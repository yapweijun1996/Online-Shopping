import { createHash, randomUUID } from 'node:crypto';
import manifest from './public-demo-gallery.json' with { type: 'json' };
import { ApiError } from './http.js';
import { FieldError } from './validation.js';
import { decodeProductImage, decodeThumbnail } from './product-image.js';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const version = (date) => Date.parse(date).toString(36);
function staticMedia(id) {
  const match = /^static:(DEMO-\d{3}):([1-5])$/.exec(id);
  const media = match && manifest.products[match[1]]?.media[Number(match[2])];
  return media && { id, ...media };
}

// A saved layout owns order and primary identity. Static references retain their
// original files; neither reads nor migration rewrite existing product assets.
async function singleGallery(store, product, seller, mode = 'manual') {
  const row = await store.get('SELECT gallery_layout_json FROM product WHERE id = ?', product.id);
  const uploads = await store.all('SELECT id, created_at FROM product_gallery_image WHERE product_id = ? ORDER BY position', product.id);
  const media = new Map();
  if (product.imageUrl) media.set('main', { id: 'main', src: product.imageUrl });
  for (const entry of uploads) media.set(entry.id, { id: entry.id,
    src: `/api/v1/${seller ? 'seller/' : ''}products/${product.id}/gallery/${entry.id}${seller ? '' : `?v=${version(entry.created_at)}`}` });
  let ids,references = [];
  const entry = manifest.products[product.sku];
  // Preview detail verifies one hero before offering immutable references, even
  // after metadata edits. Lists/variant covers never load image bytes.
  if (mode === 'public-demo' && entry && product.imageUrl) {
    const hero = await store.get('SELECT image_data FROM product WHERE id = ?', product.id);
    if (hero.image_data && hash(hero.image_data) === entry.heroSha256) references = entry.media.slice(1).map((_, index) => staticMedia(`static:${product.sku}:${index + 1}`));
  }
  if (row.gallery_layout_json !== null) {
    ids = JSON.parse(row.gallery_layout_json);
    for (const id of ids) {const item = staticMedia(id);if (item) media.set(id, item);}
  } else {
    // v11 already exposed main + stored uploads. Preserve those authoritative
    // images if additive references would exceed ten; offer references separately
    // for explicit selection instead of deleting stored images or blocking edits.
    const staticIds = product.name === entry?.name && uploads.length <= 4 ? references.map((item) => item.id) : [];
    for (const id of staticIds) media.set(id, staticMedia(id));
    ids = [...(product.imageUrl ? ['main'] : []), ...staticIds, ...uploads.map((item) => item.id)];
  }
  const items = ids.map((id) => media.get(id)).filter(Boolean);
  return { ...product, imageUrl: items[0]?.src || null, images: items.map((item) => item.src),
    imageMedia: items, galleryItems: items,
    ...(seller ? { galleryReferenceItems: references.filter((item) => !ids.includes(item.id)) } : {}) };
}

/*
 * Products of one listing share one photo gallery, kept on the listing's first variant (its "holder"). The gallery
 * holds only uploaded images, never a variant's main photo, so changing a colour's photo cannot alter the shared
 * photos or another colour. A variant shows its own main photo first when that photo is not already in the gallery.
 * A listing with a single product keeps the plain per-product gallery.
 */
async function listingHolder(store, listingId) {
  if (!listingId) return null;
  const rows = await store.all('SELECT id FROM product WHERE listing_id = ? ORDER BY created_at, sku, id LIMIT 2', listingId);
  return rows.length > 1 ? rows[0].id : null;
}

/* 'single': one product in its listing; 'holder': owns the shared gallery; 'variant': shows the holder's gallery. */
export async function galleryRole(store, product) {
  const holder = await listingHolder(store, product.listingId);
  return !holder ? 'single' : holder === product.id ? 'holder' : 'variant';
}

export async function productGallery(store, product, seller, mode = 'manual') {
  const holderId = await listingHolder(store, product.listingId);
  if (!holderId) return singleGallery(store, product, seller, mode);
  const holder = await store.get('SELECT id, sku, name FROM product WHERE id = ?', holderId);
  // The holder is read without its main photo, so only its uploaded images (and demo references) are shared.
  const shared = (await singleGallery(store, { ...holder, imageUrl: null }, seller, mode)).galleryItems
    .filter((item) => item.id !== 'main').map((item) => ({ ...item, shared: true }));
  const sameAsShared = product.imageUrl && await store.get(`SELECT 1 AS found FROM product_gallery_image g
    JOIN product p ON p.id = ? WHERE g.product_id = ? AND g.data = p.image_data LIMIT 1`, product.id, holderId);
  const own = product.imageUrl && !sameAsShared ? [{ id: 'main', src: product.imageUrl }] : [];
  const items = [...own, ...shared];
  return { ...product, imageUrl: items[0]?.src || null, images: items.map((item) => item.src), imageMedia: items,
    galleryItems: items, galleryShared: true, galleryHolderId: holderId, ...(seller ? { galleryReferenceItems: [] } : {}) };
}

export async function productCover(store, product, seller) {
  if (await listingHolder(store, product.listingId)) {
    if (product.imageUrl) return product.imageUrl;
    return (await productGallery(store, product, seller)).imageUrl;
  }
  const row = await store.get('SELECT gallery_layout_json FROM product WHERE id = ?', product.id);
  if (row.gallery_layout_json === null) return product.imageUrl;
  const id = JSON.parse(row.gallery_layout_json)[0];
  if (!id) return null;
  if (id === 'main') return product.imageUrl;
  const reference = staticMedia(id);
  if (reference) return reference.src;
  const upload = await store.get('SELECT id, created_at FROM product_gallery_image WHERE product_id = ? AND id = ?', product.id, id);
  return upload ? `/api/v1/${seller ? 'seller/' : ''}products/${product.id}/gallery/${upload.id}${seller ? '' : `?v=${version(upload.created_at)}`}` : null;
}

export async function saveProductGallery(store, productId, requested, current) {
  if (!Array.isArray(requested) || requested.length > 20) throw new FieldError('gallery', 'Choose up to ten images.');
  const allowed = new Map([...current.galleryItems, ...(current.galleryReferenceItems || [])].map((item) => [item.id, item]));
  const original = await store.get('SELECT image_data, listing_id FROM product WHERE id = ?', productId);
  const shared = Boolean(await listingHolder(store, original.listing_id));
  if (original.image_data && !shared) allowed.set('main', { id: 'main' });
  const uploads = await store.all('SELECT * FROM product_gallery_image WHERE product_id = ? ORDER BY position', productId);
  const uploadById = new Map(uploads.map((item) => [item.id, item]));
  const fingerprint = new Map(uploads.map((item) => [hash(item.data), item.id]));
  if (original.image_data && !shared) fingerprint.set(hash(original.image_data), 'main');
  const selected = [],seen = new Set(),pending = new Map();
  for (const entry of requested) {
    const keys = entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.keys(entry) : [];
    // An upload may carry its preview: { imageDataUrl, thumbDataUrl }.
    if (!(keys.length === 1 || (keys.length === 2 && keys.includes('imageDataUrl') && keys.includes('thumbDataUrl')))) {
      throw new FieldError('gallery', 'Choose an existing image or upload a new image.');
    }
    let id = entry.id;
    if (Object.hasOwn(entry, 'imageDataUrl')) {
      const image = decodeProductImage(entry.imageDataUrl);
      if (!image) throw new FieldError('gallery', 'Choose an image.');
      const digest = hash(image.data);
      id = fingerprint.get(digest);
      if (!id) {
        id = randomUUID();fingerprint.set(digest, id);
        const thumb = decodeThumbnail(entry.thumbDataUrl);
        pending.set(id, { id, mime: image.mime, data: image.data, created_at: new Date().toISOString(), thumb_mime: thumb?.mime || null, thumb_data: thumb?.data || null });
      }
    } else if (shared && id === 'main') {
      continue; // a variant's main photo is its own colour photo, not a shared one
    } else if (typeof id !== 'string' || !allowed.has(id)) {
      // Client URLs, another product's static IDs and cross-store upload IDs are
      // never resolved by a global lookup or fetched from the network.
      throw new FieldError('gallery', 'This image does not belong to this product.');
    }
    if (!seen.has(id)) {seen.add(id);selected.push(id);}
  }
  if (selected.length > 10) throw new FieldError('gallery', 'A product supports ten images in total.');
  if (selected.includes('main') && !original.image_data) throw new FieldError('gallery', 'Add a main image first.');
  // Reinsert only the selected uploads with their original IDs and bytes. The
  // enclosing product transaction rolls metadata, images and layout back together.
  await store.run('DELETE FROM product_gallery_image WHERE product_id = ?', productId);
  let position = 0;
  for (const id of selected) {
    const image = pending.get(id) || uploadById.get(id);
    if (image) await store.run('INSERT INTO product_gallery_image(id, product_id, position, mime, data, created_at, thumb_mime, thumb_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, productId, ++position, image.mime, image.data, image.created_at, image.thumb_mime ?? null, image.thumb_data ?? null);
  }
  await store.run('UPDATE product SET gallery_layout_json = ? WHERE id = ?', JSON.stringify(selected), productId);
}

export function requireGalleryRevision(current, expected) {
  if (typeof expected !== 'string' || expected !== current.updatedAt) {
    throw new ApiError(409, 'PRODUCT_CHANGED', 'This product changed. Reopen it before saving gallery changes.');
  }
}

/*
 * Called when a listing has several products: makes the holder's gallery explicit and moves its main photo out of it
 * (as an uploaded copy), so the shared gallery no longer depends on any variant's main photo. Idempotent.
 */
export async function shareListingGallery(store, listingId) {
  const holderId = await listingHolder(store, listingId);
  if (!holderId) return false;
  const holder = await store.get('SELECT id, image_mime, image_data, thumb_mime, thumb_data, gallery_layout_json FROM product WHERE id = ?', holderId);
  const uploads = await store.all('SELECT id, data FROM product_gallery_image WHERE product_id = ? ORDER BY position', holderId);
  const layout = holder.gallery_layout_json === null ? [...(holder.image_data ? ['main'] : []), ...uploads.map((row) => row.id)]
    : JSON.parse(holder.gallery_layout_json);
  if (!layout.includes('main')) {
    if (holder.gallery_layout_json === null) await store.run('UPDATE product SET gallery_layout_json = ? WHERE id = ?', JSON.stringify(layout), holderId);
    return true;
  }
  const twin = holder.image_data && uploads.find((row) => hash(row.data) === hash(holder.image_data));
  let replacement = twin?.id;
  if (!replacement && holder.image_data && uploads.length < 10) {
    replacement = randomUUID();
    const position = Number((await store.get('SELECT COALESCE(MAX(position), 0) AS last FROM product_gallery_image WHERE product_id = ?', holderId)).last) + 1;
    await store.run('INSERT INTO product_gallery_image(id, product_id, position, mime, data, created_at, thumb_mime, thumb_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      replacement, holderId, position, holder.image_mime, holder.image_data, new Date().toISOString(), holder.thumb_mime ?? null, holder.thumb_data ?? null);
  }
  const next = [];
  for (const id of layout) {
    const mapped = id === 'main' ? replacement : id;
    if (mapped && !next.includes(mapped)) next.push(mapped);
  }
  await store.run('UPDATE product SET gallery_layout_json = ? WHERE id = ?', JSON.stringify(next), holderId);
  return true;
}

/* Upgrade step: every multi-product listing gets a shared gallery, and the per-variant copies of it are removed. */
export async function migrateSharedGalleries(store) {
  const listings = await store.all('SELECT listing_id FROM product GROUP BY listing_id HAVING COUNT(*) > 1');
  for (const { listing_id: listingId } of listings) {
    await shareListingGallery(store, listingId);
    const holderId = await listingHolder(store, listingId);
    const others = await store.all('SELECT id FROM product WHERE listing_id = ? AND id <> ?', listingId, holderId);
    for (const other of others) {
      // Only exact copies of a shared photo are dropped; the variant keeps its own main photo.
      await store.run(`DELETE FROM product_gallery_image WHERE product_id = ? AND data IN
        (SELECT data FROM product_gallery_image WHERE product_id = ?)`, other.id, holderId);
      await store.run('UPDATE product SET gallery_layout_json = NULL WHERE id = ?', other.id);
    }
  }
  return listings.length;
}
