import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startContainer, docker } from '../media-codec/scripts/dev-container.js';
import { createProduct, addGalleryImage } from '../src/products.js';
import { hash } from '../src/mcp/credentials.js';
import { catalogue, valid } from '../src/mcp/tools.js';
import { crossDomainBrowserFixture } from './helpers/mcp-cross-domain-fixture.js';
import { syntheticMediaPng } from './helpers/mcp-media-hooks-fixture.js';
import { legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';
import { reviewPassword } from './helpers/mcp-review-fixture.js';

const enabled = process.env.MCP_CROSS_DOMAIN_NATIVE_BROWSER_TEST === '1' && Boolean(process.env.QA_PLAYWRIGHT_MODULE);
const expectedNames = [
  'company.get', 'company.preview_update', 'company.commit_update',
  'catalog.preview_create', 'catalog.commit_create', 'catalog.preview_update', 'catalog.commit_update',
  'analytics.sales_trend', 'analytics.top_products', 'analytics.inventory_risk',
  'inventory.summary', 'inventory.movements', 'inventory.preview_adjustment', 'inventory.commit_adjustment',
  'orders.preview_decision', 'orders.commit_decision', 'operations.get', 'operations.cancel', 'operations.audit',
  'media.list', 'media.prepare_upload', 'media.commit_upload', 'media.preview_layout', 'media.commit_layout',
];
const day = 86400000;
const localDate = instant => new Date(instant + 8 * 3600000).toISOString().slice(0, 10);

// Every decision below is made by the actual seller page, including all page/image
// deliveries, browser SHA/decode ACKs, unchecked human confirmation and fresh PW.
async function approve(f, page, operation) {
  await page.goto(operation.reviewUrl);
  await page.locator('#review').waitFor({ state: 'visible' });
  if (await page.locator('#media-review').isVisible()) {
    assert.equal(await page.locator('#media-ack').isChecked(), false);
    const count = Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_asset_ref WHERE operation_id=?', operation.operationId)).n);
    for (let n = 1; n <= count; n++) {
      await page.waitForFunction(() => !document.querySelector('#media-image-ack').disabled);
      assert.ok(await page.locator('#media-image').evaluate(node => node.naturalWidth > 0));
      await page.locator('#media-image-ack').click();
      await page.waitForFunction(expected => document.querySelector('#media-progress').textContent.startsWith(expected + ' of '), n);
    }
    await page.waitForFunction(() => !document.querySelector('#approve').disabled);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_media_delivery WHERE operation_id=? AND ack_at IS NULL', operation.operationId)).n), 0);
    await page.locator('#media-ack').check();
  }
  await page.locator('#password').fill(reviewPassword);
  const response = page.waitForResponse(value => new URL(value.url()).pathname.endsWith('/' + operation.operationId + '/approval') && value.request().method() === 'POST');
  await page.locator('#approve').click();
  assert.equal((await response).status(), 200, 'Actual first-party password/ACK approval');
  await page.locator('#decision').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#password').inputValue(), '');
  assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', operation.operationId)).state, 'APPROVED');
}

async function storefront(f, productId) {
  const response = await f.call('/api/v1/products/' + productId);
  assert.equal(response.response.status, 200, JSON.stringify(response.data));
  const hashes = [];
  for (const path of response.data.images) {
    const url = new URL(path, f.origin); assert.equal(url.origin, f.origin);
    const image = await f.context.request.get(url.href); assert.equal(image.status(), 200);
    hashes.push(hash(await image.body()));
  }
  const main = await f.context.request.get(new URL(response.data.imageUrl, f.origin).href);
  assert.equal(main.status(), 200);
  return { product: response.data, hashes, mainSha: hash(await main.body()) };
}

async function businessState(store) {
  const tables = ['product', 'listing', 'product_gallery_image', 'product_event', 'shop_order', 'order_event', 'inventory_state', 'inventory_movement', 'company_setting'];
  return Promise.all(tables.map(async name => [name, hash(JSON.stringify(await store.all(`SELECT * FROM ${name} ORDER BY ${name === 'inventory_state' ? 'product_id' : 'id'}`)))]));
}

test('actual default24 cross-domain OAuth/native/HTTPS browser acceptance on SQLite and PostgreSQL',
  { skip: !enabled, timeout: 240000 }, async t => {
    assert.ok(process.env.SHOP_TEST_DATABASE_URL, 'Both disposable databases are required.');
    const image = (await readFile(new URL('../.local/media-codec-image-id', import.meta.url), 'utf8')).trim();
    const worker = await startContainer(image); t.after(worker.stop);
    const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
    const inspect = JSON.parse(await docker(['inspect', worker.id]));
    assert.equal(inspect[0].HostConfig.NetworkMode, 'none');
    assert.equal(inspect[0].HostConfig.Memory, 192 * 1024 * 1024);
    assert.equal(inspect[0].HostConfig.MemorySwap, inspect[0].HostConfig.Memory);
    for (const dialect of ['sqlite', 'postgres']) {
      await t.test(dialect + ': five real cross-domain sequences and all24 successful response schemas', async db => {
        let f = await crossDomainBrowserFixture(db, dialect, worker, browser);
        assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM oauth_grant')).n), 0);
        assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_scope_consent')).n), 0);
        let client = await f.authorize(f.allScopes); const listed = (await client.rpc('tools/list', {})).data.result.tools;
        assert.deepEqual(listed.slice(0, 8), catalogue.map(({ scope: _scope, ...tool }) => tool));
        assert.deepEqual(listed.slice(8).map(tool => tool.name), expectedNames);
        const schemas = new Map(listed.map(tool => [tool.name, tool])), samples = new Map();
        const call = async (name, args) => {
          assert.equal(valid(args, schemas.get(name).inputSchema), true, name + ' captured valid input');
          const response = await client.call(name, args);
          assert.equal(response.response.status, 200, name + ': ' + JSON.stringify(response.data));
          assert.ok(response.data.result, name + ': ' + JSON.stringify(response.data));
          const dto = response.data.result.structuredContent;
          assert.equal(valid(dto, schemas.get(name).outputSchema), true, name + ' actual response schema');
          assert.ok(Buffer.byteLength(JSON.stringify(dto)) <= 65536);
          if (!samples.has(name)) samples.set(name, structuredClone(args));
          return dto;
        };
        let page = await f.context.newPage(); const errors = [], external = [];
        page.on('pageerror', error => errors.push(error.message));
        await f.context.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : (external.push(route.request().url()), route.abort()));
        // Separate real shops keep every actual address/account approval budget intact.
        // No address rotation, clock edits, limiter clearing or synthetic authority.
        const freshShop = async () => {
          await f.context.close();
          f = await crossDomainBrowserFixture(db, dialect, worker, browser);
          client = await f.authorize(f.allScopes);
          const tools = (await client.rpc('tools/list', {})).data.result.tools;
          assert.deepEqual(tools, listed);
          page = await f.context.newPage(); page.on('pageerror', error => errors.push(error.message));
          await f.context.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : (external.push(route.request().url()), route.abort()));
        };
        const seed = async () => createProduct(f.store, { sku: 'CROSS-DOMAIN', name: 'Synthetic cross-domain product', description: 'Synthetic initial fixture', category: 'SYNTHETIC', priceMinor: 1200, stockQuantity: 12, active: true });
        const commit = async (name, op) => {
          await approve(f, page, op);
          const result = await call(name, { operationId: op.operationId });
          assert.equal(result.status, 'COMMITTED'); assert.equal(result.replayed, false);
          const replay = await call(name, { operationId: op.operationId });
          assert.equal(replay.replayed, true); assert.deepEqual(replay.result, result.result);
          assert.ok(Buffer.byteLength(JSON.stringify(result.result)) <= 2048);
          assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM mcp_v2_event WHERE operation_id=? AND event='COMMIT'", op.operationId)).n), 1);
          return result.result;
        };
        let sequence = 0;
        const upload = async (productId, bytes, targetSlot) => {
          const revision = (await call('media.list', { productId })).revision, key = 'cross-upload-' + String(++sequence).padStart(8, '0');
          const stage = (await call('media.prepare_upload', { input: { action: 'begin', productId, targetSlot, expectedRevision: revision,
            sourceSha256: hash(bytes), sourceMime: 'image/png', declaredBytes: bytes.length, idempotencyKey: key + '-begin' } })).stage;
          for (let offset = 0; offset < bytes.length; offset += 36864) {
            const chunk = bytes.subarray(offset, offset + 36864), dataParts = Array.from({ length: Math.ceil(chunk.length / 3072) }, (_, n) => chunk.subarray(n * 3072, (n + 1) * 3072).toString('base64'));
            await call('media.prepare_upload', { input: { action: 'append', stageId: stage.stageId, offset, dataParts } });
          }
          const op = (await call('media.prepare_upload', { input: { action: 'seal', stageId: stage.stageId, idempotencyKey: key + '-seal' } })).operation;
          await commit('media.commit_upload', op); return op;
        };
        let productId, orderId, adjustment, decision;
        const original = syntheticMediaPng(17), replacement = syntheticMediaPng(91);
        await db.test('1 full CREATE inactive -> native upload -> full UPDATE publish with actual storefront SHA', async () => {
          const op = await call('catalog.preview_create', { input: { sku: 'CROSS-DOMAIN', name: 'Synthetic cross-domain product', description: 'Literal <script>window.__crossInjected=1</script>',
            category: 'SYNTHETIC', priceMinor: 1200, stockQuantity: 12, active: false }, idempotencyKey: 'cross-full-create-0001' });
          assert.equal((await f.store.get('SELECT media_policy_id FROM mcp_v2_operation WHERE id=?', op.operationId)).media_policy_id, 'catalog-media-v1');
          productId = (await commit('catalog.commit_create', op)).productId;
          assert.equal((await f.call('/api/v1/products/' + productId)).response.status, 404);
          await upload(productId, original, 'MAIN');
          assert.equal((await f.call('/api/v1/products/' + productId)).response.status, 404);
          const publish = await call('catalog.preview_update', { input: { id: productId, changes: { active: true } }, idempotencyKey: 'cross-full-publish-0001' });
          assert.equal((await f.store.get('SELECT media_policy_id FROM mcp_v2_operation WHERE id=?', publish.operationId)).media_policy_id, 'catalog-media-v1');
          await commit('catalog.commit_update', publish);
          const visible = await storefront(f, productId), stored = await f.store.get('SELECT image_data,active FROM product WHERE id=?', productId);
          assert.equal(visible.mainSha, hash(stored.image_data)); assert.equal(stored.active, 1);
          await page.goto(f.origin + '/shop/'); await page.locator('#catalog-grid .product-name-link').filter({ hasText: 'Synthetic cross-domain product' }).waitFor();
          assert.equal(await page.evaluate(() => window.__crossInjected), undefined);
        });
        await db.test('2 replace main bytes -> changed storefront SHA -> restore original SHA/layout; reorder/restore existing gallery', async () => {
          await freshShop(); productId = (await seed()).id;
          await upload(productId, original, 'MAIN');
          await addGalleryImage(f.store, productId, 'data:image/png;base64,' + syntheticMediaPng(44).toString('base64'));
          const before = await storefront(f, productId), gallery = (await call('media.list', { productId })).items[0].gallery.map(({ id }) => ({ id }));
          assert.equal(gallery.length, 2);
          await upload(productId, replacement, 'MAIN');
          const changed = await storefront(f, productId); assert.notEqual(changed.mainSha, before.mainSha);
          assert.equal(changed.mainSha, hash((await f.store.get('SELECT image_data FROM product WHERE id=?', productId)).image_data));
          await upload(productId, original, 'MAIN');
          const restored = await storefront(f, productId); assert.equal(restored.mainSha, before.mainSha); assert.deepEqual(restored.hashes, before.hashes);
          for (const [n, selection] of [[0, [...gallery].reverse()], [1, gallery]]) {
            const revision = (await call('media.list', { productId })).revision;
            const op = await call('media.preview_layout', { input: { productId, expectedRevision: revision, gallery: selection, removeMain: false }, idempotencyKey: 'cross-layout-restore-' + n });
            await commit('media.commit_layout', op);
            assert.deepEqual((await storefront(f, productId)).product.galleryItems.map(item => item.id), selection.map(item => item.id));
          }
          assert.deepEqual((await storefront(f, productId)).hashes, before.hashes);
        });
        await db.test('3 same-client stock adjustment -> MCP order confirm; both replays have exact once-only ledger identity', async () => {
          await freshShop(); productId = (await seed()).id;
          const before = await call('inventory.summary', { productId }); assert.equal(before.onHand, 12);
          adjustment = await call('inventory.preview_adjustment', { input: { productId, expectedRevision: before.revision, stockQuantity: 15, reasonCode: 'COUNT_CORRECTION', note: 'Synthetic cross-domain count' }, idempotencyKey: 'cross-stock-adjust-0001' });
          await commit('inventory.commit_adjustment', adjustment);
          const placed = await f.call('/api/v1/orders', 'POST', { buyer: { fullName: 'Synthetic Cross Buyer', whatsappPhone: '+6581234567' }, whatsappOrderContactOptIn: true,
            deliveries: [{ recipient: { fullName: 'Synthetic Cross Recipient', phone: '+60123456789' }, address: { line1: 'Synthetic Street', postcode: '50000', country: 'MY' },
              items: [{ productId, quantity: 2, expectedPriceMinor: 1200, expectedCurrency: 'MYR' }] }] }, { origin: f.origin, 'idempotency-key': randomUUID() });
          assert.equal(placed.response.status, 201, JSON.stringify(placed.data));
          orderId = (await f.store.get('SELECT id FROM shop_order WHERE order_no=?', placed.data.orderNo)).id;
          decision = await call('orders.preview_decision', { input: { orderId, decision: { action: 'confirm' } }, idempotencyKey: 'cross-order-confirm-0001' });
          const confirmed = await commit('orders.commit_decision', decision); assert.equal(confirmed.status, 'CONFIRMED');
          const after = await call('inventory.summary', { productId }); assert.equal(after.onHand, 13); assert.equal(after.held, 0);
          const movements = await call('inventory.movements', { productId }); assert.equal(movements.items.length, 3);
          for (const [op, source, reason, quantity] of [[adjustment, 'MCP_ADJUST', 'COUNT_CORRECTION', 15], [decision, 'ORDER', 'ORDER_CONFIRM', 13]]) {
            const rows = await f.store.all('SELECT * FROM inventory_movement WHERE operation_id=?', op.operationId); assert.equal(rows.length, 1);
            const record = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id=?', op.operationId), row = rows[0];
            assert.equal(row.source, source); assert.equal(row.reason_code, reason); assert.equal(row.after_quantity, quantity);
            for (const field of ['account_id', 'client_id', 'grant_id', 'correlation_id']) assert.equal(row[field === 'account_id' ? 'actor_id' : field], record[field]);
          }
          assert.equal(Number((await f.store.get("SELECT COUNT(*) AS n FROM order_event WHERE order_id=? AND event_type='CONFIRMED'", orderId)).n), 1);
          assert.equal((await call('inventory.commit_adjustment', { operationId: adjustment.operationId })).replayed, true);
          assert.equal((await call('orders.commit_decision', { operationId: decision.operationId })).replayed, true);
          assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM inventory_movement WHERE product_id=?', productId)).n), 3);
        });
        await db.test('4 default analytics RPC matches authenticated Seller dashboard HTTP on same accepted order fixture', async () => {
          const dashboard = await f.call('/api/v1/seller/dashboard', 'GET', undefined, client.headers); assert.equal(dashboard.response.status, 200);
          const today = Date.parse(dashboard.data.today), range = { from: localDate(today), toExclusive: localDate(today + day) };
          const sales = await call('analytics.sales_trend', range);
          assert.deepEqual(sales.totals.filter(row => row.orders), dashboard.data.salesToday);
          assert.deepEqual(sales.totals.filter(row => row.orders), [{ currency: 'MYR', orders: 1, totalMinor: 2400 }]);
          const window = { from: localDate(today - (dashboard.data.windowDays - 1) * day), toExclusive: range.toExclusive };
          assert.deepEqual((await call('analytics.sales_trend', window)).totals.filter(row => row.orders), dashboard.data.salesWindow);
          const top = await call('analytics.top_products', window);
          assert.deepEqual(top.items.map(({ productId: id, sku, name, currency, quantity, totalMinor }) => ({ productId: id, sku, name, currency, quantity, totalMinor })), dashboard.data.topProducts);
          const risk = await call('analytics.inventory_risk', { mode: 'all' }); assert.equal(risk.totals.scannedProducts, 1);
          assert.equal(sales.timeZone, dashboard.data.timeZone); assert.equal(sales.metricName, 'accepted_order_value');
        });
        await db.test('5 company MCP/HTTP consistency; own operation get/audit and cancellation preserve commerce', async () => {
          await freshShop();
          const before = (await call('company.get', {})).company;
          const op = await call('company.preview_update', { input: { expectedRevision: before.revision, changes: { availabilityText: 'Synthetic cross-domain availability' } }, idempotencyKey: 'cross-company-change-0001' });
          await commit('company.commit_update', op);
          const current = (await call('company.get', {})).company, portal = await f.call('/api/v1/seller/company-settings', 'GET', undefined, client.headers);
          assert.equal(portal.response.status, 200); const { revision: _revision, ...settings } = current; assert.deepEqual(settings, portal.data);
          assert.equal(current.availabilityText, 'Synthetic cross-domain availability');
          assert.equal((await call('operations.get', { operationId: op.operationId })).status, 'COMMITTED');
          const audit = await call('operations.audit', { operationId: op.operationId });
          assert.ok(audit.items.some(item => item.toolName === 'company.commit_update' && item.outcome === 'REPLAY'));
          assert.equal(audit.coverage.preOperationStagesIncluded, false);
          const pending = await call('company.preview_update', { input: { expectedRevision: current.revision, changes: { availabilityText: 'Must never be applied' } }, idempotencyKey: 'cross-company-cancel-0001' });
          const state = await businessState(f.store);
          assert.equal((await call('operations.cancel', { operationId: pending.operationId })).status, 'CANCELLED');
          assert.equal((await call('operations.cancel', { operationId: pending.operationId })).replayed, true);
          assert.deepEqual(await businessState(f.store), state);
          assert.equal((await call('company.get', {})).company.availabilityText, current.availabilityText);
        });
        await db.test('all24 actual samples plus no-bearer, closed-input, readonly-scope and valid unknown-operation matrix', async () => {
          assert.deepEqual([...samples.keys()].sort(), [...expectedNames].sort(), 'Every NEW tool has an ACTUAL successful response schema sample');
          const state = await businessState(f.store), full = await f.authorize(f.allScopes), readonly = await f.authorize(legacyCatalogScopes);
          for (const name of expectedNames) {
            const args = samples.get(name);
            const absent = await f.call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' });
            assert.equal(absent.response.status, 401, name + ' missing bearer');
            const invalid = await full.call(name, { ...args, approved: true }); assert.equal(invalid.data.error?.code, -32602, name + ' closed authority substitution');
            const denied = await readonly.call(name, args); assert.equal(denied.response.status, 403, name + ' readonly scopes'); assert.equal(denied.data.error, 'insufficient_scope');
          }
          for (const name of expectedNames.filter(name => name.includes('.commit_') || name.startsWith('operations.'))) {
            const missing = await full.call(name, { operationId: randomUUID() });
            assert.equal(missing.response.status, 403, name + ': ' + JSON.stringify(missing.data));
          }
          assert.deepEqual(await businessState(f.store), state);
          db.diagnostic(JSON.stringify({ dialect, actualSuccessfulResponseSchemas: samples.size, missingBearer: 24, closedInput: 24, readonlyScope: 24,
            unknownOperation: expectedNames.filter(name => name.includes('.commit_') || name.startsWith('operations.')).length, realOAuth: true, realNative: true, syntheticHumanEvidence: false, nativeImage: image }));
        });
        assert.deepEqual(errors, []); assert.deepEqual(external, []);
      });
    }
  });
