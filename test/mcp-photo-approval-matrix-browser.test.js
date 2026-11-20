import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addGalleryImage } from '../src/products.js';
import { mediaToolsFixture } from './helpers/mcp-media-tools-fixture.js';
import { syntheticMediaPng } from './helpers/mcp-media-hooks-fixture.js';

const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
const screenshotDir = process.env.PHOTO_APPROVAL_SCREENSHOTS;
const assets = {
  '/shop/tokens.css': ['../public/shop/tokens.css', 'text/css'],
  '/shared/theme.css': ['../public/shared/theme.css', 'text/css'],
  '/shared/review-i18n.js': ['../public/shared/review-i18n.js', 'text/javascript'],
};
const dto = response => {
  assert.equal(response.response.status, 200, JSON.stringify(response.data));
  return response.data.result.structuredContent;
};

test('Chromium: approving five current gallery photos works across Seller themes, languages and widths',
  { skip: !browserModule, timeout: 90000 }, async t => {
    const fixture = await mediaToolsFixture(t, 'sqlite');
    const origin = fixture.config.sellerOrigin;
    for (let n = 1; n <= 4; n++) {
      await addGalleryImage(fixture.store, fixture.product.id,
        'data:image/png;base64,' + syntheticMediaPng(20 + n).toString('base64'));
    }
    const list = () => fixture.tool('media.list', { productId: fixture.product.id }).then(dto);
    const before = await list();
    assert.equal(before.items[0].gallery.length, 5);
    const operation = dto(await fixture.tool('media.preview_layout', {
      input: {
        productId: fixture.product.id, expectedRevision: before.revision,
        gallery: before.items[0].gallery.map(({ id }) => ({ id })), removeMain: false,
      },
      idempotencyKey: 'visual-confirm-five-gallery-photos',
    }));

    const { chromium } = await import(browserModule);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    t.after(() => context.close());
    const errors = [], external = [];
    const separator = fixture.cookie.indexOf('=');
    const cookie = {
      name: fixture.cookie.slice(0, separator), value: fixture.cookie.slice(separator + 1), url: origin, secure: true,
    };
    const routeReview = async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) {
        external.push(url.origin);
        return route.abort();
      }
      const asset = assets[url.pathname];
      if (asset) {
        const body = await readFile(new URL(asset[0], import.meta.url));
        return route.fulfill({ contentType: asset[1], body });
      }
      const method = request.method();
      const response = await fixture.api(new Request(url, {
        method, headers: await request.allHeaders(), ...(method !== 'GET' && { body: request.postDataBuffer() }),
      }), { clientAddress: 'synthetic-gallery-visual' });
      return route.fulfill({
        status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()),
      });
    };
    await context.addCookies([cookie]);
    await context.route('**/*', routeReview);

    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const review = origin + '/oauth/operation?operationId=' + operation.operationId;
    await page.goto(review);
    const approve = page.locator('#approve');
    const images = page.locator('.gallery-additions button.media-reference img');
    const summary = page.locator('#image-impact');
    await page.locator('#approve:enabled').waitFor();
    assert.equal(await approve.textContent(), 'Confirm gallery photos');
    assert.match(await summary.textContent(), /5 photos/);
    assert.equal(await images.count(), 5);
    assert.ok(await images.evaluateAll(nodes => nodes.every(node => node.complete && node.naturalWidth > 0 && node.src.startsWith('blob:'))));

    // Use the same verified assets to exercise the renderer with a synthetic
    // 1→5 diff. Restore the genuine confirmation before any seller decision.
    await page.evaluate(productId => {
      const effects = JSON.parse(document.querySelector('#media-effect-records').textContent);
      const listing = effects.find(effect => effect.kind === 'LISTING');
      listing.before.galleryAssetKeys = listing.after.galleryAssetKeys.slice(0, 1);
      const proposal = { productId, targetSlot: 'GALLERY' };
      const change = imageChangeSummary('media.prepare_upload', proposal, effects);
      renderMediaEffects(effects, [{ productId, sku: 'MEDIA-TARGET', name: 'Synthetic MEDIA-TARGET' }], proposal, change);
      renderImageChangeSummary(change);
      document.querySelector('.intro').textContent = 'Check the proposed change before approving.';
      for (const button of document.querySelectorAll('.gallery-additions .media-reference')) {
        const preview = button.querySelector('img');
        preview.src = objectUrls.get(button.dataset.assetKey);
        preview.hidden = false;
      }
      updateReviewControls();
    }, fixture.product.id);
    assert.equal(await page.locator('h1').textContent(), 'Add 4 gallery photos');
    assert.equal(await approve.textContent(), 'Approve adding 4 photos');
    assert.match(await summary.textContent(), /Gallery goes from 1 to 5 photos · Main photo stays the same/);
    assert.equal(await images.count(), 4);
    assert.ok(await images.evaluateAll(nodes => nodes.every(node => node.src.startsWith('blob:'))));
    assert.equal(await page.locator('.gallery-existing').getAttribute('open'), null);
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, 'gallery-add-four-mobile.png'), fullPage: true });
    }
    await page.reload();
    await page.locator('#approve:enabled').waitFor();
    assert.equal(await approve.textContent(), 'Confirm gallery photos');

    const themeSelect = page.locator('#review-theme');
    await themeSelect.selectOption('system');
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await page.locator(`html[data-theme="${colorScheme}"]`).waitFor();
    }

    if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
    for (const language of ['en', 'zh-CN']) {
      if (language !== 'en') {
        await page.locator('#review-language').selectOption(language);
        await page.locator('html[lang="zh-CN"]').waitFor();
        await page.locator('#approve:enabled').waitFor();
        assert.equal(await approve.textContent(), '确认相册照片');
      }
      for (const theme of ['light', 'dark']) {
        await themeSelect.selectOption(theme);
        // A 720 CSS-pixel viewport checks the reflow of 1440 pixels at 200% zoom.
        for (const width of [320, 390, 720, 768, 1440]) {
          await page.setViewportSize({ width, height: 844 });
          const metric = await page.evaluate(async () => {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const box = selector => document.querySelector(selector).getBoundingClientRect();
            const grid = getComputedStyle(document.querySelector('.gallery-additions')).gridTemplateColumns.split(' ');
            const palette = getComputedStyle(document.documentElement).colorScheme;
            const css = selector => getComputedStyle(document.querySelector(selector));
            const luminance = rgb => {
              const linear = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255)
                .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
              return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
            };
            const contrast = (foreground, background) => {
              const pair = [luminance(foreground), luminance(background)];
              return (Math.max(...pair) + .05) / (Math.min(...pair) + .05);
            };
            window.scrollTo(0, document.scrollingElement.scrollHeight);
            return {
              overflow: document.documentElement.scrollWidth > innerWidth,
              action: box('#approve').height,
              clearance: box('#decision').top - box('footer').bottom,
              columns: grid.length,
              palette,
              firstRowContainsTwo: Math.abs(box('.gallery-additions > li:first-child').top -
                box('.gallery-additions > li:nth-child(2)').top) < 1,
              buttonContrast: contrast(css('#approve').color, css('#approve').backgroundColor),
              secondaryContrast: contrast(css('#media-progress').color, css('.review-summary').backgroundColor),
              controlContrast: contrast(css('.media-reference').borderTopColor, css('.media-reference').backgroundColor),
            };
          });
          const fixtureLabel = `${language}/${theme}/${width}`;
          assert.equal(metric.palette, theme, fixtureLabel);
          assert.equal(metric.overflow, false, fixtureLabel);
          assert.ok(metric.action >= 44, fixtureLabel);
          assert.ok(metric.buttonContrast >= 4.5, fixtureLabel);
          assert.ok(metric.secondaryContrast >= 4.5, fixtureLabel);
          assert.ok(metric.controlContrast >= 3, fixtureLabel);
          assert.equal(metric.columns, width < 700 ? 2 : 5, fixtureLabel);
          if (width < 640) {
            assert.ok(metric.clearance >= 16, fixtureLabel);
            assert.ok(metric.firstRowContainsTwo, fixtureLabel);
          }
          if (screenshotDir && [390, 768, 1440].includes(width)) {
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: join(screenshotDir, `gallery-${language}-${theme}-${width}.png`), fullPage: true });
          }
        }
      }
    }

    if (process.env.PHOTO_APPROVAL_NATIVE_ZOOM === '1') {
      const profile = await mkdtemp(join(tmpdir(), 'seller-photo-approval-zoom-'));
      let zoomContext;
      try {
        zoomContext = await chromium.launchPersistentContext(profile, {
          channel: 'chrome', headless: true, viewport: null, args: ['--window-size=1440,900', '--lang=en-US'],
        });
        const settings = zoomContext.pages()[0];
        await settings.goto('chrome://settings/appearance');
        const zoomControl = settings.getByLabel('Page zoom', { exact: true });
        await zoomControl.selectOption('1');
        await zoomContext.addCookies([cookie]);
        await zoomContext.route('https://**/*', routeReview);
        const zoomPage = await zoomContext.newPage();
        zoomPage.on('pageerror', error => errors.push(error.message));
        await zoomPage.goto(review);
        await zoomPage.locator('#review-language').selectOption('zh-CN');
        await zoomPage.locator('#approve:enabled').waitFor();
        await zoomPage.locator('#review-theme').selectOption('dark');
        const baseline = await zoomPage.evaluate(() => ({ width: innerWidth, density: devicePixelRatio }));
        await zoomControl.selectOption('2');
        await zoomPage.waitForFunction(density => Math.abs(devicePixelRatio / density - 2) < .05, baseline.density);
        const zoomed = await zoomPage.evaluate(() => ({
          width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
          button: document.querySelector('#approve').getBoundingClientRect().height,
          pinchScale: visualViewport.scale,
        }));
        assert.ok(Math.abs(zoomed.width - baseline.width / 2) <= 1, 'real Chrome page zoom halves CSS width');
        assert.equal(zoomed.pinchScale, 1, 'page zoom is distinct from pinch magnification');
        assert.equal(zoomed.overflow, false);
        assert.ok(zoomed.button >= 44);
        if (screenshotDir) {
          await zoomPage.locator('.gallery-additions').scrollIntoViewIfNeeded();
          const session = await zoomContext.newCDPSession(zoomPage);
          try {
            const { data } = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            await writeFile(join(screenshotDir, 'native-chrome-200-percent.png'), Buffer.from(data, 'base64'));
          } finally { await session.detach(); }
        }
      } finally {
        await zoomContext?.close();
        await rm(profile, { recursive: true, force: true });
      }
      // Opening the proposal again supersedes its one-use review challenge.
      await page.reload();
      await page.locator('#approve:enabled').waitFor();
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const firstImage = page.locator('.gallery-additions .media-reference').first();
    await firstImage.click();
    const dialog = page.locator('#image-dialog');
    await dialog.waitFor();
    const zoom = page.locator('#image-zoom');
    const initial = await zoom.getAttribute('src');
    await page.keyboard.press('ArrowRight');
    assert.notEqual(await zoom.getAttribute('src'), initial);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(await firstImage.evaluate(element => element === document.activeElement));

    await approve.click();
    await page.locator('#result-dialog').waitFor();
    const status = () => fixture.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', operation.operationId);
    assert.equal((await status()).state, 'APPROVED');
    assert.deepEqual(await list(), before);
    await page.reload();
    await page.locator('#pending-state').filter({ hasText: /相册已确认|Gallery confirmed/ }).waitFor();
    const commit = dto(await fixture.tool('media.commit_layout', { operationId: operation.operationId }));
    assert.equal(commit.status, 'COMMITTED');
    assert.equal((await status()).state, 'COMMITTED');
    assert.deepEqual(await list(), before);
    await page.reload();
    await page.locator('#pending-state').filter({ hasText: /相册已确认|Gallery confirmed/ }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  });
