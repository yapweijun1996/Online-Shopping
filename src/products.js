import { randomUUID } from 'node:crypto';
import { ApiError } from './http.js';
import { FieldError, boundedText } from './validation.js';
import { validateProductInput } from './product-input.js';
import { decodeProductImage } from './product-image.js';
import { getCompanySettings, requireActiveCategory } from './settings.js';
import { presentCatalogCopy } from './catalog-copy.js';
import { groupUsesOptions, loadProductOptions, optionAxes, optionError, setProductOptions } from './options.js';
import { listingFor, moveToListing, syncListing } from './listings.js';
import { reservedQuantitySql } from './stock-reservation.js';
import { productCover, productGallery, requireGalleryRevision, saveProductGallery } from './product-gallery.js';

const columns = () => `p.id, p.sku, p.name, p.description, p.category AS category_code,
  c.label AS category, p.price_minor, p.currency, p.active, p.image_mime, p.variant_group, p.variant_label, p.stock_quantity, p.listing_id,
  ${reservedQuantitySql('p.id')} AS reserved_quantity, p.created_at, p.updated_at`;
const fromProduct = `FROM product p JOIN general_code c
  ON c.type = 'PRODUCT_CATEGORY' AND c.code = p.category`;

/* Public image URLs carry this token so browsers may cache them until the product changes. */
export function imageVersion(updatedAt) {
  return Date.parse(updatedAt).toString(36);
}

function productFromRow(row, seller = false) {
  if (!row) return null;
  const imagePath = seller ? `/api/v1/seller/products/${row.id}/image` :
  `/api/v1/products/${row.id}/image?v=${imageVersion(row.updated_at)}`;
  return {
    id: row.id, sku: row.sku, name: row.name, description: row.description,
    category: row.category, priceMinor: row.price_minor, currency: row.currency,
    variantGroup: row.variant_group, variantLabel: row.variant_label, listingId: row.listing_id,
    ...(seller ? { categoryCode: row.category_code, active: Boolean(row.active), stockQuantity: row.stock_quantity } : { inStock: row.stock_quantity === null || row.stock_quantity - Number(row.reserved_quantity) > 0 }),
    imageUrl: row.image_mime ? imagePath : null,
    ...(seller ? { createdAt: row.created_at, updatedAt: row.updated_at } : {})
  };
}

async function validateVariantGroup(database, product, excludeId = null) {
  // With option types the label is derived from the chosen values, so only the group is required.
  const hasOptions = Array.isArray(product.options) && product.options.length > 0;
  if (hasOptions && !product.variantGroup) throw optionError('OPTIONS_GROUP_REQUIRED', 'Set a variant group before choosing options.');
  if (!hasOptions && Boolean(product.variantGroup) !== Boolean(product.variantLabel)) {
    throw new FieldError('variantLabel', 'Set both the variant group and option label.');
  }
  if (!product.variantGroup) return;
  // The category belongs to the listing, so a variant joining a group simply takes it; only the currency must match.
  const related = await database.get(`SELECT currency FROM product WHERE variant_group = ?
    AND (? IS NULL OR id <> ?) LIMIT 1`, product.variantGroup, excludeId, excludeId);
  if (related && related.currency !== product.currency) {
    throw new FieldError('variantGroup', 'Variants must share a currency.');
  }
}

async function detailFields(database, product, seller, mode) {
  if (!product) return null;
  product = await productGallery(database, product, seller, mode);
  product.variants = product.variantGroup ? await Promise.all((await database.all(`SELECT ${columns()} ${fromProduct}
    WHERE p.variant_group = ? ${seller ? '' : 'AND p.active = 1'} ORDER BY p.variant_label, p.id`, product.variantGroup)).
  map(async (row) => ({ id: row.id, label: row.variant_label, sku: row.sku, priceMinor: row.price_minor,
    currency: row.currency, imageUrl: await productCover(database, productFromRow(row, seller), seller),
    ...(seller ? { active: Boolean(row.active), stockQuantity: row.stock_quantity } : { inStock: row.stock_quantity === null || row.stock_quantity - Number(row.reserved_quantity) > 0 }) }))) : [];
  const optionsById = await loadProductOptions(database, [product.id, ...product.variants.map((variant) => variant.id)]);
  product.options = optionsById.get(product.id);
  for (const variant of product.variants) variant.options = optionsById.get(variant.id);
  // The option types and values in use by the group, in display order, for the storefront selector.
  product.optionTypes = optionAxes(product.variants.map((variant) => variant.options));
  return product;
}

