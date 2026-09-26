// Smoke-tests a local `wrangler dev` Worker end to end with synthetic data.
// Usage: npm run worker:dev, then npm run worker:smoke -- [origin] [--rate-limit]
// --rate-limit also checks login limiting and locks seller login for 15 minutes.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const origin = args.find((arg) => !arg.startsWith('--')) || 'http://127.0.0.1:8787';
const parsedOrigin = new URL(origin);
if (parsedOrigin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname) ||
    parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password) {
  throw new Error('Worker smoke tests are limited to a local HTTP origin.');
}
const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD;
if (!username || !password) throw new Error('Set ADMIN_USERNAME and ADMIN_PASSWORD in ignored .dev.vars.');
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); };
const req = async (method, path, body, headers = {}) => {
  const r = await fetch(origin + path, { method, redirect: 'manual', headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
};
// static assets
let x = await req('GET', '/'); check('/ redirects to /shop/', x.r.status === 302 && x.r.headers.get('location').endsWith('/shop/'));
x = await req('GET', '/shop/'); check('/shop/ served with CSP', x.r.status === 200 && /script-src 'self'/.test(x.r.headers.get('content-security-policy') || ''));
x = await req('GET', '/seller/'); check('/seller/ served', x.r.status === 200);
x = await req('GET', '/shop/app.js'); check('js content type', /javascript/.test(x.r.headers.get('content-type')));
x = await req('GET', '/_headers'); check('_headers not exposed', x.r.status === 404, String(x.r.status));
x = await req('GET', '/api/v1/nope'); check('unknown API 404 JSON', x.r.status === 404 && x.data.error?.code === 'NOT_FOUND');
// session
x = await req('POST', '/api/v1/seller/session', { username, password }, { origin: 'https://evil.example' }); check('login wrong origin 403', x.r.status === 403);
x = await req('POST', '/api/v1/seller/session', { username, password });
check('login ok', x.r.status === 200 && !!x.data.csrfToken);
const cookie = x.r.headers.get('set-cookie').split(';')[0], csrf = x.data.csrfToken;
check('cookie flags', /HttpOnly/.test(x.r.headers.get('set-cookie')) && /SameSite=Strict/.test(x.r.headers.get('set-cookie')));
const auth = { cookie, 'x-csrf-token': csrf };
x = await req('GET', '/api/v1/seller/session', null, { cookie }); check('session read', x.r.status === 200);
// categories and company settings
x = await req('POST', '/api/v1/seller/categories', { code: 'SMOKE', label: 'Smoke tests' }, auth);
check('category create (or already present)', x.r.status === 201 || x.data.error?.code === 'DUPLICATE_CATEGORY', String(x.r.status));
x = await req('GET', '/api/v1/seller/categories', null, { cookie });
check('category listed', x.data.items?.some((item) => item.code === 'SMOKE' && item.active));
x = await req('GET', '/api/v1/seller/company-settings', null, { cookie });
check('company settings', ['MYR', 'SGD'].includes(x.data.defaultCurrency));
x = await req('POST', '/api/v1/seller/products', { sku: `NOCAT-${Date.now()}`, name: 'n', description: 'd', category: 'MISSING', priceMinor: 1, currency: 'MYR', active: true }, auth);
check('unknown category rejected', x.r.status === 400 && x.data.error?.field === 'category', JSON.stringify(x.data));
// products + images
const png = readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url));
const sku = `SMOKE-${Date.now()}`;
x = await req('POST', '/api/v1/seller/products', { sku, name: 'Smoke mug', description: 'd', category: 'SMOKE', priceMinor: 1000, currency: 'MYR', active: true, imageDataUrl: `data:image/png;base64,${png.toString('base64')}` }, { cookie });
check('create without CSRF 403', x.r.status === 403);
x = await req('POST', '/api/v1/seller/products', { sku, name: 'Smoke mug', description: 'd', category: 'SMOKE', priceMinor: 1000, currency: 'MYR', active: true, imageDataUrl: `data:image/png;base64,${png.toString('base64')}` }, auth);
check('create product 201', x.r.status === 201, JSON.stringify(x.data).slice(0, 120));
const product = x.data;
x = await req('POST', '/api/v1/seller/products', { sku, name: 'Dup', description: 'd', category: 'SMOKE', priceMinor: 1, currency: 'MYR', active: true }, auth);
check('duplicate SKU 409', x.r.status === 409 && x.data.error?.code === 'DUPLICATE_SKU', JSON.stringify(x.data));
x = await req('GET', '/api/v1/products');
const listed = x.data.items.find((i) => i.id === product.id);
check('public list has versioned imageUrl', /\?v=[0-9a-z]+$/.test(listed?.imageUrl || ''));
let img = await fetch(origin + listed.imageUrl);
const bytes = Buffer.from(await img.arrayBuffer());
check('versioned image cacheable + bytes intact', img.headers.get('cache-control') === 'public, max-age=31536000, immutable' && bytes.equals(png), `${img.headers.get('cache-control')} ${bytes.length}/${png.length}`);
img = await fetch(`${origin}/api/v1/products/${product.id}/image`); check('unversioned image no-store', img.headers.get('cache-control') === 'no-store');
img = await fetch(`${origin}/api/v1/seller/products/${product.id}/image`, { headers: { cookie } }); check('seller image 200', img.status === 200 && Buffer.from(await img.arrayBuffer()).equals(png));
x = await req('POST', '/api/v1/seller/products', { sku: sku + 'X', name: 'Big', description: 'd', category: 'SMOKE', priceMinor: 1, currency: 'MYR', active: true, imageDataUrl: 'data:image/png;base64,' + 'A'.repeat(800000) }, auth);
check('oversized body 413', x.r.status === 413, String(x.r.status));
// checkout
const order = (expected) => ({ buyer: { fullName: 'Smoke Buyer', whatsappPhone: '+60123456789', email: null }, whatsappOrderContactOptIn: true, locale: 'en',
  deliveries: [{ recipient: { fullName: 'Smoke Recipient', phone: '+6581234567' }, address: { line1: 'Example Street 1', postcode: '47810', country: 'MY' }, items: [{ productId: product.id, quantity: 2, expectedPriceMinor: expected, expectedCurrency: 'MYR' }] }] });
