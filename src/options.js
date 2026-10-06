import { randomUUID } from 'node:crypto';
import { ApiError } from './http.js';
import { FieldError, boundedText } from './validation.js';
import { OPTION_LIMITS } from './option-limits.js';

/*
 * Tenant-defined product options. Nothing is predefined: the seller creates option types (any name,
 * such as Colour, Storage or Material) and their values, and assigns one value per type to each
 * product (SKU) in a variant group. A product stays the unit of price, stock, SKU and cart line, so
 * carts and orders are unchanged.
 */
export const OPTION_DISPLAYS = ['button', 'swatch', 'image', 'dropdown'];
const localePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const colorPattern = /^#[0-9a-fA-F]{6}$/;
const duplicate = (error) => error?.code === '23505' || String(error?.message).includes('UNIQUE constraint failed');

function slug(text) {
  return text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function translationsInput(value, field) {
  if (value === undefined) return undefined;
  if (value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > OPTION_LIMITS.translationLocales) {
    throw new FieldError(field, 'Enter translations as an object of language codes and text.');
  }
  const result = {};
  for (const [locale, text] of Object.entries(value)) {
    if (!localePattern.test(locale)) throw new FieldError(field, 'Use valid language codes such as zh-Hans.');
    const label = boundedText(text, field, 80, false);
    if (label) result[locale] = label;
  }
  return result;
}

function onlyKeys(input, allowed, field) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length ||
      Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new FieldError(field, 'Enter supported option fields.');
  }
}

function positionInput(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > 100000) throw new FieldError('position', 'Enter a position from 0 to 100000.');
  return value;
}

function typeFromRow(row) {
  return { id: row.id, code: row.code, name: row.name, translations: JSON.parse(row.translations_json),
    display: row.display, position: row.position, active: Boolean(row.active), values: [] };
}

function valueFromRow(row) {
  return { id: row.id, code: row.code, label: row.label, translations: JSON.parse(row.translations_json),
    swatchColor: row.swatch_color, position: row.position, active: Boolean(row.active) };
}

export async function listOptionTypes(database) {
  const types = (await database.all('SELECT * FROM option_type ORDER BY position, name, id')).map(typeFromRow);
  const byId = new Map(types.map((type) => [type.id, type]));
  for (const row of await database.all('SELECT * FROM option_value ORDER BY position, label, id')) byId.get(row.option_type_id)?.values.push(valueFromRow(row));
  return types;
}

async function uniqueCode(database, table, scope, base, fallbackPrefix) {
  const root = base || `${fallbackPrefix}-${randomUUID().slice(0, 6)}`;
  for (let n = 1; n < 1000; n++) {
    const code = n === 1 ? root : `${root}-${n}`.slice(-60);
    const taken = await database.get(`SELECT 1 FROM ${table} WHERE lower(code) = ?${scope ? ' AND option_type_id = ?' : ''}`,
      ...(scope ? [code.toLowerCase(), scope] : [code.toLowerCase()]));
    if (!taken) return code;
  }
  throw new ApiError(409, 'DUPLICATE_OPTION', 'Choose a different name.');
}

export async function createOptionType(database, input) {
  return database.transaction(async () => {
    onlyKeys(input, ['name', 'code', 'display', 'translations', 'position'], 'optionType');
    const name = boundedText(input.name, 'name', 60);
    const display = input.display ?? 'button';
    if (!OPTION_DISPLAYS.includes(display)) throw new FieldError('display', 'Choose button, swatch, image or dropdown.');
    const translations = translationsInput(input.translations, 'translations') ?? {};
    const position = positionInput(input.position) ?? 0;
    const requested = input.code === undefined ? slug(name) : boundedText(input.code, 'code', 40).toLowerCase();
    if (input.code !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(requested)) throw new FieldError('code', 'Use lowercase letters, digits, hyphens or underscores.');
    if (await database.get('SELECT 1 FROM option_type WHERE lower(name) = ?', name.toLowerCase())) {
      throw new ApiError(409, 'DUPLICATE_OPTION', 'An option type with this name already exists.');
    }
    const id = randomUUID(), now = new Date().toISOString();
    const code = await uniqueCode(database, 'option_type', null, requested, 'type');
    await database.run(`INSERT INTO option_type (id, code, name, translations_json, display, position, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`, id, code, name, JSON.stringify(translations), display, position, now, now);
    return (await listOptionTypes(database)).find((type) => type.id === id);
  });
}

