import { reservedQuantitySql } from '../stock-reservation.js';
import { getCompanySettings } from '../settings.js';
import { getShopSetup } from '../shop-setup.js';
import { createWhatsAppQrStore } from '../whatsapp-qr/store.js';
import { orderMatchesThread } from '../whatsapp-qr/order-match.js';
import { aiError } from './provider.js';
import { clean } from './prompt.js';
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export function createTools({ store, secretBox, thread, now = Date.now, qr = createWhatsAppQrStore({ store, secretBox }), session }) {
  const columns = `p.id,p.name,p.sku,p.description,p.price_minor,p.currency,p.stock_quantity,p.variant_group,p.variant_label,c.label AS category,${reservedQuantitySql('p.id', typeof now === 'function' ? now() : now)} AS held`;
  const from = 'FROM product p JOIN general_code c ON c.code = p.category AND c.type = \'PRODUCT_CATEGORY\' WHERE p.active = 1';
  const present = p => ({ id: p.id, name: clean(p.name, 200), sku: clean(p.sku, 100), priceMinor: p.price_minor, currency: p.currency, stock: p.stock_quantity === null ? 'in stock' : p.stock_quantity - Number(p.held) <= 0 ? 'out of stock' : p.stock_quantity - Number(p.held) <= 5 ? 'low stock' : 'in stock', category: clean(p.category, 100) });
  const definitions = [
    ['search_products', 'Search active shop products.', { query: { type: 'string', maxLength: 80 } }],
    ['get_product', 'Read product and active variants.', { productId: { type: 'string' } }],
    ['get_shop_info', 'Read shop policies and business notes.', {}],
    ['lookup_order', 'Read status and item summary for this chat only.', { orderNo: { type: 'string' } }]
  ].map(([name, description, properties]) => ({ name, strict: true, description, input_schema: schema(properties) }));
  return { definitions, async run(name, input) {
    const definition = definitions.find(d => d.name === name);
    if (!definition || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(definition.input_schema.properties, k)) || definition.input_schema.required.some(k => typeof input[k] !== 'string')) throw aiError('AI_BAD_RESPONSE');
    if (name === 'search_products') {
      const query = `%${clean(input.query, 80).replace(/[\\%_]/g, '\\$&')}%`;
      return (await store.all(`SELECT ${columns} ${from} AND (LOWER(p.name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(p.sku) LIKE LOWER(?) ESCAPE '\\' OR LOWER(p.description) LIKE LOWER(?) ESCAPE '\\') ORDER BY p.id LIMIT 8`, query, query, query)).map(present);
    }
    if (name === 'get_product') {
      const p = await store.get(`SELECT ${columns} ${from} AND p.id = ?`, input.productId);
      if (!p) return { found: false };
      const variants = p.variant_group ? await store.all(`SELECT ${columns} ${from} AND p.variant_group = ? ORDER BY p.id LIMIT 100`, p.variant_group) : [];
      return { ...present(p), description: clean(p.description, 800), variants: variants.map(v => ({ ...present(v), label: clean(v.variant_label, 100) })) };
    }
    if (name === 'get_shop_info') {
      const s = await getCompanySettings(store), a = await store.get('SELECT business_notes,tone FROM ai_setting WHERE id = 1');
      return { shopName: (await getShopSetup(store)).shopName, defaultCurrency: s.defaultCurrency, availabilityText: s.availabilityText, shippingText: s.shippingText, returnsText: s.returnsText, business_notes: a.business_notes, tone: a.tone };
    }
    const order = await store.get('SELECT id,status,buyer_phone,contact_erased_at FROM shop_order WHERE order_no = ?', clean(input.orderNo, 80));
    const currentSession = session ?? await store.get('SELECT * FROM whatsapp_qr_session WHERE id = 1');
    if (!await orderMatchesThread({ store, qr, session: currentSession, thread, order })) return { found: false };
    const items = await store.all('SELECT i.name_snapshot AS name,i.quantity FROM order_item i JOIN delivery d ON d.id = i.delivery_id WHERE d.order_id = ? ORDER BY i.id LIMIT 100', order.id);
    return { found: true, status: order.status, items: items.map(row => ({ name: clean(row.name, 200), quantity: row.quantity })) };
  } };
}
