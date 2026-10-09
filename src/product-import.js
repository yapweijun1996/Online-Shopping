// CSV import of the catalog (the counterpart of product-export.js). Rows are matched by SKU: an existing SKU is updated,
// a new SKU is created. Only price, stock, active, name, description and category can be set. Variant columns cannot be
// imported (variants are made in the app). A preview reports every row without writing; the import itself is all or
// nothing and goes through the same create and update code, and the same history, as the editor.
import { ApiError } from './http.js';
import { FieldError } from './validation.js';
import { validateProductInput } from './product-input.js';
import { createProduct, updateProduct } from './products.js';
import { trackCreate, trackUpdate } from './product-history.js';
import { getCompanySettings } from './settings.js';

export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_MAX_CHARS = 1_000_000;
const CELL_MAX = 4000;
const COLUMNS = { sku: 'sku', name: 'name', description: 'description', category: 'category', 'variant group': 'variantGroup', 'variant label': 'variantLabel',
  currency: 'currency', price: 'price', stock: 'stock', 'stock (blank = unlimited)': 'stock', active: 'active', 'updated (utc)': 'updated' };

/* RFC 4180 reader: quoted cells may hold commas, quotes ("") and line breaks; a leading byte-order mark is dropped. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false, index = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  for (; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') { if (text[index + 1] === '"') { cell += '"'; index++; } else quoted = false; }
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(cell); cell = '';
      if (row.some((value) => value !== '') || row.length > 1) rows.push(row);
      row = [];
    } else cell += char;
    if (cell.length > CELL_MAX) throw new FieldError('csv', 'A cell is longer than allowed.');
    if (rows.length > IMPORT_MAX_ROWS + 1) throw new FieldError('csv', `The file has more than ${IMPORT_MAX_ROWS} rows.`);
  }
  if (quoted) throw new FieldError('csv', 'The file has an unclosed quote.');
  row.push(cell);
  if (row.some((value) => value !== '') || row.length > 1) rows.push(row);
  return rows;
}

// The exporter puts an apostrophe in front of cells a spreadsheet could read as a formula; take it off again.
const unprotect = (value) => /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;

const err = (field, code, message) => ({ field, code, message });

function parsePrice(text) {
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
function parseActive(text) {
  const value = text.toLowerCase();
  if (['yes', 'true', '1'].includes(value)) return true;
  if (['no', 'false', '0'].includes(value)) return false;
  return null;
}

async function existingBySku(database, skus) {
  const found = new Map();
  for (let start = 0; start < skus.length; start += 400) {
    const chunk = skus.slice(start, start + 400);
    const rows = await database.all(`SELECT id, sku, name, description, category, price_minor, currency, active, stock_quantity, variant_group, variant_label, listing_id
      FROM product WHERE sku IN (${chunk.map(() => '?').join(', ')})`, ...chunk);
    for (const row of rows) found.set(row.sku, row);
  }
  return found;
}

/* Reads the file and works out, row by row, what an import would do. Nothing is written. */
export async function planImport(database, csvText) {
  if (typeof csvText !== 'string' || !csvText.trim() || csvText.length > IMPORT_MAX_CHARS) throw new FieldError('csv', 'Send a CSV file of up to 1,000,000 characters.');
  const table = parseCsv(csvText);
  if (table.length - 1 > IMPORT_MAX_ROWS) throw new FieldError('csv', `The file has more than ${IMPORT_MAX_ROWS} rows.`);
  if (table.length < 2) throw new FieldError('csv', 'The file needs a header row and at least one product row.');
  const header = table[0].map((name) => COLUMNS[name.trim().toLowerCase()] ?? null);
  if (!header.includes('sku')) throw new FieldError('csv', 'The file needs a SKU column.');
  if (new Set(header.filter(Boolean)).size !== header.filter(Boolean).length) throw new FieldError('csv', 'A column appears twice.');
  const currency = (await getCompanySettings(database)).defaultCurrency;
  const categories = new Map();
  for (const row of await database.all("SELECT code, label, active FROM general_code WHERE type = 'PRODUCT_CATEGORY'")) {
    for (const key of [row.code, row.label]) categories.set(key.toLowerCase(), { code: row.code, active: Number(row.active) === 1 });
  }
  const read = (cells, name) => { const at = header.indexOf(name); return at < 0 ? undefined : unprotect((cells[at] ?? '').trim()); };
  const lines = table.slice(1).map((cells, i) => ({ line: i + 2, cells }));
  const skuOf = (cells) => (read(cells, 'sku') ?? '').toUpperCase();
  const existing = await existingBySku(database, [...new Set(lines.map(({ cells }) => skuOf(cells)).filter(Boolean))]);
  const seen = new Set(), listingValues = new Map();
  const rows = [];

  for (const { line, cells } of lines) {
    const sku = skuOf(cells);
    const entry = { line, sku, action: 'error', changes: [], errors: [], input: null, id: null };
    rows.push(entry);
    if (!sku) { entry.errors.push(err('sku', 'REQUIRED', 'The SKU is empty.')); continue; }
    if (seen.has(sku)) { entry.errors.push(err('sku', 'DUPLICATE_IN_FILE', 'This SKU appears more than once in the file.')); continue; }
    seen.add(sku);
    const current = existing.get(sku);
    const text = Object.fromEntries(['name', 'description', 'category', 'variantGroup', 'variantLabel', 'currency', 'price', 'stock', 'active'].map((name) => [name, read(cells, name)]));
    const has = (name) => text[name] !== undefined;
    const blank = (name) => !has(name) || text[name] === '';

    // Values shared by both cases.
    const wanted = {};
    if (!blank('price')) { const minor = parsePrice(text.price); if (minor === null) entry.errors.push(err('priceMinor', 'INVALID', 'Enter the price as a number such as 19.99.')); else wanted.priceMinor = minor; }
    if (!blank('active')) { const flag = parseActive(text.active); if (flag === null) entry.errors.push(err('active', 'INVALID', 'Use yes or no.')); else wanted.active = flag; }
    if (has('stock')) {
      if (text.stock === '') wanted.stockQuantity = null;
      else if (/^\d{1,7}$/.test(text.stock)) wanted.stockQuantity = Number(text.stock);
      else entry.errors.push(err('stockQuantity', 'INVALID', 'Use a whole number, or leave it blank for unlimited.'));
    }
    if (!blank('category')) {
      const found = categories.get(text.category.toLowerCase());
      if (!found || !found.active) entry.errors.push(err('category', 'CATEGORY_UNKNOWN', 'Choose an existing, active category (its code or its name).')); else wanted.category = found.code;
    }
    if (!blank('name')) wanted.name = text.name;
    if (!blank('description')) wanted.description = text.description;
    if (!blank('currency') && text.currency.toUpperCase() !== (current?.currency ?? currency)) entry.errors.push(err('currency', 'CURRENCY_MISMATCH', 'The currency does not match the shop or the product.'));
    if (entry.errors.length) continue;

    try {
      if (!current) {
        if (!blank('variantGroup') || !blank('variantLabel')) throw Object.assign(new Error('Variants are created in the app, not by import.'), { code: 'VARIANT_NOT_IMPORTABLE', field: 'variantGroup' });
        const missing = ['name', 'description', 'category', 'priceMinor'].filter((field) => !Object.hasOwn(wanted, field));
        if (missing.length) throw Object.assign(new Error('A new product needs a name, description, category and price.'), { code: 'REQUIRED', field: missing[0] === 'priceMinor' ? 'priceMinor' : missing[0] });
        const input = { sku, name: wanted.name, description: wanted.description, category: wanted.category, priceMinor: wanted.priceMinor, currency,
          active: wanted.active ?? true, ...(Object.hasOwn(wanted, 'stockQuantity') ? { stockQuantity: wanted.stockQuantity } : {}) };
        validateProductInput(input, [currency]);
        entry.action = 'create'; entry.input = input;
        entry.changes = ['name', 'category', 'priceMinor', 'active', 'stockQuantity'].filter((field) => Object.hasOwn(input, field)).map((field) => ({ field, from: null, to: input[field] }));
        continue;
      }
      // An existing product: variant columns may be present but must say what is already there.
      for (const [name, stored] of [['variantGroup', current.variant_group], ['variantLabel', current.variant_label]]) {
        if (has(name) && (text[name] || '').toUpperCase() !== (stored || '').toUpperCase()) throw Object.assign(new Error('Variant columns cannot be changed by import.'), { code: 'VARIANT_NOT_IMPORTABLE', field: name });
      }
      const patch = {};
      const same = { name: current.name, description: current.description, category: current.category, priceMinor: Number(current.price_minor), active: Number(current.active) === 1, stockQuantity: current.stock_quantity === null ? null : Number(current.stock_quantity) };
      for (const [field, value] of Object.entries(wanted)) if (value !== same[field]) patch[field] = value;
      if (current.currency !== currency && (Object.hasOwn(patch, 'priceMinor') || patch.active === true)) {
        throw Object.assign(new Error('Review the existing product currency before changing its price or activating it.'), { code: 'COMPANY_CURRENCY_CONFLICT', field: 'priceMinor' });
      }
      // Name, description and category belong to the whole listing: rows of one listing must agree.
      for (const field of ['name', 'description', 'category']) {
        const value = Object.hasOwn(wanted, field) ? wanted[field] : same[field];
        const key = `${current.listing_id}:${field}`;
        if (Object.hasOwn(wanted, field)) {
          if (listingValues.has(key) && listingValues.get(key) !== value) throw Object.assign(new Error('Variants of one product share this value, but the file gives different ones.'), { code: 'SHARED_CONFLICT', field });
          listingValues.set(key, value);
        }
      }
      entry.id = current.id;
      if (!Object.keys(patch).length) { entry.action = 'unchanged'; continue; }
      validateProductInput(patch, [current.currency], { partial: true });
      entry.action = 'update'; entry.input = patch;
      entry.changes = Object.entries(patch).map(([field, to]) => ({ field, from: same[field], to }));
    } catch (error) {
      entry.action = 'error';
      entry.errors.push(error instanceof FieldError ? err(error.field ?? 'product', 'INVALID', error.message) : err(error.field ?? 'product', error.code ?? 'INVALID', error.message));
    }
  }
  const count = (action) => rows.filter((row) => row.action === action).length;
  return { rows, summary: { create: count('create'), update: count('update'), unchanged: count('unchanged'), errors: count('error') } };
}

/* The plan as the page shows it: no internal ids, bounded size. */
export const presentPlan = (plan) => ({ summary: plan.summary,
  rows: plan.rows.filter((row) => row.action !== 'unchanged').slice(0, 300).map(({ line, sku, action, changes, errors }) => ({ line, sku, action, changes, errors })),
  hiddenRows: Math.max(0, plan.rows.filter((row) => row.action !== 'unchanged').length - 300) });

export async function importProducts(database, csvText, actor, mode = 'manual') {
  return database.transaction(async () => {
    const plan = await planImport(database, csvText);
    if (plan.summary.errors) throw Object.assign(new ApiError(409, 'IMPORT_HAS_ERRORS', 'Fix the rows with errors first. Nothing was imported.'), { plan });
    for (const row of plan.rows) {
      if (row.action === 'create') await trackCreate(database, actor, () => createProduct(database, row.input));
      else if (row.action === 'update') await trackUpdate(database, row.id, actor, () => updateProduct(database, row.id, row.input, mode));
    }
    return plan;
  });
}
