import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertDecisionClearance, catalogReviewBrowserFixture, digest, injection, operationId as id } from './helpers/mcp-operation-review-browser-fixture.js';

const browserModule = process.env.QA_PLAYWRIGHT_MODULE;
const origin = 'https://approval.test';
const proposalPath = `/api/v1/seller/mcp/operations/${id}`;
const sessionPath = '/api/v1/seller/session';
const reviewUrl = `${origin}/oauth/operation?operationId=${id}`;

async function serveFixture(route, respond) {
  const request = route.request();
  const result = await respond(new Request(request.url(), {
    method: request.method(), headers: request.headers(), body: request.postDataBuffer(),
  }));
  await route.fulfill({
    status: result.status, headers: Object.fromEntries(result.headers),
    body: Buffer.from(await result.arrayBuffer()),
  });
}

async function assertNamedTargets(scope) {
  const controls = scope.locator('a[href]:visible, button:visible, input:visible, summary:visible, pre[tabindex="0"]:visible');
  for (const control of await controls.all()) {
    const snapshot = await control.ariaSnapshot();
    // Playwright snapshots may represent a native summary by its accessible text.
    const name = /^- [\w]+ "[^"]+"/.test(snapshot) || /^- text: \S/.test(snapshot);
    assert.ok(name, `Control has an accessible name: ${snapshot}`);
    const box = await control.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `44px target: ${snapshot}`);
  }
}

