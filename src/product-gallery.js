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
    ids = galleryLayoutIds(JSON.parse(row.gallery_layout_json), false, []);
    for (const id of ids) {const item = staticMedia(id);if (item) media.set(id, item);}
  } else {
    // v11 already exposed main + stored uploads. Preserve those authoritative
    // images if additive references would exceed ten; offer references separately
    // for explicit selection instead of deleting stored images or blocking edits.
    const staticIds = product.name === entry?.name && uploads.length <= 4 ? references.map((item) => item.id) : [];
    for (const id of staticIds) media.set(id, staticMedia(id));
    ids = galleryLayoutIds(null, Boolean(product.imageUrl), uploads.map(item => item.id), staticIds);
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
// The caller supplies rows ordered by the existing DATABASE created_at,sku,id rule.
export const galleryHolderFromOrderedMembers = rows => rows.length > 1 ? rows[0].id : null;

// Null layouts retain the original implicit main/reference/upload order.
export const galleryLayoutIds = (saved, hasMain, uploadIds, implicitReferenceIds = []) => saved === null
  ? [...(hasMain ? ['main'] : []), ...implicitReferenceIds, ...uploadIds] : saved;

// The real service obtains sameAsShared by its original SQL byte equality;
// a projector must derive that fact from captured full-byte SHA, never MIME keys.
export const sharedGalleryItems = (ownMain, shared, sameAsShared) => [
  ...(ownMain && !sameAsShared ? [ownMain] : []), ...shared.map(item => ({ ...item, shared: true }))
];

async function listingHolder(store, listingId) {
  if (!listingId) return null;
  const rows = await store.all('SELECT id FROM product WHERE listing_id = ? ORDER BY created_at, sku, id LIMIT 2', listingId);
  return galleryHolderFromOrderedMembers(rows);
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
    .filter((item) => item.id !== 'main');
  const sameAsShared = product.imageUrl && await store.get(`SELECT 1 AS found FROM product_gallery_image g
    JOIN product p ON p.id = ? WHERE g.product_id = ? AND g.data = p.image_data LIMIT 1`, product.id, holderId);
  const items = sharedGalleryItems(product.imageUrl ? { id: 'main', src: product.imageUrl } : null, shared, sameAsShared);
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

// Read-only selection plan. A trusted main projection reproduces the portal
// post-patch main state without speculative writes. Private bytes stay internal.
export async function planProductGallery(store, productId, requested, current, projection = {}) {
  if (!Array.isArray(requested) || requested.length > 20) throw new FieldError('gallery', 'Choose up to ten images.');
  const allowed = new Map([...current.galleryItems, ...(current.galleryReferenceItems || [])].map((item) => [item.id, item]));
  const original = await store.get('SELECT image_data, listing_id FROM product WHERE id = ?', productId);
  const mainData = Object.hasOwn(projection, 'mainImageDataUrl') ? decodeProductImage(projection.mainImageDataUrl)?.data ?? null : original.image_data;
  const holderId = await listingHolder(store, original.listing_id);
  const shared = Boolean(holderId);
  const role = !shared ? 'single' : holderId === productId ? 'holder' : 'variant';
  if (mainData && !shared) allowed.set('main', { id: 'main' });
  const uploads = await store.all('SELECT * FROM product_gallery_image WHERE product_id = ? ORDER BY position', productId);
  const uploadById = new Map(uploads.map((item) => [item.id, item]));
  const fingerprint = new Map(uploads.map((item) => [hash(item.data), item.id]));
  if (mainData && !shared) fingerprint.set(hash(mainData), 'main');
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
        id = `upload:sha256:${digest}`;
        // Stored legacy IDs need not be UUIDs; keep new aliases disjoint.
        for (let n = 1; allowed.has(id) || uploadById.has(id); n++) id = `upload:sha256:${digest}:${n}`;
        fingerprint.set(digest, id);
        const thumb = decodeThumbnail(entry.thumbDataUrl);
        pending.set(id, { mime: image.mime, data: image.data, thumb_mime: thumb?.mime || null, thumb_data: thumb?.data || null });
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
  if (selected.includes('main') && !mainData) throw new FieldError('gallery', 'Add a main image first.');
  return { productId, role, holderId, mainDigest: mainData ? hash(mainData) : null, selected, retained: uploadById, pending };
}

// Internal plans contain private bytes, not MCP proposal DTOs. Apply only a plan
// derived from current state inside the same enclosing business transaction.
// The existing caller still owns revision updates, domain history and authority.
export async function applyProductGalleryPlan(store, plan) {
  const { productId, selected, retained, pending } = plan;
  const allocated = new Map([...pending].map(([ref, image]) => [ref, { ...image, id: randomUUID(), created_at: new Date().toISOString() }]));
  const resolved = selected.map(ref => allocated.get(ref)?.id || ref);
  // Reinsert only selected uploads; retain old identities, bytes and timestamps.
  await store.run('DELETE FROM product_gallery_image WHERE product_id = ?', productId);
  let position = 0;
  for (const ref of selected) {
    const image = allocated.get(ref) || retained.get(ref);
    if (image) await store.run('INSERT INTO product_gallery_image(id, product_id, position, mime, data, created_at, thumb_mime, thumb_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      image.id, productId, ++position, image.mime, image.data, image.created_at, image.thumb_mime ?? null, image.thumb_data ?? null);
  }
  await store.run('UPDATE product SET gallery_layout_json = ? WHERE id = ?', JSON.stringify(resolved), productId);
  return resolved;
}

export async function saveProductGallery(store, productId, requested, current) {
  await applyProductGalleryPlan(store, await planProductGallery(store, productId, requested, current));
}

// Image-only replacement restores a hidden single main at the end, preserving
// the selected primary/order. Preview and portal share the same overflow guard.
export async function planProductMainRestoration(store, productId, imageDataUrl, current) {
  if (!imageDataUrl || current.galleryShared || current.galleryItems.some(item => item.id === 'main')) return null;
  return planProductGallery(store, productId, [...current.galleryItems.map(item => ({ id: item.id })), { id: 'main' }],
    current, { mainImageDataUrl: imageDataUrl });
}

// Preserve the upload endpoint's early image validation and optional-preview
// truthiness. Thumbnail validation remains in planning only for a new digest.
export function prepareGalleryUploadEntry(imageDataUrl, thumbDataUrl = null) {
  if (!decodeProductImage(imageDataUrl)) throw new FieldError('imageDataUrl', 'Choose an image.');
  return thumbDataUrl ? { imageDataUrl, thumbDataUrl } : { imageDataUrl };
}

// Shared unchanged guard for a main-only removal. An explicit gallery change
// is validated against its effective main by the layout planner instead.
export function requireMainImageRemoval(current, image, galleryChanging = false) {
  if (!galleryChanging && !current.galleryShared && image === null && current.images.length > (current.imageUrl ? 1 : 0)) {
    throw new FieldError('imageDataUrl', 'Remove gallery images before removing the main image.');
  }
}

export function requireGalleryRevision(current, expected) {
  if (typeof expected !== 'string' || expected !== current.updatedAt) {
    throw new ApiError(409, 'PRODUCT_CHANGED', 'This product changed. Reopen it before saving.');
  }
}

/*
 * Called when a listing has several products: makes the holder's gallery explicit and moves its main photo out of it
 * (as an uploaded copy), so the shared gallery no longer depends on any variant's main photo. Idempotent.
 */
// Metadata-only kernel shared by real SQL planning and a future bounded projector.
// This accepts trusted internal facts, not authority, bytes, IDs to allocate or URLs.
export function planSharedGallerySelection({ holderId, layout, mainSha256, uploads }) {
  const ids = galleryLayoutIds(layout, Boolean(mainSha256), uploads.map(row => row.id));
  if (!ids.includes('main')) return { holderId, selected: ids, pendingRef: null, writeLayout: layout === null };
  const twin = mainSha256 && uploads.find(row => row.byteSha256 === mainSha256);
  let replacement = twin?.id, pendingRef = null;
  if (!replacement && mainSha256 && uploads.length < 10) {
    const base = `shared-main:sha256:${mainSha256}`;
    replacement = base;
    for (let n = 1; ids.includes(replacement) || uploads.some(row => row.id === replacement); n++) replacement = `${base}:${n}`;
    pendingRef = replacement;
  }
  const selected = [];
  for (const id of ids) {
    const mapped = id === 'main' ? replacement : id;
    if (mapped && !selected.includes(mapped)) selected.push(mapped);
  }
  return { holderId, selected, pendingRef, writeLayout: true };
}

// Private binary plan: planning performs SELECTs only; new IDs/times are allocated
// by the existing service inside its caller's transaction, never by a client.
export async function planListingGallerySharing(store, listingId) {
  const holderId = await listingHolder(store, listingId);
  if (!holderId) return null;
  const holder = await store.get('SELECT id, image_mime, image_data, thumb_mime, thumb_data, gallery_layout_json FROM product WHERE id = ?', holderId);
  const uploads = await store.all('SELECT id, data FROM product_gallery_image WHERE product_id = ? ORDER BY position', holderId);
  const layout = holder.gallery_layout_json === null ? null : JSON.parse(holder.gallery_layout_json);
  const mainNeeded = holder.image_data && (layout === null || layout.includes('main'));
  const plan = planSharedGallerySelection({ holderId, layout, mainSha256: mainNeeded ? hash(holder.image_data) : null,
    uploads: uploads.map(row => ({ id: row.id, byteSha256: mainNeeded ? hash(row.data) : null })) });
  let pending = null;
  if (plan.pendingRef) {
    const position = Number((await store.get('SELECT COALESCE(MAX(position), 0) AS last FROM product_gallery_image WHERE product_id = ?', holderId)).last) + 1;
    pending = { ref: plan.pendingRef, position, mime: holder.image_mime, data: holder.image_data,
      thumb_mime: holder.thumb_mime ?? null, thumb_data: holder.thumb_data ?? null };
  }
  return { holderId, selected: plan.selected, pending, writeLayout: plan.writeLayout };
}

export async function shareListingGallery(store, listingId) {
  const plan = await planListingGallerySharing(store, listingId);
  if (!plan) return false;
  let replacement;
  if (plan.pending) {
    replacement = randomUUID();
    const image = plan.pending;
    await store.run('INSERT INTO product_gallery_image(id, product_id, position, mime, data, created_at, thumb_mime, thumb_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      replacement, plan.holderId, image.position, image.mime, image.data, new Date().toISOString(), image.thumb_mime, image.thumb_data);
  }
  if (plan.writeLayout) await store.run('UPDATE product SET gallery_layout_json = ? WHERE id = ?',
    JSON.stringify(plan.selected.map(ref => plan.pending && ref === plan.pending.ref ? replacement : ref)), plan.holderId);
  if (plan.pending || plan.writeLayout) {
    // Invalidate portal selections captured before this sharing conversion.
    const current = await store.get('SELECT updated_at FROM product WHERE id = ?', plan.holderId);
    await store.run('UPDATE product SET updated_at = ? WHERE id = ?',
      new Date(Math.max(Date.now(), Date.parse(current.updated_at) + 1)).toISOString(), plan.holderId);
  }
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
