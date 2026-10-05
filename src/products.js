import { randomUUID } from 'node:crypto';
import { ApiError } from './http.js';
import { FieldError, boundedText } from './validation.js';
import { validateProductInput } from './product-input.js';
import { decodeProductImage } from './product-image.js';
import { getCompanySettings, requireActiveCategory } from './settings.js';

const columns = `p.id, p.sku, p.name, p.description, p.category AS category_code,
  c.label AS category, p.price_minor, p.currency, p.active, p.image_mime, p.variant_group, p.variant_label, p.stock_quantity,
  p.created_at, p.updated_at`;
const fromProduct = `FROM product p JOIN general_code c
  ON c.type = 'PRODUCT_CATEGORY' AND c.code = p.category`;

/* Public image URLs carry this token so browsers may cache them until the product changes. */
export function imageVersion(updatedAt) {
  return Date.parse(updatedAt).toString(36);
}

function productFromRow(row, seller = false) {
  if (!row) return null;
  const imagePath = seller ? `/api/v1/seller/products/${row.id}/image`
    : `/api/v1/products/${row.id}/image?v=${imageVersion(row.updated_at)}`;
  return {
    id: row.id, sku: row.sku, name: row.name, description: row.description,
    category: row.category, priceMinor: row.price_minor, currency: row.currency,
    variantGroup: row.variant_group, variantLabel: row.variant_label,
    ...(seller ? { categoryCode: row.category_code, active: Boolean(row.active), stockQuantity: row.stock_quantity }
      : { inStock: row.stock_quantity === null || row.stock_quantity > 0 }),
    imageUrl: row.image_mime ? imagePath : null,
    ...(seller ? { createdAt: row.created_at, updatedAt: row.updated_at } : {}),
  };
}

async function validateVariantGroup(database, product, excludeId = null) {
  if (Boolean(product.variantGroup) !== Boolean(product.variantLabel)) {
    throw new FieldError('variantLabel', 'Set both the variant group and option label.');
  }
  if (!product.variantGroup) return;
  const related = await database.get(`SELECT category, currency FROM product WHERE variant_group = ?
    AND (? IS NULL OR id <> ?) LIMIT 1`, product.variantGroup, excludeId, excludeId);
  if (related && (related.category !== product.category || related.currency !== product.currency)) {
    throw new FieldError('variantGroup', 'Variants must share a category and currency.');
  }
}

async function detailFields(database, product, seller) {
  if (!product) return null;
  const gallery = await database.all(`SELECT id, created_at FROM product_gallery_image WHERE product_id = ? ORDER BY position`, product.id);
  product.images = [product.imageUrl, ...gallery.map((entry) =>
    `/api/v1/${seller ? 'seller/' : ''}products/${product.id}/gallery/${entry.id}${seller ? '' : `?v=${imageVersion(entry.created_at)}`}`)].filter(Boolean);
  product.variants = product.variantGroup ? (await database.all(`SELECT ${columns} ${fromProduct}
    WHERE p.variant_group = ? ${seller ? '' : 'AND p.active = 1'} ORDER BY p.variant_label, p.id`, product.variantGroup))
    .map((row) => ({ id: row.id, label: row.variant_label, sku: row.sku, priceMinor: row.price_minor,
      currency: row.currency, imageUrl: productFromRow(row, seller).imageUrl,
      ...(seller ? { active: Boolean(row.active), stockQuantity: row.stock_quantity } : { inStock: row.stock_quantity === null || row.stock_quantity > 0 }) })) : [];
  return product;
}

function duplicateSku(error) {
  if ((error?.code === '23505' && error.constraint === 'product_sku_key') || String(error?.message).includes('UNIQUE constraint failed: product.sku')) {
    throw new ApiError(409, 'DUPLICATE_SKU', 'This SKU is already in use.');
  }
  if ((error?.code === '23505' && error.constraint === 'product_variant_option') || String(error?.message).includes('UNIQUE constraint failed: product.variant_group, product.variant_label')) {
    const conflict = new ApiError(409, 'DUPLICATE_VARIANT', 'This variant option is already in the group.');
    conflict.field = 'variantLabel';
    throw conflict;
  }
  throw error;
}

