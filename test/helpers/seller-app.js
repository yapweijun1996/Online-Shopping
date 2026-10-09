// Shared fixture for seller API tests: a real app on a temporary SQLite file, one product, fictional buyers.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server.js';
import { createProduct } from '../../src/products.js';
import { createCategory } from '../../src/settings.js';

export async function sellerFixture(extraConfig = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'online-shopping-seller-'));
  const config = { username: 'review_owner', password: 'LocalReviewPass123!', dbPath: path.join(directory, 'private.db'),
    production: false, publicOrigin: null, ...extraConfig };
  const app = await createApp(config);
  await createCategory(app.database, { code: 'EXAMPLES', label: 'Examples' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const product = await createProduct(app.database, { sku: 'SELLER-ITEM', name: 'Example item', description: 'Fictional item',
    category: 'EXAMPLES', priceMinor: 1250, currency: 'MYR', active: true });
  async function request(method, url, body, headers = {}) {
    const response = await fetch(`${origin}${url}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { response, data };
  }
  return {
    app, config, directory, origin, product, request,
    async submit({ buyerName = 'Example Buyer', quantity = 2 } = {}) {
      return request('POST', '/api/v1/orders', {
        buyer: { fullName: buyerName, whatsappPhone: '+6581234567', email: 'example@example.invalid' }, whatsappOrderContactOptIn: true, locale: 'en',
        deliveries: [{ recipient: { fullName: 'Example Recipient', phone: '+60123456789' },
          address: { line1: 'Example Street', line2: 'Unit 1', city: 'Example City', postcode: '50000', country: 'MY' },
          items: [{ productId: product.id, quantity, expectedPriceMinor: product.priceMinor, expectedCurrency: product.currency }] }],
      }, { origin, 'idempotency-key': randomUUID() });
    },
    async login(username = config.username, password = config.password) {
      const result = await request('POST', '/api/v1/seller/session', { username, password }, { origin });
      assert.equal(result.response.status, 200);
      const cookie = result.response.headers.get('set-cookie').split(';')[0];
      return { cookie, csrf: result.data.csrfToken, headers: { origin, cookie, 'x-csrf-token': result.data.csrfToken }, session: result.data };
    },
    async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
