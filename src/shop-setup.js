import catalog from './public-demo-catalog.json' with { type: 'json' };
import { ApiError } from './http.js';
import { createProduct } from './products.js';
import { createCategory } from './settings.js';
import { boundedText, FieldError } from './validation.js';
import { shopIdOf } from './tenant.js';

const categories = { HOME: 'Home', STATIONERY: 'Stationery', KITCHEN: 'Kitchen', TRAVEL: 'Travel', TECH_ACCESSORIES: 'Tech Accessories', APPAREL: 'Apparel', PET_CARE: 'Pet Care' };

export function getShopSetup(store) {
  const row = store.get('SELECT mode, name FROM shop WHERE id = ?', shopIdOf(store));
  return { mode: row.mode, shopName: row.name };
}

// Writes the fictional starting catalog; callers run it inside a transaction.
function seedDemo(store) {
  store.run(`UPDATE company_setting SET default_currency = 'MYR', seller_whatsapp_phone = NULL,
    mobile_hide_bars_on_scroll = 0, updated_at = ? WHERE shop_id = ?`, new Date().toISOString(), shopIdOf(store));
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
    const shopId = shopIdOf(store);
    const ownOrders = '(SELECT id FROM shop_order WHERE shop_id = ?)';
    store.run(`DELETE FROM order_event WHERE order_id IN ${ownOrders}`, shopId);
    store.run(`DELETE FROM order_item WHERE delivery_id IN (SELECT id FROM delivery WHERE order_id IN ${ownOrders})`, shopId);
    store.run(`DELETE FROM delivery WHERE order_id IN ${ownOrders}`, shopId);
    for (const table of ['checkout_idempotency', 'shop_order', 'general_code']) store.run(`DELETE FROM ${table} WHERE shop_id = ?`, shopId);
    store.run('DELETE FROM product_gallery_image WHERE product_id IN (SELECT id FROM product WHERE shop_id = ?)', shopId);
    store.run('DELETE FROM product WHERE shop_id = ?', shopId);
    store.run('UPDATE order_sequence SET value = 0 WHERE shop_id = ?', shopId);
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
      const shopId = shopIdOf(store);
      if (store.get('SELECT 1 FROM product WHERE shop_id = ? LIMIT 1', shopId) || store.get('SELECT 1 FROM shop_order WHERE shop_id = ? LIMIT 1', shopId) ||
          store.get('SELECT 1 FROM general_code WHERE shop_id = ? LIMIT 1', shopId)) {
        throw new ApiError(409, 'SHOP_NOT_EMPTY', 'Demo requires an empty catalog without categories or orders. Choose Production to keep your data.');
      }
      seedDemo(store);
    }
    store.run('UPDATE shop SET mode = ?, name = ?, updated_at = ? WHERE id = ?', input.mode, shopName, new Date().toISOString(), shopIdOf(store));
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