export async function createProduct(database, input) {
  return database.transaction(async () => {
  const currency = (await getCompanySettings(database)).defaultCurrency;
  if (!input || typeof input !== 'object' || Array.isArray(input)) validateProductInput(input, [currency]);
  const product = validateProductInput(input && { currency, ...input }, [currency]);
  await requireActiveCategory(database, product.category);
  await validateVariantGroup(database, product);
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    await database.run(`INSERT INTO product
      (id, sku, name, description, category, price_minor, currency, active, image_mime, image_data,
       variant_group, variant_label, stock_quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, product.sku, product.name, product.description, product.category,
      product.priceMinor, product.currency, Number(product.active),
      product.image?.mime || null, product.image?.data || null, product.variantGroup || null,
      product.variantLabel || null, product.stockQuantity ?? null, now, now,
    );
  } catch (error) { duplicateSku(error); }
  return await getProduct(database, id, true);
  });
}

export async function updateProduct(database, id, input) {
  return database.transaction(async () => {
  const existing = await getProduct(database, id, true);
  if (!existing) return null;
  const currency = (await getCompanySettings(database)).defaultCurrency;
  const patch = validateProductInput(input, [existing.currency], { partial: true });
  // A legacy mismatch requires explicit price review, never a currency relabel.
  if (existing.currency !== currency && (Object.hasOwn(patch, 'priceMinor') || patch.active === true || Object.hasOwn(patch, 'currency'))) {
    throw new ApiError(409, 'COMPANY_CURRENCY_CONFLICT', 'Review the existing product currency before changing its price or activating it.');
  }
  if (Object.hasOwn(patch, 'category') && patch.category !== existing.categoryCode) await requireActiveCategory(database, patch.category);
  await validateVariantGroup(database, {
    variantGroup: Object.hasOwn(patch, 'variantGroup') ? patch.variantGroup : existing.variantGroup,
    variantLabel: Object.hasOwn(patch, 'variantLabel') ? patch.variantLabel : existing.variantLabel,
    category: patch.category || existing.categoryCode, currency: patch.currency || existing.currency,
  }, id);
  if (patch.image === null && existing.images.length > (existing.imageUrl ? 1 : 0)) {
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
  values.push(new Date().toISOString(), id);
  try {
    await database.run(`UPDATE product SET ${assignments.join(', ')} WHERE id = ?`, ...values);
  } catch (error) { duplicateSku(error); }
  return await getProduct(database, id, true);
  });
}

export async function getProduct(database, id, seller = false) {
  const row = await database.get(`SELECT ${columns} ${fromProduct} WHERE p.id = ? ${seller ? '' : 'AND p.active = 1'}`, id);
  return await detailFields(database, productFromRow(row, seller), seller);
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

export async function addGalleryImage(database, productId, imageDataUrl) {
  const image = decodeProductImage(imageDataUrl);
  if (!image) throw new FieldError('imageDataUrl', 'Choose an image.');
  return await database.transaction(async () => {
    const product = await database.get('SELECT image_mime FROM product WHERE id = ?', productId);
    if (!product) throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
    if (!product.image_mime) throw new FieldError('imageDataUrl', 'Add a main image first.');
    const count = (await database.get('SELECT COUNT(*) AS count FROM product_gallery_image WHERE product_id = ?', productId)).count;
    if (count >= 9) throw new FieldError('imageDataUrl', 'A product supports nine additional images.');
    const id = randomUUID();
    await database.run(`INSERT INTO product_gallery_image(id, product_id, position, mime, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`, id, productId, count + 1, image.mime, image.data, new Date().toISOString());
    return await getProduct(database, productId, true);
  });
}

export async function deleteGalleryImage(database, productId, imageId) {
  return await database.transaction(async () => {
    const entry = await database.get('SELECT position FROM product_gallery_image WHERE id = ? AND product_id = ?', imageId, productId);
    if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Image not found.');
    await database.run('DELETE FROM product_gallery_image WHERE id = ?', imageId);
    for (const row of await database.all('SELECT id FROM product_gallery_image WHERE product_id = ? AND position > ? ORDER BY position', productId, entry.position)) {
      await database.run('UPDATE product_gallery_image SET position = position - 1 WHERE id = ?', row.id);
    }
    return await getProduct(database, productId, true);
  });
}

export async function listProducts(database, params, seller = false) {
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
  const rows = await database.all(`SELECT ${columns} ${fromProduct} WHERE ${activeClause}
    (? = '' OR instr(lower(p.name), lower(?)) > 0 OR instr(lower(p.sku), lower(?)) > 0)
    AND (? = '' OR c.label = ?)
    ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`, search, search, search, category, category, limit + 1, offset);
  const hasMore = rows.length > limit;
  const result = { items: rows.slice(0, limit).map((row) => productFromRow(row, seller)), nextOffset: hasMore ? offset + limit : null };
  if (!seller) result.categories = (await database.all(`SELECT DISTINCT c.label AS category ${fromProduct}
    WHERE p.active = 1 ORDER BY c.label`)).map((row) => row.category);
  return result;
}
