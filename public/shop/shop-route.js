const productId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function productHash(id) {
  if (typeof id !== 'string' || !productId.test(id)) throw new TypeError('Invalid product ID.');
  return `#product/${id.toLowerCase()}`;
}

export function readShopRoute(hash) {
  const value = hash.replace(/^#/, '');
  if (value.startsWith('product/')) {
    const id = value.slice('product/'.length);
    return { page: 'product', id: productId.test(id) ? id.toLowerCase() : null };
  }
  return { page: ['cart', 'checkout', 'receipt', 'profile', 'orders', 'settings', 'addresses'].includes(value) ? value : 'catalog', id: null };
}

export function readCatalogFilters(search) {
  const params = new URLSearchParams(search);
  return { search: params.get('search') || '', category: params.get('category') || '' };
}

export function catalogFilterURL(href, filters, hash = '#catalog-results') {
  const url = new URL(href);
  for (const key of ['search', 'category']) {
    const value = filters[key].trim();
    if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
  }
  url.hash = hash;
  return url;
}
