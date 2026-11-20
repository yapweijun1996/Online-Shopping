import { recordUsage } from './budget.js';
// AI Studio work done for a seller: read a photo, and make one styled image at a time (independent jobs).
// Generation stores private candidates. Only a seller's separate selection updates the gallery.
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
const DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000;
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
      const suggestion = await studioProvider(apiKey).analyze({ image: { mime: decoded.mime, data: decoded.data }, categories, languageHint: language, onUsage: data => recordUsage(store, call, data) });
      await settle(store, call, 'OK');
      return suggestion;
    } catch (error) {
      await settle(store, call, failureOutcome(error)).catch(() => {});
      throw providerFailure(error);
    }
  });
}

async function requireGalleryOwner(store, productId) {
  const row = await store.get('SELECT listing_id, image_mime FROM product WHERE id = ?', productId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
  const role = await galleryRole(store, { id: productId, listingId: row.listing_id });
  if (role === 'variant') throw new ApiError(409, 'AI_STUDIO_VARIANT', 'Choose the main variant of this listing: its gallery is shared.');
  if (!row.image_mime) throw new ApiError(409, 'AI_STUDIO_MAIN_PHOTO', 'Add a main photo to this product first.');
  return role;
}

/* One style, one product: edit call, advisory review call, then a private candidate. */
export async function generateStyleImage({ store, secretBox, shopId, studioProvider, actor, productId, body, mode = 'manual' }) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((name) => name !== 'style') || !STYLE_IDS.includes(body.style)) {
    throw new FieldError('style', `Choose one of: ${STYLE_IDS.join(', ')}.`);
  }
  const style = body.style;
  return withSlot(async () => {
    const product = await getProduct(store, productId, true, mode);
    if (!product) throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
    await requireGalleryOwner(store, productId);
    const source = await getProductImage(store, productId, true);
    if (!source?.data) throw new FieldError('product', 'Add a main photo to this product first.');
    const apiKey = await requireKey(store, secretBox, shopId);
    const [imageCall, reviewCall] = await reserve(store, ['IMAGE', 'REVIEW'], actor, productId);
    const provider = studioProvider(apiKey);
    const image = { mime: source.mime, data: Buffer.from(source.data) };
    let generated;
    try {
      generated = await provider.edit({ image, prompt: buildPrompt(style, { name: product.name, categoryLabel: product.category ?? '' }), size: STYLES[style].size, format: 'webp', compression: 70, onUsage: data => recordUsage(store, imageCall, data) });
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
      ({ verdict, issues } = await provider.review({ source: image, result: generated, onUsage: data => recordUsage(store, reviewCall, data) }));
      await settle(store, reviewCall, 'OK');
    } catch (error) {
      await settle(store, reviewCall, failureOutcome(error)).catch(() => {});
    }
    return store.transaction(async () => {
      await requireGalleryOwner(store, productId);
      const now = new Date();
      const draft = { id: randomUUID(), style, verdict, issues_json: JSON.stringify(issues),
        created_at: now.toISOString(), expires_at: new Date(now.getTime() + DRAFT_LIFETIME_MS).toISOString() };
      await store.run('DELETE FROM ai_studio_draft WHERE expires_at <= ?', draft.created_at);
      await store.run(`INSERT INTO ai_studio_draft (id, product_id, mime, data, style, verdict, issues_json, created_by, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      draft.id, productId, generated.mime, generated.data, style, verdict, draft.issues_json, String(actor).slice(0, 300), draft.created_at, draft.expires_at);
      return presentDraft(draft);
    });
  });
}

function presentDraft(row) {
  return { draftId: row.id, style: row.style, aiGenerated: true, verdict: row.verdict, issues: JSON.parse(row.issues_json),
    reviewed: row.verdict !== null, createdAt: row.created_at, expiresAt: row.expires_at };
}

export async function listStudioDrafts(store, productId) {
  const rows = await store.all(`SELECT id, style, verdict, issues_json, created_at, expires_at FROM ai_studio_draft
    WHERE product_id = ? AND expires_at > ? ORDER BY created_at, id`, productId, new Date().toISOString());
  return rows.map(presentDraft);
}

export async function getStudioDraftImage(store, productId, draftId) {
  return store.get('SELECT mime, data FROM ai_studio_draft WHERE product_id = ? AND id = ? AND expires_at > ?',
    productId, draftId, new Date().toISOString());
}

export async function addStudioDraftToGallery(store, productId, draftId, actor, mode) {
  return store.transaction(async () => {
    // A retried selection after a lost response returns the same gallery image.
    const applied = await store.get(`SELECT a.gallery_image_id FROM ai_studio_image a
      JOIN product_gallery_image g ON g.id = a.gallery_image_id AND g.product_id = a.product_id
      WHERE a.id = ? AND a.product_id = ?`, draftId, productId);
    if (applied) return { galleryImageId: applied.gallery_image_id };
    const draft = await store.get('SELECT * FROM ai_studio_draft WHERE product_id = ? AND id = ? AND expires_at > ?',
      productId, draftId, new Date().toISOString());
    if (!draft) throw new ApiError(404, 'AI_STUDIO_DRAFT_MISSING', 'This preview has expired or is no longer available.');
    const role = await requireGalleryOwner(store, productId);
    const current = await getProduct(store, productId, true, mode);
    const selected = current.galleryItems.filter((item) => role === 'single' || item.id !== 'main');
    if (selected.length >= 10) throw new ApiError(409, 'AI_STUDIO_GALLERY_FULL', 'The gallery is full. Remove a photo first.');
    const before = new Set(selected.map((item) => item.id));
    const updated = await addGalleryImage(store, productId, `data:${draft.mime};base64,${Buffer.from(draft.data).toString('base64')}`, mode);
    const added = updated.galleryItems.find((item) => item.id !== 'main' && !before.has(item.id));
    if (!added) throw new ApiError(409, 'AI_STUDIO_DUPLICATE', 'This photo is already in the gallery.');
    await store.run('INSERT INTO ai_studio_image (id, product_id, gallery_image_id, style, verdict, issues_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      draftId, productId, added.id, draft.style, draft.verdict, draft.issues_json, String(actor).slice(0, 300), new Date().toISOString());
    await store.run('DELETE FROM ai_studio_draft WHERE id = ?', draftId);
    return { galleryImageId: added.id };
  });
}

/* Provenance for the images that still exist in a product's gallery. */
export async function listStudioImages(store, productId) {
  const rows = await store.all(`SELECT a.gallery_image_id, a.style, a.verdict, a.issues_json, a.created_at FROM ai_studio_image a
    JOIN product_gallery_image g ON g.id = a.gallery_image_id AND g.product_id = a.product_id WHERE a.product_id = ? ORDER BY a.created_at`, productId);
  return rows.map((row) => ({ galleryImageId: row.gallery_image_id, style: row.style, aiGenerated: true, verdict: row.verdict, issues: JSON.parse(row.issues_json), createdAt: row.created_at }));
}
