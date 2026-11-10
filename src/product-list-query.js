import { FieldError, boundedText } from './validation.js';

// The seller list and CSV share listing-level matching. Legacy callers keep their
// existing all/status behavior; catalogStatus gives the UI disjoint listing scopes.
export function sellerCatalogQuery(params, selectedColumns = 'p.*, c.label AS category_label') {
  const search = boundedText(params.get('search'), 'search', 100, false);
  const category = boundedText(params.get('category'), 'category', 80, false);
  const includeInactive = params.get('includeInactive');
  if (includeInactive !== null && !['false', 'true'].includes(includeInactive)) throw new FieldError('includeInactive', 'Choose true or false.');
  const legacyStatus = params.get('status') || '';
  if (!['', 'active', 'inactive'].includes(legacyStatus)) throw new FieldError('status', 'Choose active or inactive.');
  if (includeInactive !== null && legacyStatus) throw new FieldError('status', 'Use one status filter.');
  const catalogStatus = params.get('catalogStatus');
  if (catalogStatus !== null && !['active', 'inactive', 'all'].includes(catalogStatus)) throw new FieldError('catalogStatus', 'Choose active, inactive or all.');
  if (catalogStatus !== null && (includeInactive !== null || legacyStatus)) throw new FieldError('catalogStatus', 'Use one status filter.');
  const status = catalogStatus === 'all' ? '' : catalogStatus || (includeInactive === 'false' ? 'active' : legacyStatus);
  const stock = params.get('stock') || '';
  if (!['', 'in-stock', 'out-of-stock', 'unlimited'].includes(stock)) throw new FieldError('stock', 'Choose a stock filter.');
  const sort = params.get('sort') || 'updated';
  const orders = { updated: 'updated_at DESC, id DESC', name: 'lower(name), id', price_asc: 'group_min_price, id', price_desc: 'group_min_price DESC, id DESC' };
  if (!Object.hasOwn(orders, sort)) throw new FieldError('sort', 'Choose a sort order.');
  const sql = `WITH catalog_groups AS (
    SELECT listing_id, COUNT(*) AS group_size, MIN(price_minor) AS group_min_price,
      MAX(price_minor) AS group_max_price, SUM(active) AS group_active,
      CASE WHEN COUNT(*) <> COUNT(stock_quantity) THEN NULL ELSE SUM(stock_quantity) END AS group_stock
    FROM product GROUP BY listing_id
  ), catalog_listed AS (
    SELECT ${selectedColumns}, g.group_size, g.group_min_price, g.group_max_price, g.group_active, g.group_stock,
      ROW_NUMBER() OVER (PARTITION BY p.listing_id ORDER BY p.created_at, p.sku, p.id) AS group_rank
    FROM product p JOIN general_code c ON c.type = 'PRODUCT_CATEGORY' AND c.code = p.category
    JOIN catalog_groups g ON g.listing_id = p.listing_id
    WHERE (? = '' OR instr(lower(p.name), lower(?)) > 0 OR instr(lower(p.sku), lower(?)) > 0)
      AND (? = '' OR c.label = ?)
  ), catalog_matches AS (
    SELECT * FROM catalog_listed WHERE group_rank = 1
      AND (? = '' OR (? = 'active' AND group_active > 0) OR (? = 'inactive' AND ${catalogStatus !== null ? 'group_active = 0' : 'group_active < group_size'}))
      AND (? = '' OR (? = 'in-stock' AND (group_stock IS NULL OR group_stock > 0))
        OR (? = 'out-of-stock' AND group_stock = 0) OR (? = 'unlimited' AND group_stock IS NULL))
  )`;
  return { sql, args: [search, search, search, category, category, status, status, status, stock, stock, stock, stock],
    order: orders[sort], exportOrder: { updated: 'm.updated_at DESC, m.id DESC', name: 'lower(m.name), m.id', price_asc: 'm.group_min_price, m.id', price_desc: 'm.group_min_price DESC, m.id DESC' }[sort], search, activeVariantsOnly: includeInactive === 'false' || catalogStatus === 'active', inactiveVariantsOnly: catalogStatus === 'inactive' };
}

export async function sellerCatalogStats(database) {
  const row = await database.get(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN active_count > 0 THEN 1 ELSE 0 END), 0) AS active
    FROM (SELECT listing_id, SUM(active) AS active_count FROM product GROUP BY listing_id) catalog`);
  const total = Number(row.total), active = Number(row.active);
  return { active, inactive: total - active, total };
}
