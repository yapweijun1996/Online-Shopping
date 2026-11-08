import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProductDetail } from '../public/shared/product-detail.js';
import { sellerFixture } from './helpers/seller-app.js';
import { createProduct } from '../src/products.js';
import { deflateSync } from 'node:zlib';

function fixtureImage(width = 320, height = 600) {
  const crc = data => { let result = 0xffffffff; for (const value of data) { result ^= value; for (let i = 0; i < 8; i++) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0); } return (result ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), check = Buffer.alloc(4); size.writeUInt32BE(data.length); check.writeUInt32BE(crc(body)); return Buffer.concat([size, body, check]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); row[0] = 0;
    for (let x = 0; x < width; x++) { const inside = x > width * .22 && x < width * .78 && y > height * .15 && y < height * .85; row.set(inside ? [47, 95, 87] : [235, 241, 235], 1 + x * 3); }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// Minimal DOM contract: a write to HTML fails, and all content must be built as text/nodes.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this._text = ''; }
  set innerHTML(_) { assert.fail('Rich product content must never be parsed as HTML.'); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  addEventListener(type, handler) { this.events[type] = handler; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}
const ownerDocument = { location: { pathname: '/shop/' }, createElement: tag => new Element(tag) };
const productId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-000000000002';
const src = `/api/v1/products/${productId}/detail/images/${assetId}`;
const asset = { id: assetId, src, width: 640, height: 1200 };
const image = { type: 'image', assetId, alt: 'Product back view', caption: 'Back panel' };
const render = (blocks, assets = [asset], options = {}) => renderProductDetail({ version: 1, blocks }, assets, { ownerDocument, ...options });

test('Rich details build inert headings, text, lists, specifications and dimensional lazy images', () => {
  const malicious = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const result = render([
    { type: 'heading', text: malicious }, { type: 'paragraph', text: malicious, bold: true },
    { type: 'list', items: [malicious, 'Two'] }, { type: 'specs', rows: [{ label: malicious, value: 'Steel' }] }, image,
  ]);
  assert.deepEqual(result.children.map(child => child.tagName), ['h3', 'p', 'ul', 'dl', 'figure']);
  assert.equal(result.children[0].textContent, malicious);
  assert.equal(result.children[1].children[0].tagName, 'strong');
  assert.equal(result.descendants().filter(child => child.tagName === 'img').length, 1);
  const photo = result.children[4].children[0];
  assert.equal(photo.src, src); assert.equal(photo.alt, image.alt);
  assert.equal(photo.width, 640); assert.equal(photo.height, 1200);
  assert.equal(photo.loading, 'lazy'); assert.equal(photo.decoding, 'async');
});

test('Unknown documents and absent, malformed or foreign assets keep the short description fallback', () => {
  for (const invalid of [undefined, { version: 2, blocks: [image] }, { version: 1, blocks: [{ type: 'html', html: '<script>x</script>' }] }]) {
    const result = renderProductDetail(invalid, [asset], { ownerDocument, fallbackText: 'Existing description' });
    assert.equal(result.children[0].className, 'detail-description');
    assert.equal(result.textContent, 'Existing description');
  }
  const rejected = [
    [], [{ ...asset, src: '' }], [{ ...asset, src: `https://evil.invalid${src}` }],
    [{ ...asset, src: `//evil.invalid${src}` }], [{ ...asset, src: `javascript:alert(1)` }],
    [{ ...asset, src: `/another${src}` }], [{ ...asset, src: `${src}?external=1` }],
    [{ ...asset, src: src.replace(assetId, productId) }], [{ ...asset, width: 0 }],
    [{ ...asset, width: 32768, height: 32768 }], [{ ...asset, id: 17 }],
  ];
  for (const assets of rejected) {
    const result = render([image], assets, { fallbackText: 'Existing description' });
    assert.equal(result.textContent, 'Existing description', JSON.stringify(assets));
    assert.equal(result.descendants().some(child => child.tagName === 'img'), false);
  }
});

test('Tenant preview accepts only assets under its own tenant path and permits seller-protected images', () => {
  const tenantDocument = { ...ownerDocument, location: { pathname: '/shopone/seller/' } };
  const result = render([image], [{ ...asset, src: `/shopone${src.replace('/v1/', '/v1/seller/')}` }], { ownerDocument: tenantDocument });
  assert.equal(result.descendants().filter(child => child.tagName === 'img').length, 1);
  assert.equal(render([image], [asset], { ownerDocument: tenantDocument }).children.length, 0);
});

test('Unavailable decoded images remove the whole dependent figure without orphan captions', () => {
  const result = render([image]);
  const photo = result.children[0].children[0]; photo.events.error();
  assert.equal(result.descendants().some(child => child.tagName === 'img'), false);
  assert.equal(result.textContent, '');
  assert.equal(result.children.length, 0);
  const bare = render([{ ...image, caption: '' }]);
  bare.children[0].children[0].events.error();
  assert.equal(bare.children.length, 0);
});

test('Late image failures show one summary only after all images fail and preserve surviving detail text', () => {
  const multiple = render([image, image], [asset], { fallbackText: 'Saved summary' });
  const first = multiple.children[0].children[0], second = multiple.children[1].children[0];
  first.events.error();
  assert.equal(multiple.children.length, 1);
  assert.equal(multiple.children[0].tagName, 'figure', 'a surviving image prevents early fallback');
  assert.doesNotMatch(multiple.textContent, /Saved summary/);
  second.events.error();
  assert.equal(multiple.children.length, 1); assert.equal(multiple.textContent, 'Saved summary');
  second.events.error();
  assert.equal(multiple.children.length, 1, 'a repeated failure cannot duplicate the summary');
  const mixed = render([{ type: 'paragraph', text: 'Existing detail text' }, image], [asset], { fallbackText: 'Saved summary' });
  mixed.children[1].children[0].events.error();
  assert.equal(mixed.textContent, 'Existing detail text');
  assert.equal(mixed.children.length, 1, 'existing detail content remains authoritative');
});

test('Untrusted detail shape and collections are bounded during rendering', () => {
  assert.equal(render(Array(100).fill({ type: 'paragraph', text: 'x' })).children.length, 40);
  assert.equal(render([{ type: 'heading', text: 'x'.repeat(1000) }]).textContent.length, 240);
  assert.equal(render([{ type: 'list', items: Array(100).fill('x') }]).children[0].children.length, 30);
  assert.equal(render([null, {}, { type: 'paragraph', text: {} }, { type: 'image', assetId: 'missing' }]).children.length, 0);
});

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
test('Storefront image-only details fall back to the saved summary when the last real image fails', { skip: !modulePath }, async (t) => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] });
  t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block' });
  const photoPath = `/api/v1/products/${f.product.id}/detail/images/${assetId}`;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== f.origin) return route.abort();
    if (url.pathname === `/api/v1/products/${f.product.id}/detail`) return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        revision: '1', document: { version: 1, blocks: [image] }, assets: [{ ...asset, src: photoPath }],
      }),
    });
    if (url.pathname === photoPath) return route.fulfill({ status: 404 });
    return route.continue();
  });
  const page = await context.newPage();
  const unavailablePhoto = page.waitForResponse(response => new URL(response.url()).pathname === photoPath && response.status() === 404);
  await page.goto(`${f.origin}/shop/#product/${f.product.id}`);
  await page.locator('.product-rich-content').scrollIntoViewIfNeeded();
  await unavailablePhoto;
  await page.waitForFunction(() => !document.querySelector('.product-rich-content figure'));
  assert.equal(await page.locator('.product-rich-content').innerText(), 'Fictional item');
  assert.equal(await page.locator('.product-rich-content .detail-description').count(), 1);
  assert.equal(await page.locator('.product-rich-content img').count(), 0);
  assert.equal(await page.getByText('Back panel', { exact: true }).count(), 0);
  assert.equal(await page.locator('.product-purchase .product-add').isEnabled(), true);
});

