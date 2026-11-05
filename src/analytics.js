import { ApiError } from './http.js';
import { DAY_MS, SHOP_OFFSET_MS, SALES_STATUSES, SALES_STATUSES_SQL, SALES_CURRENCIES, SALES_TIME_ZONE, SALES_DEFINITION_VERSION, shopDayStart } from './sales-definition.js';
import { RESERVATION_HOURS, stockAvailability } from './stock-reservation.js';

export const ANALYTICS_LIMITS = Object.freeze({ days: 366, orders: 10000, lines: 50000, products: 10000, bytes: 8 * 1024 * 1024, page: 100, offset: 10000 });
export const ANALYTICS_COVERAGE_NOTE = 'Complete bounded database records for this query; historical/external completeness is unverified. Pages are live reads.';
const invalid = () => { throw new ApiError(400, 'INVALID_INPUT', 'Invalid analytics filters.'); };
const limited = () => { throw new ApiError(503, 'ANALYTICS_LIMIT', 'Analytics exceeds its safe data limit. Narrow the range.'); };
const corrupt = () => { throw new ApiError(503, 'ANALYTICS_INVALID_DATA', 'Analytics source data is unsupported.'); };
const iso = ms => new Date(ms).toISOString();
const date = ms => iso(ms + SHOP_OFFSET_MS).slice(0, 10);
function keys(args, allowed, required = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(args, key))) invalid();
}
function integer(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function enumeration(value, fallback, options) {
  if (value === undefined) return fallback;
  if (!options.includes(value)) invalid();
  return value;
}
function flag(value, fallback) { if (value === undefined) return fallback; if (typeof value !== 'boolean') invalid(); return value; }
function dateMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) invalid();
  const ms = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(ms) || iso(ms).slice(0, 10) !== value) invalid();
  return ms - SHOP_OFFSET_MS;
}
function range(args) {
  const from = dateMs(args.from), to = dateMs(args.toExclusive);
  if (to <= from || to - from > ANALYTICS_LIMITS.days * DAY_MS) invalid();
  return { from, to };
}
function page(args) { return { limit: integer(args.limit, 50, 1, ANALYTICS_LIMITS.page), offset: integer(args.offset, 0, 0, ANALYTICS_LIMITS.offset) }; }
function selectedCurrency(args) { return enumeration(args.currency, null, SALES_CURRENCIES); }
function text(value, maximum) { if (typeof value !== 'string' || value.length > maximum) corrupt(); return value; }
function whole(value) {
  const str = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof str !== 'string' || !/^(0|[1-9]\d*)$/.test(str) || str.length > 16) corrupt();
  const number = BigInt(str); if (number > BigInt(Number.MAX_SAFE_INTEGER)) limited(); return number;
}
function safe(value) { if (value < -BigInt(Number.MAX_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) limited(); return Number(value); }
function instant(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || iso(Date.parse(value)) !== value) corrupt(); return Date.parse(value); }
function budget() { let bytes = 0; return rows => { bytes += Buffer.byteLength(JSON.stringify(rows)); if (bytes > ANALYTICS_LIMITS.bytes) limited(); return rows; }; }
function checkedRows(rows, cap, charge) { if (rows.length > cap) limited(); return charge(rows); }
// Sentinel limits reject incomplete sources before any totals are published.
// The registry caller holds the lifecycle fence and shared store transaction.
async function orders(read, bounds, charge, { pending = false, values = true } = {}) {
  const predicate = pending ? "status = 'SUBMITTED' AND submitted_at > ?" : `status IN ${SALES_STATUSES_SQL} AND submitted_at >= ? AND submitted_at < ?`;
  const args = pending ? [iso(bounds.from)] : [iso(bounds.from), iso(bounds.to)];
  const rows = checkedRows(await read.all(`SELECT id, submitted_at, currency${values ? ', CAST(total_minor AS TEXT) AS total_minor' : ''} FROM shop_order WHERE ${predicate} LIMIT ${ANALYTICS_LIMITS.orders + 1}`, ...args), ANALYTICS_LIMITS.orders, charge);
  for (const row of rows) { instant(row.submitted_at); if (!SALES_CURRENCIES.includes(row.currency)) corrupt(); if (values) whole(row.total_minor); }
  return rows;
}
async function lines(read, bounds, charge, { pending = false, metadata = false } = {}) {
  const predicate = pending ? "o.status = 'SUBMITTED' AND o.submitted_at > ?" : `o.status IN ${SALES_STATUSES_SQL} AND o.submitted_at >= ? AND o.submitted_at < ?`;
  const args = pending ? [iso(bounds.from)] : [iso(bounds.from), iso(bounds.to)];
  return checkedRows(await read.all(`SELECT d.order_id, i.product_id, i.currency, CAST(i.quantity AS TEXT) AS quantity${metadata ? ', CAST(i.line_total_minor AS TEXT) AS line_total_minor' : ''}${metadata ? ', p.sku, p.name, p.category' : ''}
    FROM shop_order o JOIN delivery d ON d.order_id = o.id JOIN order_item i ON i.delivery_id = d.id${metadata ? ' JOIN product p ON p.id = i.product_id' : ''}
    WHERE ${predicate} LIMIT ${ANALYTICS_LIMITS.lines + 1}`, ...args), ANALYTICS_LIMITS.lines, charge);
}
function currencyTable(currency, quantities = false) {
  return new Map((currency ? [currency] : SALES_CURRENCIES).map(code => [code, { currency: code, ...(quantities ? { quantity: 0n } : { orders: 0n }), totalMinor: 0n }]));
}
const tableView = map => [...map.values()].map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? safe(value) : value])));
function paginate(items, args) {
  const { limit, offset } = page(args), end = offset + limit, more = items.length > end, capped = more && end > ANALYTICS_LIMITS.offset;
  return { items: items.slice(offset, end), nextOffset: more && !capped ? end : null, paginationCapped: capped,
    coverage: { databaseComplete: true, historyComplete: false, pageComplete: !more && offset === 0, note: ANALYTICS_COVERAGE_NOTE } };
}
function base(now) {
  const ms = now.getTime(); if (!Number.isFinite(ms)) invalid();
  return { timeZone: SALES_TIME_ZONE, definitionVersion: SALES_DEFINITION_VERSION, asOf: iso(ms), acceptedStatuses: [...SALES_STATUSES] };
}
function buckets(bounds, groupBy) {
  const out = []; let start = bounds.from;
  while (start < bounds.to) {
    let end;
    if (groupBy === 'day') end = start + DAY_MS;
    else if (groupBy === 'week') end = shopDayStart(start) + (7 - (new Date(start + SHOP_OFFSET_MS).getUTCDay() + 6) % 7) * DAY_MS;
    else { const month = new Date(start + SHOP_OFFSET_MS); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0); month.setUTCMonth(month.getUTCMonth() + 1); end = month.getTime() - SHOP_OFFSET_MS; }
    end = Math.min(end, bounds.to); out.push({ from: start, to: end }); start = end;
  }
  return out;
}
export async function salesTrend(read, args, now = new Date()) {
  keys(args, ['from', 'toExclusive', 'groupBy', 'currency', 'comparePrevious', 'limit', 'offset'], ['from', 'toExclusive']);
  const bounds = range(args), groupBy = enumeration(args.groupBy, 'day', ['day', 'week', 'month']), currency = selectedCurrency(args), compare = flag(args.comparePrevious, false);
  page(args); const charge = budget(), current = await orders(read, bounds, charge), totals = currencyTable(currency), points = buckets(bounds, groupBy).map(value => ({ ...value, values: currencyTable(currency) }));
  const byDay = new Map(); for (const point of points) for (let ms = point.from; ms < point.to; ms += DAY_MS) byDay.set(ms, point);
  for (const row of current) {
    if (currency && row.currency !== currency) continue;
    const total = totals.get(row.currency), point = byDay.get(shopDayStart(instant(row.submitted_at))).values.get(row.currency), amount = whole(row.total_minor);
    total.orders++; total.totalMinor += amount; point.orders++; point.totalMinor += amount;
  }
  let comparison = null;
  if (compare) {
    const previous = { from: bounds.from - (bounds.to - bounds.from), to: bounds.from };
    if (!/^\d{4}-/.test(date(previous.from)) || date(previous.from).startsWith('0000-')) invalid();
    const previousTotals = currencyTable(currency);
    for (const row of await orders(read, previous, charge)) { if (currency && row.currency !== currency) continue; const total = previousTotals.get(row.currency); total.orders++; total.totalMinor += whole(row.total_minor); }
    comparison = { from: date(previous.from), toExclusive: date(previous.to), totals: tableView(previousTotals), delta: [...totals.values()].map(row => ({ currency: row.currency,
      orders: safe(row.orders - previousTotals.get(row.currency).orders), totalMinor: safe(row.totalMinor - previousTotals.get(row.currency).totalMinor) })) };
  }
  return { ...base(now), metricName: 'accepted_order_value', dateRange: { from: args.from, toExclusive: args.toExclusive }, currency, filters: { currency, groupBy, comparePrevious: compare }, groupBy, weekStartsOn: 'MONDAY',
    totals: tableView(totals), comparison, ...paginate(points.map(point => ({ from: date(point.from), toExclusive: date(point.to), sales: tableView(point.values) })), args) };
}
export async function topProducts(read, args, now = new Date()) {
  keys(args, ['from', 'toExclusive', 'groupBy', 'currency', 'sortBy', 'limit', 'offset'], ['from', 'toExclusive']);
  const bounds = range(args), groupBy = enumeration(args.groupBy, 'product', ['product', 'category']), currency = selectedCurrency(args), sortBy = enumeration(args.sortBy, 'quantity', ['quantity', 'value']);
  page(args); const charge = budget(), accepted = new Map((await orders(read, bounds, charge, { values: false })).map(row => [row.id, row])), values = await lines(read, bounds, charge, { metadata: true }), groups = new Map(), totals = currencyTable(currency, true);
  for (const row of values) {
    const order = accepted.get(row.order_id); if (!order || row.currency !== order.currency) corrupt();
    if (currency && row.currency !== currency) continue;
    const sku = text(row.sku, 40), name = text(row.name, 120), category = text(row.category, 80), quantity = whole(row.quantity), amount = whole(row.line_total_minor);
    const identity = groupBy === 'product' ? row.product_id : category, key = JSON.stringify([identity, row.currency]);
    if (!groups.has(key)) groups.set(key, { productId: groupBy === 'product' ? row.product_id : null, sku: groupBy === 'product' ? sku : null, name: groupBy === 'product' ? name : null,
      categoryCode: category, currency: row.currency, quantity: 0n, totalMinor: 0n });
    const group = groups.get(key), total = totals.get(row.currency); group.quantity += quantity; group.totalMinor += amount; total.quantity += quantity; total.totalMinor += amount;
  }
  const sorted = [...groups.values()].sort((a, b) => {
    if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
    const field = sortBy === 'quantity' ? 'quantity' : 'totalMinor', other = sortBy === 'quantity' ? 'totalMinor' : 'quantity';
    return a[field] !== b[field] ? (a[field] > b[field] ? -1 : 1) : a[other] !== b[other] ? (a[other] > b[other] ? -1 : 1) : String(a.productId || a.categoryCode).localeCompare(String(b.productId || b.categoryCode)) || a.currency.localeCompare(b.currency);
  }).map(row => ({ ...row, quantity: safe(row.quantity), totalMinor: safe(row.totalMinor) }));
  return { ...base(now), metricName: 'accepted_item_value', dateRange: { from: args.from, toExclusive: args.toExclusive }, currency, filters: { currency, groupBy, sortBy }, groupBy, sortBy,
    attribution: 'CURRENT_PRODUCT_AND_CATEGORY', historicalCategoryAvailable: false, totals: tableView(totals), ...paginate(sorted, args) };
}
export async function inventoryRisk(read, args, now = new Date()) {
  keys(args, ['threshold', 'slowDays', 'mode', 'activeOnly', 'limit', 'offset']);
  const threshold = integer(args.threshold, 5, 0, 1000000), slowDays = integer(args.slowDays, 30, 1, ANALYTICS_LIMITS.days), mode = enumeration(args.mode, 'either', ['low', 'slow', 'either', 'all']), activeOnly = flag(args.activeOnly, true);
  page(args); const charge = budget(), products = checkedRows(await read.all(`SELECT id, sku, name, category, active, CAST(stock_quantity AS TEXT) AS stock_quantity, created_at FROM product${activeOnly ? ' WHERE active = 1' : ''} LIMIT ${ANALYTICS_LIMITS.products + 1}`), ANALYTICS_LIMITS.products, charge);
  const ms = now.getTime(); base(now);
  const slowRange = { from: ms - slowDays * DAY_MS, to: ms }, heldRange = { from: ms - RESERVATION_HOURS * 3600000 };
  const accepted = new Map((await orders(read, slowRange, charge, { values: false })).map(row => [row.id, row])), pending = new Map((await orders(read, heldRange, charge, { pending: true, values: false })).map(row => [row.id, row])), quantities = new Map(), holds = new Map();
  for (const [values, target, source] of [[await lines(read, slowRange, charge), quantities, accepted], [await lines(read, heldRange, charge, { pending: true }), holds, pending]]) {
    for (const row of values) { const order = source.get(row.order_id); if (!order || row.currency !== order.currency) corrupt(); target.set(row.product_id, (target.get(row.product_id) || 0n) + whole(row.quantity)); }
  }
  const items = products.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(row => {
    text(row.sku, 40); text(row.name, 120); text(row.category, 80); if (![0, 1].includes(row.active)) corrupt();
    const created = instant(row.created_at), stock = row.stock_quantity === null ? null : whole(row.stock_quantity), reserved = holds.get(row.id) || 0n, acceptedQuantity = quantities.get(row.id) || 0n;
    const availability = stockAvailability(stock === null ? null : safe(stock), safe(reserved));
    const lowStock = availability.availableQuantity !== null && availability.availableQuantity <= threshold, slowMoving = created <= slowRange.from ? acceptedQuantity === 0n : null;
    return { productId: row.id, sku: row.sku, name: row.name, categoryCode: row.category, active: row.active === 1, stockQuantity: stock === null ? null : safe(stock),
      ...availability,
      lowStock, slowMoving, acceptedQuantityInPeriod: safe(acceptedQuantity) };
  }).filter(row => mode === 'all' || (mode === 'low' ? row.lowStock : mode === 'slow' ? row.slowMoving === true : row.lowStock || row.slowMoving === true));
  return { ...base(now), metricName: 'inventory_risk', dateRange: { from: iso(slowRange.from), toExclusive: iso(slowRange.to) }, currency: null, filters: { threshold, slowDays, mode, activeOnly }, threshold, slowDays, mode, activeOnly, reservationHours: RESERVATION_HOURS,
    lookbackFrom: iso(slowRange.from), lookbackToExclusive: iso(slowRange.to), slowDefinition: 'ZERO_ACCEPTED_UNITS_AND_OLD_ENOUGH', totals: { scannedProducts: products.length, matchedProducts: items.length,
      matchedTracked: items.filter(row => row.stockQuantity !== null).length, matchedUnlimited: items.filter(row => row.stockQuantity === null).length,
      matchedLowStock: items.filter(row => row.lowStock).length, matchedSlowMoving: items.filter(row => row.slowMoving === true).length, matchedUnknownSlow: items.filter(row => row.slowMoving === null).length }, ...paginate(items, args) };
}