function duplicateSku(error) {
  if (error?.code === '23505' && error.constraint === 'product_sku_key' || String(error?.message).includes('UNIQUE constraint failed: product.sku')) {
    throw new ApiError(409, 'DUPLICATE_SKU', 'This SKU is already in use.');
  }
  if (error?.code === '23505' && error.constraint === 'product_variant_option' || String(error?.message).includes('UNIQUE constraint failed: product.variant_group, product.variant_label')) {
    const conflict = new ApiError(409, 'DUPLICATE_VARIANT', 'This variant option is already in the group.');
    conflict.field = 'variantLabel';
    throw conflict;
  }
  throw error;
}

export async function createProduct(database, input) {
  return await database.transaction(async () => {
    const currency = (await getCompanySettings(database)).defaultCurrency;
    if (!input || typeof input !== 'object' || Array.isArray(input)) validateProductInput(input, [currency]);
    const product = validateProductInput(input && { currency, ...input }, [currency]);
    await requireActiveCategory(database, product.category);
    await validateVariantGroup(database, product);
    const id = randomUUID();
    const now = new Date().toISOString();
    // Variants share their listing's title, description and category; the first product of a group defines them.
    const listing = await listingFor(database, product, now);
    try {
      await database.run(`INSERT INTO product
      (id, sku, name, description, category, price_minor, currency, active, image_mime, image_data,
       variant_group, variant_label, stock_quantity, listing_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, product.sku, listing.name, listing.description, listing.category,
      product.priceMinor, product.currency, Number(product.active),
      product.image?.mime || null, product.image?.data || null, product.variantGroup || null,
      product.variantLabel || null, product.stockQuantity ?? null, listing.id, now, now
      );
    } catch (error) {duplicateSku(error);}
    const hasOptions = Array.isArray(product.options) && product.options.length > 0;
    if (hasOptions) await setProductOptions(database, id, product.variantGroup, product.options, { newProduct: true });
    else if (product.variantGroup && await groupUsesOptions(database, product.variantGroup, id)) {
      throw optionError('OPTIONS_REQUIRED', 'This variant group is described by option types; choose its options.');
    }
    return await getProduct(database, id, true);
  });
}

export async function updateProduct(database, id, input, mode = 'manual') {
  return await database.transaction(async () => {
    const existing = await getProduct(database, id, true, mode);
    if (!existing) return null;
    const hasGallery = input && Object.hasOwn(input, 'gallery');
    let patch = input;
    if (hasGallery) {
      requireGalleryRevision(existing, input.expectedUpdatedAt);
      const { gallery, expectedUpdatedAt, ...metadata } = input;
      patch = metadata;
      // Gallery-only edits still advance the shared product revision.
      if (!Object.keys(patch).length) patch = { name: existing.name };
    }
    await patchProduct(database, id, patch, { galleryChanging: hasGallery });
    if (hasGallery) await saveProductGallery(database, id, input.gallery, existing);else
    if (input.imageDataUrl && !existing.galleryItems.some((item) => item.id === 'main')) {
      // A legacy image-only replacement must become visible. Keep any explicitly
      // selected primary/order, append the restored main, and reject overflow
      // atomically rather than accepting an invisible replacement.
      await saveProductGallery(database, id, [...existing.galleryItems.map((item) => ({ id: item.id })), { id: 'main' }], existing);
    }
    return await getProduct(database, id, true, mode);
  });
}

async function patchProduct(database, id, input, { galleryChanging = false } = {}) {
  const existing = await getProduct(database, id, true);
  if (!existing) return null;
  const currency = (await getCompanySettings(database)).defaultCurrency;
  const patch = validateProductInput(input, [existing.currency], { partial: true });
  // A legacy mismatch requires explicit price review, never a currency relabel.
  if (existing.currency !== currency && (Object.hasOwn(patch, 'priceMinor') || patch.active === true || Object.hasOwn(patch, 'currency'))) {
    throw new ApiError(409, 'COMPANY_CURRENCY_CONFLICT', 'Review the existing product currency before changing its price or activating it.');
  }
  // Leaving a variant group also drops the option label that belonged to it.
  if (Object.hasOwn(patch, 'variantGroup') && !patch.variantGroup && !Object.hasOwn(patch, 'variantLabel')) patch.variantLabel = null;
  if (Object.hasOwn(patch, 'category') && patch.category !== existing.categoryCode) await requireActiveCategory(database, patch.category);
  await validateVariantGroup(database, {
    variantGroup: Object.hasOwn(patch, 'variantGroup') ? patch.variantGroup : existing.variantGroup,
    variantLabel: Object.hasOwn(patch, 'variantLabel') ? patch.variantLabel : existing.variantLabel,
    options: patch.options,
    category: patch.category || existing.categoryCode, currency: patch.currency || existing.currency
  }, id);
  if (!galleryChanging && patch.image === null && existing.images.length > (existing.imageUrl ? 1 : 0)) {
    throw new FieldError('imageDataUrl', 'Remove gallery images before removing the main image.');
  }
  const mapping = { sku: 'sku', name: 'name', description: 'description', category: 'category', priceMinor: 'price_minor', currency: 'currency', active: 'active', variantGroup: 'variant_group', variantLabel: 'variant_label', stockQuantity: 'stock_quantity' };
  const assignments = [];
  const values = [];
  for (const [key, column] of Object.entries(mapping)) {
    if (!Object.hasOwn(patch, key)) continue;
    assignments.push(`${column} = ?`);
    values.push(key === 'active' ? Number(patch.active) : patch[key]);
  }
  if (Object.hasOwn(patch, 'image')) {
    assignments.push('image_mime = ?', 'image_data = ?');
    values.push(patch.image?.mime || null, patch.image?.data || null);
  }
  assignments.push('updated_at = ?');
  values.push(new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString(), id);
  try {
    await database.run(`UPDATE product SET ${assignments.join(', ')} WHERE id = ?`, ...values);
  } catch (error) {duplicateSku(error);}
  // Shared fields live on the listing; a group change moves the row to the listing of its new group.
  const now = new Date().toISOString();
  if (Object.hasOwn(patch, 'variantGroup') && (patch.variantGroup || null) !== (existing.variantGroup || null)) {
    const merged = { ...existing, ...patch, category: patch.category || existing.categoryCode };
    await moveToListing(database, id, existing.listingId, merged, now);
  } else {
    await syncListing(database, existing.listingId, patch, now);
  }
  await saveOptions(database, id, existing, patch);
  return await getProduct(database, id, true);
}

// Applies option changes after the product row is updated; moving or leaving a group drops stale options.
async function saveOptions(database, id, existing, patch) {
  const group = Object.hasOwn(patch, 'variantGroup') ? patch.variantGroup : existing.variantGroup;
  if (Object.hasOwn(patch, 'options')) await setProductOptions(database, id, group, patch.options);
  else if (Object.hasOwn(patch, 'variantGroup') && group !== existing.variantGroup) await setProductOptions(database, id, group, []);
  const has = Boolean(await database.get('SELECT 1 FROM product_option WHERE product_id = ?', id));
  if (group && !has && await groupUsesOptions(database, group, id)) {
    throw optionError('OPTIONS_REQUIRED', 'This variant group is described by option types; choose its options.');
  }
}

export async function getProduct(database, id, seller = false, mode = 'manual') {
  const row = await database.get(`SELECT ${columns()} ${fromProduct} WHERE p.id = ? ${seller ? '' : 'AND p.active = 1'}`, id);
  return await detailFields(database, productFromRow(row, seller), seller, mode);
}

export async function getProductImage(database, id, seller = false) {
  const row = await database.get(`SELECT image_mime AS mime, image_data AS data, updated_at FROM product
    WHERE id = ? ${seller ? '' : 'AND active = 1'}`, id);
  return row && { mime: row.mime, data: row.data, version: imageVersion(row.updated_at) };
}

export async function getGalleryImage(database, productId, imageId, seller = false) {
  const row = await database.get(`SELECT i.mime, i.data, i.created_at FROM product_gallery_image i
    JOIN product p ON p.id = i.product_id WHERE i.id = ? AND i.product_id = ? ${seller ? '' : 'AND p.active = 1'}`,
  imageId, productId);
  return row && { mime: row.mime, data: row.data, version: imageVersion(row.created_at) };
}

export async function addGalleryImage(database, productId, imageDataUrl, mode = 'manual') {
  const image = decodeProductImage(imageDataUrl);
  if (!image) throw new FieldError('imageDataUrl', 'Choose an image.');
  return await database.transaction(async () => {
    const product = await database.get('SELECT image_mime FROM product WHERE id = ?', productId);
    if (!product) throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
    if (!product.image_mime) throw new FieldError('imageDataUrl', 'Add a main image first.');
    const current = await getProduct(database, productId, true, mode);
    await saveProductGallery(database, productId, [...current.galleryItems.map((item) => ({ id: item.id })), { imageDataUrl }], current);
    await database.run('UPDATE product SET updated_at = ? WHERE id = ?', new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString(), productId);
    return await getProduct(database, productId, true, mode);
  });
}

export async function deleteGalleryImage(database, productId, imageId, mode = 'manual') {
  return await database.transaction(async () => {
    const entry = await database.get('SELECT position FROM product_gallery_image WHERE id = ? AND product_id = ?', imageId, productId);
    if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Image not found.');
    const current = await getProduct(database, productId, true, mode);
    await saveProductGallery(database, productId, current.galleryItems.filter((item) => item.id !== imageId).map((item) => ({ id: item.id })), current);
    await database.run('UPDATE product SET updated_at = ? WHERE id = ?', new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString(), productId);
    return await getProduct(database, productId, true, mode);
  });
}

export async function listProducts(database, params, seller = false, mode = 'manual') {
  const search = boundedText(params.get('search'), 'search', 100, false);
  const category = boundedText(params.get('category'), 'category', 80, false);
  const parseNumber = (key, fallback, maximum) => {
    const value = params.get(key);
    if (value === null) return fallback;
    if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > maximum) throw new FieldError(key, 'Enter a valid list range.');
    return Number(value);
  };
  const limit = parseNumber('limit', 24, 100);
  const offset = parseNumber('offset', 0, 10_000);
  if (limit < 1) throw new FieldError('limit', 'Enter a valid list range.');
  const activeClause = seller ? '' : 'p.active = 1 AND ';
  const filters = `(? = '' OR instr(lower(p.name), lower(?)) > 0 OR instr(lower(p.sku), lower(?)) > 0) AND (? = '' OR c.label = ?)`;
  const siblings = (expression) => `(SELECT ${expression} FROM product x WHERE x.listing_id = p.listing_id)`;
  const rows = seller
    // The seller sees one row per listing too (its oldest variant, or the one that matches the search), with totals
    // over all of its variants; the variants themselves are managed inside the listing.
    ? await database.all(`SELECT * FROM (
        SELECT ${columns()}, ROW_NUMBER() OVER (PARTITION BY p.listing_id ORDER BY p.created_at, p.id) AS group_rank,
          ${siblings('COUNT(*)')} AS group_size, ${siblings('MIN(x.price_minor)')} AS group_min_price,
          ${siblings('MAX(x.price_minor)')} AS group_max_price, ${siblings('SUM(x.active)')} AS group_active,
          ${siblings('CASE WHEN COUNT(*) <> COUNT(x.stock_quantity) THEN NULL ELSE SUM(x.stock_quantity) END')} AS group_stock
        ${fromProduct} WHERE ${activeClause} ${filters}) listed
      WHERE group_rank = 1 ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`, search, search, search, category, category, limit + 1, offset)
    // Shoppers see one card per product: the variants of a group collapse to its cheapest in-stock variant
    // (the one that matches the search), with the group size and whether its prices differ.
    : await database.all(`SELECT * FROM (
        SELECT ${columns()}, ROW_NUMBER() OVER (PARTITION BY COALESCE('g:' || p.variant_group, 'p:' || p.id)
          ORDER BY CASE WHEN p.stock_quantity IS NULL OR p.stock_quantity > 0 THEN 0 ELSE 1 END, p.price_minor, p.sku, p.id) AS group_rank,
          COUNT(*) OVER (PARTITION BY COALESCE('g:' || p.variant_group, 'p:' || p.id)) AS group_size,
          MAX(p.price_minor) OVER (PARTITION BY COALESCE('g:' || p.variant_group, 'p:' || p.id)) AS group_max_price
        ${fromProduct} WHERE ${activeClause} ${filters}) listed
      WHERE group_rank = 1 ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`, search, search, search, category, category, limit + 1, offset);
  const hasMore = rows.length > limit;
  const result = { items: await Promise.all(rows.slice(0, limit).map(async (row) => {
      const product = productFromRow(row, seller);
      const group = seller ? { variantCount: Number(row.group_size), activeCount: Number(row.group_active),
        priceFromMinor: Number(row.group_min_price), priceToMinor: Number(row.group_max_price),
        stockTotal: row.group_stock === null ? null : Number(row.group_stock) }
        : { variantCount: Number(row.group_size), priceVaries: Number(row.group_max_price) !== row.price_minor };
      return presentCatalogCopy({ ...product, ...group, imageUrl: await productCover(database, product, seller) }, mode);
    })), nextOffset: hasMore ? offset + limit : null };
  if (!seller) result.categories = (await database.all(`SELECT DISTINCT c.label AS category ${fromProduct}
    WHERE p.active = 1 ORDER BY c.label`)).map((row) => row.category);
  return result;
}
