import { randomUUID } from 'node:crypto';
import { ApiError } from './http.js';
import { FieldError, boundedText } from './validation.js';
import { validateProductInput } from './product-input.js';
import { requireActiveCategory } from './settings.js';

const columns = `p.id, p.sku, p.name, p.description, p.category AS category_code,
  c.label AS category, p.price_minor, p.currency, p.active, p.image_mime, p.created_at, p.updated_at`;
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
    ...(seller ? { categoryCode: row.category_code, active: Boolean(row.active) } : {}),
    imageUrl: row.image_mime ? imagePath : null,
    ...(seller ? { createdAt: row.created_at, updatedAt: row.updated_at } : {}),
  };
}

function duplicateSku(error) {
  if (error?.errcode % 256 === 19 && String(error.message).includes('UNIQUE constraint failed: product.sku')) {
    throw new ApiError(409, 'DUPLICATE_SKU', 'This SKU is already in use.');
  }
  throw error;
}

export function createProduct(database, input) {
  const product = validateProductInput(input, ['MYR', 'SGD']);
  requireActiveCategory(database, product.category);
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    database.prepare(`INSERT INTO product
      (id, sku, name, description, category, price_minor, currency, active, image_mime, image_data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, product.sku, product.name, product.description, product.category,
      product.priceMinor, product.currency, Number(product.active),
      product.image?.mime || null, product.image?.data || null, now, now,
    );
  } catch (error) { duplicateSku(error); }
  return getProduct(database, id, true);
}

export function updateProduct(database, id, input) {
  const existing = getProduct(database, id, true);
  if (!existing) return null;
  const patch = validateProductInput(input, ['MYR', 'SGD'], { partial: true });
  if (Object.hasOwn(patch, 'category') && patch.category !== existing.categoryCode) requireActiveCategory(database, patch.category);
  const mapping = { sku: 'sku', name: 'name', description: 'description', category: 'category', priceMinor: 'price_minor', currency: 'currency', active: 'active' };
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
    database.prepare(`UPDATE product SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
  } catch (error) { duplicateSku(error); }
  return getProduct(database, id, true);
}

export function getProduct(database, id, seller = false) {
  const row = database.prepare(`SELECT ${columns} ${fromProduct} WHERE p.id = ? ${seller ? '' : 'AND p.active = 1'}`).get(id);
  return productFromRow(row, seller);
}

export function getProductImage(database, id, seller = false) {
  const row = database.prepare(`SELECT image_mime AS mime, image_data AS data, updated_at FROM product
    WHERE id = ? ${seller ? '' : 'AND active = 1'}`).get(id);
  return row && { mime: row.mime, data: row.data, version: imageVersion(row.updated_at) };
}

export function listProducts(database, params, seller = false) {
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
  const rows = database.prepare(`SELECT ${columns} ${fromProduct} WHERE ${activeClause}
    (? = '' OR instr(lower(p.name), lower(?)) > 0 OR instr(lower(p.sku), lower(?)) > 0)
    AND (? = '' OR c.label = ?)
    ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`)
    .all(search, search, search, category, category, limit + 1, offset);
  const hasMore = rows.length > limit;
  const result = { items: rows.slice(0, limit).map((row) => productFromRow(row, seller)), nextOffset: hasMore ? offset + limit : null };
  if (!seller) result.categories = database.prepare(`SELECT DISTINCT c.label AS category ${fromProduct}
    WHERE p.active = 1 ORDER BY c.label`).all().map((row) => row.category);
  return result;
}
