import { readFileSync } from 'node:fs';
import catalog from '../src/public-demo-catalog.json' with { type: 'json' };
import gallery from '../src/public-demo-gallery.json' with { type: 'json' };
import { createProduct } from '../src/products.js';
import { createCategory } from '../src/settings.js';

const categoryLabels = { HOME: 'Home', STATIONERY: 'Stationery', KITCHEN: 'Kitchen', TRAVEL: 'Travel', TECH_ACCESSORIES: 'Tech Accessories', APPAREL: 'Apparel', PET_CARE: 'Pet Care' };

/*
 * One-time catalog replacement. Existing products whose SKU or name differ from the new set are
 * archived (inactive, SKU prefixed OLD-), never deleted, so nothing is lost and orders stay valid.
 * Refuses to run when any order exists. Re-running skips products that are already imported.
 */
export async function replaceCatalog(store) {
  const orders = await store.get('SELECT COUNT(*) AS n FROM shop_order');
  if (Number(orders.n) !== 0) throw new Error('Refusing to replace the catalog: orders exist.');
  const wanted = new Map(catalog.map((product) => [product.sku, product]));
  const result = { archived: 0, imported: 0, skipped: 0, categories: 0 };

  await store.transaction(async () => {
    for (const row of await store.all('SELECT id, sku, name FROM product ORDER BY sku')) {
      const target = wanted.get(row.sku);
      if (target && target.name === row.name) continue;
      if (row.sku.startsWith('OLD-')) continue;
      await store.run('UPDATE product SET sku = ?, active = 0, updated_at = ? WHERE id = ?', `OLD-${row.sku}`, new Date().toISOString(), row.id);
      result.archived++;
    }
    // Reuse an existing category with the same label (the live shop uses codes like "Home").
    const byLabel = new Map((await store.all("SELECT code, label FROM general_code WHERE type = 'PRODUCT_CATEGORY' AND active = 1"))
      .map((row) => [row.label.toLowerCase(), row.code]));
    const codeFor = new Map();
    for (const code of new Set(catalog.map((product) => product.category))) {
      const label = categoryLabels[code] || code;
      if (!byLabel.has(label.toLowerCase())) { await createCategory(store, { code, label }); byLabel.set(label.toLowerCase(), code); result.categories++; }
      codeFor.set(code, byLabel.get(label.toLowerCase()));
    }
    for (const product of catalog) {
      if (await store.get('SELECT 1 FROM product WHERE sku = ?', product.sku)) { result.skipped++; continue; }
      const created = await createProduct(store, { ...product, category: codeFor.get(product.category) });
      const media = gallery.products[product.sku]?.media ?? [];
      const layout = ['main', ...media.slice(1, 6).map((_, index) => `static:${product.sku}:${index + 1}`)];
      await store.run('UPDATE product SET gallery_layout_json = ? WHERE id = ?', JSON.stringify(layout), created.id);
      result.imported++;
    }
  });
  return result;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const { openPostgresDatabase } = await import('../src/postgres-db.js');
  const password = readFileSync(process.env.OWNER_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '');
  const url = `postgresql://online_shopping:${encodeURIComponent(password)}@${process.env.DATABASE_HOST || 'postgres'}:5432/online_shopping`;
  const store = await openPostgresDatabase(url);
  try { console.log(JSON.stringify(await replaceCatalog(store))); } finally { await store.close(); }
}
