import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

const out = '/tmp/seller-boot-shots';
const loader = '#seller-boot-loader';
const dashboard = '#workspace .dashboard-home .dashboard-card';
const config = {
  dbPath: ':memory:', shopMode: 'manual', username: 'synthetic_seller_boot',
  password: randomUUID() + randomUUID(), production: false, publicOrigin: null,
};

async function assertBooting(page) {
  await page.locator(loader).waitFor({ state: 'visible' });
  assert.equal(await page.locator(`${loader}[hidden]`).count(), 0, 'the loader is not hidden during boot');
  assert.equal(await page.locator('body.seller-booting').count(), 1);
}

async function assertReady(page, screen) {
  await page.locator(screen).waitFor({ state: 'visible' });
  await page.locator(`${loader}[hidden]`).waitFor({ state: 'attached' });
  assert.equal(await page.locator(loader).isVisible(), false, 'the loader is no longer visible');
  assert.equal(await page.locator('body.seller-booting').count(), 0);
}

async function reloadWithHeldGet(page, heldGets, url, inspect, respond = (route) => route.continue()) {
  const release = Promise.withResolvers();
  heldGets.set(url, async (route) => {
    await release.promise;
    return respond(route);
  });
  try {
    await Promise.all([
      page.waitForRequest((request) => request.url() === url && request.method() === 'GET'),
      page.reload({ waitUntil: 'commit' }),
    ]);
    return await inspect();
  } finally {
    heldGets.delete(url);
    release.resolve();
  }
}

async function signIn(page, origin) {
  await page.goto(`${origin}/seller/`);
  await assertReady(page, '#login-view');
  await page.evaluate(({ username, password }) => {
    document.querySelector('#username').value = username;
    document.querySelector('#password').value = password;
  }, { username: config.username, password: config.password });
  const [response] = await Promise.all([
    page.waitForResponse((result) => result.url() === `${origin}/api/v1/seller/session` && result.request().method() === 'POST'),
    page.locator('#login-submit').click(),
  ]);
  assert.equal(response.status(), 200, 'fixture sign-in succeeds');
  await assertReady(page, dashboard);
}

async function checkBootstrapError(page, origin, heldGets) {
  const bootElement = await reloadWithHeldGet(page, heldGets, `${origin}/api/v1/shop`, async () => {
    await assertBooting(page);
    return page.locator(loader).elementHandle();
  }, (route) => route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } }));
  try {
    await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
    await page.locator(loader).waitFor({ state: 'hidden' });
    // The error screen replaces the body contents; verify the original element was hidden first.
    assert.equal(await bootElement.evaluate((node) => node.hasAttribute('hidden')), true);
    assert.equal(await page.locator('body.seller-booting').count(), 0);
  } finally {
    await bootElement.dispose();
  }
}

const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
const app = await createApp(config);
let browser;
try {
  const listening = once(app.server, 'listening');
  app.server.listen(0, '127.0.0.1');
  await listening;
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ headless: true });
  mkdirSync(out, { recursive: true });

  for (const width of [1280, 390]) {
    for (const theme of ['light', 'dark']) {
      const mobile = width === 390;
      const context = await browser.newContext({
        viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile,
        colorScheme: theme, reducedMotion: 'no-preference', serviceWorkers: 'block',
      });
      try {
        const heldGets = new Map();
        await context.route('**/*', (route) => {
          const request = route.request();
          if (new URL(request.url()).origin !== origin) return route.abort();
          const respond = request.method() === 'GET' && heldGets.get(request.url());
          return respond ? respond(route) : route.continue();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(12000);
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await signIn(page, origin);
        const shot = join(out, `seller-boot-${mobile ? 'mobile' : 'desktop'}-${width}-${theme}.png`);

        // Let the real session restore, but keep the first dashboard screen pending until the shot is taken.
        await reloadWithHeldGet(page, heldGets, `${origin}/api/v1/seller/setup`, async () => {
          await page.locator('#workspace .dashboard-loading').waitFor({ state: 'attached' });
          await assertBooting(page);
          assert.equal(await page.locator(dashboard).count(), 0);
          assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
          const art = page.locator(`${loader} img:visible`);
          await art.waitFor();
          const artwork = await art.evaluate(async (img) => {
            await img.decode();
            return new URL(img.currentSrc).pathname;
          });
          assert.equal(artwork, `/shared/brand/pomelo-placeholder-loader${theme === 'dark' ? '-dark' : ''}.svg`);
          assert.ok(!(await page.locator('#password').inputValue()), 'fixture password must not appear in the screenshot');
          await page.screenshot({ path: shot });
        });
        await assertReady(page, dashboard);
        console.log(`PASS ${width}px ${theme}: ${shot}`);

        if (!mobile && theme === 'light') {
          await checkBootstrapError(page, origin, heldGets);
          console.log('PASS bootstrap error clears the loader');
        }
        assert.deepEqual(pageErrors, []);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  try {
    await browser?.close();
  } finally {
    if (app.server.listening) await app.close();
    else await app.database.close();
  }
}
