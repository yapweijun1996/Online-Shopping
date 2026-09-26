import { ApiError } from './http.js';
import { FieldError, boundedText } from './validation.js';

const categoryType = 'PRODUCT_CATEGORY';

export function listCategories(database) {
  return database.all(`SELECT code, label, active FROM general_code
    WHERE type = ? ORDER BY label COLLATE NOCASE, code`, categoryType)
    .map((row) => ({ ...row, active: Boolean(row.active) }));
}

export function requireActiveCategory(database, code) {
  if (!database.get(`SELECT 1 FROM general_code WHERE type = ? AND code = ? AND active = 1`, categoryType, code)) {
    throw new FieldError('category', 'Choose an active product category.');
  }
}

function categoryInput(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FieldError('category', 'Enter category details.');
  const allowed = partial ? ['label', 'active'] : ['code', 'label'];
  if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new FieldError('category', 'Enter supported category details.');
  }
  if (!partial && (!Object.hasOwn(input, 'code') || !Object.hasOwn(input, 'label'))) {
    throw new FieldError('category', 'Enter category code and label.');
  }
  const result = {};
  if (Object.hasOwn(input, 'code')) {
    result.code = boundedText(input.code, 'code', 80);
    if (!/^[A-Z][A-Z0-9_-]*$/.test(result.code)) throw new FieldError('code', 'Use uppercase letters, digits, hyphens or underscores.');
  }
  if (Object.hasOwn(input, 'label')) result.label = boundedText(input.label, 'label', 80);
  if (Object.hasOwn(input, 'active')) {
    if (typeof input.active !== 'boolean') throw new FieldError('active', 'Choose category availability.');
    result.active = input.active;
  }
  return result;
}

export function createCategory(database, input) {
  const category = categoryInput(input);
  const now = new Date().toISOString();
  try {
    database.run(`INSERT INTO general_code(type, code, label, active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)`, categoryType, category.code, category.label, now, now);
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) throw new ApiError(409, 'DUPLICATE_CATEGORY', 'Category code or label already exists.');
    throw error;
  }
  return { ...category, active: true };
}

export function updateCategory(database, code, input) {
  const patch = categoryInput(input, true);
  const existing = database.get('SELECT code, label, active FROM general_code WHERE type = ? AND code = ?', categoryType, code);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Category not found.');
  const label = patch.label ?? existing.label;
  const active = patch.active ?? Boolean(existing.active);
  try {
    database.run(`UPDATE general_code SET label = ?, active = ?, updated_at = ? WHERE type = ? AND code = ?`,
      label, Number(active), new Date().toISOString(), categoryType, code);
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) throw new ApiError(409, 'DUPLICATE_CATEGORY', 'Category label already exists.');
    throw error;
  }
  return { code, label, active };
}

export function getCompanySettings(database) {
  const row = database.get('SELECT default_currency FROM company_setting WHERE id = 1');
  return { defaultCurrency: row.default_currency };
}

export function updateCompanySettings(database, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== 1 || !Object.hasOwn(input, 'defaultCurrency') ||
      !['MYR', 'SGD'].includes(input.defaultCurrency)) {
    throw new FieldError('defaultCurrency', 'Choose MYR or SGD.');
  }
  database.run('UPDATE company_setting SET default_currency = ?, updated_at = ? WHERE id = 1', input.defaultCurrency, new Date().toISOString());
  return getCompanySettings(database);
}
