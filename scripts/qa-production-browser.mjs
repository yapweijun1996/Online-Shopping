// Read-only production smoke in a separate Chrome profile. No authentication or order mutations.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const phase = process.argv[2];
if (!['prepare-r2', 'verify-r2', 'replay-r2'].includes(phase)) throw new Error('Use prepare-r2 before deployment or verify-r2 after deployment.');
const settings = JSON.parse(await readFile('output/qa/multi-tenant/environment.json', 'utf8'));
const { chromium } = await import(pathToFileURL(settings.playwright));
const profile = join(settings.scratch, 'production-browser-profile'); await mkdir(profile, { recursive: true, mode: 0o700 });
const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 } });
const report = { phase, pageErrors: [], unexpectedConsoleErrors: [], expectedUnauthorized: 0, offers: {}, surfaces: [] };
await context.exposeBinding('recordUpdateOffer', ({ page }, version) => { const host = new URL(page.url()).host; const versions = report.offers[host] ||= []; if (!versions.includes(version)) versions.push(version); });
await context.addInitScript(() => {
  const inspect = () => {
    for (const button of document.querySelectorAll('.pwa-update button, .shop-update-settings .primary-button, .shop-update-banner button, #login-install-update, #install-update-button')) {
      if (button.hidden || !button.getClientRects().length) continue;
      const version = button.textContent.match(/\bv\d+\b/)?.[0];
      if (version) { console.debug('QA_UPDATE_OFFER:' + version); window.recordUpdateOffer(version); }
    }
  };
  addEventListener('DOMContentLoaded', () => { new MutationObserver(inspect).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); inspect(); });
});
const pages = [];
try {
  for (const surface of ['shop', 'seller']) {
    const url = `https://${surface}.gmb01.xyz/${surface}/`, page = await context.newPage(); pages.push(page);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    page.on('console', (message) => { if (message.text().startsWith('QA_UPDATE_OFFER:')) { const versions = report.offers[new URL(page.url()).host] ||= []; const version = message.text().slice('QA_UPDATE_OFFER:'.length); if (!versions.includes(version)) versions.push(version); } if (message.type() === 'error') { if (/401/.test(message.text())) report.expectedUnauthorized++; else report.unexpectedConsoleErrors.push(message.text()); } });
    if (phase === 'replay-r2') {
      // Reconstruct the prior released worker only in this disposable browser profile. The server is read-only.
      const script = execFileSync('git', ['show', `71f5d27b1abc1471e6b7e8da740138dd122a58b2:public/${surface}/sw.js`], { encoding: 'utf8' });
      const previousScript = url + 'sw.js?qa-previous-r2=' + Date.now();
      const html = execFileSync('git', ['show', `71f5d27b1abc1471e6b7e8da740138dd122a58b2:public/${surface}/index.html`], { encoding: 'utf8' });
      await context.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: route.request().resourceType() === 'document' ? '<!doctype html><link rel="icon" href="data:,"><title>Previous release worker replay</title>' : html }));
      const previousAssets = `https://${surface}.gmb01.xyz/**`;
      await context.route(previousAssets, (route) => {
        const path = new URL(route.request().url()).pathname;
        if (!/\.(?:js|css)$/.test(path) || path.endsWith('/sw.js')) return route.continue();
        try { const body = execFileSync('git', ['show', '71f5d27b1abc1471e6b7e8da740138dd122a58b2:public' + path], { stdio: ['ignore', 'pipe', 'ignore'] });
          return route.fulfill({ status: 200, contentType: path.endsWith('.js') ? 'application/javascript' : 'text/css', body }); }
        catch { return route.continue(); }
      });
      await context.route(previousScript, (route) => { report.interceptedPreviousWorker = (report.interceptedPreviousWorker || 0) + 1; return route.fulfill({ status: 200, contentType: 'application/javascript', body: script }); });
      await page.goto(url);
      await page.evaluate(async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); for (const key of await caches.keys()) await caches.delete(key); });
      await page.goto(url);
      await page.evaluate(async (previousScript) => {
        const registration = await navigator.serviceWorker.register(previousScript, { scope: './', updateViaCache: 'none' });
        await new Promise((resolve) => { const check = () => { const worker = registration.waiting || registration.installing;
          if (registration.waiting) { registration.waiting.postMessage({ type: 'SKIP_WAITING' }); }
          if (registration.active?.scriptURL === previousScript) return resolve(); setTimeout(check, 100); }; check(); });
      }, previousScript);
      await page.waitForFunction(async () => { const r = await navigator.serviceWorker.getRegistration(); return r.active?.scriptURL.includes('qa-previous-r2') && !r.waiting; });
      const prior = await page.evaluate(async () => new Promise((resolve) => { const c = new MessageChannel(); c.port1.onmessage = ({ data }) => resolve(data.version); navigator.serviceWorker.getRegistration().then((r) => r.active.postMessage({ type: 'GET_VERSION' }, [c.port2])); }));
      assert.equal(prior, surface === 'shop' ? 'v143' : 'v134');
      await context.unroute(url); await context.unroute(previousScript); await context.unroute(previousAssets);
      report.replayedPreviousRelease = '71f5d27b1abc1471e6b7e8da740138dd122a58b2';
    }
    assert.equal((await page.goto(url)).status(), 200);
    await page.waitForFunction(() => window.shopPalette || window.sellerPalette);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const expected = surface === 'shop' ? phase === 'prepare-r2' ? 'v143' : 'v144' : phase === 'prepare-r2' ? 'v134' : 'v135';
    if (phase === 'prepare-r2') {
      const cdp = await context.newCDPSession(page);
      await cdp.send('PWA.install', { manifestId: url, installUrlOrBundleUrl: url });
      await cdp.send('PWA.getOsAppState', { manifestId: url });
    } else {
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    }
    await page.waitForFunction(async (expected) => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration?.active) return false;
      const actual = await new Promise((resolve) => { const channel = new MessageChannel(); const timer = setTimeout(() => resolve(null), 3000);
        channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data.version); }; registration.active.postMessage({ type: 'GET_VERSION' }, [channel.port2]); });
      return actual === expected && !registration.waiting;
    }, expected, { timeout: 45_000 });
    if (surface === 'shop') await page.locator('#catalog-view').waitFor();
    else await page.locator('#login-form').waitFor();
    const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).json());
    assert.equal(manifest.id, `/${surface}/`); assert.equal(manifest.scope, manifest.id); assert.equal(manifest.start_url, manifest.id);
    report.surfaces.push({ surface, activeVersion: expected, installed: true, manifestId: manifest.id });
  }
  if (phase !== 'prepare-r2') {
    assert.deepEqual(report.offers['shop.gmb01.xyz'], ['v144']); assert.deepEqual(report.offers['seller.gmb01.xyz'], ['v135']);
    for (const page of pages) { await page.waitForTimeout(1000); const cdp = await context.newCDPSession(page); await cdp.send('PWA.uninstall', { manifestId: page.url().split('#')[0] }); }
  }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.unexpectedConsoleErrors, []);
  await writeFile(`output/qa/multi-tenant/r2-production-browser-${phase}.json`, JSON.stringify(report, null, 2));
  console.log(`Production Chrome ${phase}: both legacy surfaces passed.`);
} finally { await writeFile(`output/qa/multi-tenant/r2-production-browser-${phase}.json`, JSON.stringify(report, null, 2)); await context.close(); }