test('first-party review prototype renders all untrusted data as text and requires an explicit decision',
  { skip: !browserModule, timeout: 60000 }, async (t) => {
    const { calls, respond } = await catalogReviewBrowserFixture();
    const { chromium } = await import(browserModule);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const backgrounds = new Map();
    const scenarios = [320, 360, 379, 380, 390, 768, 1440].flatMap(width => ['light', 'dark'].map(colorScheme => [width, width === 390 ? '/alpha' : '', colorScheme === 'dark' ? 'reject' : 'approve', colorScheme]));
    for (const [index, [width, base, decision, colorScheme]] of scenarios.entries()) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme });
      t.after(() => context.close());
      const external = [];
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === origin) return serveFixture(route, respond);
        external.push(route.request().url()); return route.abort();
      });
      const page = await context.newPage();
      await page.goto(`${origin}${base}/oauth/operation?operationId=${id}`);
      await page.locator('#review').waitFor({ state: 'visible' });
      if (width === 390) await assertDecisionClearance(page, 'catalog');
      assert.equal(await page.evaluate(() => window.__injected), undefined);
      assert.equal(await page.locator('#proposal script').count(), 0);
      assert.equal(await page.locator('#client script').count(), 0);
      assert.equal(await page.locator('#client').textContent(), injection);
      assert.equal(await page.locator('#technical-details').getAttribute('open'), null);
      const summary = await page.locator('#summary-fields').textContent();
      for (const value of ['Old synthetic', 'OLD', '123', 'USD', '7', 'Old category', 'Old description', 'NEW', '456', 'New category', 'New description']) assert.ok(summary.includes(value), value);
      assert.match(summary, /minor units/i);
      assert.match(summary, /currency not provided/i);
      const description = page.locator('.summary-field').filter({ has: page.getByRole('heading', { name: 'Description Changed' }) });
      assert.equal(await description.locator('.changed-badge').textContent(), 'Changed');
      const before = description.locator('.comparison > div').first();
      const after = description.locator('.comparison > div').last();
      assert.equal(await before.locator('dt').textContent(), 'Before');
      assert.equal(await after.locator('dt').textContent(), 'After');
      const beforeBox = await before.boundingBox(), afterBox = await after.boundingBox();
      if (width < 640) assert.ok(afterBox.y >= beforeBox.y + beforeBox.height, `stacked comparison at ${width}px`);
      else assert.equal(afterBox.y, beforeBox.y);
      const unchanged = page.locator('.unchanged-fields');
      assert.equal(await unchanged.getAttribute('open'), null);
      assert.match(await unchanged.locator('summary').textContent(), /^Unchanged fields \(3\)$/);
      assert.equal(await unchanged.getByText('Options', { exact: true }).isVisible(), false);
      if (width === 390) {
        await page.evaluate(() => window.scrollTo(0, 0));
        const bar = page.locator('#decision');
        assert.equal(await bar.evaluate(node => getComputedStyle(node).position), 'fixed');
        const box = await bar.boundingBox();
        assert.ok(box.y > 0 && box.y + box.height <= 844, 'decision bar fits in the initial viewport');
        assert.equal(await page.locator('#approve').evaluate(button => {
          const box = button.getBoundingClientRect();
          return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button;
        }), true);
        await page.evaluate(() => window.scrollTo(0, 120));
        const scrolled = await bar.boundingBox();
        assert.ok(Math.abs(scrolled.y - box.y) < 1, 'decision bar stays anchored while scrolling');
        await assertNamedTargets(page);
        await unchanged.locator('summary').click();
        assert.equal(await unchanged.getByText('Options', { exact: true }).isVisible(), true);
        await unchanged.locator('summary').click();
      }
      await page.locator('#technical-details > summary').click();
      assert.equal(await page.locator('#proposal').isVisible(), true);
      if (width === 390) await assertNamedTargets(page);
      const displayed = await page.locator('#proposal').textContent();
      assert.ok(displayed.includes(injection));
      assert.ok(displayed.includes('Full proposal visible'));
      assert.ok(displayed.includes('\\u202e'));
      assert.equal(calls.length, index); // no automatic approval
      const background = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
      if (colorScheme === 'light') backgrounds.set(width, background);
      else assert.notEqual(background, backgrounds.get(width));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /object-src 'none'/);
      assert.deepEqual(external, []);
      if (process.env.QA_APPROVAL_SCREENSHOT_DIR) {
        await mkdir(process.env.QA_APPROVAL_SCREENSHOT_DIR, { recursive: true });
        await page.locator('#technical-details > summary').click();
        await page.screenshot({ path: join(process.env.QA_APPROVAL_SCREENSHOT_DIR, `approval-${width}-${colorScheme}.png`), fullPage: true });
      }
      assert.equal(await page.locator('#seller-link').getAttribute('href'), `${base}/seller/`);
      assert.equal(await page.locator('#approve').textContent(), 'Approve change');
      assert.equal(await page.locator('button[value="reject"]').textContent(), 'Reject');
      assert.ok((await page.locator('#approve').boundingBox()).height >= 44);
      assert.ok((await page.locator('button[value="reject"]').boundingBox()).height >= 44);
      await page.locator(`button[value="${decision}"]`).click();
      const approved = decision === 'approve';
      const dialog = page.getByRole('alertdialog', { name: approved ? 'Approved' : 'Rejected', exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.evaluate(node => node.matches(':modal')), true);
      assert.equal(await dialog.locator('#result-description').textContent(), approved
        ? `Return to ${injection} to apply this change.`
        : 'No change was made.');
      assert.equal(await dialog.locator('svg').isVisible(), approved);
      assert.equal(await page.locator('#status').textContent(), approved
        ? `Approved · Waiting to be applied. Return to ${injection} to apply this change.`
        : 'Rejected. No change was made.');
      assert.equal(await page.locator('#status').getAttribute('aria-live'), 'polite');
      assert.equal(await page.locator('#status').evaluate(node => getComputedStyle(node).clipPath), 'inset(50%)');
      const close = dialog.getByRole('button', { name: 'Close', exact: true });
      assert.ok((await close.boundingBox()).height >= 44);
      if (width === 390) await assertNamedTargets(dialog);
      assert.equal(await close.evaluate(node => node === document.activeElement), true);
      if (approved || width === 390) await close.click();
      else await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('#status:focus').waitFor();
      assert.match(await page.getByRole('status').ariaSnapshot(), approved ? /Approved/ : /Rejected/);
      assert.equal(await page.locator('#pending-state').textContent(), approved ? 'Approved · Waiting to be applied' : 'Rejected');
      assert.equal(await page.locator('#check-status').isVisible(), approved);
      assert.equal(await page.locator('#decision').isVisible(), false);
      const call = calls.at(-1);
      assert.equal(call.path, `${base}/api/v1/seller/mcp/operations/${id}/approval`);
      assert.equal(call.csrf, 'synthetic-csrf');
      assert.deepEqual(call.body, { operationId: id, previewHash: digest, challenge: 'a'.repeat(43), decision });
      assert.equal(await page.locator('#decision input[type=password]').count(), 0);
      await context.close();
    }
  });

