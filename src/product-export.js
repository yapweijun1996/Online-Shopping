// CSV export of the catalog for the seller: one row per product (a variant is its own row). It holds no buyer data.
import { ApiError } from './http.js';
import { boundedText } from './validation.js';
import { money, toCsv } from './csv.js';

export const PRODUCT_EXPORT_LIMIT = 5000;
const HEADER = ['SKU', 'Name', 'Description', 'Category', 'Variant group', 'Variant label', 'Currency', 'Price', 'Stock (blank = unlimited)', 'Active', 'Updated (UTC)'];

export async function exportProductsCsv(database, params) {
  const search = boundedText(params.get('search'), 'search', 100, false);
  const filter = `(? = '' OR instr(lower(p.name), lower(?)) > 0 OR instr(lower(p.sku), lower(?)) > 0)`;
  const { total } = await database.get(`SELECT COUNT(*) AS total FROM product p WHERE ${filter}`, search, search, search);
  if (Number(total) > PRODUCT_EXPORT_LIMIT) throw new ApiError(413, 'TOO_MANY_ROWS', `More than ${PRODUCT_EXPORT_LIMIT} products match. Narrow the search.`);
  const rows = await database.all(`SELECT p.sku, p.name, p.description, c.label AS category, p.variant_group, p.variant_label, p.currency,
      p.price_minor, p.stock_quantity, p.active, p.updated_at
    FROM product p JOIN general_code c ON c.type = 'PRODUCT_CATEGORY' AND c.code = p.category
    WHERE ${filter} ORDER BY p.name, p.sku`, search, search, search);
  return toCsv([HEADER, ...rows.map((row) => [row.sku, row.name, row.description, row.category, row.variant_group, row.variant_label, row.currency,
    money(Number(row.price_minor)), row.stock_quantity, Number(row.active) === 1 ? 'yes' : 'no', row.updated_at])]);
}
