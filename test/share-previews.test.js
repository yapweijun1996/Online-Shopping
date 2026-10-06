import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/db.js';
import { setupShop } from '../src/shop-setup.js';
import { createApi } from '../src/app.js';
import { createCategory } from '../src/settings.js';
import { createProduct, updateProduct } from '../src/products.js';
import { escapeHtml, isCrawler, previewPage, summary } from '../src/share.js';

const FACEBOOK = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const WHATSAPP = 'WhatsApp/2.23.20.0 A';
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const png = 'data:image/png;base64,' + readFileSync(new URL('../public/shop/icons/icon-192.png', import.meta.url)).toString('base64');

async function fixture(t) {
  const store = await openDatabase(':memory:'); t.after(async () => await store.close());
  await setupShop(store, { mode: 'production', shopName: 'Synthetic <Shop> & "Co"' });
  await createCategory(store, { code: 'HOME', label: 'Home' });
  const api = await createApi({ store, config: { shopMode: 'manual', production: false, publicOrigin: 'https://shop.example.test' } });
  const get = (path, agent) => api(new Request('https://shop.example.test' + path, { headers: { 'user-agent': agent } }), { clientAddress: 'synthetic-client' });
  return { store, get };
}
const product = (extra = {}) => ({ sku: 'SH-1', name: 'Desk lamp', description: 'A warm lamp.', category: 'HOME', priceMinor: 12990, currency: 'MYR', active: true, imageDataUrl: png, ...extra });

test('link-preview crawlers are recognised, browsers are not', () => {
  for (const agent of [FACEBOOK, WHATSAPP, 'Twitterbot/1.0', 'TelegramBot (like TwitterBot)', 'Slackbot-LinkExpanding 1.0', 'Mozilla/5.0 (compatible; Discordbot/2.0)', 'meta-externalagent/1.1']) assert.equal(isCrawler(agent), true, agent);
  for (const agent of [BROWSER, 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36', '', null, undefined]) assert.equal(isCrawler(agent), false, String(agent));
});

test('preview tags are escaped and complete', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(summary('  one \n two   three  ', 100), 'one two three');
  assert.equal(summary('x'.repeat(300), 50).length, 50);
  const page = previewPage({ title: 'A "quoted" <title>', description: 'd', image: 'https://e.test/i.jpg', imageAlt: 'alt', url: 'https://e.test/p/1', siteName: 'S', type: 'product', price: { amount: '12.99', currency: 'MYR' }, enter: '/shop/#product/1' });
  assert.match(page, /<meta property="og:title" content="A &quot;quoted&quot; &lt;title&gt;">/);
  for (const name of ['og:type', 'og:site_name', 'og:description', 'og:url', 'og:image', 'og:image:alt', 'product:price:amount', 'product:price:currency']) assert.match(page, new RegExp(`property="${name}"`));
  assert.match(page, /name="twitter:card" content="summary_large_image"/);
  assert.doesNotMatch(previewPage({ title: 't', description: 'd', url: 'u', siteName: 's', enter: '/' }), /og:image|summary_large_image/);
  assert.doesNotMatch(page, /<script/i);
});

test('a product link gives crawlers a preview and sends browsers into the shop', async t => {
  const { store, get } = await fixture(t);
  const lamp = await createProduct(store, product({ name: 'Desk <b>lamp</b> "Pro"', description: 'A warm lamp. <script>alert(1)</script>' }));
  for (const agent of [FACEBOOK, WHATSAPP]) {
    const response = await get(`/p/${lamp.id}`, agent);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    const html = await response.text();
    assert.match(html, /property="og:title" content="Desk &lt;b&gt;lamp&lt;\/b&gt; &quot;Pro&quot;"/);
    assert.match(html, /property="og:url" content="https:\/\/shop\.example\.test\/p\//);
    assert.match(html, new RegExp(`property="og:image" content="https://shop\\.example\\.test/api/v1/products/${lamp.id}/image\\?v=`));
    assert.match(html, /property="og:description" content="MYR 129\.90 · A warm lamp\. &lt;script&gt;/);
    assert.match(html, /property="product:price:amount" content="129\.90"/);
    assert.match(html, /property="og:site_name" content="Synthetic &lt;Shop&gt; &amp; &quot;Co&quot;"/);
    assert.doesNotMatch(html, /<script>alert/);
  }
  const browser = await get(`/p/${lamp.id}`, BROWSER);
  assert.equal(browser.status, 302);
  assert.equal(browser.headers.get('location'), `/shop/#product/${lamp.id}`);
});

test('unknown, malformed and inactive products give no preview', async t => {
  const { store, get } = await fixture(t);
  const lamp = await createProduct(store, product());
  assert.equal((await get('/p/00000000-0000-4000-8000-000000000000', FACEBOOK)).status, 404);
  assert.equal((await get('/p/not-a-uuid', FACEBOOK)).status, 404);
  await updateProduct(store, lamp.id, { active: false });
  assert.equal((await get(`/p/${lamp.id}`, FACEBOOK)).status, 404);
  assert.equal((await get(`/p/${lamp.id}`, BROWSER)).status, 404);
});

test('shop home preview carries the shop name and the share image', async t => {
  const { get } = await fixture(t);
  const html = await (await get('/s/home', FACEBOOK)).text();
  assert.match(html, /property="og:title" content="Synthetic &lt;Shop&gt; &amp; &quot;Co&quot;"/);
  assert.match(html, /property="og:image" content="https:\/\/shop\.example\.test\/shop\/share\.png"/);
  assert.match(html, /property="og:url" content="https:\/\/shop\.example\.test\/shop\/"/);
});

test('Caddy sends share links and crawler home requests to the backend and keeps /s private', () => {
  for (const file of ['../deploy/Caddyfile.production', '../deploy/Caddyfile']) {
    const caddy = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(caddy, /@share path \/p\/\*/, file);
    assert.match(caddy, /rewrite \* \/s\/home/, file);
    assert.match(caddy, /header_regexp ua User-Agent \(\?i\)\([^)]*facebookexternalhit[^)]*whatsapp/, file);
  }
  const production = readFileSync(new URL('../deploy/Caddyfile.production', import.meta.url), 'utf8');
  assert.equal((production.match(/\/s\/\*/g) || []).length, 2, 'blocked on the shop and the seller host');
});

test('the share image is a 1200x630 PNG small enough for WhatsApp', () => {
  const bytes = readFileSync(new URL('../public/shop/share.png', import.meta.url));
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), 1200); assert.equal(bytes.readUInt32BE(20), 630);
  assert.ok(bytes.length < 300 * 1024, `${bytes.length} bytes`);
});
