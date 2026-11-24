import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const operationId = '00000000-0000-4000-8000-000000000001';
export const digest = 'a'.repeat(64);
export const injection = '</pre><script>window.__injected = true</script>';

export async function approvalSuccessAsset(path) {
  if (!/^\/(?:seller\/approval-success(?:-copy)?\.(?:js|css)|shared\/(?:i18n|modal)\.js)$/.test(path)) return null;
  const type = path.endsWith('.css') ? 'text/css' : 'text/javascript';
  const body = await readFile(new URL('../../public' + path, import.meta.url));
  return { type, body };
}

export async function assertDecisionClearance(page, fixture) {
  async function measure(scenario) {
    const { footerBottom, panelTop, scrollportBottom, atBottom, panelHeight, safeArea, summaryLines, approveHeight } = await page.evaluate(() => {
      const scroller = document.querySelector('main');
      scroller.scrollTo(0, scroller.scrollHeight);
      const panel = document.querySelector('#decision');
      const panelBox = panel.getBoundingClientRect();
      const summary = document.querySelector('#image-change-summary');
      return {
        footerBottom: document.querySelector('footer').getBoundingClientRect().bottom,
        panelTop: panelBox.top,
        scrollportBottom: scroller.getBoundingClientRect().bottom,
        panelHeight: panelBox.height,
        safeArea: parseFloat(getComputedStyle(panel).getPropertyValue('--ui-safe-bottom')),
        summaryLines: summary.getBoundingClientRect().height / parseFloat(getComputedStyle(summary).lineHeight),
        approveHeight: document.querySelector('#approve').getBoundingClientRect().height,
        atBottom: Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) <= 1,
      };
    });
    assert.ok(atBottom, `${fixture} (${scenario}) reached maximum scroll`);
    assert.ok(Math.abs(scrollportBottom - panelTop) < 1,
      `${fixture} (${scenario}) reserves exactly the panel height below the scrollport`);
    assert.ok(panelTop - footerBottom >= 16,
      `Last ${fixture} content ends at ${footerBottom}px, panel starts at ${panelTop}px (${scenario}, 16px required)`);
    return { panelHeight, safeArea, summaryLines, approveHeight };
  }

  // A ResizeObserver update can occur after the first animation frame's callbacks.
  const settleLayout = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const initial = await measure('initial layout');
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
    await settleLayout();
    const inset = await measure('34px safe area');
    assert.equal(inset.safeArea, 34);
    assert.ok(inset.panelHeight - initial.panelHeight >= 34);

    const original = await page.evaluate(() => {
      const summary = document.querySelector('#image-change-summary');
      const approve = document.querySelector('#approve');
      const original = { summary: summary.textContent, hidden: summary.hidden, label: approve.textContent };
      summary.textContent = 'The new image updates the main product photo. The existing image stays in the gallery and still appears on the storefront.';
      summary.hidden = false;
      return original;
    });
    try {
      await settleLayout();
      const wrapped = await measure('34px safe area and wrapped summary');
      assert.ok(wrapped.summaryLines >= 2 && wrapped.summaryLines <= 3, `Expected 2–3 summary lines, got ${wrapped.summaryLines}`);
      await page.locator('#approve').evaluate(button => {
        button.textContent = 'Approve the proposed changes to the main product photo and the storefront gallery';
      });
      await settleLayout();
      const longLabel = await measure('34px safe area, wrapped summary and long approval label');
      assert.ok(longLabel.approveHeight > wrapped.approveHeight, 'the long approval label increased the button height');
    } finally {
      await page.evaluate(({ summary, hidden, label }) => {
        const note = document.querySelector('#image-change-summary');
        note.textContent = summary;
        note.hidden = hidden;
        document.querySelector('#approve').textContent = label;
      }, original);
    }
  } finally {
    await session.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    await session.detach();
    await settleLayout();
  }
}

export async function catalogReviewBrowserFixture({ descriptionOnly = false } = {}) {
  const files = {
    '/oauth/operation': ['src/mcp/operation-review.html', 'text/html; charset=utf-8'],
    '/oauth/operation-review.js': ['src/mcp/operation-review.js', 'text/javascript'],
    '/oauth/operation-review.css': ['src/mcp/operation-review.css', 'text/css'],
    '/shop/tokens.css': ['public/shop/tokens.css', 'text/css'],
    '/shared/theme.css': ['public/shared/theme.css', 'text/css'],
    '/shared/review-i18n.js': ['public/shared/review-i18n.js', 'text/javascript'],
  };
  const assets = new Map(await Promise.all(Object.entries(files).map(async ([path, [file, type]]) =>
    [path, { type, body: await readFile(new URL(`../../${file}`, import.meta.url)) }])));
  const calls = [];
  const before = descriptionOnly
    ? { name: 'Field Day Canvas Tote', sku: 'TOTE-01', priceMinor: 4800, currency: 'MYR', stockQuantity: 24,
      active: true, category: 'Bags', description: 'An everyday canvas tote with two handles and an interior pocket.', options: [] }
    : { name: 'Old synthetic', sku: 'OLD', priceMinor: 123, currency: 'USD', stockQuantity: 7, active: true,
      category: 'Old category', description: 'Old description', options: [] };
  const after = descriptionOnly
    ? { ...before, description: 'A roomy tote in heavy cotton canvas with reinforced handles and an inside pocket sized for your keys and phone. Folds flat for easy storage.' }
    : { name: injection, sku: 'NEW', priceMinor: 456, stockQuantity: 0, active: false, category: 'New category',
      description: `New description ${'longunbrokenword'.repeat(12)}`, options: [], bidi: 'A\u202eB', tail: 'Full proposal visible' };
  const review = '/api/v1/seller/mcp/operations/' + operationId;
  async function respond(request) {
    const path = new URL(request.url).pathname.replace(/^\/alpha(?=\/)/, '');
    const asset = assets.get(path) ?? await approvalSuccessAsset(path);
    if (asset) return new Response(asset.body, { headers: { 'Content-Type': asset.type } });
    if (path === '/api/v1/seller/session' && request.method === 'GET') return Response.json({ csrfToken: 'synthetic-csrf' });
    if (path === review && request.method === 'GET') {
      return Response.json({
        currencyAcknowledgementRequired: false, currencyWarning: null, operationId,
        shopName: descriptionOnly ? 'Field Day Supply' : 'Synthetic shop', accountName: descriptionOnly ? 'Alex Chen' : 'synthetic_owner',
        clientName: descriptionOnly ? 'Claude' : injection, clientId: 'synthetic-client',
        toolName: 'catalog.preview_update', resourceType: 'product', resourceId: operationId, risk: 'MEDIUM',
        expiresAt: new Date(Date.now() + (descriptionOnly ? 480000 : 600000)).toISOString(),
        previewHash: digest, challenge: 'a'.repeat(43), proposal: { before, after },
      });
    }
    if (path === review + '/approval' && request.method === 'POST') {
      const body = await request.json();
      calls.push({ body, csrf: request.headers.get('x-csrf-token'), path: new URL(request.url).pathname });
      return Response.json({ operationId, status: body.decision === 'approve' ? 'APPROVED' : 'REJECTED' });
    }
    return new Response(null, { status: 404 });
  }
  return { calls, respond };
}
