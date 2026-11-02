// AI Studio work done for a seller: read a photo, and make one styled image at a time (independent jobs).
// Everything is a draft. Images are only generated for products that are not published, so nothing reaches the
// storefront before the seller looks at it. Calls are reserved against the daily cap before they are made.
import { randomUUID } from 'node:crypto';
import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';
import { decodeProductImage } from '../product-image.js';
import { listCategories } from '../settings.js';
import { getProduct, getProductImage, addGalleryImage } from '../products.js';
import { galleryRole } from '../product-gallery.js';
import { openKey } from './credential.js';
import { reserve, settle, failureOutcome } from './usage.js';
import { STYLES, STYLE_IDS, buildPrompt } from './styles.js';

const MAX_IN_FLIGHT = 2;   // the backend has a small memory cap; images are decoded in memory
const GALLERY_LIMIT = 10;
let inFlight = 0;

async function withSlot(work) {
  if (inFlight >= MAX_IN_FLIGHT) throw new ApiError(429, 'AI_STUDIO_BUSY', 'AI Studio is busy. Try again in a moment.');
  inFlight += 1;
  try { return await work(); } finally { inFlight -= 1; }
}

function providerFailure(error) {
  switch (error?.code) {
    case 'STUDIO_KEY_REJECTED': return new ApiError(422, 'AI_STUDIO_KEY_REJECTED', 'OpenAI no longer accepts the saved key. Enter it again.');
    case 'STUDIO_RATE_LIMITED': return new ApiError(429, 'AI_STUDIO_PROVIDER_LIMIT', 'OpenAI is limiting requests for this key. Try again later.');
    case 'STUDIO_REQUEST_REJECTED': return new ApiError(422, 'AI_STUDIO_REQUEST_REJECTED', 'OpenAI could not process this image. Try another photo.');
    case 'STUDIO_REFUSED': return new ApiError(422, 'AI_STUDIO_REFUSED', 'The AI declined to process this image. It may still have been charged.');
    case 'STUDIO_TIMEOUT': return new ApiError(504, 'AI_STUDIO_TIMEOUT', 'The request timed out and may still have been charged. Check your OpenAI usage before trying again.');
    case 'STUDIO_BAD_RESPONSE': return new ApiError(502, 'AI_STUDIO_BAD_RESPONSE', 'The AI returned an unreadable answer. It may still have been charged.');
    default: return new ApiError(502, 'AI_STUDIO_UNAVAILABLE', 'AI Studio could not complete the request.');
  }
}

async function requireKey(store, secretBox, shopId) {
  const apiKey = await openKey(store, secretBox, shopId);
  if (!apiKey) throw new ApiError(409, 'AI_STUDIO_NO_KEY', 'Add your OpenAI API key in AI Studio settings first.');
  return apiKey;
}

/* One billable call: suggestions for a product from one photo. Nothing is saved except the usage record. */
export async function analyzePhoto({ store, secretBox, shopId, studioProvider, actor, body, language = 'English' }) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((name) => name !== 'imageDataUrl')) {
    throw new FieldError('imageDataUrl', 'Choose a photo.');
  }
  const decoded = decodeProductImage(body.imageDataUrl);
  if (!decoded) throw new FieldError('imageDataUrl', 'Choose a photo.');
  return withSlot(async () => {
    const apiKey = await requireKey(store, secretBox, shopId);
    const categories = (await listCategories(store)).filter((category) => category.active);
    const [call] = await reserve(store, ['ANALYZE'], actor);
    try {
      const suggestion = await studioProvider(apiKey).analyze({ image: { mime: decoded.mime, data: decoded.data }, categories, languageHint: language });
      await settle(store, call, 'OK');
      return suggestion;
    } catch (error) {
      await settle(store, call, failureOutcome(error)).catch(() => {});
      throw providerFailure(error);
    }
  });
}

