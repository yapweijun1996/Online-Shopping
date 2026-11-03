import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createCategory } from '../src/settings.js';

// Product gallery against the real backend: image-first cards (photo, position, Primary badge, one main action, a More
// menu), responsive columns, keyboard menu, staged edits that Cancel discards and Save persists, and the ten-photo limit.
const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
const screenshots = process.env.GALLERY_SCREENSHOTS;
const username = 'gallery_owner', password = 'LocalGalleryPass123!';

test('seller product gallery: image-first cards, More menu, staged edits, Save and Cancel', { skip: !browserModule, timeout: 180000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'online-shopping-gallery-'));
  const app = await createApp({ username, password, dbPath: path.join(directory, 'private.db'), production: false, publicOrigin: null });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  await createCategory(app.database, { code: 'PET', label: 'Pet Care' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const { chromium } = await import(browserModule);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce', bypassCSP: Boolean(process.env.AXE_SOURCE) });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/seller/`);
  // Photos of different shapes (square, wide, tall) drawn in the browser, so the preview frame is tested with real images.
  const photos = await page.evaluate(() => [[600, 600], [900, 450], [450, 900], [600, 600], [800, 500], [500, 800], [600, 600], [1000, 400], [700, 700], [640, 480]].map(([w, h], i) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h }), c = canvas.getContext('2d');
    c.fillStyle = `hsl(${i * 45} 45% 70%)`; c.fillRect(0, 0, w, h); c.fillStyle = '#1d2b24'; c.font = 'bold 120px sans-serif'; c.fillText(String(i + 1), w / 2 - 35, h / 2 + 40);
    return canvas.toDataURL('image/png');
  }));
  await page.locator('#username').fill(username); await page.locator('#password').fill(password); await page.locator('#login-submit').click();
  await page.locator('#workspace').waitFor();
  // Seed through the real API with the browser's session.
  const productId = await page.evaluate(async ({ photos }) => {
    const csrf = await (await fetch('/api/v1/seller/session')).json().then((s) => s.csrfToken);
    const call = async (method, url, body) => { const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) }); const d = await r.json(); if (!r.ok) throw new Error(JSON.stringify(d)); return d; };
    const created = await call('POST', '/api/v1/seller/products', { sku: 'BAG-1', name: 'Pet carrier bag', description: 'Synthetic gallery fixture.', category: 'PET', priceMinor: 1790, currency: 'MYR', active: true, imageDataUrl: photos[0] });
    const detail = await (await fetch(`/api/v1/seller/products/${created.id}`)).json();
    await call('PATCH', `/api/v1/seller/products/${created.id}`, { expectedUpdatedAt: detail.updatedAt, gallery: [{ id: detail.galleryItems[0].id }, ...photos.slice(1, 8).map((imageDataUrl) => ({ imageDataUrl }))] });
    return created.id;
  }, { photos });
  const serverOrder = () => page.evaluate(async (id) => (await (await fetch(`/api/v1/seller/products/${id}`)).json()).galleryItems.map((item) => item.id), productId);
  const original = await serverOrder();
  assert.equal(original.length, 8);
  const openEditor = async () => {
    await page.evaluate(() => document.querySelector('[data-view=products]').click());
    await page.locator('.product-card').first().getByRole('button', { name: /edit/i }).first().click();
    await page.locator('#product-gallery-panel .product-gallery-item').nth(7).waitFor();
  };
  await openEditor();
  const cards = page.locator('#product-gallery-panel .product-gallery-item');
  const order = () => cards.evaluateAll((nodes) => nodes.map((node) => node.dataset.imageId));
  assert.deepEqual(await order(), original);
  assert.equal(await page.locator('#product-gallery-count').innerText(), '8 / 10 photos');

  // Anatomy: photo, position, a readable Primary badge on the first card only, at most one visible button plus More.
  const anatomy = await cards.evaluateAll((nodes) => nodes.map((node) => ({
    number: node.querySelector('.product-gallery-meta span').textContent, badge: node.querySelector('.product-gallery-badge')?.textContent || '',
    visibleButtons: [...node.querySelectorAll('button')].filter((b) => b.offsetParent !== null).length,
    setPrimary: Boolean(node.querySelector('[data-gallery-action=primary]')), menuHidden: node.querySelector('[role=menu]').hidden,
  })));
  assert.deepEqual(anatomy.map((a) => a.number), ['01', '02', '03', '04', '05', '06', '07', '08']);
  assert.equal(anatomy[0].badge, 'Primary image'); assert.ok(anatomy.slice(1).every((a) => a.badge === ''));
  assert.equal(anatomy[0].setPrimary, false); assert.ok(anatomy.slice(1).every((a) => a.setPrimary));
  assert.ok(anatomy.every((a) => a.menuHidden && a.visibleButtons <= 3), JSON.stringify(anatomy)); // view, set primary, more

  // Layout per width: the gallery spans the editor, cards are wide enough, buttons stay on one line, nothing overflows.
  for (const [width, height, columns] of [[1440, 900, 5], [1024, 768, 3], [768, 1024, 3], [430, 932, 2], [390, 844, 1], [320, 720, 1]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#product-gallery-panel .product-gallery-item')];
      const tops = new Set(items.map((node) => Math.round(node.getBoundingClientRect().top)));
      const firstRow = items.filter((node) => Math.round(node.getBoundingClientRect().top) === Math.min(...tops)).length;
      const primary = document.querySelector('#product-gallery-panel [data-gallery-action=primary]');
      const lineHeight = parseFloat(getComputedStyle(primary).lineHeight) || 18;
      const outside = items.some((node) => [...node.querySelectorAll('button')].some((b) => { const r = b.getBoundingClientRect(), c = node.getBoundingClientRect(); return r.width && (r.right > c.right + 1 || r.left < c.left - 1); }));
      const pricing = document.querySelector('.product-pricing-card').getBoundingClientRect(), panel = document.querySelector('.product-image-column').getBoundingClientRect();
      return { columns: firstRow, cardWidth: Math.round(items[0].getBoundingClientRect().width), wraps: primary.scrollHeight > lineHeight * 1.6 + 16, outside,
        overflow: document.documentElement.scrollWidth > innerWidth, imagesUnderPricing: panel.right >= pricing.right - 1 };
    });
    const at = `${width}px`;
    assert.equal(layout.columns, columns, `${at} ${JSON.stringify(layout)}`);
    assert.ok(layout.cardWidth >= 140, at); assert.equal(layout.wraps, false, `${at} Set as primary stays on one line`);
    assert.equal(layout.outside, false, at); assert.equal(layout.overflow, false, at);
    if (width >= 1051) assert.equal(layout.imagesUnderPricing, true, `${at} gallery uses the full editor width`);
    if (screenshots) await page.locator('#product-gallery-panel').screenshot({ path: `${screenshots}/gallery-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Keyboard menu: ArrowDown opens on the first enabled item, arrows move, Escape closes and returns focus; boundaries disabled.
  const more = (index) => cards.nth(index).locator('.product-gallery-more');
  await more(0).focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await more(0).getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.galleryAction), 'later', 'Move earlier is disabled on the first photo');
  assert.equal(await cards.nth(0).locator('[data-gallery-action=earlier]').isDisabled(), true);
  await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.dataset.galleryAction), 'remove');
  await page.keyboard.press('Escape');
  assert.equal(await more(0).getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('product-gallery-more')), true);
  await more(7).click(); assert.equal(await cards.nth(7).locator('[data-gallery-action=later]').isDisabled(), true);
  await page.mouse.click(5, 5); assert.equal(await cards.nth(7).locator('[role=menu]').isHidden(), true, 'a click outside closes the menu');
  if (screenshots) { await more(2).click(); await page.locator('#product-gallery-panel').screenshot({ path: `${screenshots}/gallery-menu.png` }); await page.keyboard.press('Escape'); }

  // Optional automated accessibility check (WCAG 2.2 A/AA rules) with a menu open: set AXE_SOURCE to axe.min.js.
  if (process.env.AXE_SOURCE) {
    await page.addScriptTag({ path: process.env.AXE_SOURCE });
    await more(2).click();
    const violations = await page.evaluate(async () => (await axe.run('#product-gallery-panel', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`));
    assert.deepEqual(violations, []);
    await page.keyboard.press('Escape');
  }
  // Staged edits: move later, set primary, remove. Focus follows the photo and the change is announced; nothing is sent yet.
  await more(0).click(); await cards.nth(0).locator('[data-gallery-action=later]').click();
  assert.deepEqual((await order()).slice(0, 2), [original[1], original[0]]);
  assert.equal(await page.evaluate(() => document.activeElement.closest('.product-gallery-item')?.dataset.imageId), original[0]);
  assert.match(await page.locator('#product-gallery-status').textContent(), /position 2/);
  assert.equal(await cards.nth(0).locator('.product-gallery-badge').innerText(), 'Primary image');
  await cards.nth(4).locator('[data-gallery-action=primary]').click();
  assert.equal((await order())[0], original[4]);
  await more(2).click(); await cards.nth(2).locator('[data-gallery-action=remove]').click();
  assert.equal(await page.locator('#product-gallery-count').innerText(), '7 / 10 photos');
  assert.deepEqual(await serverOrder(), original, 'staged: the server is unchanged before Save');

  // Cancel discards the staged gallery.
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#product-cancel').click();
  await openEditor();
  assert.deepEqual(await order(), original);

  // Preview: the photo opens a dialog; Escape closes it.
  await cards.nth(1).locator('.product-gallery-view').click();
  assert.equal(await page.locator('#product-photo-preview').isVisible(), true);
  assert.equal(await page.locator('#product-photo-preview h3').innerText(), 'View photo 2');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#product-photo-preview').isVisible(), false);

  // Save persists the intended order (primary = first photo) after a reload.
  await cards.nth(3).locator('[data-gallery-action=primary]').click();
  const intended = await order();
  await page.locator('#product-save').click();
  await page.waitForFunction(() => document.querySelector('#product-form-success')?.textContent.trim() !== '', null, { timeout: 20000 });
  assert.deepEqual(await serverOrder(), intended);
  await page.reload(); await page.locator('#workspace').waitFor(); await openEditor();
  assert.deepEqual(await order(), intended);
  assert.equal(await cards.nth(0).getAttribute('data-image-id'), original[3]);

  // Ten photos (the server ignores duplicate image bytes, so two new ones): the add input is disabled at the limit.
  await page.evaluate(async ({ id, photos }) => {
    const csrf = await (await fetch('/api/v1/seller/session')).json().then((s) => s.csrfToken);
    const detail = await (await fetch(`/api/v1/seller/products/${id}`)).json();
    const response = await fetch(`/api/v1/seller/products/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ expectedUpdatedAt: detail.updatedAt, gallery: [...detail.galleryItems.map((item) => ({ id: item.id })), { imageDataUrl: photos[8] }, { imageDataUrl: photos[9] }] }) });
    return { status: response.status, body: await response.text() };
  }, { id: productId, photos }).then((result) => assert.equal(result.status, 200, result.body));
  await page.reload(); await page.locator('#workspace').waitFor(); await openEditor();
  await cards.nth(9).waitFor();
  assert.equal(await page.locator('#product-gallery-count').innerText(), '10 / 10 photos');
  assert.equal(await page.locator('#product-gallery-panel input[name=gallery]').isDisabled(), true);
  assert.deepEqual(errors, []);
});
