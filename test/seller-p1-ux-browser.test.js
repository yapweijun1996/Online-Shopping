import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sellerFixture } from './helpers/seller-app.js';
const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
async function fixture(t, width = 375) {
  assert.ok(modulePath, 'QA_PLAYWRIGHT_MODULE is required');
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const f = await sellerFixture(); t.after(() => f.close());
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  await page.goto(`${f.origin}/seller/`);
  await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password);
  await page.locator('#login-submit').click(); await page.locator('.dashboard-home').waitFor();
  await page.goto(`${f.origin}/seller/#products/${f.product.id}`);
  await page.locator('#product-form:not([hidden])').waitFor();
  return { f, page, context };
}
test('P1 inventory: explicit unlimited mode, finite validation, zero, restore and baseline reversion', async t => {
  const { page, f } = await fixture(t);
  const unlimited = page.locator('input[name=unlimitedStock]'), stock = page.locator('input[name=stockQuantity]');
  assert.equal(await unlimited.count(), 1, 'explicit unlimited control exists');
  assert.equal(await unlimited.isChecked(), true); assert.equal(await stock.isDisabled(), true);
  await unlimited.uncheck(); await page.locator('#product-save').click();
  await page.locator('#product-stock-error:not([hidden])').waitFor();
  assert.equal(await stock.getAttribute('aria-invalid'), 'true');
  await stock.fill('0'); await unlimited.check(); assert.equal(await page.locator('#product-save-state').innerText(), 'No unsaved changes'); await unlimited.uncheck(); assert.equal(await stock.inputValue(), '0');
  await stock.fill('-1'); await page.locator('#product-save').click();
  assert.equal(await stock.getAttribute('aria-invalid'), 'true');
  await stock.fill('0'); await page.locator('#product-save').click(); await page.locator('#product-form-success', { hasText: 'saved' }).waitFor();
  const auth = await f.login();
  assert.equal((await f.request('GET', `/api/v1/seller/products/${f.product.id}`, null, auth.headers)).data.stockQuantity, 0);
  await page.reload(); await page.locator('#product-form:not([hidden])').waitFor();
  assert.equal(await unlimited.isChecked(), false); assert.equal(await stock.inputValue(), '0');
  await stock.fill('18'); await unlimited.check(); await unlimited.uncheck(); assert.equal(await stock.inputValue(), '18');
  await stock.fill('0');
  let dialogs = 0; page.on('dialog', async dialog => { dialogs++; await dialog.dismiss(); });
  await page.locator('#product-back').click(); await page.locator('#product-list-view:not([hidden])').waitFor();
  assert.equal(dialogs, 0, 'reverting finite value to baseline is clean');
});

for (const width of [375, 768, 1440]) test(`P1 editor save state, recovery and sticky geometry at ${width}`, async t => {
  const { page, context } = await fixture(t, width);
  const state = page.locator('#product-save-state'), name = page.locator('input[name=name]');
  assert.equal(await state.count(), 1, 'actual save status exists');
  assert.equal(await state.innerText(), 'No unsaved changes');
  assert.equal(await page.locator('.product-variant-fields input[name=sku]').count(), 1);
  assert.equal(await page.locator('.product-variant-fields input[name=variantGroup]').count(), 1);
  assert.equal(await page.locator('.product-variant-fields input[name=variantLabel]').count(), 1);
  assert.ok(Number(await page.locator('textarea[name=description]').getAttribute('rows')) >= 6);
  assert.equal(await page.locator('.product-price-currency').innerText(), 'MYR');
  assert.equal(await page.locator('#product-history').evaluate(e => !!(e.compareDocumentPosition(document.querySelector('.product-editor-layout')) & Node.DOCUMENT_POSITION_PRECEDING)), true);
  await name.fill('Changed'); await state.filter({ hasText: 'Unsaved changes' }).waitFor();
  await name.fill('Example item'); await state.filter({ hasText: 'No unsaved changes' }).waitFor();
  let writes = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  await context.route('**/api/v1/seller/products/*', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    writes++; await gate; return route.fulfill({ status: 500, json: { error: { code: 'INTERNAL' } } });
  });
  await name.fill('Keep this edit'); await page.locator('#product-save').click();
  await state.filter({ hasText: 'Saving' }).waitFor(); assert.equal(await page.locator('#product-save').isDisabled(), true);
  release(); await state.filter({ hasText: 'Could not save' }).waitFor();
  assert.equal(await name.inputValue(), 'Keep this edit'); assert.equal(writes, 1);
  await context.unroute('**/api/v1/seller/products/*');
  await page.locator('#product-save').click(); await state.filter({ hasText: 'Saved' }).waitFor();
  await name.fill('Example item'); await state.filter({ hasText: 'Unsaved changes' }).waitFor();
  await name.fill('Keep this edit'); await state.filter({ hasText: 'No unsaved changes' }).waitFor();
  for (const selector of ['input[name=name]', 'textarea[name=description]', 'input[name=stockQuantity]']) {
    const input = page.locator(selector); if (await input.isDisabled()) continue;
    await input.focus(); await page.keyboard.press('Tab');
    const geometry = await page.evaluate(() => {
      const b = document.querySelector('.product-editor-actions'), r = b.getBoundingClientRect(), a = document.activeElement.getBoundingClientRect();
      return { position: getComputedStyle(b).position, top: r.top, bottom: r.bottom, h: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, focusObscured: a.bottom > r.top && a.top < r.bottom && !b.contains(document.activeElement) };
    });
    assert.equal(geometry.position, 'sticky'); assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.h + 1, JSON.stringify(geometry));
    assert.equal(geometry.overflow, false); assert.equal(geometry.focusObscured, false);
  }
});

