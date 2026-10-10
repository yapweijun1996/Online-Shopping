// Read-only production smoke in a separate Chrome profile. No authentication or order mutations.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const phase = process.argv[2];
if (!['prepare-r2', 'verify-r2'].includes(phase)) throw new Error('Use prepare-r2 before deployment or verify-r2 after deployment.');
const settings = JSON.parse(await readFile('output/qa/multi-tenant/environment.json', 'utf8'));
const { chromium } = await import(pathToFileURL(settings.playwright));
const profile = join(settings.scratch, 'production-browser-profile'); await mkdir(profile, { recursive: true, mode: 0o700 });
const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 } });
const report = { phase, pageErrors: [], unexpectedConsoleErrors: [], expectedUnauthorized: 0, offers: {}, surfaces: [] };
await context.exposeBinding('recordUpdateOffer', ({ page }, version) => { const host = new URL(page.url()).host; const versions = report.offers[host] ||= []; if (!versions.includes(version)) versions.push(version); });
await context.addInitScript(() => {
  const inspect = () => {
    for (const button of document.querySelectorAll('.pwa-update button, .shop-update-settings button, .shop-update-banner button')) {
      if (button.hidden || button.disabled || !button.getClientRects().length) continue;
      const version = button.textContent.match(/\bv\d+\b/)?.[0];
      if (version) window.recordUpdateOffer(version);
    }
  };
  addEventListener('DOMContentLoaded', () => { new MutationObserver(inspect).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); inspect(); });
});
const pages = [];
try {
  for (const surface of ['shop', 'seller']) {
    const url = `https://${surface}.gmb01.xyz/${surface}/`, page = await context.newPage(); pages.push(page);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') { if (/401/.test(message.text())) report.expectedUnauthorized++; else report.unexpectedConsoleErrors.push(message.text()); } });
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
  if (phase === 'verify-r2') {
    assert.deepEqual(report.offers['shop.gmb01.xyz'], ['v144']); assert.deepEqual(report.offers['seller.gmb01.xyz'], ['v135']);
    for (const page of pages) { await page.waitForTimeout(1000); const cdp = await context.newCDPSession(page); await cdp.send('PWA.uninstall', { manifestId: page.url().split('#')[0] }); }
  }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.unexpectedConsoleErrors, []);
  await writeFile(`output/qa/multi-tenant/r2-production-browser-${phase}.json`, JSON.stringify(report, null, 2));
  console.log(`Production Chrome ${phase}: both legacy surfaces passed.`);
} finally { await context.close(); }