test('Storefront keeps purchase usable while rich detail loads and renders safe long content at phone/desktop widths', { skip: !modulePath }, async (t) => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] });
  t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block' });
  let releaseDetail;
  let showFixtureImage = false;
  const gate = new Promise(resolve => { releaseDetail = resolve; });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== f.origin) return route.abort();
    if (url.pathname === `/api/v1/products/${f.product.id}/detail`) {
      await gate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        listingId: f.product.listingId, revision: '1', document: { version: 1, blocks: [
          { type: 'heading', text: '<script>window.__richXss=1</script>Item information' },
          { type: 'paragraph', text: 'Long product details.\n'.repeat(30), bold: true },
          { type: 'list', items: ['One', 'Two'] }, { type: 'specs', rows: [{ label: 'Material', value: 'Steel' }] },
          image,
        ] }, assets: [{ ...asset, src: `/api/v1/products/${f.product.id}/detail/images/${assetId}` }],
      }) });
    }
    if (url.pathname.endsWith(`/detail/images/${assetId}`)) return showFixtureImage
      ? route.fulfill({ status: 200, contentType: 'image/png', body: fixtureImage() })
      : route.fulfill({ status: 404 });
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${f.origin}/shop/#product/${f.product.id}`);
  await page.locator('.product-purchase .product-add').waitFor();
  assert.equal(await page.locator('.product-purchase .product-add').isEnabled(), true);
  assert.equal(await page.locator('.product-rich-content').innerText(), 'Fictional item');
  releaseDetail();
  await page.locator('.rich-product-detail>h3').waitFor();
  assert.match(await page.locator('.rich-product-detail').innerText(), /Long product details/);
  assert.equal(await page.evaluate(() => window.__richXss), undefined);
  assert.equal(await page.locator('.rich-product-detail script').count(), 0);
  await page.locator('.rich-product-detail').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => !document.querySelector('.rich-product-detail img'));
  assert.equal(await page.locator('.rich-product-detail figure').count(), 0, 'protected image does not leave a broken icon');
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal overflow at ${width}`);
  }
  const shotDirectory = process.env.PRODUCT_RICH_SHOTS;
  if (shotDirectory) {
    showFixtureImage = true;
    await page.reload(); await page.locator('.rich-product-detail img').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('.rich-product-detail img')?.naturalWidth > 0);
    for (const width of [375, 1280]) for (const colorScheme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `${shotDirectory}/shop-rich-${width}-${colorScheme}.png`, fullPage: true });
    }
  }
});

test('Storefront rejects a late sibling detail response and retains fallback after a detail fetch failure', { skip: !modulePath }, async (t) => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] });
  t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  const base = { name: 'Shared item', description: 'Saved shared description', category: 'EXAMPLES', currency: 'MYR', priceMinor: 1200, active: true, variantGroup: 'RICH-SHARED' };
  const first = await createProduct(f.app.database, { ...base, sku: 'RICH-S', variantLabel: 'Small' });
  const second = await createProduct(f.app.database, { ...base, sku: 'RICH-L', variantLabel: 'Large' });
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block' });
  let firstResponseSeen;
  const firstRequested = new Promise(resolve => { firstResponseSeen = resolve; });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== f.origin) return route.abort();
    if (url.pathname === `/api/v1/products/${first.id}/detail`) {
      firstResponseSeen(); await gate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ document: { version: 1, blocks: [{ type: 'paragraph', text: 'Obsolete detail response' }] }, assets: [] }) });
    }
    if (url.pathname === `/api/v1/products/${second.id}/detail`) return route.fulfill({ status: 503 });
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${f.origin}/shop/#product/${first.id}`);
  await page.locator('.product-rich-content').waitFor(); await firstRequested;
  await page.goto(`${f.origin}/shop/#product/${second.id}`);
  await page.waitForFunction(() => document.querySelector('.detail-specifications') && document.querySelector('.product-rich-content')?.textContent === 'Saved shared description');
  const response = page.waitForResponse(value => value.url().endsWith(`/products/${first.id}/detail`));
  releaseFirst(); await response;
  await page.locator('.product-purchase .product-add').waitFor();
  assert.equal(await page.locator('.product-rich-content').innerText(), 'Saved shared description');
  assert.equal(await page.locator('.product-purchase .product-add').isEnabled(), true);
  assert.equal(await page.getByText('Obsolete detail response', { exact: true }).count(), 0);
});
