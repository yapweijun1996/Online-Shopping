// Numbers for the seller dashboard. "Today" is the calendar day in Malaysia and Singapore (UTC+8, no daylight saving),
// computed here and passed to SQL as exact UTC instants so SQLite and PostgreSQL agree. Sales never mix currencies:
// every amount is reported per currency, and only orders the seller accepted count (not rejected or cancelled ones).
const SHOP_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SALES = "('CONFIRMED', 'SHIPPED', 'DELIVERED')";
export const TOP_PRODUCTS = 5;
export const TREND_DAYS = 30;

const iso = (ms) => new Date(ms).toISOString();

export function shopDayStart(nowMs) {
  return Math.floor((nowMs + SHOP_OFFSET_MS) / DAY_MS) * DAY_MS - SHOP_OFFSET_MS;
}

export async function dashboardFigures(database, now = new Date()) {
  const todayStart = shopDayStart(now.getTime());
  const windowStart = todayStart - (TREND_DAYS - 1) * DAY_MS;
  const tomorrow = todayStart + DAY_MS;
  const { orders: ordersToday } = await database.get('SELECT COUNT(*) AS orders FROM shop_order WHERE submitted_at >= ? AND submitted_at < ?', iso(todayStart), iso(tomorrow));
  const { pending } = await database.get("SELECT COUNT(*) AS pending FROM shop_order WHERE status = 'SUBMITTED'");
  const sales = (from, to) => database.all(`SELECT currency, COUNT(*) AS orders, SUM(total_minor) AS total_minor FROM shop_order
    WHERE status IN ${SALES} AND submitted_at >= ? AND submitted_at < ? GROUP BY currency ORDER BY currency`, iso(from), iso(to));
  const view = (rows) => rows.map((row) => ({ currency: row.currency, orders: Number(row.orders), totalMinor: Number(row.total_minor) }));
  const top = await database.all(`SELECT i.product_id, MAX(i.name_snapshot) AS name, MAX(i.sku_snapshot) AS sku, i.currency,
      SUM(i.quantity) AS quantity, SUM(i.line_total_minor) AS total_minor
    FROM order_item i JOIN delivery d ON d.id = i.delivery_id JOIN shop_order o ON o.id = d.order_id
    WHERE o.status IN ${SALES} AND o.submitted_at >= ? AND o.submitted_at < ?
    GROUP BY i.product_id, i.currency ORDER BY SUM(i.quantity) DESC, SUM(i.line_total_minor) DESC, i.product_id LIMIT ?`, iso(windowStart), iso(tomorrow), TOP_PRODUCTS);
  return {
    timeZone: 'UTC+8', today: iso(todayStart), windowDays: TREND_DAYS,
    ordersToday: Number(ordersToday), pending: Number(pending),
    salesToday: view(await sales(todayStart, tomorrow)), salesWindow: view(await sales(windowStart, tomorrow)),
    topProducts: top.map((row) => ({ productId: row.product_id, name: row.name, sku: row.sku, currency: row.currency, quantity: Number(row.quantity), totalMinor: Number(row.total_minor) })),
  };
}
