import catalog from './pet-demo-catalog.json' with { type: 'json' };
import { ApiError } from './http.js';
import { createProduct } from './products.js';
import { createCategory } from './settings.js';
import { boundedText, FieldError } from './validation.js';
import { DEMO_SELLER_WHATSAPP_PHONE } from './demo-defaults.js';

const categories = {
  LITTER_BOXES: 'Automatic Litter Boxes', CAT_LITTER: 'Cat Litter',
  ODOR_CONTROL: 'Odor Control', WASTE_BAGS: 'Waste Bags', ACCESSORIES: 'Litter Box Accessories',
};

export function getShopSetup(store) {
  const row = store.get('SELECT mode, shop_name FROM shop_setup WHERE id = 1');
  return { mode: row.mode, shopName: row.shop_name };
}

export function setupShop(store, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['mode', 'shopName'].includes(key)) ||
      !['demo', 'production'].includes(input.mode)) {
    throw new FieldError('mode', 'Choose Demo or Production.');
  }
  const shopName = input.mode === 'demo' ? 'Paws & Whiskers Pet Shop' : boundedText(input.shopName, 'shopName', 80);
  return store.transaction(() => {
    const current = getShopSetup(store);
    // Setup is a one-time operation, so retries cannot overwrite seller edits or orders.
    if (current.mode) {
      if (current.mode === input.mode) return current;
      throw new ApiError(409, 'SHOP_ALREADY_CONFIGURED', 'Use a separate empty database for another shop mode.');
    }
    if (input.mode === 'demo') {
      if (store.get('SELECT 1 FROM product LIMIT 1') || store.get('SELECT 1 FROM shop_order LIMIT 1') ||
          store.get('SELECT 1 FROM general_code LIMIT 1')) {
        throw new ApiError(409, 'SHOP_NOT_EMPTY', 'Demo requires an empty catalog without categories or orders. Choose Production to keep your data.');
      }
      for (const [code, label] of Object.entries(categories)) createCategory(store, { code, label });
      for (const product of catalog) createProduct(store, product);
      store.run("UPDATE company_setting SET default_currency = 'MYR', seller_whatsapp_phone = ?, updated_at = ? WHERE id = 1",
        DEMO_SELLER_WHATSAPP_PHONE, new Date().toISOString());
    }
    store.run('UPDATE shop_setup SET mode = ?, shop_name = ? WHERE id = 1', input.mode, shopName);
    return getShopSetup(store);
  });
}

// Deployment mode is independent of NODE_ENV: a public demo still uses secure cookies.
export function initializeShop(store, config) {
  if (config.shopMode === 'demo') setupShop(store, { mode: 'demo' });
}

export function shopObjectName(mode) {
  if (!['demo', 'manual'].includes(mode)) throw new Error('Unsupported shop mode.');
  return mode === 'demo' ? 'pet-shop-demo-v1' : 'shop';
}