x = await req('PATCH', `/api/v1/seller/products/${product.id}`, { priceMinor: 1500 }, auth); check('price update', x.r.status === 200 && x.data.priceMinor === 1500);
const key = `smoke-intent-${Date.now()}`;
x = await req('POST', '/api/v1/orders', order(1000), { 'idempotency-key': key + 'a' });
check('stale price -> PRICE_CHANGED', x.r.status === 409 && x.data.error?.code === 'PRICE_CHANGED');
x = await req('POST', '/api/v1/orders', order(1500), { 'idempotency-key': key });
check('checkout 201', x.r.status === 201 && x.data.totalMinor === 3000, JSON.stringify(x.data));
const receipt = x.data;
x = await req('POST', '/api/v1/orders', order(1500), { 'idempotency-key': key });
check('idempotent replay 200 same receipt', x.r.status === 200 && x.data.orderNo === receipt.orderNo);
// seller orders
x = await req('GET', `/api/v1/seller/orders?search=${receipt.orderNo}`, null, { cookie });
const summary = x.data.items?.[0]; check('seller finds order', Boolean(summary) && summary.orderNo === receipt.orderNo);
x = await req('GET', `/api/v1/seller/orders/${summary.id}`, null, { cookie });
check('order detail snapshot', x.data.deliveries?.[0]?.items?.[0]?.priceMinor === 1500 && x.data.events?.length === 1);
x = await req('POST', `/api/v1/seller/orders/${summary.id}/confirm`, { expectedRevision: 1 }, auth); check('confirm', x.r.status === 200 && x.data.status === 'CONFIRMED');
x = await req('POST', `/api/v1/seller/orders/${summary.id}/confirm`, { expectedRevision: 1 }, auth); check('stale confirm 409', x.r.status === 409 && x.data.error?.code === 'STALE_REVISION');
x = await req('DELETE', `/api/v1/seller/orders/${summary.id}`, null, auth); check('no order deletion', x.r.status === 404);
x = await req('DELETE', '/api/v1/seller/session', null, auth); check('logout', x.r.status === 200);
x = await req('GET', '/api/v1/seller/session', null, { cookie }); check('session gone', x.r.status === 401);
if (args.includes('--rate-limit')) {
  const results = await Promise.all(Array.from({ length: 12 }, () => req('POST', '/api/v1/seller/session', { username, password: 'wrong-password-123' })));
  const c = {}; for (const { r } of results) c[r.status] = (c[r.status] || 0) + 1;
  check('parallel wrong logins capped at 5', c[401] === 5 && c[429] === 7, JSON.stringify(c));
  x = await req('POST', '/api/v1/seller/session', { username, password }); check('correct login locked out', x.r.status === 429);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