async function studio(t, width = 1440, status = {}) {
  const result = await fixture(t, width);
  const auth = await result.f.login();
  await result.f.request('PATCH', `/api/v1/seller/products/${result.f.product.id}`, { active: false }, auth.headers);
  await result.context.route('**/api/v1/seller/ai-studio', route => route.fulfill({ json: { available: true, configured: true, usedToday: 0, dailyCallCap: 20, keyRevision: 1, settingRevision: 1, ...status } }));
  await result.page.goto(`${result.f.origin}/seller/#aistudio`); await result.page.locator('.ai-studio').waitFor();
  await result.page.locator('#page-title', { hasText: 'AI Studio' }).waitFor();
  await result.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return result;
}
for (const width of [375, 768, 1440]) test(`P1 AI workspace: tabs, keyboard, two panes, reasons, selection and retained state at ${width}`, async t => {
  const { page } = await studio(t, width);
  assert.equal(await page.getByRole('tab').count(), 2, 'two explicit task tabs');
  const create = page.getByRole('tab', { name: 'Create Product', exact: true }), images = page.getByRole('tab', { name: 'Generate Images', exact: true });
  assert.equal(await create.getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('button', { name: 'Analyze product photo', exact: true }).isDisabled(), true);
  await page.locator('#ai-photo-reason', { hasText: 'Choose a photo first.' }).waitFor();
  assert.equal(await page.locator('.ai-studio-settings').getAttribute('open'), null, 'key controls are secondary');
  const panes = await page.locator('#ai-create-panel .ai-studio-pane').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y }; }));
  if (width >= 1024) assert.ok(panes[1].x > panes[0].x); else assert.ok(panes[1].y > panes[0].y);
  await create.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await images.getAttribute('aria-selected'), 'true'); assert.equal(await images.evaluate(e => e === document.activeElement), true);
  await page.locator('#ai-gen-reason', { hasText: 'Select a product first.' }).waitFor();
  await page.locator('.ai-studio-search input').fill('SELLER'); await page.locator('.ai-studio-search button').click();
  await page.locator('.ai-studio-hits button').first().click();
  assert.match(await page.locator('.ai-studio-selected').innerText(), /SELLER-ITEM/);
  await page.locator('.ai-studio-style input[value=studio]').uncheck();
  await page.locator('#ai-gen-reason', { hasText: 'Pick at least one style.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Generate images', exact: true }).isDisabled(), true);
  await create.click(); await images.click();
  assert.equal(await page.locator('.ai-studio-search input').inputValue(), 'SELLER');
  assert.equal(await page.locator('.ai-studio-style input[value=studio]').isChecked(), false);
  const steps = page.locator('#ai-images-panel .ai-studio-steps li'); assert.equal(await steps.count(), 3);
  assert.equal(await steps.nth(1).getAttribute('aria-current'), 'step');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