export async function updateOptionType(database, id, input) {
  return database.transaction(async () => {
    onlyKeys(input, ['name', 'display', 'translations', 'position', 'active'], 'optionType');
    const existing = await database.get('SELECT * FROM option_type WHERE id = ?', id);
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Option type not found.');
    const name = Object.hasOwn(input, 'name') ? boundedText(input.name, 'name', 60) : existing.name;
    const display = Object.hasOwn(input, 'display') ? input.display : existing.display;
    if (!OPTION_DISPLAYS.includes(display)) throw new FieldError('display', 'Choose button, swatch, image or dropdown.');
    const translations = translationsInput(input.translations, 'translations') ?? JSON.parse(existing.translations_json);
    const position = positionInput(input.position) ?? existing.position;
    let active = Boolean(existing.active);
    if (Object.hasOwn(input, 'active')) { if (typeof input.active !== 'boolean') throw new FieldError('active', 'Choose active or inactive.'); active = input.active; }
    if (name.toLowerCase() !== existing.name.toLowerCase() && await database.get('SELECT 1 FROM option_type WHERE lower(name) = ? AND id <> ?', name.toLowerCase(), id)) {
      throw new ApiError(409, 'DUPLICATE_OPTION', 'An option type with this name already exists.');
    }
    await database.run(`UPDATE option_type SET name = ?, translations_json = ?, display = ?, position = ?, active = ?, updated_at = ? WHERE id = ?`,
      name, JSON.stringify(translations), display, position, Number(active), new Date().toISOString(), id);
    await refreshVariantLabels(database, await productIdsForType(database, id));
    return (await listOptionTypes(database)).find((type) => type.id === id);
  });
}

