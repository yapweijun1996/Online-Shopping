import catalog from './public-demo-catalog.json' with { type: 'json' };
import { ApiError } from './http.js';
import { createProduct } from './products.js';
import { createCategory } from './settings.js';
import { boundedText, FieldError } from './validation.js';

const categories = { HOME: 'Home', STATIONERY: 'Stationery', KITCHEN: 'Kitchen', TRAVEL: 'Travel', TECH_ACCESSORIES: 'Tech Accessories', APPAREL: 'Apparel', PET_CARE: 'Pet Care' };

export function getShopSetup(store) {
  const row = store.get('SELECT mode, shop_name FROM shop_setup WHERE id = 1');
  return { mode: row.mode, shopName: row.shop_name };
}

// Writes the fictional starting catalog; callers run it inside a transaction.
function seedDemo(store) {
  store.run(`UPDATE company_setting SET default_currency = 'MYR', seller_whatsapp_phone = NULL,
    mobile_hide_bars_on_scroll = 0, updated_at = ? WHERE id = 1`, new Date().toISOString());
  for (const [code, label] of Object.entries(categories)) createCategory(store, { code, label });
  for (const product of catalog) createProduct(store, product);
}

/*
 * Restores a Demo shop to its seeded state: orders, products, galleries, categories and
 * company settings are replaced; the admin account, sessions and rate limits are kept.
 * All-or-nothing, so a failure leaves the previous data in place.
 */
export function resetDemo(store) {
  return store.transaction(() => {
    if (getShopSetup(store).mode !== 'demo') {
      throw new ApiError(409, 'NOT_DEMO', 'Only a Demo shop can be reset.');
    }
    for (const table of ['order_event', 'order_item', 'delivery', 'checkout_idempotency', 'shop_order',
      'product_gallery_image', 'product', 'general_code']) store.run(`DELETE FROM ${table}`);
    store.run('UPDATE order_sequence SET value = 0 WHERE id = 1');
    seedDemo(store);
    return { reset: true, products: catalog.length };
  });
}

export function setupShop(store, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['mode', 'shopName'].includes(key)) ||
      !['demo', 'production'].includes(input.mode)) {
    throw new FieldError('mode', 'Choose Demo or Production.');
  }
  const shopName = input.mode === 'demo' ? 'Demo General Store' : boundedText(input.shopName, 'shopName', 80);
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
      seedDemo(store);
    }
    store.run('UPDATE shop_setup SET mode = ?, shop_name = ? WHERE id = 1', input.mode, shopName);
    return getShopSetup(store);
  });
}

// Deployment mode is independent of NODE_ENV: a public demo still uses secure cookies.
export function initializeShop(store, config) {
  if (['demo', 'public-demo'].includes(config.shopMode)) setupShop(store, { mode: 'demo' });
}

export function shopObjectName(mode, revision = 'v1') {
  if (!['demo', 'manual', 'public-demo'].includes(mode)) throw new Error('Unsupported shop mode.');
  if (mode === 'public-demo') {
    if (typeof revision !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(revision)) throw new Error('Invalid public demo revision.');
    return `public-general-demo-${revision}`;
  }
  return mode === 'demo' ? 'pet-shop-demo-v1' : 'shop';
}