async function photo(page, name = 'source.png') {
  const data = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 80; c.height = 60; const x = c.getContext('2d'); x.fillStyle = '#397259'; x.fillRect(0,0,80,60); return c.toDataURL('image/png').split(',')[1]; });
  return { name, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
}
async function drop(page, file) {
  await page.locator('.ai-studio-drop').evaluate((zone, data) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(data.base64), c => c.charCodeAt(0))], data.name, { type: data.type }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { base64: file.buffer.toString('base64'), name: file.name, type: file.mimeType });
}
test('P1 photo workflow: keyboard choose, validated drop, preview, replace/remove protection, request isolation and save actions', async t => {
  const { page, context, f } = await studio(t);
  const choose = page.getByRole('button', { name: 'Choose photo', exact: true });
  assert.equal(await choose.count(), 1, 'native keyboard-accessible choose button');
  await choose.focus(); const chooser = page.waitForEvent('filechooser'); await choose.press('Enter');
  await (await chooser).setFiles(await photo(page));
  await page.locator('.ai-studio-preview:not([hidden])').waitFor();
  assert.equal(await page.locator('.ai-studio-preview').evaluate(img => img.complete && img.naturalWidth > 0), true);
  assert.equal(await page.locator('.ai-studio-filename').innerText(), 'source.png');
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  await context.route('**/ai-studio/analyze', async route => { calls++; await gate; return route.fulfill({ json: { name: 'Stale source', description: 'Old source', category: 'EXAMPLES' } }); });
  await page.getByRole('button', { name: 'Analyze product photo', exact: true }).click();
  await drop(page, await photo(page, 'new.png')); await page.locator('.ai-studio-filename', { hasText: 'new.png' }).waitFor();
  release(); await page.locator('#ai-photo-reason:empty').waitFor({ state: 'attached' });
  assert.equal(await page.locator('form:has(input[name=sku])').isHidden(), true, 'old analysis must not attach to replacement');
  await context.unroute('**/ai-studio/analyze');
  await context.route('**/ai-studio/analyze', route => { calls++; return route.fulfill({ json: { name: 'Local bag', description: 'Fixture photo', category: 'EXAMPLES' } }); });
  await page.getByRole('button', { name: 'Analyze product photo', exact: true }).click(); await page.locator('input[name=name]').waitFor();
  await page.locator('input[name=name]').fill('My edited bag');
  await page.getByRole('tab', { name: 'Generate Images', exact: true }).click(); await page.getByRole('tab', { name: 'Create Product', exact: true }).click();
  assert.equal(await page.locator('input[name=name]').inputValue(), 'My edited bag');
  await page.getByRole('button', { name: 'Remove photo', exact: true }).click();
  await page.getByRole('dialog').waitFor(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' }); assert.equal(await page.locator('input[name=name]').inputValue(), 'My edited bag');
  await drop(page, { name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('bad') });
  await page.getByRole('dialog').waitFor(); await page.getByRole('dialog').getByRole('button', { name: 'Replace photo', exact: true }).click();
  await page.getByText('Choose a PNG, JPEG or WebP photo.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Analyze product photo', exact: true }).isDisabled(), true);
  await drop(page, await photo(page, 'final.png')); await page.locator('.ai-studio-preview:not([hidden])').waitFor();
  await page.getByRole('button', { name: 'Analyze product photo', exact: true }).click(); await page.locator('input[name=name]').waitFor();
  await page.locator('input[name=sku]').fill('P1-DRAFT'); await page.locator('input[name=price]').fill('10.00');
  await page.getByRole('button', { name: 'Save as draft', exact: true }).click();
  await page.getByRole('button', { name: 'Edit saved product', exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Create Product', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: 'Create images for this draft', exact: true }).click();
  assert.match(await page.locator('.ai-studio-selected').innerText(), /P1-DRAFT/);
  assert.equal(calls, 3, 'only explicit analyze clicks spend calls');
  const auth = await f.login(); const list = await f.request('GET', '/api/v1/seller/products?search=P1-DRAFT', null, auth.headers);
  assert.equal(list.data.items.length, 1); assert.equal(list.data.items[0].active, false);
});

test('P1 search and image batches: latest search wins; late results cannot redirect a running target', async t => {
  const { page, context, f } = await studio(t);
  await page.getByRole('tab', { name: 'Generate Images', exact: true }).click();
  let releaseSearch, searched; const pending = new Promise(r => { releaseSearch = r; }), started = new Promise(r => { searched = r; });
  await context.route('**/api/v1/seller/products?*', async route => {
    const term = new URL(route.request().url()).searchParams.get('search');
    if (term === 'old') { searched(); await pending; return route.fulfill({ json: { items: [{ id: '00000000-0000-4000-8000-000000000009', name: 'Stale result', sku: 'OLD', active: false }] } }); }
    return route.continue();
  });
  const search = page.locator('.ai-studio-search input');
  await search.fill('old'); await search.press('Enter'); await started;
  await search.fill('SELLER'); await search.press('Enter'); await page.locator('.ai-studio-hits button', { hasText: 'SELLER-ITEM' }).waitFor();
  releaseSearch();
  await page.waitForFunction(() => !document.querySelector('.ai-studio-hits')?.textContent.includes('Stale result'));
  await page.locator('.ai-studio-hits button', { hasText: 'SELLER-ITEM' }).click();
  let releaseImage, made; const gate = new Promise(r => { releaseImage = r; }), called = new Promise(r => { made = r; }); const targets = [];
  await context.route('**/ai-studio/products/*/images', async route => { targets.push(new URL(route.request().url()).pathname); made(); await gate; return route.fulfill({ status: 201, json: { galleryImageId: '00000000-0000-4000-8000-000000000002', verdict: 'PASS', issues: [] } }); });
  const img = await photo(page); await context.route('**/gallery/*?size=thumb', route => route.fulfill({ contentType: 'image/png', body: img.buffer }));
  await page.getByRole('button', { name: 'Generate images', exact: true }).click(); await called;
  await page.getByRole('tab', { name: 'Create Product', exact: true }).click();
  await page.getByRole('tab', { name: 'Generate Images', exact: true }).click();
  assert.equal(await search.isDisabled(), true); await page.locator('#ai-gen-reason', { hasText: 'Working' }).waitFor();
  releaseImage(); await page.locator('.ai-studio-result .ai-studio-badge').first().waitFor();
  assert.deepEqual(targets, [`/api/v1/seller/ai-studio/products/${f.product.id}/images`]);
  assert.match(await page.locator('.ai-studio-selected').innerText(), /SELLER-ITEM/);
});
for (const [label, status, expected] of [
  ['missing key', { configured: false }, 'Add your OpenAI key first.'],
  ['unavailable', { available: false }, 'AI Studio is not set up on this server.'],
  ['budget exhausted', { usedToday: 20 }, 'daily'],
]) test(`P1 disabled explanation: ${label}`, async t => {
  const { page } = await studio(t, 375, status);
  await page.locator('#ai-photo-reason', { hasText: expected }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Analyze product photo', exact: true }).isDisabled(), true);
  await page.getByRole('tab', { name: 'Generate Images', exact: true }).click();
  await page.locator('#ai-gen-reason', { hasText: expected }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Generate images', exact: true }).isDisabled(), true);
});

test('P1 all seven locales keep complete workspace copy and retained inputs without overflow', async t => {
  const { page } = await studio(t, 375);
  for (const code of ['en', 'zh-Hans', 'ms', 'vi', 'th', 'ja', 'ko']) {
    await page.evaluate(async code => { (await import('/shared/i18n.js')).setLocale(code); }, code);
    const expectedAlt = await page.evaluate(async () => (await import('/shared/i18n.js')).t('aist_source'));
    assert.equal(await page.locator('.ai-studio-preview').getAttribute('alt'), expectedAlt, code);
    const labels = await page.getByRole('tab').allTextContents(); assert.equal(labels.length, 2); assert.ok(labels.every(v => v.trim() && !v.includes('aist_')));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, code);
  }
});
test('P1 actual sibling variants and discard guard remain functional', async t => {
  const { page, f } = await fixture(t, 768); const auth = await f.login();
  assert.equal((await f.request('PATCH', `/api/v1/seller/products/${f.product.id}`, { variantGroup: 'BOWL', variantLabel: 'Small' }, auth.headers)).response.status, 200);
  const sibling = await f.request('POST', '/api/v1/seller/products', { sku: 'BOWL-L', name: 'Example item', description: 'Fictional item', category: 'EXAMPLES', priceMinor: 1850, currency: 'MYR', active: false, stockQuantity: 7, variantGroup: 'BOWL', variantLabel: 'Large' }, auth.headers);
  assert.equal(sibling.response.status, 201);
  await page.reload(); await page.locator('#product-variants:not([hidden])').waitFor();
  assert.match(await page.locator('#product-variants-list').innerText(), /BOWL-L/);
  await page.locator('input[name=name]').fill('Do not discard');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#product-variants-list').getByRole('button', { name: 'Edit product: Large (BOWL-L)', exact: true }).click();
  assert.equal(await page.locator('input[name=name]').inputValue(), 'Do not discard');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#product-variants-list').getByRole('button', { name: 'Edit product: Large (BOWL-L)', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[name=sku]')?.value === 'BOWL-L');
  assert.equal(await page.locator('input[name=stockQuantity]').inputValue(), '7');
  assert.equal(await page.locator('input[name=unlimitedStock]').isChecked(), false);
});

// Evidence-only border: retain every raw app pixel, never modify production DOM/UI.
async function labeledScreenshot(page, file, options = {}) {
  const rawPath = file.replace(/\.png$/, '.raw.png');
  const raw = await page.screenshot({ path: rawPath, animations: 'disabled', ...options });
  const labeled = await page.evaluate(async base64 => {
    const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height + 48;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff4bd'; ctx.fillRect(0, 0, canvas.width, 48);
    ctx.fillStyle = '#191919'; ctx.font = 'bold 12px sans-serif';
    ctx.fillText('LOCAL QA FIXTURE / simulated AI /', 8, 18); ctx.fillText('not production', 8, 36);
    ctx.drawImage(image, 0, 48); return canvas.toDataURL('image/png').split(',')[1];
  }, raw.toString('base64'));
  writeFileSync(file, Buffer.from(labeled, 'base64')); return rawPath;
}

test('P1 deterministic fixture screenshots: editor, both task sources and outputs at 375/768/1440', async t => {
  const folder = path.resolve('.local/ux-task/screenshots'); mkdirSync(folder, { recursive: true }); const manifest = [];
  for (const width of [375, 768, 1440]) {
    const { page, context, f } = await fixture(t, width); await page.emulateMedia({ reducedMotion: 'reduce' });
    const shot = async state => {
      await page.evaluate(() => { window.scrollTo(0, 0); });
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].filter(img => img.getClientRects().length).map(img => img.decode().catch(() => {}))); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${state}-${width}`);
      const file = path.join(folder, `${state}-${width}.png`); const rawPath = await labeledScreenshot(page, file, { fullPage: true }); manifest.push({ width, state, path: file, rawPath, capture: 'full-page; scroll top; sticky bar placement is not viewport obstruction evidence', fixture: 'local real app; fictional product; simulated AI endpoints' });
    };
    await shot('editor');
    const auth = await f.login(); await f.request('PATCH', `/api/v1/seller/products/${f.product.id}`, { active: false }, auth.headers);
    const usage = { available: true, configured: true, usedToday: 0, dailyCallCap: 20, keyRevision: 1, settingRevision: 1 };
    await context.route('**/api/v1/seller/ai-studio', route => route.fulfill({ json: usage }));
    const image = await photo(page);
    await context.route('**/ai-studio/analyze', route => { usage.usedToday++; return route.fulfill({ json: { name: 'Canvas travel bag', description: 'A durable green bag with a woven strap. Check the photo before saving.', category: 'EXAMPLES' } }); });
    await context.route('**/ai-studio/products/*/images', route => { usage.usedToday += 2; return route.fulfill({ status: 201, json: { galleryImageId: '00000000-0000-4000-8000-000000000002', style: 'studio', verdict: 'WARN', issues: ['Check the strap details against the source photo.'] } }); });
    await context.route('**/gallery/*?size=thumb', route => route.fulfill({ contentType: 'image/png', body: image.buffer }));
    await page.goto(`${f.origin}/seller/#aistudio`); await page.locator('#ai-photo-reason', { hasText: 'Choose a photo first.' }).waitFor();
    await page.locator('.ai-studio-file').setInputFiles(image); await page.locator('.ai-studio-preview:not([hidden])').waitFor(); await shot('create-source');
    await page.getByRole('button', { name: 'Analyze product photo', exact: true }).click(); await page.locator('input[name=name]').waitFor();
    await page.locator('input[name=sku]').fill('TRAVEL-BAG'); await page.locator('input[name=price]').fill('49.90'); await shot('create-suggestions');
    await page.getByRole('tab', { name: 'Generate Images', exact: true }).click();
    await page.locator('.ai-studio-search input').fill('SELLER'); await page.locator('.ai-studio-search button').click(); await page.locator('.ai-studio-hits button').first().click(); await shot('images-source');
    await page.getByRole('button', { name: 'Generate images', exact: true }).click(); await page.locator('.ai-studio-result img').waitFor(); await shot('images-output');
    if (width === 375) {
      await page.evaluate(async () => { (await import('/shared/i18n.js')).setLocale('zh-Hans'); }); const doneText = await page.evaluate(async () => (await import('/seller/ai-studio-copy.js')).studioText('done'));
      assert.equal(await page.locator('.ai-studio-result-status').innerText(), doneText, 'locale change must not reset a completed result to waiting');
      const aiText = await page.evaluate(async () => (await import('/seller/ai-studio-copy.js')).studioText('aiLabel'));
      assert.equal(await page.locator('.ai-studio-badge').first().innerText(), aiText);
      await shot('images-output-zh');
      await page.evaluate(async () => { (await import('/shared/i18n.js')).setLocale('vi'); }); await shot('images-output-vi');
    }
    await page.close(); await context.close();
  }
  assert.equal(manifest.length, 17); writeFileSync(path.resolve('.local/ux-task/screenshot-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
});

test('P1 selected tab remains readable and desktop task panes fill their workspace', async t => {
  const { page } = await studio(t);
  const geometry = await page.evaluate(() => {
    const tab = document.querySelector('[role=tab][aria-selected=true]'), panel = document.querySelector('#ai-create-panel');
    return { background: getComputedStyle(tab).backgroundColor, panel: panel.getBoundingClientRect().width, workspace: panel.parentElement.getBoundingClientRect().width };
  });
  assert.notEqual(geometry.background, 'rgba(0, 0, 0, 0)', 'selected tab needs a real token background behind white text');
  assert.ok(geometry.panel >= geometry.workspace - 2, JSON.stringify(geometry));
  await page.getByText('Analysis: 1 AI call. Your daily limit applies.', { exact: true }).waitFor();
});
test('P1 pending service status never invents a remaining call allowance', async t => {
  const { page, context, f } = await fixture(t);
  let release, started; const gate = new Promise(r => { release = r; }), got = new Promise(r => { started = r; });
  await context.route('**/api/v1/seller/ai-studio', async route => { started(); await gate; return route.fulfill({ json: { available: true, configured: true, usedToday: 6, dailyCallCap: 9 } }); });
  await page.goto(`${f.origin}/seller/#aistudio`); await got;
  await page.getByRole('tab', { name: 'Generate Images', exact: true }).click();
  assert.doesNotMatch(await page.locator('.ai-studio').innerText(), /20|remaining|left today/i, 'do not display a hardcoded allowance before the service responds');
  release(); await page.getByRole('tab', { name: 'Generate Images', exact: true }).click();
  await page.getByText(/Used today: 6 of 9/).waitFor({ state: 'attached' });
});

test('P1 mobile reduced visual viewport keeps focused fields above the safe-area save bar', async t => {
  const { page } = await fixture(t, 375);
  await page.setViewportSize({ width: 375, height: 480 });
  await page.locator('input[name=unlimitedStock]').uncheck();
  for (const selector of ['textarea[name=description]', 'input[name=price]', 'input[name=stockQuantity]']) {
    const field = page.locator(selector); await field.focus(); await field.press('a');
    const geometry = await page.evaluate(() => {
      const focus = document.activeElement.getBoundingClientRect(), bar = document.querySelector('.product-editor-actions').getBoundingClientRect();
      return { focusTop: focus.top, focusBottom: focus.bottom, barTop: bar.top, barBottom: bar.bottom, height: innerHeight };
    });
    assert.ok(geometry.focusTop >= 0 && geometry.focusBottom <= geometry.barTop, JSON.stringify(geometry));
    assert.ok(geometry.barTop >= 0 && geometry.barBottom <= geometry.height + 1, JSON.stringify(geometry));
  }
});
test('P1 analysis errors belong only to the initiating photo; disposal never mutates the next page', async t => {
  const { page, context } = await studio(t);
  let release, started; const gate = new Promise(r => { release = r; }), got = new Promise(r => { started = r; });
  await context.route('**/ai-studio/analyze', async route => { started(); await gate; return route.fulfill({ status: 504, json: { error: { code: 'AI_STUDIO_TIMEOUT' } } }); });
  await page.locator('.ai-studio-file').setInputFiles(await photo(page)); await page.locator('.ai-studio-preview:not([hidden])').waitFor();
  await page.getByRole('button', { name: 'Analyze product photo', exact: true }).click(); await got;
  await drop(page, await photo(page, 'replacement.png')); await page.locator('.ai-studio-filename', { hasText: 'replacement.png' }).waitFor();
  release(); await page.locator('#ai-photo-reason:empty').waitFor({ state: 'attached' });
  assert.doesNotMatch(await page.locator('#ai-create-panel').innerText(), /may still have been charged/);
  assert.equal(await page.locator('.ai-studio-preview').evaluate(img => img.complete && img.naturalWidth > 0), true);
  await page.locator('.ai-studio-file').setInputFiles(await photo(page, 'newest.png'));
  await page.locator('.ai-studio-filename', { hasText: 'newest.png' }).waitFor();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(page.url().replace('#aistudio', '#dashboard')); await page.locator('.dashboard-home').waitFor();
  assert.equal(await page.locator('.ai-studio').count(), 0); assert.deepEqual(errors, []);
  // Exercise actual module disposal while a second request is still outstanding.
  await context.unroute('**/ai-studio/analyze');
  let releaseDisposed, beginDisposed;
  const disposedGate = new Promise(r => { releaseDisposed = r; }), disposedStarted = new Promise(r => { beginDisposed = r; });
  await context.route('**/ai-studio/analyze', async route => { beginDisposed(); await disposedGate; return route.fulfill({ json: { name: 'Late disposed result', description: 'Must not be applied', category: 'EXAMPLES' } }); });
  await page.evaluate(async () => {
    const root = document.createElement('div'); root.id = 'p1-disposal-root'; document.querySelector('#workspace-content').replaceChildren(root);
    const { mountAiStudio } = await import('/seller/ai-studio.js');
    window.p1Disposed = mountAiStudio(root, { csrfToken: () => 'fixture-token', role: 'OWNER', onUnauthorized() {} });
  });
  const manual = page.locator('#p1-disposal-root'); await manual.locator('#ai-photo-reason', { hasText: 'Choose a photo first.' }).waitFor();
  await manual.locator('.ai-studio-file').setInputFiles(await photo(page)); await manual.locator('.ai-studio-preview:not([hidden])').waitFor();
  await manual.getByRole('button', { name: 'Analyze product photo', exact: true }).click(); await disposedStarted;
  await page.evaluate(() => { window.p1Disposed.dispose(); document.querySelector('#p1-disposal-root').textContent = 'Next workspace'; });
  const response = page.waitForResponse(r => r.url().endsWith('/ai-studio/analyze')); releaseDisposed(); await response;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await manual.innerText(), 'Next workspace'); assert.equal(await manual.locator('.ai-studio').count(), 0); assert.deepEqual(errors, []);
});

test('P1 late initial product lookup cannot replace a more recent explicit selection', async t => {
  const { page, context, f } = await studio(t); const auth = await f.login();
  const second = await f.request('POST', '/api/v1/seller/products', { sku: 'LATEST-DRAFT', name: 'Latest selection', description: 'Fictional selection', category: 'EXAMPLES', priceMinor: 1500, currency: 'MYR', active: false }, auth.headers); assert.equal(second.response.status, 201);
  let release, start; const gate = new Promise(r => { release = r; }), started = new Promise(r => { start = r; });
  await context.route(`**/api/v1/seller/products/${f.product.id}`, async route => { start(); await gate; return route.continue(); });
  await page.evaluate(async id => {
    const { mountAiStudio } = await import('/seller/ai-studio.js');
    window.p1Manual = mountAiStudio(document.querySelector('#workspace-content'), { csrfToken: () => 'fixture-token', role: 'OWNER', onUnauthorized() {}, initialProductId: id });
  }, f.product.id); await started;
  await page.locator('.ai-studio-search input').fill('LATEST-DRAFT'); await page.locator('.ai-studio-search button').click();
  await page.locator('.ai-studio-hits button').first().click();
  const response = page.waitForResponse(r => r.url().endsWith(`/api/v1/seller/products/${f.product.id}`)); release(); await response;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.match(await page.locator('.ai-studio-selected').innerText(), /LATEST-DRAFT/);
  await page.evaluate(() => window.p1Manual.dispose());
});

test('P1 delayed product/gallery detail never overwrites metadata typed into a newer editor', async t => {
  const { page, context, f } = await fixture(t);
  let release, begin; const gate = new Promise(r => { release = r; }), got = new Promise(r => { begin = r; });
  await context.route(`**/api/v1/seller/products/${f.product.id}`, async route => { begin(); await gate; return route.continue(); });
  await page.reload(); await got;
  await page.goto(`${f.origin}/seller/#products/new`); await page.locator('#product-form:not([hidden])').waitFor();
  await page.locator('input[name=name]').fill('New editor metadata'); await page.locator('input[name=sku]').fill('NEW-EDITOR');
  const response = page.waitForResponse(r => r.url().endsWith(`/api/v1/seller/products/${f.product.id}`)); release(); await response;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('input[name=name]').inputValue(), 'New editor metadata');
  assert.equal(await page.locator('input[name=sku]').inputValue(), 'NEW-EDITOR');
  assert.equal(await page.locator('#product-save-state').innerText(), 'Unsaved changes');
});

test('P1 ignored stale analysis still refreshes actual server call accounting', async t => {
  const { page, context } = await studio(t);
  const usage = { available: true, configured: true, usedToday: 0, dailyCallCap: 3 };
  await context.route('**/api/v1/seller/ai-studio', route => route.fulfill({ json: usage }));
  let release, start; const gate = new Promise(r => { release = r; }), got = new Promise(r => { start = r; });
  await context.route('**/ai-studio/analyze', async route => { usage.usedToday++; start(); await gate; return route.fulfill({ json: { name: 'Stale result', description: 'Unused', category: 'EXAMPLES' } }); });
  await page.locator('.ai-studio-file').setInputFiles(await photo(page)); await page.locator('.ai-studio-preview:not([hidden])').waitFor();
  await page.getByRole('button', { name: 'Analyze product photo', exact: true }).click(); await got;
  await drop(page, await photo(page, 'replacement.png')); await page.locator('.ai-studio-filename', { hasText: 'replacement.png' }).waitFor(); release();
  await page.waitForFunction(() => document.querySelectorAll('.ai-studio-usage')[1]?.textContent.includes('Used today: 1 of 3'));
  assert.equal(await page.locator('form:has(input[name=sku])').isHidden(), true);
});

test('P1 failed service lookup does not fabricate usage and recovers after retry', async t => {
  const { page, context, f } = await fixture(t);
  await context.route('**/api/v1/seller/ai-studio', route => route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } }));
  await page.goto(`${f.origin}/seller/#aistudio`);
  await page.locator('#ai-photo-reason', { hasText: 'AI Studio is not set up on this server.' }).waitFor();
  await page.locator('.ai-studio-settings > summary').click();
  assert.doesNotMatch(await page.locator('.ai-studio-usage').last().innerText(), /null|of 0/);
  await page.getByRole('tab', { name: 'Generate Images', exact: true }).click();
  assert.doesNotMatch(await page.locator('#ai-images-panel').innerText(), /0 calls left today/);
  await context.unroute('**/api/v1/seller/ai-studio');
  await context.route('**/api/v1/seller/ai-studio', route => route.fulfill({ json: { available: true, configured: true, usedToday: 2, dailyCallCap: 9 } }));
  await page.reload(); await page.locator('#ai-photo-reason', { hasText: 'Choose a photo first.' }).waitFor();
  assert.match(await page.locator('.ai-studio-usage').last().textContent(), /Used today: 2 of 9/);
});