test('review recovers from transient proposal failures and reports pending and uncertain decisions',
  { skip: !browserModule, timeout: 60000 }, async (t) => {
    const { respond } = await catalogReviewBrowserFixture();
    const { chromium } = await import(browserModule);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin
      ? serveFixture(route, respond) : route.abort());

    for (const failure of ['network', 503]) {
      await t.test(`retry loads the same proposal after ${failure}`, async (t) => {
        const page = await context.newPage();
        t.after(() => page.close());
        const requests = [];
        page.on('request', request => {
          const path = new URL(request.url()).pathname;
          if (path.startsWith('/api/')) requests.push([request.method(), path]);
        });
        await page.route(origin + proposalPath, route => failure === 'network'
          ? route.abort('failed') : route.fulfill({ status: failure }), { times: 1 });
        await page.goto(reviewUrl);
        const retry = page.getByRole('button', { name: 'Try again', exact: true });
        await retry.waitFor();
        assert.equal(await page.getByRole('status').textContent(), 'The proposal is unavailable. Try again to load this preview.');
        assert.equal(await page.locator('#review').isVisible(), false);
        await retry.click();
        await page.locator('#review').waitFor();
        assert.equal(await retry.isVisible(), false);
        assert.equal(await page.locator('#approve').isEnabled(), true);
        assert.equal(page.url(), reviewUrl);
        assert.deepEqual(requests, [['GET', sessionPath], ['GET', proposalPath], ['GET', sessionPath], ['GET', proposalPath]]);
      });
    }

    await t.test('an expired proposal asks for a new preview without a retry button', async (t) => {
      const page = await context.newPage();
      t.after(() => page.close());
      await page.route(origin + proposalPath, async route => {
        const proposal = await respond(new Request(route.request().url()));
        await route.fulfill({ json: { ...await proposal.json(), expiresAt: new Date(Date.now() - 10000).toISOString() } });
      });
      await page.goto(reviewUrl);
      await page.getByRole('status').filter({ hasText: 'Proposal expired. Ask the connected app for a new preview.' }).waitFor();
      assert.equal(await page.locator('#proposal-retry').isVisible(), false);
      assert.equal(await page.locator('#approve').isDisabled(), true);
    });

    for (const [name, path, failure, message] of [
      ['session 401', sessionPath, { status: 401 }, 'Sign in to Seller Studio to review this proposal.'],
      ['proposal 401', proposalPath, { status: 401 }, 'Sign in to Seller Studio to review this proposal.'],
      ['proposal 403', proposalPath, { status: 403 }, 'The proposal is unavailable. Ask the connected app to prepare a new preview.'],
      ['invalid proposal', proposalPath, { json: {} }, 'The proposal is unavailable. Ask the connected app to prepare a new preview.'],
    ]) {
      await t.test(`${name} has its own next step without a retry button`, async (t) => {
        const page = await context.newPage();
        t.after(() => page.close());
        await page.route(origin + path, route => route.fulfill(failure));
        await page.goto(reviewUrl);
        await page.getByText(message, { exact: true }).waitFor();
        assert.equal(await page.locator('#proposal-retry').isVisible(), false);
        assert.equal(await page.locator('#review').isVisible(), false);
        if (failure.status === 401) {
          assert.equal(await page.getByRole('link', { name: 'Sign in to review this proposal' }).getAttribute('href'),
            `/seller/?reviewOperation=${id}`);
        }
      });
    }

    for (const [decision, message, failure] of [['approve', 'Approving…', 'network'], ['reject', 'Rejecting…', 500]]) {
      await t.test(`${decision} shows progress then offers a read-only status check after ${failure}`, async (t) => {
        const page = await context.newPage();
        t.after(() => page.close());
        const release = Promise.withResolvers();
        let submissions = 0;
        await page.route(`${origin}${proposalPath}/approval`, async route => {
          submissions += 1;
          await release.promise;
          if (failure === 'network') await route.abort('failed');
          else await route.fulfill({ status: failure });
        });
        await page.goto(reviewUrl);
        const panel = page.getByRole('form', { name: 'Your decision' });
        const approve = panel.getByRole('button', { name: 'Approve change', exact: true });
        const reject = panel.getByRole('button', { name: 'Reject', exact: true });
        const status = panel.getByRole('status');
        try {
          await (decision === 'approve' ? approve : reject).click();
          await status.filter({ hasText: message }).waitFor();
          assert.equal(await status.textContent(), message);
          assert.equal(await approve.isDisabled(), true);
          assert.equal(await reject.isDisabled(), true);
          await reject.evaluate(button => button.form.dispatchEvent(new SubmitEvent('submit', {
            cancelable: true, submitter: button,
          })));
        } finally {
          release.resolve();
        }
        const reloadMessage = 'We could not confirm the result. Check the status before trying again.';
        await status.filter({ hasText: reloadMessage }).waitFor();
        assert.equal(await status.textContent(), reloadMessage);
        assert.equal(await page.getByRole('alertdialog').isVisible(), false);
        assert.equal(await page.locator('#proposal-retry').isVisible(), false);
        assert.equal(await approve.isDisabled(), true);
        assert.equal(await reject.isDisabled(), true);
        const check = page.getByRole('button', { name: 'Check status', exact: true });
        await check.click();
        await page.locator('#approve:enabled').waitFor();
        assert.equal(await check.isVisible(), false);
        assert.equal(submissions, 1);
      });
    }
  });
