import { ApiError } from './http.js';
import { FieldError, boundedText } from './validation.js';
import { normalizeContactPhone } from './phone.js';

const categoryType = 'PRODUCT_CATEGORY';

export async function listCategories(database) {
  return (await database.all(`SELECT code, label, active FROM general_code
    WHERE type = ? ORDER BY label COLLATE NOCASE, code`, categoryType))
    .map((row) => ({ ...row, active: Boolean(row.active) }));
}

export async function requireActiveCategory(database, code) {
  if (!await database.get(`SELECT 1 FROM general_code WHERE type = ? AND code = ? AND active = 1`, categoryType, code)) {
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
    if (!/^[A-Z][A-Z0-9_\-]*$/.test(result.code)) throw new FieldError('code', 'Use uppercase letters, digits, hyphens or underscores.');
  }
  if (Object.hasOwn(input, 'label')) result.label = boundedText(input.label, 'label', 80);
  if (Object.hasOwn(input, 'active')) {
    if (typeof input.active !== 'boolean') throw new FieldError('active', 'Choose category availability.');
    result.active = input.active;
  }
  return result;
}

export async function createCategory(database, input) {
  return database.transaction(async () => {
  const category = categoryInput(input);
  const now = new Date().toISOString();
  try {
    await database.run(`INSERT INTO general_code(type, code, label, active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)`, categoryType, category.code, category.label, now, now);
  } catch (error) {
    if (error.code === '23505' || String(error.message).includes('UNIQUE constraint failed')) throw new ApiError(409, 'DUPLICATE_CATEGORY', 'Category code or label already exists.');
    throw error;
  }
  return { ...category, active: true };
  });
}

export async function updateCategory(database, code, input) {
  return database.transaction(async () => {
  const patch = categoryInput(input, true);
  const existing = await database.get('SELECT code, label, active FROM general_code WHERE type = ? AND code = ?', categoryType, code);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Category not found.');
  const label = patch.label ?? existing.label;
  const active = patch.active ?? Boolean(existing.active);
  try {
    await database.run(`UPDATE general_code SET label = ?, active = ?, updated_at = ? WHERE type = ? AND code = ?`,
      label, Number(active), new Date().toISOString(), categoryType, code);
  } catch (error) {
    if (error.code === '23505' || String(error.message).includes('UNIQUE constraint failed')) throw new ApiError(409, 'DUPLICATE_CATEGORY', 'Category label already exists.');
    throw error;
  }
  return { code, label, active };
  });
}

export async function getCompanySettings(database) {
  const row = await database.get('SELECT default_currency, seller_whatsapp_phone, mobile_hide_bars_on_scroll FROM company_setting WHERE id = 1');
  return { defaultCurrency: row.default_currency, sellerWhatsAppPhone: row.seller_whatsapp_phone,
    mobileHideBarsOnScroll: Boolean(row.mobile_hide_bars_on_scroll) };
}

export async function updateCompanySettings(database, input) {
  return database.transaction(async () => {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Object.keys(input).length ||
      Object.keys(input).some((key) => !['defaultCurrency', 'sellerWhatsAppPhone', 'mobileHideBarsOnScroll'].includes(key))) {
    throw new FieldError('companySettings', 'Enter supported company settings.');
  }
  const current = await getCompanySettings(database);
  const currency = Object.hasOwn(input, 'defaultCurrency') ? input.defaultCurrency : current.defaultCurrency;
  if (!['MYR', 'SGD'].includes(currency)) throw new FieldError('defaultCurrency', 'Choose MYR or SGD.');
  if (currency !== current.defaultCurrency && await database.get('SELECT 1 FROM product WHERE currency <> ? LIMIT 1', currency)) {
    throw new ApiError(409, 'COMPANY_CURRENCY_CONFLICT', 'Existing products use another currency. Review prices before changing company currency.');
  }
  let phone = current.sellerWhatsAppPhone;
  const hideBars = Object.hasOwn(input, 'mobileHideBarsOnScroll') ? input.mobileHideBarsOnScroll : current.mobileHideBarsOnScroll;
  if (typeof hideBars !== 'boolean') throw new FieldError('mobileHideBarsOnScroll', 'Choose whether to hide mobile bars on scroll.');
  if (Object.hasOwn(input, 'sellerWhatsAppPhone')) {
    if (input.sellerWhatsAppPhone === null || input.sellerWhatsAppPhone === '') phone = null;
    else {
      try {
        const value = input.sellerWhatsAppPhone;
        phone = normalizeContactPhone(typeof value === 'string' && /^\d+$/.test(value) ? `+${value}` : value).slice(1);
      } catch { throw new FieldError('sellerWhatsAppPhone', 'Enter a valid +60 or +65 mobile number.'); }
    }
  }
  await database.run('UPDATE company_setting SET default_currency = ?, seller_whatsapp_phone = ?, mobile_hide_bars_on_scroll = ?, updated_at = ? WHERE id = 1',
    currency, phone, Number(hideBars), new Date().toISOString());
  return await getCompanySettings(database);
  });
}
