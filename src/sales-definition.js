// One definition for dashboard and extended analytics. Value is accepted order
// value attributed to submission time, not cash collected, cost or profit.
export const SHOP_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const SALES_STATUSES = Object.freeze(['CONFIRMED', 'SHIPPED', 'DELIVERED']);
export const SALES_STATUSES_SQL = '(' + SALES_STATUSES.map(status => "'" + status + "'").join(', ') + ')';
export const SALES_CURRENCIES = Object.freeze(['MYR', 'SGD']);
export const SALES_TIME_ZONE = 'UTC+8';
export const SALES_DEFINITION_VERSION = 'accepted-submission-v1';
export function shopDayStart(nowMs) {
  return Math.floor((nowMs + SHOP_OFFSET_MS) / DAY_MS) * DAY_MS - SHOP_OFFSET_MS;
}
