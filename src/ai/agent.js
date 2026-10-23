import { reservedQuantitySql } from '../stock-reservation.js';
import { createTools } from './tools.js';
import { aiError } from './provider.js';
import { buildMessages, buildSystemPrompt, clean } from './prompt.js';
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = maxLength => ({ type: 'string', maxLength });
const itemSchema = object({ productId: text(100), quantity: { type: 'integer', minimum: 1, maximum: 99 } });
const orderSchema = object({ items: { type: 'array', minItems: 1, maxItems: 100, items: itemSchema }, recipientName: text(80), address: text(240), notes: text(200) });
export const submitSuggestion = { name: 'submit_suggestion', strict: true, description: 'Finish with a suggestion for human review; never sends or orders. Use empty strings for unknown order fields.', input_schema: object({ reply: text(1000), handoff: { type: 'boolean' }, handoffReason: { enum: ['COMPLAINT', 'REFUND', 'UNKNOWN', 'SENSITIVE', 'OTHER', null] }, order: { anyOf: [{ type: 'null' }, orderSchema] } }) };
function valid(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(s => valid(value, s));
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string' && value.isWellFormed() && value.length <= schema.maxLength;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems && value.every(v => valid(v, schema.items));
  return value && typeof value === 'object' && !Array.isArray(value) && schema.required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => Object.hasOwn(schema.properties, k) && valid(value[k], schema.properties[k]));
}
export async function suggestReply({ store, provider, thread, history, settings, now = Date.now, secretBox, qr, session }) {
  const tools = createTools({ store, secretBox, thread, now, qr, session });
  const shop = await tools.run('get_shop_info', {});
  const system = buildSystemPrompt({ shopName: shop.shopName, tone: settings.tone });
  const messages = buildMessages(history, thread), usage = { inputTokens: 0, outputTokens: 0 };
  const deadline = AbortSignal.timeout(45000);
  try {
    for (let call = 0; call < 4; call++) {
      const response = await provider.complete({ system, messages, tools: [...tools.definitions, submitSuggestion], maxTokens: 2000, signal: deadline });
      usage.inputTokens += response.usage.input_tokens; usage.outputTokens += response.usage.output_tokens;
      const uses = response.content.filter(b => b.type === 'tool_use');
      if (!uses.length || uses.length > 16) throw aiError('AI_BAD_RESPONSE');
      const submit = uses.find(b => b.name === 'submit_suggestion');
      if (submit) {
        const value = submit.input;
        if (uses.length !== 1 || !valid(value, submitSuggestion.input_schema) || value.handoff !== (value.handoffReason !== null)) throw aiError('AI_BAD_RESPONSE');
        let orderDraft = null;
        if (value.order) {
          orderDraft = { items: [], totalMinor: 0, currency: shop.defaultCurrency, recipientName: clean(value.order.recipientName, 80), address: clean(value.order.address, 240), notes: clean(value.order.notes, 200), missing: [] };
          const quantities = new Map();
          for (const item of value.order.items) quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
          for (const [productId, quantity] of quantities) {
            const item = { productId, quantity };
            const p = await tools.run('get_product', { productId: item.productId });
            if (!p.id) { orderDraft.missing.push(`product:${clean(item.productId, 100)}:unavailable`); continue; }
            if (p.currency !== orderDraft.currency) { orderDraft.missing.push(`product:${clean(item.productId, 100)}:currency`); continue; }
            const inventory = await store.get(`SELECT p.stock_quantity, ${reservedQuantitySql('p.id', now())} AS held FROM product p WHERE p.id = ?`, p.id);
            if (!inventory) { orderDraft.missing.push(`product:${clean(item.productId, 100)}:unavailable`); continue; }
            if (inventory.stock_quantity !== null && item.quantity > inventory.stock_quantity - Number(inventory.held)) { orderDraft.missing.push(`product:${clean(item.productId, 100)}:stock`); continue; }
            orderDraft.items.push({ productId: p.id, name: p.name, quantity: item.quantity, unitPriceMinor: p.priceMinor, currency: p.currency });
            orderDraft.totalMinor += p.priceMinor * item.quantity;
            if (!Number.isSafeInteger(orderDraft.totalMinor)) throw aiError('AI_BAD_RESPONSE');
          }
          for (const field of ['address', 'recipientName']) if (!orderDraft[field].trim()) orderDraft.missing.push(field);
        }
        return { reply: clean(value.reply, 1000), handoff: value.handoff, handoffReason: value.handoffReason, orderDraft, usage };
      }
      messages.push({ role: 'assistant', content: response.content });
      const content = [];
      for (const use of uses) content.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(await tools.run(use.name, use.input)) });
      messages.push({ role: 'user', content });
    }
    throw aiError('AI_BAD_RESPONSE');
  } catch (error) {
    error.usage = { inputTokens: usage.inputTokens + (error.usage?.inputTokens ?? 0), outputTokens: usage.outputTokens + (error.usage?.outputTokens ?? 0) };
    throw error;
  }
}