export async function createOptionValue(database, typeId, input) {
  return database.transaction(async () => {
    onlyKeys(input, ['label', 'code', 'swatchColor', 'translations', 'position'], 'optionValue');
    const type = await database.get('SELECT id FROM option_type WHERE id = ?', typeId);
    if (!type) throw new ApiError(404, 'NOT_FOUND', 'Option type not found.');
    const label = boundedText(input.label, 'label', 80);
    const swatch = swatchInput(input.swatchColor) ?? null;
    const translations = translationsInput(input.translations, 'translations') ?? {};
    const position = positionInput(input.position) ?? 0;
    const count = Number((await database.get('SELECT COUNT(*) AS n FROM option_value WHERE option_type_id = ?', typeId)).n);
    if (count >= OPTION_LIMITS.valuesPerType) throw new ApiError(409, 'OPTION_LIMIT', `An option type can have at most ${OPTION_LIMITS.valuesPerType} values.`);
    if (await database.get('SELECT 1 FROM option_value WHERE option_type_id = ? AND lower(label) = ?', typeId, label.toLowerCase())) {
      throw new ApiError(409, 'DUPLICATE_OPTION', 'This option value already exists.');
    }
    const requested = input.code === undefined ? slug(label) : boundedText(input.code, 'code', 60).toLowerCase();
    const code = await uniqueCode(database, 'option_value', typeId, requested, 'value');
    const id = randomUUID(), now = new Date().toISOString();
    await database.run(`INSERT INTO option_value (id, option_type_id, code, label, translations_json, swatch_color, position, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, id, typeId, code, label, JSON.stringify(translations), swatch, position, now, now);
    return valueFromRow(await database.get('SELECT * FROM option_value WHERE id = ?', id));
  });
}

function swatchInput(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !colorPattern.test(value)) throw new FieldError('swatchColor', 'Enter a colour such as #1e3a5f.');
  return value.toLowerCase();
}

export async function updateOptionValue(database, typeId, valueId, input) {
  return database.transaction(async () => {
    onlyKeys(input, ['label', 'swatchColor', 'translations', 'position', 'active'], 'optionValue');
    const existing = await database.get('SELECT * FROM option_value WHERE id = ? AND option_type_id = ?', valueId, typeId);
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Option value not found.');
    const label = Object.hasOwn(input, 'label') ? boundedText(input.label, 'label', 80) : existing.label;
    const swatch = swatchInput(input.swatchColor);
    const translations = translationsInput(input.translations, 'translations') ?? JSON.parse(existing.translations_json);
    const position = positionInput(input.position) ?? existing.position;
    let active = Boolean(existing.active);
    if (Object.hasOwn(input, 'active')) { if (typeof input.active !== 'boolean') throw new FieldError('active', 'Choose active or inactive.'); active = input.active; }
    if (label.toLowerCase() !== existing.label.toLowerCase() &&
        await database.get('SELECT 1 FROM option_value WHERE option_type_id = ? AND lower(label) = ? AND id <> ?', typeId, label.toLowerCase(), valueId)) {
      throw new ApiError(409, 'DUPLICATE_OPTION', 'This option value already exists.');
    }
    await database.run(`UPDATE option_value SET label = ?, translations_json = ?, swatch_color = ?, position = ?, active = ?, updated_at = ? WHERE id = ?`,
      label, JSON.stringify(translations), swatch === undefined ? existing.swatch_color : swatch, position, Number(active), new Date().toISOString(), valueId);
    await refreshVariantLabels(database, (await database.all('SELECT product_id FROM product_option WHERE option_value_id = ?', valueId)).map((row) => row.product_id));
    return valueFromRow(await database.get('SELECT * FROM option_value WHERE id = ?', valueId));
  });
}

async function productIdsForType(database, typeId) {
  return (await database.all('SELECT product_id FROM product_option WHERE option_type_id = ?', typeId)).map((row) => row.product_id);
}

const placeholders = (items) => items.map(() => '?').join(', ');

/* Options of the given products, ordered by option type position, as the public/seller response shape. */
export async function loadProductOptions(database, productIds) {
  const result = new Map(productIds.map((id) => [id, []]));
  if (!productIds.length) return result;
  const rows = await database.all(`SELECT po.product_id, t.id AS type_id, t.code AS type_code, t.name AS type_name,
      t.translations_json AS type_translations, t.display, v.id AS value_id, v.code AS value_code, v.label,
      v.translations_json AS value_translations, v.swatch_color, v.position AS value_position
    FROM product_option po JOIN option_type t ON t.id = po.option_type_id JOIN option_value v ON v.id = po.option_value_id
    WHERE po.product_id IN (${placeholders(productIds)}) ORDER BY t.position, t.name, t.id`, ...productIds);
  for (const row of rows) {
    result.get(row.product_id).push({
      type: { id: row.type_id, code: row.type_code, name: row.type_name, translations: JSON.parse(row.type_translations), display: row.display },
      value: { id: row.value_id, code: row.value_code, label: row.label, translations: JSON.parse(row.value_translations), swatchColor: row.swatch_color, position: row.value_position },
    });
  }
  return result;
}

const labelOf = (options) => options.map((option) => option.value.label).join(' / ');

/* The label shown in the variant list stays derived from the chosen values, so older screens keep working. */
export async function refreshVariantLabels(database, productIds) {
  const ids = [...new Set(productIds)];
  if (!ids.length) return;
  const options = await loadProductOptions(database, ids);
  for (const id of ids) {
    const label = labelOf(options.get(id));
    if (label) await database.run('UPDATE product SET variant_label = ? WHERE id = ?', label.slice(0, 80), id);
  }
}

const optionKey = (options) => options.map((option) => `${option.type.id}:${option.value.id}`).sort().join('|');
const typeSet = (options) => options.map((option) => option.type.id).sort().join('|');

/*
 * Replaces the options of one product. `options` is [{ typeId, valueId }]; an empty array clears them.
 * All products of a variant group must use the same option types, and each combination is unique.
 */
export async function setProductOptions(database, productId, variantGroup, options, { newProduct = false } = {}) {
  if (!Array.isArray(options)) throw new FieldError('options', 'Choose options as a list.');
  if (!options.length) {
    await database.run('DELETE FROM product_option WHERE product_id = ?', productId);
    return;
  }
  if (!variantGroup) throw new FieldError('options', 'Set a variant group before choosing options.');
  if (options.length > OPTION_LIMITS.typesPerGroup) throw new FieldError('options', `Use at most ${OPTION_LIMITS.typesPerGroup} option types.`);
  const picked = [];
  for (const item of options) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.typeId !== 'string' || typeof item.valueId !== 'string' ||
        Object.keys(item).some((key) => !['typeId', 'valueId'].includes(key))) throw new FieldError('options', 'Choose an option type and value.');
    picked.push(item);
  }
  if (new Set(picked.map((item) => item.typeId)).size !== picked.length) throw new FieldError('options', 'Choose each option type only once.');
  const rows = await database.all(`SELECT v.id AS value_id, v.option_type_id, v.active AS value_active, t.active AS type_active
    FROM option_value v JOIN option_type t ON t.id = v.option_type_id WHERE v.id IN (${placeholders(picked)})`, ...picked.map((item) => item.valueId));
  const byValue = new Map(rows.map((row) => [row.value_id, row]));
  const current = new Set((await database.all('SELECT option_value_id FROM product_option WHERE product_id = ?', productId)).map((row) => row.option_value_id));
  for (const item of picked) {
    const row = byValue.get(item.valueId);
    if (!row || row.option_type_id !== item.typeId) throw new FieldError('options', 'Choose an existing option value.');
    if ((!row.value_active || !row.type_active) && !current.has(item.valueId)) throw new FieldError('options', 'This option is inactive.');
  }
  const siblings = await database.all('SELECT id FROM product WHERE variant_group = ? AND id <> ?', variantGroup, productId);
  if (siblings.length + 1 > OPTION_LIMITS.combinationsPerGroup) throw new ApiError(409, 'OPTION_LIMIT', `A variant group can have at most ${OPTION_LIMITS.combinationsPerGroup} products.`);
  const siblingOptions = await loadProductOptions(database, siblings.map((row) => row.id));
  const mine = picked.map((item) => ({ type: { id: item.typeId }, value: { id: item.valueId } }));
  for (const [, theirs] of siblingOptions) {
    if (!theirs.length) continue;
    if (typeSet(theirs) !== typeSet(mine)) throw new FieldError('options', 'All products in a variant group must use the same option types.');
    if (optionKey(theirs) === optionKey(mine)) {
      const conflict = new ApiError(409, 'DUPLICATE_VARIANT', 'This combination already exists in the group.');
      conflict.field = 'options';
      throw conflict;
    }
  }
  await database.run('DELETE FROM product_option WHERE product_id = ?', productId);
  for (const item of picked) {
    await database.run('INSERT INTO product_option (product_id, option_type_id, option_value_id) VALUES (?, ?, ?)', productId, item.typeId, item.valueId);
  }
  try { await refreshVariantLabels(database, [productId]); }
  catch (error) {
    if (!duplicate(error)) throw error;
    const conflict = new ApiError(409, 'DUPLICATE_VARIANT', 'This combination already exists in the group.');
    conflict.field = 'options';
    throw conflict;
  }
}

/* Axes of a variant group for the storefront: the option types in use and the values present. */
export function optionAxes(variantOptions) {
  const axes = new Map();
  for (const options of variantOptions) {
    for (const { type, value } of options) {
      if (!axes.has(type.id)) axes.set(type.id, { ...type, values: new Map() });
      axes.get(type.id).values.set(value.id, value);
    }
  }
  const byPosition = (a, b) => a.position - b.position || a.label.localeCompare(b.label);
  return [...axes.values()].map((axis) => ({ ...axis, values: [...axis.values.values()].sort(byPosition) }));
}

/* True when other products in the group are described by options (new products must then use them too). */
export async function groupUsesOptions(database, variantGroup, excludeId) {
  if (!variantGroup) return false;
  return Boolean(await database.get(`SELECT 1 FROM product_option po JOIN product p ON p.id = po.product_id
    WHERE p.variant_group = ? AND p.id <> ? LIMIT 1`, variantGroup, excludeId));
}

/*
 * One-time conversion of the original single "option label" variants: one option type called "Option"
 * with a value per distinct label, assigned to each product. Safe to run again.
 */
export async function migrateLegacyVariants(store) {
  const rows = await store.all(`SELECT id, variant_label FROM product WHERE variant_group IS NOT NULL AND variant_label IS NOT NULL
    ORDER BY variant_group, variant_label, id`);
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  let type = await store.get("SELECT id FROM option_type WHERE code = 'option'");
  if (!type) {
    type = { id: randomUUID() };
    await store.run(`INSERT INTO option_type (id, code, name, translations_json, display, position, active, created_at, updated_at)
      VALUES (?, 'option', 'Option', '{}', 'button', 0, 1, ?, ?)`, type.id, now, now);
  }
  const values = new Map((await store.all('SELECT id, label FROM option_value WHERE option_type_id = ?', type.id)).map((row) => [row.label.toLowerCase(), row.id]));
  let position = values.size, converted = 0;
  for (const row of rows) {
    if (await store.get('SELECT 1 FROM product_option WHERE product_id = ?', row.id)) continue;
    const key = row.variant_label.toLowerCase();
    if (!values.has(key)) {
      const id = randomUUID();
      const code = await uniqueCode(store, 'option_value', type.id, slug(row.variant_label), 'value');
      await store.run(`INSERT INTO option_value (id, option_type_id, code, label, translations_json, swatch_color, position, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, '{}', NULL, ?, 1, ?, ?)`, id, type.id, code, row.variant_label, position++, now, now);
      values.set(key, id);
    }
    await store.run('INSERT INTO product_option (product_id, option_type_id, option_value_id) VALUES (?, ?, ?)', row.id, type.id, values.get(key));
    converted++;
  }
  return converted;
}
