// CSV export of the catalog for the seller: one row per product (a variant is its own row). It holds no buyer data.
import { ApiError } from './http.js';
import { sellerCatalogQuery } from './product-list-query.js';
import { money, toCsv } from './csv.js';

export const PRODUCT_EXPORT_LIMIT = 5000;
const HEADER = ['SKU', 'Name', 'Description', 'Category', 'Variant group', 'Variant label', 'Currency', 'Price', 'Stock (blank = unlimited)', 'Active', 'Updated (UTC)'];

export async function exportProductsCsv(database, params) {
  const query = sellerCatalogQuery(params);
  // Existing direct CSV callers retain variant-level search; the new UI uses listing-level filters.
  const legacySearch = !params.has('includeInactive');
  const filter = (query.activeVariantsOnly ? 'AND p.active = 1' : '') +
    (legacySearch ? " AND (? = '' OR instr(lower(p.name), lower(?)) > 0 OR instr(lower(p.sku), lower(?)) > 0)" : '');
  const order = legacySearch && !params.has('sort') ? 'p.name, p.sku' : query.exportOrder + ', p.sku';
  const args = [...query.args, ...(legacySearch ? [query.search, query.search, query.search] : [])];
  const { total } = await database.get(`${query.sql} SELECT COUNT(*) AS total FROM product p JOIN catalog_matches m ON m.listing_id = p.listing_id WHERE 1=1 ${filter}`, ...args);
  if (Number(total) > PRODUCT_EXPORT_LIMIT) throw new ApiError(413, 'TOO_MANY_ROWS', `More than ${PRODUCT_EXPORT_LIMIT} products match. Narrow the filters.`);
  const rows = await database.all(`${query.sql} SELECT p.sku, p.name, p.description, m.category_label AS category, p.variant_group, p.variant_label, p.currency,
      p.price_minor, p.stock_quantity, p.active, p.updated_at
    FROM catalog_matches m JOIN product p ON p.listing_id = m.listing_id
    WHERE 1=1 ${filter} ORDER BY ${order}`, ...args);
  return toCsv([HEADER, ...rows.map((row) => [row.sku, row.name, row.description, row.category, row.variant_group, row.variant_label, row.currency,
    money(Number(row.price_minor)), row.stock_quantity, Number(row.active) === 1 ? 'yes' : 'no', row.updated_at])]);
}
