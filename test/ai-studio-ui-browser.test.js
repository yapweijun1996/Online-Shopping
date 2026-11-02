import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { sellerFixture } from './helpers/seller-app.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const check = Buffer.alloc(4); check.writeUInt32BE(crc(body)); return Buffer.concat([length, body, check]); };
function png(width = 64, height = 48) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 180)]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

test('AI Studio page: key, photo to draft, independent styled images, phone width', { skip: !modulePath }, async (t) => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block' });
  const status = { available: true, configured: false, provider: 'OPENAI', dailyCallCap: 20, usedToday: 0, last4: null, keyRevision: 0, settingRevision: 1 };
  const seen = { key: null, analyze: 0, images: [] };
  let releaseFirst; const firstImage = new Promise((resolve) => { releaseFirst = resolve; });
  const thumb = png(8, 8);
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== f.origin) return route.abort();
    const reply = (code, body) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
    const path = url.pathname, method = request.method();
    if (path.endsWith('/api/v1/seller/ai-studio') && method === 'GET') return reply(200, status);
    if (path.endsWith('/ai-studio/key') && method === 'PUT') {
      const body = request.postDataJSON(); seen.key = body;
      if (body.apiKey.includes('rejected')) { seen.key = null; return reply(422, { error: { code: 'AI_STUDIO_KEY_REJECTED', message: 'x' } }); }
      Object.assign(status, { configured: true, last4: body.apiKey.slice(-4), keyRevision: 1 }); return reply(200, { configured: true, last4: status.last4, revision: 1 });
    }
    if (path.endsWith('/ai-studio/analyze')) { seen.analyze += 1; status.usedToday += 1; return reply(200, { name: '<img src=x onerror=window.__xss=1>Canvas tote', description: 'A tote bag.\n<script>window.__xss=1</script>', category: 'EXAMPLES', tags: [] }); }
    const images = /\/ai-studio\/products\/([0-9a-f-]{36})\/images$/.exec(path);
    if (images && method === 'POST') {
      const { style } = request.postDataJSON(); seen.images.push(style); status.usedToday += 2;
      if (style === 'studio') await firstImage;
      if (style === 'hero') return reply(504, { error: { code: 'AI_STUDIO_TIMEOUT', message: 'x' } });
      return reply(201, { galleryImageId: '00000000-0000-4000-8000-000000000001', style, aiGenerated: true, verdict: 'WARN', issues: ['Logo <b>text</b> differs'], reviewed: true });
    }
    if (/\/gallery\/[0-9a-f-]{36}$/.test(path) && url.searchParams.get('size') === 'thumb') return route.fulfill({ status: 200, contentType: 'image/png', body: thumb });
    return route.continue();
  });
  const page = await context.newPage();
  const shot = async (name) => { if (process.env.AI_STUDIO_SHOTS) await page.screenshot({ path: `${process.env.AI_STUDIO_SHOTS}/${name}.png`, fullPage: true }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.goto(`${f.origin}/seller/`);
  await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password); await page.locator('#password').press('Enter');
  await page.locator('#open-menu').click();
  await page.locator('.nav-item[data-view=aistudio]').click();
  await page.locator('.ai-studio').waitFor();
  assert.equal(await page.locator('#page-title').innerText(), 'AI Studio');
  assert.equal(await page.locator('.ai-studio-card').nth(1).isHidden(), true, 'photo card stays hidden until a key exists');
  assert.equal(await page.locator('input[name=apiKey]').getAttribute('type'), 'password');
  await shot('1-no-key-375');
  // Save the key
  await page.locator('input[name=apiKey]').fill('short');
  await page.getByRole('button', { name: 'Check and save key' }).click();
  await page.getByText('Enter a valid OpenAI API key.').waitFor();
  assert.equal(seen.key, null);
  await page.locator('input[name=apiKey]').fill('sk-rejected-0123456789abcdefghij');
  await page.getByRole('button', { name: 'Check and save key' }).click();
  await page.getByText('OpenAI did not accept this key.').waitFor();
  assert.equal(await page.locator('input[name=apiKey]').inputValue(), '', 'a rejected key is cleared from the field too');
  const key = 'sk-fictional-0123456789abcdefghij-WXYZ';
  await page.locator('input[name=apiKey]').fill(key);
  await page.getByRole('button', { name: 'Check and save key' }).click();
  await page.getByText('Key checked and saved.').waitFor();
  assert.equal(seen.key.apiKey, key); assert.equal(seen.key.expectedRevision, 0);
  assert.equal(await page.locator('input[name=apiKey]').inputValue(), '', 'the key is cleared from the field after saving');
  assert.doesNotMatch(await page.locator('.ai-studio').innerText(), /sk-fictional/);
  await page.getByText('Key saved, ending in WXYZ.').waitFor();
  assert.ok(await overflow() <= 0, 'no horizontal scroll at 375px');
  await shot('2-key-saved-375');
  // Photo to draft
  await page.locator('.ai-studio-file').setInputFiles({ name: 'tote.png', mimeType: 'image/png', buffer: png(900, 700) });
  await page.locator('.ai-studio-preview').waitFor();
  await page.getByRole('button', { name: /Read photo/ }).click();
  await page.locator('input[name=name]').waitFor();
  assert.match(await page.locator('input[name=name]').inputValue(), /^<img src=x onerror=window\.__xss=1>Canvas tote$/);
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'AI text is never rendered as HTML');
  assert.equal(await page.locator('select[name=category]').inputValue(), 'EXAMPLES');
  const locale = (code) => page.evaluate(async (value) => { (await import('/shared/i18n.js')).setLocale(value); }, code);
  await locale('zh-Hans');
  await page.getByText('价格（MYR）').waitFor();   // the currency survives a language change
  await locale('en');
  await page.locator('input[name=sku]').fill('TOTE-UI-1'); await page.locator('input[name=price]').fill('49.90');
  await page.locator('input[name=name]').fill('Canvas tote');
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await page.getByText('Draft saved. It is not published.').waitFor();
  assert.equal(await page.locator('form:has(input[name=sku])').isHidden(), true, 'the suggestion cannot be saved twice');
  const list = await (await fetch(`${f.origin}/api/v1/seller/products?search=TOTE-UI-1`, { headers: (await f.login()).headers })).json();
  assert.equal(list.items.length, 1); assert.equal(list.items[0].active, false, 'the new product is an unpublished draft');
  assert.ok(await overflow() <= 0);
  await shot('3-draft-375');
  // Styled images: one succeeds with a warning, the next times out and stops the batch
  await page.getByText('Selected: Canvas tote').waitFor();
  await page.locator('.ai-studio-style input[value=hero]').check();
  await page.locator('.ai-studio-style input[value=macro]').check();
  await page.getByText(/Images: 3, AI reviews: 3, total 6 AI calls/).waitFor();
  await page.getByRole('button', { name: 'Generate images' }).click();
  await page.locator('.ai-studio-result[data-style=studio] .ai-studio-result-status', { hasText: 'Working' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Generate images' }).isDisabled(), true, 'no second batch while one runs');
  assert.equal(await page.locator('.ai-studio-style input[value=macro]').isDisabled(), true);
  assert.equal(await page.locator('.ai-studio-search input').isDisabled(), true, 'the product cannot change during a batch');
  releaseFirst();
  await page.locator('.ai-studio-result[data-style=studio] .ai-studio-badge', { hasText: 'AI-generated' }).waitFor();
  await page.getByText('AI review: check the details').waitFor();
  assert.equal(await page.locator('.ai-studio-issues li').first().innerText(), 'Logo <b>text</b> differs');
  const thumbnail = page.locator('.ai-studio-result[data-style=studio] img');
  await thumbnail.scrollIntoViewIfNeeded();
  await page.waitForFunction((element) => element.complete && element.naturalWidth > 0, await thumbnail.elementHandle());
  await page.locator('.ai-studio-result[data-style=hero]').getByText(/may still have been charged/).waitFor();
  assert.deepEqual(seen.images, ['studio', 'hero'], 'a timeout stops the rest of the batch');
  assert.equal(await page.locator('.ai-studio-result[data-style=macro]').count(), 0);
  assert.ok(await overflow() <= 0);
  assert.match(await page.locator('.ai-studio-usage').last().innerText(), /Used today: 5 of 20/);   // 1 photo + 2 for the first image + 2 for the timed-out one
  await shot('4-results-375');
  // Desktop layout and language switch keep working
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.ok(await overflow() <= 0);
  await shot('5-results-1280');
  await locale('zh-Hans');
  await page.getByRole('button', { name: '生成图片' }).waitFor();
  assert.equal(await page.locator('#page-title').innerText(), 'AI 工作室');
  assert.match(await page.locator('.ai-studio-usage').last().innerText(), /今日已用：5/);
  assert.ok(await overflow() <= 0);
});
