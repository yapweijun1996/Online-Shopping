import { createHmac } from 'node:crypto';
import { openDatabase } from '../../worker-runtime/db.js';
import { createCategory } from '../../worker-runtime/settings.js';
import { createProduct } from '../../worker-runtime/products.js';
import { createOrder } from '../../worker-runtime/orders.js';
import { createSyntheticIntegrationLedger } from '../../src/integration-ledger.js';
import { createSyntheticMessagingAuthority } from '../../src/integration-consent.js';
import { createOfflineMetaIngress } from '../../src/integration-ingress.js';
import { buildTrustedWhatsAppMessageRequest } from '../../src/integration-requests.js';
import { createSyntheticProviderAdapter } from '../../src/integration-adapters.js';

export const syntheticKey = 'synthetic-meta-app-key-for-fixtures-only';
export const syntheticApp = 'synthetic-meta-app';
export const trustBinding = (provider = 'WHATSAPP_CLOUD', company = 'alpha') => ({ companyId: `synthetic-${company}`,
  connectionId: provider.toLowerCase(), accountId: `synthetic-${company}-${provider.toLowerCase().replaceAll('_','-')}`, provider, environment: 'SYNTHETIC' });
export const metaPayload = (value, { wabaId = '000000000000001', phoneId = '000000000000011' } = {}) => ({ object: 'whatsapp_business_account',
  entry: [{ id: wabaId, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId }, ...value } }] }] });
export function signed(payload, key = syntheticKey) {
  const rawBody = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return { rawBody, signature: `sha256=${createHmac('sha256', key).update(rawBody).digest('hex')}` };
}
export const inboundText = (time, id = 'wamid.SYNTHETIC_INBOUND', from = '60123456789', body = 'Fictional text') => ({ from, id, timestamp: String(Math.floor(time / 1000)), type: 'text', text: { body } });
export const statusEvent = (time, status, id = 'wamid.SYNTHETIC001') => ({ id, timestamp: String(Math.floor(time / 1000)), status, recipient_id: '60123456789' });

export function trustFixture(t, { wrap = store => store, file = ':memory:', openWindow = false } = {}) {
  const store = openDatabase(file); let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } }; t.after(close);
  let time = Math.ceil((Date.now() + 1000) / 1000) * 1000;
  const storage = wrap(store), ledger = createSyntheticIntegrationLedger(storage, { mode: 'SYNTHETIC', now: () => time });
  for (const company of ['alpha','beta']) {
    ledger.addCompany(`synthetic-${company}`);
    for (const provider of ['NINJA_VAN','WHATSAPP_CLOUD']) {
      const b = trustBinding(provider, company); ledger.forCompany(b.companyId).addConnection({ id: b.connectionId, provider, environment: b.environment, accountId: b.accountId });
    }
  }
  const authority = createSyntheticMessagingAuthority(storage, { mode: 'SYNTHETIC', now: () => time });
  for (const [index, company] of ['alpha','beta'].entries()) authority.registerPhone(trustBinding('WHATSAPP_CLOUD', company),
    { appId: syntheticApp, wabaId: `00000000000000${index + 1}`, phoneNumberId: `00000000000001${index + 1}` });
  createCategory(store, { code: 'TRUST_FIXTURE', label: 'Synthetic Trust Category' });
  const product = createProduct(store, { sku: 'trust-fixture', name: 'Fictional Product', description: 'Synthetic consent tests only', category: 'TRUST_FIXTURE', priceMinor: 1234, currency: 'MYR', active: true });
  let sequence = 0;
  function makeOrder({ phone = '+60123456789', optIn = true } = {}) {
    createOrder(store, `synthetic-trust-order-${++sequence}`, { buyer: { fullName: 'Fictional Buyer', whatsappPhone: phone, email: 'fictional@example.invalid' }, whatsappOrderContactOptIn: optIn,
      locale: 'en', deliveries: [{ recipient: { fullName: 'Different Fictional Recipient', phone: '+60129876543' }, address: { line1: 'Synthetic Street', postcode: '47810', country: 'MY' },
        items: [{ productId: product.id, quantity: 1, expectedPriceMinor: 1234, expectedCurrency: 'MYR' }] }] });
    return store.get('SELECT id FROM shop_order ORDER BY rowid DESC LIMIT 1').id;
  }
  const orderId = makeOrder(), b = trustBinding(); authority.registerOrder(b, orderId);
  const ingress = createOfflineMetaIngress({ store: storage, authority, mode: 'SYNTHETIC', appId: syntheticApp, appSecret: syntheticKey, now: () => time });
  const open = () => ingress.receive(signed(metaPayload({ messages: [inboundText(time)] })));
  if (openWindow) open();
  return { store, storage, ledger, authority, ingress, b, orderId, makeOrder, close, openWindow: open, now: () => time, advance: value => { time += value; },
    prepare(input = { recipient: '+60123456789', kind: 'TEXT', body: 'Synthetic order update' }, ref = { orderId, purpose: 'ORDER_CONTACT' }, bound = b) {
      const proof = authority.resolve(bound, { ...ref, recipient: input.recipient, kind: input.kind, template: input.template, language: input.language, parameterCount: input.parameters?.length });
      return buildTrustedWhatsAppMessageRequest(bound, input, proof);
    },
    adapter(transport, bound = trustBinding('NINJA_VAN')) { return createSyntheticProviderAdapter({ ledger, ...bound, transport, messagingAuthority: authority, now: () => time }); },
  };
}
