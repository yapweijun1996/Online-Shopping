import catalog from './public-demo-catalog.json' with { type: 'json' };

// Present only the exact controlled legacy fixture copy; never rewrite stored
// descriptions, seller edits, order snapshots, SKUs or namespace identities.
const fixtures = new Map(catalog.map(item => [item.sku, item.description]));
export function presentCatalogCopy(product, mode) {
  if (!['demo', 'public-demo'].includes(mode)) return product;
  const current = fixtures.get(product.sku);
  const legacy = current?.replace('Fictional preview ', 'Fictional demo ')
    .replace('No payment, delivery or automatic contact will occur.', 'No payment, delivery or contact will occur.');
  return current && product.description === legacy ? { ...product, description: current } : product;
}

export function presentShopName(setup) {
  return setup.mode === 'demo' && setup.shopName === 'Demo General Store'
    ? { ...setup, shopName: 'Preview General Store' } : setup;
}
