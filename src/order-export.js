// CSV export of the orders matching the seller's current filters, for accounting. It holds buyer contact data, so the
// route requires a session and is refused on a quick sign-in site. Cells that a spreadsheet could read as a formula
// are neutralised, because buyers choose their own names and addresses.
import { ApiError } from './http.js';
import { orderFilter } from './seller-orders.js';

export const EXPORT_ROW_LIMIT = 5000;
const HEADER = ['Order number', 'Submitted (UTC)', 'Status', 'Currency', 'Total', 'Items', 'Buyer name', 'Buyer WhatsApp', 'Buyer email',
  'Destinations', 'Carrier', 'Tracking number', 'Contact erased'];

export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const money = (minor) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

export async function exportOrdersCsv(database, params) {
  const filter = orderFilter(params);
  const aliased = orderFilter(params, 'o.');
  const { total } = await database.get(`SELECT COUNT(*) AS total FROM shop_order WHERE ${filter.where}`, ...filter.values);
  if (total > EXPORT_ROW_LIMIT) throw new ApiError(413, 'TOO_MANY_ROWS', `More than ${EXPORT_ROW_LIMIT} orders match. Narrow the filters.`);
  const rows = await database.all(`SELECT o.order_no, o.submitted_at, o.status, o.currency, o.total_minor, o.buyer_name, o.buyer_phone, o.buyer_email,
      o.tracking_carrier, o.tracking_no, o.contact_erased_at,
      (SELECT COALESCE(SUM(i.quantity), 0) FROM order_item i JOIN delivery d ON d.id = i.delivery_id WHERE d.order_id = o.id) AS items,
      (SELECT COUNT(*) FROM delivery d WHERE d.order_id = o.id) AS destinations
    FROM shop_order o WHERE ${aliased.where}
    ORDER BY o.submitted_at DESC, o.id DESC`, ...filter.values);
  const lines = [HEADER, ...rows.map((row) => [row.order_no, row.submitted_at, row.status, row.currency, money(row.total_minor), row.items,
    row.buyer_name, row.buyer_phone, row.buyer_email, row.destinations, row.tracking_carrier, row.tracking_no, row.contact_erased_at ? 'yes' : 'no'])];
  // The byte-order mark makes Excel read the file as UTF-8.
  return `﻿${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
