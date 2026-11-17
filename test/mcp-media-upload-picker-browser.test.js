import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startContainer } from '../media-codec/scripts/dev-container.js';
import { uploadUrlE2eFixture } from './helpers/mcp-upload-url-e2e-fixture.js';

const enabled = process.env.MCP_UPLOAD_PICKER_BROWSER_TEST === '1' && Boolean(process.env.QA_PLAYWRIGHT_MODULE);
test('real mobile file picker uploads original bytes and links the pending proposal without seller cookies', { skip: !enabled, timeout: 90000 }, async t => {
  const worker = await startContainer((await readFile(new URL('../.local/media-codec-image-id', import.meta.url), 'utf8')).trim());
  t.after(worker.stop);
  const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const f = await uploadUrlE2eFixture(t, 'sqlite', worker);
  const { image } = await import('../media-codec/test/fixtures.js');
  const bytes = await image('jpeg'), file = join(f.dir, 'image.jpg'), wrong = join(f.dir, 'wrong.jpg');
  await writeFile(file, bytes); await writeFile(wrong, bytes.subarray(0, 8));
  const before = (await f.client.call('media.list', { productId: f.product.id })).data.result.structuredContent;
  const issued = await f.client.call('media.request_upload_url', { productId: f.product.id, targetSlot: 'MAIN',
    expectedRevision: before.revision, sourceMime: 'image/jpeg', declaredBytes: bytes.length, idempotencyKey: 'local-browser-upload-0001' });
  const link = issued.data.result.structuredContent;
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 375, height: 812 } });
  t.after(() => context.close()); const page = await context.newPage();
  const response = await page.goto(link.uploadUrl); assert.equal(response.status(), 200);
  assert.deepEqual(await context.cookies(), []);
  await page.locator('#image').setInputFiles(wrong); await page.getByRole('button', { name: 'Upload for review' }).click();
  assert.match(await page.locator('#status').textContent(), /requested original image/);
  assert.equal((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_stage')).n, 0);
  await page.locator('#image').setInputFiles(file); await page.getByRole('button', { name: 'Upload for review' }).click();
  await page.locator('#review').waitFor({ state: 'visible' });
  const review = new URL(await page.locator('#review').getAttribute('href'));
  assert.equal(review.origin, f.origin);
  const operationId = review.searchParams.get('operationId');
  assert.equal((await f.client.call('operations.get', { operationId })).data.result.structuredContent.status, 'PENDING_APPROVAL');
  assert.deepEqual((await f.client.call('media.list', { productId: f.product.id })).data.result.structuredContent, before);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await context.cookies(), []);
});
