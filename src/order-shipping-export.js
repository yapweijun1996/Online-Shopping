import { toXlsx } from './xlsx.js';
import { senderFields } from './sender-settings.js';
import { ApiError } from './http.js';
import { orderFilter } from './seller-orders.js';
import { money, toCsv } from './csv.js';

const HEADER = ['Sender name', 'Sender phone', 'Sender address line 1', 'Sender address line 2', 'Sender city', 'Sender state', 'Sender postcode', 'Sender country', 'Order number', 'Parcel', 'Recipient name', 'Recipient phone', 'Address line 1', 'Address line 2', 'City', 'State', 'Postcode', 'Country', 'Items', 'Item count', 'Order total', 'Currency', 'Buyer email', 'Weight (kg)', 'Parcel content', 'Submitted (UTC)'];
const shorten = (text, limit) => Array.from(text).slice(0, limit).join('');

export async function exportShippingList(database, params, format = 'csv') {
  params = new URLSearchParams(params);
  if (!params.get('status')) params.set('status', 'CONFIRMED');
  const filter = orderFilter(params, 'o.');
  return database.transaction(async () => {
    const counts = await database.get(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN o.contact_erased_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS skipped
      FROM delivery d JOIN shop_order o ON o.id = d.order_id WHERE ${filter.where}`, ...filter.values);
    if (counts.total - counts.skipped > 500) throw new ApiError(413, 'TOO_MANY_ROWS', 'More than 500 parcels match. Narrow the filters.');
    const parcels = await database.all(`SELECT d.*, o.order_no, o.submitted_at, o.total_minor, o.currency, o.buyer_email,
      (SELECT COUNT(*) FROM delivery p WHERE p.order_id = o.id) AS parcels
      FROM delivery d JOIN shop_order o ON o.id = d.order_id
      WHERE ${filter.where} AND o.contact_erased_at IS NULL
      ORDER BY o.submitted_at, o.id, d.position, d.id LIMIT 501`, ...filter.values);
    if (parcels.length > 500) throw new ApiError(413, 'TOO_MANY_ROWS', 'More than 500 parcels match. Narrow the filters.');
    const items = new Map();
    for (let start = 0; start < parcels.length; start += 400) {
      const ids = parcels.slice(start, start + 400).map((parcel) => parcel.id);
      const rows = await database.all(`SELECT delivery_id, name_snapshot, quantity FROM order_item
        WHERE delivery_id IN (${ids.map(() => '?').join(',')}) ORDER BY delivery_id, position, id`, ...ids);
      for (const row of rows) {
        if (!items.has(row.delivery_id)) items.set(row.delivery_id, []);
        items.get(row.delivery_id).push(row);
      }
    }
    const settings = await database.get('SELECT * FROM company_setting WHERE id = 1');
    const sender = Object.values(senderFields).map(([column]) => column === 'sender_phone' && settings[column] ? `+${settings[column]}` : settings[column] ?? '');
    const positions = new Map();
    const lines = parcels.map((parcel) => {
      const position = (positions.get(parcel.order_id) || 0) + 1;
      positions.set(parcel.order_id, position);
      const contents = items.get(parcel.id) || [];
      const summary = contents.map((item) => `${item.quantity} x ${item.name_snapshot}`).join('; ');
      return [...sender, parcel.order_no, `${position}/${parcel.parcels}`, parcel.recipient_name, parcel.recipient_phone,
        parcel.address_line1, parcel.address_line2, parcel.address_city, parcel.address_region, parcel.address_postcode,
        parcel.address_country, shorten(summary, 200), contents.reduce((sum, item) => sum + item.quantity, 0),
        money(parcel.total_minor), parcel.currency, parcel.buyer_email, '', shorten(summary, 60), parcel.submitted_at];
    });
    return { [format]: format === 'xlsx' ? toXlsx([HEADER, ...lines]) : toCsv([HEADER, ...lines]), skipped: Number(counts.skipped) };
  });
}
