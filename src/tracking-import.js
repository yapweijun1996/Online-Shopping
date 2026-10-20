import { ApiError } from './http.js';
import { FieldError, boundedText } from './validation.js';
import { parseCsv, toCsv } from './csv.js';
import { applySellerDecision } from './seller-orders.js';

const columns = new Map([['order number', 'orderNo'], ['carrier', 'carrier'], ['tracking number', 'trackingNo'], ['shipped date', 'shippedDate']]);
const carriers = new Map(['Ninja Van', 'J&T Express', 'Pos Laju', 'DHL eCommerce', 'Flash Express', 'SPX Express'].map((name) => [name.toLowerCase(), name]));
carriers.set('j&t', 'J&T Express');
const canonicalCarrier = (value) => carriers.get(value.toLowerCase()) ?? value;
const day = (instant) => new Date(Date.parse(instant) + 8 * 3600_000).toISOString().slice(0, 10);
const fail = (row, field, code, message) => row.errors.push({ field, code, message });
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');

export function trackingRows(csv) {
  if (typeof csv !== 'string' || !csv.trim()) throw new FieldError('csv', 'Send a CSV file.');
  if (csv.length > 1_000_000) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The file exceeds 1,000,000 characters.');
  let table;
  try { table = parseCsv(csv, { maxRows: 500, strict: true }); }
  catch (error) {
    if (error.message.includes('more than 500')) throw new ApiError(413, 'TOO_MANY_ROWS', error.message);
    throw error;
  }
  const header = (table.shift() ?? []).map((name) => columns.get(name.trim().replace(/[A-Z]/g, (c) => c.toLowerCase())));
  if (header.some((value) => !value) || new Set(header).size !== header.length || !['orderNo', 'carrier', 'trackingNo'].every((key) => header.includes(key))) {
    throw new FieldError('csv', 'Use Order number, Carrier, Tracking number and optional Shipped date; duplicate or unknown columns are not accepted.');
  }
  if (!table.length) throw new FieldError('csv', 'The file needs at least one tracking row.');
  return table.map((cells, index) => {
    if (cells.length !== header.length) throw new FieldError('csv', `Record ${index + 2} has the wrong number of columns.`);
    const row = { line: index + 2, action: 'error', changes: [], errors: [], warnings: [] };
    for (const [field, maximum] of [['orderNo', 40], ['carrier', 40], ['trackingNo', 60], ['shippedDate', 10]]) {
      let value = cells[header.indexOf(field)] ?? '';
      if (/^'(?=\s*[=+\-@]|[\t\r\n])/.test(value)) value = value.slice(1);
      try {
        row[field] = boundedText(value, field, maximum, field !== 'shippedDate');
        if (['orderNo', 'trackingNo'].includes(field) && (/^[=+\-@]/.test(row[field]) || (field === 'trackingNo' && (/\s/u.test(row[field]) || /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(row[field]))))) throw new FieldError(field, 'Use a text identifier, not a formula or scientific notation.');
      } catch (error) { row[field] = ''; fail(row, field, 'INVALID', error.message); }
    }
    row.carrier = canonicalCarrier(row.carrier);
    return row;
  });
}

async function plan(database, csv, expected) {
  const rows = trackingRows(csv);
  const orders = new Map();
  const names = [...new Set(rows.map((row) => row.orderNo).filter(Boolean))];
  for (let start = 0; start < names.length; start += 400) {
    const chunk = names.slice(start, start + 400);
    for (const order of await database.all(`SELECT o.id, o.order_no, o.status, o.revision, o.tracking_carrier, o.tracking_no, o.contact_erased_at,
      (SELECT COUNT(*) FROM delivery d WHERE d.order_id = o.id) AS destinations,
      (SELECT MAX(e.occurred_at) FROM order_event e WHERE e.order_id = o.id AND e.status = 'CONFIRMED') AS confirmed_at
      FROM shop_order o WHERE o.order_no IN (${chunk.map(() => '?').join(',')})`, ...chunk)) orders.set(order.order_no, order);
  }
  const manifest = [...orders.values()].map((order) => ({ orderNo: order.order_no, revision: order.revision })).sort((a, b) => a.orderNo.localeCompare(b.orderNo));
  let revisions;
  if (expected !== undefined) {
    if (!Array.isArray(expected) || expected.length !== manifest.length || expected.some((entry) => !entry || Object.keys(entry).some((key) => !['orderNo', 'revision'].includes(key)) || typeof entry.orderNo !== 'string' || !Number.isSafeInteger(entry.revision) || entry.revision < 1) || new Set(expected.map((entry) => entry.orderNo)).size !== expected.length || expected.some((entry) => !orders.has(entry.orderNo))) throw new FieldError('expectedRevisions', 'Supply the complete preview revision manifest.');
    revisions = new Map(expected.map((entry) => [entry.orderNo, entry.revision]));
  }
  for (const row of rows) {
    const order = orders.get(row.orderNo);
    if (rows.filter((other) => other.orderNo === row.orderNo).length > 1) fail(row, 'orderNo', 'DUPLICATE_ORDER', 'Every occurrence of a repeated order must be removed.');
    if (!order) { fail(row, 'orderNo', 'ORDER_NOT_FOUND', 'Order not found in this shop.'); continue; }
    row.id = order.id; row.expectedRevision = order.revision;
    if (order.destinations !== 1) fail(row, 'orderNo', 'MULTI_DESTINATION_UNSUPPORTED', 'Only single-destination orders can be imported.');
    if (order.contact_erased_at || order.order_no.startsWith('DEMO-')) fail(row, 'orderNo', 'ORDER_NOT_ELIGIBLE', 'This order is not eligible.');
    const same = canonicalCarrier(order.tracking_carrier ?? '') === row.carrier && order.tracking_no === row.trackingNo;
    if (['SHIPPED', 'DELIVERED'].includes(order.status)) {
      if (same) { row.action = 'unchanged'; if (row.shippedDate) row.warnings.push('The declared date is not recorded again for an unchanged order.'); }
      else fail(row, 'trackingNo', 'TRACKING_CONFLICT', 'Existing tracking cannot be replaced by import.');
    } else if (order.status !== 'CONFIRMED') fail(row, 'orderNo', 'INVALID_STATUS', 'The order is not confirmed.');
    else {
      row.action = 'ship';
      if (revisions && revisions.get(row.orderNo) !== order.revision) fail(row, 'orderNo', 'STALE_REVISION', 'The order changed; preview again.');
      row.changes = [{ field: 'status', from: order.status, to: 'SHIPPED' }, { field: 'carrier', from: order.tracking_carrier, to: row.carrier }, { field: 'trackingNo', from: order.tracking_no, to: row.trackingNo }];
    }
    if (row.shippedDate && (!/^\d{4}-\d{2}-\d{2}$/.test(row.shippedDate) || !Number.isFinite(Date.parse(`${row.shippedDate}T00:00:00Z`)) || new Date(`${row.shippedDate}T00:00:00Z`).toISOString().slice(0, 10) !== row.shippedDate || row.shippedDate > day(new Date().toISOString()) || (order.confirmed_at && row.shippedDate < day(order.confirmed_at)))) fail(row, 'shippedDate', 'INVALID_DATE', 'Use a real date between confirmation and today (UTC+8).');
  }
  // Query only candidate tracking identifiers, in bounded chunks; never scan another shop.
  const tracking = [...new Set(rows.map((row) => row.trackingNo).filter(Boolean))];
  const assigned = [];
  for (let start = 0; start < tracking.length; start += 400) {
    const chunk = tracking.slice(start, start + 400);
    assigned.push(...await database.all(`SELECT id, tracking_carrier, tracking_no FROM shop_order WHERE status IN ('SHIPPED','DELIVERED') AND tracking_no IN (${chunk.map(() => '?').join(',')})`, ...chunk));
  }
  for (const row of rows) {
    if (rows.some((other) => other !== row && other.orderNo !== row.orderNo && other.carrier === row.carrier && other.trackingNo === row.trackingNo) || assigned.some((other) => other.id !== row.id && canonicalCarrier(other.tracking_carrier ?? '') === row.carrier && other.tracking_no === row.trackingNo)) fail(row, 'trackingNo', 'TRACKING_REUSED', 'This carrier and tracking number are assigned to another order.');
    if (row.errors.length) row.action = 'error';
  }
  return { rows, summary: { ship: rows.filter((r) => r.action === 'ship').length, unchanged: rows.filter((r) => r.action === 'unchanged').length, errors: rows.filter((r) => r.action === 'error').length }, expectedRevisions: manifest, hiddenRows: 0, planHash: await digest(csv) };
}

export const presentTrackingPlan = (value) => ({ ...value, rows: value.rows.map(({ id: _id, ...row }) => row),
  reportCsv: toCsv([['Record', 'Order number', 'Action', 'Field', 'Code', 'Message'], ...value.rows.flatMap((row) =>
    (row.errors.length ? row.errors : [{ field: '', code: '', message: '' }]).map((error) =>
      [row.line, row.orderNo, row.action, error.field, error.code, error.message]))]) });

export async function trackingImport(database, input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['csv', 'commit', 'expectedRevisions', 'planHash'].includes(key)) || typeof input.commit !== 'boolean') throw new FieldError('import', 'Send csv and commit.');
  if (input.commit && (!Array.isArray(input.expectedRevisions) || typeof input.planHash !== 'string' || input.planHash !== await digest(input.csv ?? ''))) throw new FieldError('planHash', 'Preview this exact file before committing.');
  return database.transaction(async () => {
    const result = await plan(database, input.csv, input.commit ? input.expectedRevisions : undefined);
    if (!input.commit) return presentTrackingPlan(result);
    if (result.summary.errors) throw Object.assign(new ApiError(409, 'IMPORT_HAS_ERRORS', 'Nothing imported. Resolve errors and preview again.'), { plan: presentTrackingPlan(result) });
    for (const row of result.rows.filter((r) => r.action === 'ship').sort((a, b) => a.id.localeCompare(b.id))) {
      await applySellerDecision(database, row.id, 'ship', { expectedRevision: row.expectedRevision, carrier: row.carrier, trackingNo: row.trackingNo }, actor,
        `tracking CSV${row.shippedDate ? `; declared shipped date ${row.shippedDate}` : ''}`);
    }
    return { ...presentTrackingPlan(result), applied: { shipped: result.summary.ship, unchanged: result.summary.unchanged } };
  });
}