// Independent-review regressions exercise the real app, writes and navigation guard.
test('REVIEW gallery mutations after confirmed saves report current dirty state', async t => {
  const { page, f } = await fixture(t, 1440);
  const { addGalleryImage, updateProduct } = await import('../src/products.js');
  const image = await photo(page);
  const data = 'data:image/png;base64,' + image.buffer.toString('base64');
  await updateProduct(f.app.database, f.product.id, { imageDataUrl: data });
  await addGalleryImage(f.app.database, f.product.id, 'data:image/png;base64,' + Buffer.concat([image.buffer, Buffer.from('front')]).toString('base64'));
  await addGalleryImage(f.app.database, f.product.id, 'data:image/png;base64,' + Buffer.concat([image.buffer, Buffer.from('back')]).toString('base64'));
  await page.reload(); await page.locator('.product-gallery-item').nth(2).waitFor();
  const state = page.locator('#product-save-state');
  const save = async () => {
    await page.locator('#product-save').click();
    await page.waitForFunction(() => document.querySelector('#product-save-state')?.dataset.state === 'p1Saved' && !document.querySelector('#product-save').disabled);
    // A clean post-save editor must navigate without a discard prompt.
    let dialogs = 0; const dismiss = async d => { dialogs++; await d.dismiss(); };
    page.on('dialog', dismiss);
    await page.locator('#product-back').click(); await page.locator('#product-list-view:not([hidden])').waitFor();
    page.off('dialog', dismiss); assert.equal(dialogs, 0, 'confirmed save captures a clean gallery baseline');
    await page.goto(`${f.origin}/seller/#products/${f.product.id}`);
    await page.waitForFunction(() => document.querySelector('#product-save-state')?.dataset.state === 'p1Unchanged');
    // Re-save without leaving so historical success is present for the mutation.
    await page.locator('#product-save').click();
    await page.waitForFunction(() => document.querySelector('#product-save-state')?.dataset.state === 'p1Saved' && !document.querySelector('#product-save').disabled);
  };
  for (const [action, index] of [['later', 0], ['earlier', 1], ['primary', 1], ['remove', 2]]) {
    await save();
    const before = await page.locator('.product-gallery-item').evaluateAll(nodes => nodes.map(n => n.dataset.imageId));
    await page.locator('.product-gallery-item').nth(index).locator(`[data-gallery-action=${action}]`).click();
    const after = await page.locator('.product-gallery-item').evaluateAll(nodes => nodes.map(n => n.dataset.imageId));
    assert.notDeepEqual(after, before, `${action} actually mutates gallery`);
    assert.equal(await state.innerText(), 'Unsaved changes', `${action}: current dirty state beats historical save success`);
    let dirtyDialogs = 0;
    page.once('dialog', async d => { dirtyDialogs++; await d.dismiss(); });
    await page.locator('#product-back').click();
    assert.equal(dirtyDialogs, 1, 'gallery mutation is dirty to the real navigation guard');
    assert.equal(await page.locator('#product-form').isVisible(), true, 'dirty gallery retains discard guard');
  }
  await save();
});