/* A generated image may only be added to a product that no shopper can see: not this product, nor a listing sibling. */
async function requireDraftProduct(store, product, productId) {
  const row = await store.get('SELECT listing_id FROM product WHERE id = ?', productId);
  const visible = await store.get('SELECT 1 AS found FROM product WHERE listing_id = ? AND active = 1', row.listing_id);
  if (visible || product.active) throw new ApiError(409, 'AI_STUDIO_PUBLISHED', 'Unpublish this product before generating images, then publish it again after you review them.');
  if (await galleryRole(store, { id: productId, listingId: row.listing_id }) === 'variant') throw new ApiError(409, 'AI_STUDIO_VARIANT', 'Generate images on the main variant of this listing: its gallery is shared.');
  const count = await store.get('SELECT COUNT(*) AS n FROM product_gallery_image WHERE product_id = ?', productId);
  if (Number(count.n) >= GALLERY_LIMIT) throw new ApiError(409, 'AI_STUDIO_GALLERY_FULL', 'The gallery is full. Remove a photo first.');
}

/* One style, one product: edit call, advisory review call, then the gallery image and its AI record together. */
export async function generateStyleImage({ store, secretBox, shopId, studioProvider, actor, productId, body, mode = 'manual' }) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((name) => name !== 'style') || !STYLE_IDS.includes(body.style)) {
    throw new FieldError('style', `Choose one of: ${STYLE_IDS.join(', ')}.`);
  }
  const style = body.style;
  return withSlot(async () => {
    const product = await getProduct(store, productId, true, mode);
    if (!product) throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
    const source = await getProductImage(store, productId, true);
    if (!source?.data) throw new FieldError('product', 'Add a main photo to this product first.');
    await requireDraftProduct(store, product, productId);
    const apiKey = await requireKey(store, secretBox, shopId);
    const [imageCall, reviewCall] = await reserve(store, ['IMAGE', 'REVIEW'], actor, productId);
    const provider = studioProvider(apiKey);
    const image = { mime: source.mime, data: Buffer.from(source.data) };
    let generated;
    try {
      generated = await provider.edit({ image, prompt: buildPrompt(style, { name: product.name, categoryLabel: product.category ?? '' }), size: STYLES[style].size, format: 'webp', compression: 70 });
      await settle(store, imageCall, 'OK');
    } catch (error) {
      await settle(store, imageCall, failureOutcome(error)).catch(() => {});
      await settle(store, reviewCall, 'ERROR').catch(() => {});
      throw providerFailure(error);
    }
    const dataUrl = `data:${generated.mime};base64,${generated.data.toString('base64')}`;
    try { decodeProductImage(dataUrl); }
    catch {
      await settle(store, reviewCall, 'ERROR').catch(() => {});
      throw new ApiError(422, 'AI_STUDIO_IMAGE_REJECTED', 'The generated image is larger than the gallery allows. It was charged to your key; try again.');
    }
    let verdict = null, issues = [];
    try {
      ({ verdict, issues } = await provider.review({ source: image, result: generated }));
      await settle(store, reviewCall, 'OK');
    } catch (error) {
      await settle(store, reviewCall, failureOutcome(error)).catch(() => {});
    }
    // The image and its AI-generated record are saved together, so a gallery photo never lacks its provenance.
    return store.transaction(async () => {
      const before = new Set((await store.all('SELECT id FROM product_gallery_image WHERE product_id = ?', productId)).map((row) => row.id));
      await addGalleryImage(store, productId, dataUrl, mode);
      const added = (await store.all('SELECT id FROM product_gallery_image WHERE product_id = ?', productId)).find((row) => !before.has(row.id));
      if (!added) throw new ApiError(500, 'AI_STUDIO_SAVE_FAILED', 'The generated image was not saved.');
      await store.run('INSERT INTO ai_studio_image (id, product_id, gallery_image_id, style, verdict, issues_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        randomUUID(), productId, added.id, style, verdict, JSON.stringify(issues), String(actor).slice(0, 300), new Date().toISOString());
      return { galleryImageId: added.id, style, aiGenerated: true, verdict, issues, reviewed: verdict !== null };
    });
  });
}

/* Provenance for the images that still exist in a product's gallery. */
export async function listStudioImages(store, productId) {
  const rows = await store.all(`SELECT a.gallery_image_id, a.style, a.verdict, a.issues_json, a.created_at FROM ai_studio_image a
    JOIN product_gallery_image g ON g.id = a.gallery_image_id AND g.product_id = a.product_id WHERE a.product_id = ? ORDER BY a.created_at`, productId);
  return rows.map((row) => ({ galleryImageId: row.gallery_image_id, style: row.style, aiGenerated: true, verdict: row.verdict, issues: JSON.parse(row.issues_json), createdAt: row.created_at }));
}
