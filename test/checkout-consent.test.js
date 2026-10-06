import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('WhatsApp order-contact consent is checked by default and re-checked when it applies', () => {
  const html = readFileSync(new URL('../public/shop/index.html', import.meta.url), 'utf8');
  const input = html.match(/<input[^>]*id="whatsapp-opt-in"[^>]*>/)?.[0];
  assert.ok(input, 'consent checkbox exists');
  assert.match(input, /\brequired\b/);
  assert.match(input, /\bchecked\b/);
  const script = readFileSync(new URL('../public/shop/checkout.js', import.meta.url), 'utf8');
  assert.match(script, /consent\.checked = needsConsent;/);
});