for (const width of [900, 901, 1024, 1050, 1051]) test(`REVIEW editor columns and areas geometry at ${width}`, async t => {
  const { page } = await fixture(t, width);
  const geometry = await page.evaluate(() => {
    const root = document.querySelector('.product-editor-layout'), rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width }; };
    return { layout: rect(root), info: rect(root.querySelector('.product-details-card')), pricing: rect(root.querySelector('.product-pricing-card')), images: rect(root.querySelector('.product-image-column')), columns: getComputedStyle(root).gridTemplateColumns.split(' ').length, areas: getComputedStyle(root).gridTemplateAreas, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.equal(geometry.overflow, false, JSON.stringify(geometry));
  assert.equal(geometry.columns, width <= 1050 ? 1 : 2, JSON.stringify(geometry));
  if (width <= 1050) {
    assert.ok(Math.abs(geometry.info.width - geometry.layout.width) <= 2, JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.pricing.width - geometry.layout.width) <= 2, JSON.stringify(geometry));
    assert.ok(geometry.pricing.y >= geometry.info.bottom && geometry.images.y >= geometry.pricing.bottom, JSON.stringify(geometry));
  } else {
    assert.ok(geometry.pricing.x >= geometry.info.right, JSON.stringify(geometry));
    assert.ok(geometry.images.y >= geometry.info.bottom, JSON.stringify(geometry));
  }
});

