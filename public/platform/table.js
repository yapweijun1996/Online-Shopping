export function tableRows(items, { query = '', status = '', sort = 'createdAt', direction = 'descending', page = 1, size = 25 } = {}) {
  const needle = query.trim().toLowerCase();
  const filtered = items.filter(row => (!status || row.status === status) && (!needle || Object.values(row).filter(value => typeof value === 'string').join(' ').toLowerCase().includes(needle)));
  const order = ['ACTIVE', 'SUSPENDED', 'PROVISIONING', 'FAILED', 'DELETING'];
  if (sort && direction) filtered.sort((a, b) => {
    let result;
    if (sort === 'status') result = order.indexOf(a.status) - order.indexOf(b.status);
    else if (sort === 'createdAt' || sort === 'created_at') result = new Date(a[sort] || 0) - new Date(b[sort] || 0);
    else result = String(a[sort] ?? '').localeCompare(String(b[sort] ?? ''), 'en', { sensitivity: 'base' });
    return direction === 'ascending' ? result : -result;
  });
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  page = Math.max(1, Math.min(page, pages));
  return { rows: filtered.slice((page - 1) * size, page * size), total: filtered.length, page, pages, start: filtered.length ? (page - 1) * size + 1 : 0, end: Math.min(page * size, filtered.length) };
}

export function safeLink(value, base = location.href) {
  try {
    const url = new URL(value, base), origin = new URL(base);
    const family = host => ['localhost', '127.0.0.1', '[::1]'].includes(host) ? 'loopback' : host.replace(/^(admin|seller|shop)\./, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || family(url.hostname) !== family(origin.hostname)) return null;
    return url.href;
  } catch { return null; }
}
