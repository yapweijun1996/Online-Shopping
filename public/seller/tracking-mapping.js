// Inbound CSV: preserve cell text; the server remains the validation authority.
export const mappingFields = ['orderNo', 'carrier', 'trackingNo', 'shippedDate'];
const aliases = [
  ['Order number', 'Order No', 'Order #', 'Order Ref', 'Reference', 'Your Reference', 'Order Reference', 'Order ID', 'Merchant Reference', 'Customer Reference', 'Ref No', 'Ref', 'Your Order', 'Seller Order'],
  ['Carrier', 'Courier', 'Courier Name', 'Service Provider', 'Courier Company', 'Courier Service', 'Shipping Provider', 'Logistics', 'Delivery Company'],
  ['Tracking Number', 'Tracking No', 'Tracking', 'AWB', 'AWB No', 'Consignment No', 'Consignment Note', 'Waybill', 'Tracking ID', 'Tracking Code', 'Tracking Ref', 'Waybill No', 'Consignment Number', 'Parcel No', 'Airway Bill'],
  ['Shipped Date', 'Ship Date', 'Shipping Date', 'Dispatch Date', 'Date Shipped'],
];
const normalize = (value) => value.trim().toLowerCase().replace(/[\p{P}\p{S}\s_]+/gu, '');
const remembered = new Map();
export function parseTrackingFile(text) {
  if (text.length > 1_000_000) throw new Error('size');
  const table = []; let row = [], cell = '', quoted = false, closed = false;
  const push = () => { row.push(cell); if (row.some(Boolean) || row.length > 1) table.push(row); row = []; cell = ''; closed = false; if (table.length > 501) throw new Error('rows'); };
  for (let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; }
    else if (c === ',') { row.push(cell); cell = ''; closed = false; }
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; push(); }
    else if (c === '"' && !cell && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error('quotes'); cell += c; }
    if (cell.length > 4000) throw new Error('cell');
  }
  if (quoted) throw new Error('quotes'); push();
  const headers = table.shift() ?? [];
  if (!table.length || table.some((cells) => cells.length !== headers.length)) throw new Error('columns');
  const matches = aliases.map((names) => headers.flatMap((name, index) => names.some((alias) => normalize(alias) === normalize(name)) ? [index] : []));
  const selection = matches.map((indices) => indices.length === 1 ? indices[0] : -1);
  const signature = JSON.stringify(headers);
  return { headers, rows: table, signature, selection: remembered.get(signature)?.slice() ?? selection, needsMapping: headers.length > matches.flat().length || matches.some((indices) => indices.length > 1) || selection.slice(0, 3).includes(-1), noCarrier: matches[1].length === 0 };
}
export function validMapping(file, selection, carrier = '') {
  const selected = selection.filter((index) => index !== -1);
  const text = carrier.trim().normalize('NFC');
  return selection.length === 4 && selected.every((index) => Number.isInteger(index) && index >= 0 && index < file.headers.length) && new Set(selected).size === selected.length && selection[0] !== -1 && selection[2] !== -1 && (selection[1] !== -1 || (file.noCarrier && text.length > 0 && text.length <= 40 && !/\p{Cc}/u.test(carrier) && !carrier.includes('\uFFFD')));
}
export function mappedTrackingCsv(file, selection, carrier = '') {
  if (!validMapping(file, selection, carrier)) throw new Error('mapping');
  remembered.set(file.signature, selection.slice());
  const escape = (value) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return '\uFEFF' + [['Order number', 'Carrier', 'Tracking number', 'Shipped date'], ...file.rows.map((row) => selection.map((index, field) => index === -1 ? field === 1 ? carrier : '' : row[index]))].map((row) => row.map(escape).join(',')).join('\r\n') + '\r\n';
}