test('REVIEW real viewport focused variant and stock evidence at phone and desktop', async t => {
  const folder = path.resolve('.local/ux-task/review-screenshots'); mkdirSync(folder, { recursive: true });
  const manifest = [];
  for (const viewport of [{ width: 375, height: 900 }, { width: 375, height: 480 }, { width: 1440, height: 900 }]) {
    const { page } = await fixture(t, viewport.width); await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('input[name=unlimitedStock]').uncheck();
    for (const name of ['variantGroup', 'variantLabel', 'sku', 'stockQuantity']) {
      const field = page.locator(`input[name=${name}]`);
      await field.scrollIntoViewIfNeeded(); await field.focus();
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      const geometry = await field.evaluate(field => {
        const rect = e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
        const bar = document.querySelector('.product-editor-actions');
        const range = document.createRange(); range.selectNodeContents(field.closest('label').querySelector('span') || field.closest('label'));
        const label = range.getBoundingClientRect();
        const r = field.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { focus: rect(field), label: { top: label.top, bottom: label.bottom }, bar: rect(bar), focused: document.activeElement === field, hit: hit === field, scrollY, innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(geometry.focused, true); assert.equal(geometry.hit, true, JSON.stringify(geometry));
      assert.ok(geometry.focus.top >= 0 && geometry.focus.bottom <= geometry.bar.top, `${name} ${JSON.stringify(viewport)} ${JSON.stringify(geometry)}`);
      assert.ok(geometry.label.top >= 0 && geometry.label.bottom <= geometry.bar.top, `label reachable: ${name} ${JSON.stringify(geometry)}`);
      assert.ok(geometry.bar.top >= 0 && geometry.bar.bottom <= viewport.height + 1, JSON.stringify(geometry));
      assert.equal(geometry.overflow, false);
      const file = path.join(folder, `focus-${name}-${viewport.width}x${viewport.height}.png`);
      const rawPath = await labeledScreenshot(page, file, { fullPage: false });
      manifest.push({ path: file, rawPath, viewport, field: name, geometry, capture: 'real viewport; scrollIntoViewIfNeeded then native focus; reduced motion; 2 animation frames; service workers blocked; local real SQLite app; no AI call; evidence border adds 48px without cropping or overwriting app pixels' });
    }
  }
  assert.equal(manifest.length, 12);
  writeFileSync(path.resolve('.local/ux-task/review-screenshot-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
});
