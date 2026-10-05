// Presentation only: amounts and category names remain catalog-owned.
export function formatCatalogPrice(minor, currency, locale = 'en') {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError('Invalid minor amount');
  if (currency === 'MYR') return 'RM\u00a0' + new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency });
  return formatter.format(minor / (10 ** formatter.resolvedOptions().maximumFractionDigits));
}
const icons = {
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  grain: 'M4 17h16l-2 4H6zM7 12h.01M12 8h.01M17 12h.01M9 4h.01M16 4h.01',
  bag: 'M5 7h14l1 14H4zM9 7V5a3 3 0 0 1 6 0v2',
  spark: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  tools: 'M14 4l-3 3 2 2 3-3a5 5 0 0 1-6 6l-6 6 2 2 6-6a5 5 0 0 1 6-6',
  screen: 'M3 4h18v13H3zM8 21h8M12 17v4',
  book: 'M4 3h7a2 2 0 0 1 2 2v16a4 4 0 0 0-4-2H4zM13 5a2 2 0 0 1 2-2h5v16h-3a4 4 0 0 0-4 2',
  home: 'M3 11l9-8 9 8M5 9v12h14V9M10 21v-7h4v7',
  clothing: 'M8 3l4 2 4-2 5 5-4 3v10H7V11L3 8z',
};
export function categoryIconPath(category) {
  const name = String(category || '').toLowerCase();
  const kind = !name ? 'grid' : /accessor|tool|配件/.test(name) ? 'tools' : /litter box|盒|箱/.test(name) ? 'box' : /litter|砂/.test(name) ? 'grain' : /bag|袋/.test(name) ? 'bag' : /odor|clean|清洁|清潔/.test(name) ? 'spark' : /electronic|computer|电脑|電腦/.test(name) ? 'screen' : /book|书|書/.test(name) ? 'book' : /cloth|apparel|服装|服裝/.test(name) ? 'clothing' : /home|家居/.test(name) ? 'home' : 'grid';
  return icons[kind];
}
