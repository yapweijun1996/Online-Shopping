import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server.js';
import { useWorkerIngress } from '../test/browser/worker-harness.mjs';

const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
const out = resolve(process.env.QA_OUTPUT_DIR || 'output/qa/customer-profile-address');
mkdirSync(out, { recursive: true });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.QA_EXPECTED_HEAD) assert.equal(head, process.env.QA_EXPECTED_HEAD);
const paths = ['public/shop/app.js', 'public/shop/profile.js', 'public/shop/addresses.js',
  'public/shop/checkout.js', 'public/shop/checkout-payload.js', 'public/shop/cart.js',
  'public/shop/storage-scope.js', 'public/shared/modal.js', 'src/worker.js', 'src/app.js', 'src/orders.js'];
const hashes = () => Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const report = {
  sourceHead: head, sourceHashes: hashes(),
  gitStatusBefore: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  versions: Object.fromEntries(['shop', 'seller'].map(surface => [surface, /v\d+/.exec(readFileSync(`public/${surface}/version.js`, 'utf8'))[0]])),
  scope: 'Criteria23/24 only; actual UI/browser storage, Worker/API, temporary fictional SQLite;390/1280; one browser worker',
  profileDraftPolicy: 'Same-document route changes retain input; explicit reload restores saved input. Reload/close draft protection policy unspecified; no auto-save/discard feature added.',
  cases: [], stateEvidence: [], pageErrors: [], externalRequests: [], unexpectedDialogs: [], dialogs: [],
};
const browser = await chromium.launch({ headless: true });
report.browser = browser.version();
let app, context, temp, width, stage;
const checked = async (id, label, fn) => {
  stage = `#${id} ${label}`;
  try {
    const evidence = await fn();
    report.cases.push({ id, label, width, status: 'PASS', evidence });
    console.log(`PASS #${id}/${width} ${label}`);
  } catch (error) {
    report.cases.push({ id, label, width, status: 'FAIL', error: error.message });
    throw error;
  }
};

try {
  for (width of [390, 1280]) {
    temp = mkdtempSync(join(tmpdir(), 'online-shopping-profile-address-qa-'));
    const config = { dbPath: join(temp, 'fictional.db'), shopMode: 'manual',
      username: 'synthetic_profile_address_qa', password: randomUUID() + randomUUID(),
      production: false, publicOrigin: null };
    app = createApp(config);
    const gateway = useWorkerIngress(app, config);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    const login = await fetch(origin + '/api/v1/seller/session', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: config.username, password: config.password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrfToken;
    const category = await fetch(origin + '/api/v1/seller/categories', { method: 'POST',
      headers: { origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PROFILE_QA', label: 'Fictional local category' }) });
    assert.equal(category.status, 201);
    const created = await fetch(origin + '/api/v1/seller/products', { method: 'POST',
      headers: { origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ sku: `PROFILE-QA-${width}`, name: 'Fictional profile-address item',
        category: 'PROFILE_QA', description: 'Synthetic local state fixture', priceMinor: 1200, active: true }) });
    assert.equal(created.status, 201);
    const product = await created.json();
    const orders = () => Object.fromEntries(['shop_order', 'delivery', 'order_item', 'order_event',
      'checkout_idempotency', 'order_sequence'].map(table => [table, app.database.all('SELECT * FROM ' + table)]));
    const initialDomain = orders();
    const orderPosts = () => gateway.records.filter(r => r.method === 'POST' && r.path === '/api/v1/orders');
    context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      if (!route.request().url().startsWith(origin + '/')) {
        report.externalRequests.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    const confirmations = new Map();
    const attach = (page, name) => {
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => report.pageErrors.push({ width, name, stage, error: error.message }));
      page.on('dialog', async dialog => {
        const reply = confirmations.get(page);
        confirmations.delete(page);
        const event = { width, name, stage, type: dialog.type(), message: dialog.message(), expected: reply !== undefined };
        report.dialogs.push(event);
        if (!event.expected) report.unexpectedDialogs.push(event);
        if (reply === true) await dialog.accept(); else await dialog.dismiss();
      });
    };
    const page = await context.newPage();
    attach(page, 'customer');
    const visible = view => page.locator(`#${view}-view`).waitFor({ state: 'visible' });
    const stored = (name, tab = page, session = false) => tab.evaluate(async ({ name, session }) => {
      const key = (await import('/shop/storage-scope.js')).storageKey(name);
      const value = (session ? sessionStorage : localStorage).getItem(key);
      return name === 'online-shopping-checkout-address-v1' ? value : JSON.parse(value || 'null');
    }, { name, session });
    const profile = () => stored('online-shopping-profile-v1');
    const addresses = (tab = page) => stored('online-shopping-addresses-v1', tab);
    const selected = () => stored('online-shopping-checkout-address-v1', page, true);
    const selection = () => stored('online-shopping-selection-v1', page, true);
    const cart = () => page.evaluate(async () => (await (await import('/shop/cart.js')).createCartStore()).list());
    const shot = name => page.screenshot({ path: out + `/${name}-${width}.png`, fullPage: true });
    const sidebar = async name => { await page.locator(`.account-sidebar a[href="#${name}"]`).click(); await visible(name); };
    const goCart = async () => {
      const detailCart = page.locator('.product-nav-cart');
      if (await detailCart.isVisible()) await detailCart.click();
      else await page.locator(width === 390 ? '#mobile-navigation a[href="#cart"]' : '.shop-nav a[href="#cart"]').click();
      await visible('cart');
      await page.waitForFunction(() => document.querySelectorAll('#cart-list .cart-row').length === 1 && !document.querySelector('#checkout-button').disabled);
    };
    const accountRoute = async name => {
      if (width === 390) {
        await page.locator('#mobile-navigation a[href="#profile"]').click(); await visible('profile');
        if (name !== 'profile') await sidebar(name);
      } else {
        await page.locator('#profile-menu-button').click();
        await page.locator(`#profile-menu a[href="#${name}"]`).click(); await visible(name);
      }
    };
    const addTwo = async () => {
      await page.locator(width === 390 ? '#mobile-navigation a[href="#catalog"]' : '.shop-topbar .brand').click();
      await visible('catalog');
      await page.waitForFunction(() => document.querySelector('#catalog-grid')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.catalog-card').length === 1);
      await page.locator(`.product-name-link[data-product-id="${product.id}"]`).click(); await visible('product');
      await page.locator('.product-add').waitFor(); await page.locator('#detail-quantity').fill('2');
      await page.locator('.product-add').click();
      await page.waitForFunction(() => document.querySelector('#cart-count').textContent === '2');
      await goCart();
    };
    const checkout = async blocked => {
      await goCart(); await page.locator('#checkout-button').click(); await visible('checkout');
      await page.waitForFunction(blocked => document.querySelectorAll('#assignment-list .assignment-row').length === 1 && document.querySelector('#submit-order').disabled === blocked, blocked);
    };
    const currentForm = tab => tab.locator('.app-modal[open] .address-form');
    const fillAddress = async (tab, entry) => {
      const form = currentForm(tab);
      await form.locator('[name=fullName]').waitFor();
      for (const name of ['fullName', 'phone', 'line1', 'line2', 'city', 'postcode']) await form.locator(`[name=${name}]`).fill(entry[name] || '');
      await form.locator('[name=region]').selectOption(entry.region);
      await form.locator('[name=city]').click();
    };
    const saveAddress = async (tab, entry) => {
      await fillAddress(tab, entry); await currentForm(tab).locator('[type=submit]').click();
      await tab.locator('.app-modal[open]').waitFor({ state: 'hidden' });
    };
    const addAddress = async (entry, tab = page) => {
      await tab.locator('#add-address').click(); await saveAddress(tab, entry);
      return (await addresses(tab)).entries.find(x => x.fullName === entry.fullName);
    };
    const addressRow = (entry, tab = page) => tab.locator('.address-card').filter({ has: tab.locator('.address-copy strong', { hasText: entry.fullName }) });
    const editAddress = async (entry, patch, tab = page) => {
      await addressRow(entry, tab).locator('.address-actions button').nth(0).click();
      await saveAddress(tab, { ...entry, ...patch });
      return (await addresses(tab)).entries.find(x => x.id === entry.id);
    };
    const deleteAddress = async (entry, accept, tab = page) => {
      confirmations.set(tab, accept);
      const dialog = tab.waitForEvent('dialog');
      await addressRow(entry, tab).locator('.address-actions button').nth(1).click(); await dialog;
      if (accept) await addressRow(entry, tab).waitFor({ state: 'detached' });
    };
    const submitSelected = async expected => {
      const savedBuyer = await profile();
      const responsePromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/orders' && r.request().method() === 'POST');
      await page.locator('#submit-order').click();
      const response = await responsePromise, payload = response.request().postDataJSON(), receipt = await response.json();
      assert.equal(response.status(), 201); assert.equal(receipt.totalMinor, 2400); assert.equal(receipt.currency, 'MYR');
      assert.deepEqual(payload.buyer, { fullName: savedBuyer.fullName, whatsappPhone: '', email: savedBuyer.email });
      assert.deepEqual(payload.deliveries[0].recipient, { fullName: expected.fullName, phone: expected.phone });
      const expectedAddress = Object.fromEntries(['line1', 'line2', 'city', 'region', 'postcode', 'country'].map(key => [key, expected[key]]));
      assert.deepEqual(payload.deliveries[0].address, expectedAddress);
      const delivery = app.database.get('SELECT d.* FROM delivery d JOIN shop_order o ON o.id=d.order_id WHERE o.order_no=?', receipt.orderNo);
      assert.equal(delivery.recipient_name, expected.fullName); assert.equal(delivery.recipient_phone, expected.phone);
      for (const [key, value] of Object.entries(expectedAddress)) assert.equal(delivery['address_' + key], value);
      const order = app.database.get('SELECT * FROM shop_order WHERE order_no=?', receipt.orderNo);
      assert.equal(order.buyer_name, savedBuyer.fullName); assert.equal(order.buyer_email, savedBuyer.email);
      await page.locator('#receipt-view').waitFor({ state: 'visible' }); assert.deepEqual(await cart(), []);
      return { receipt, actualRequest: payload, storedBuyer: { fullName: order.buyer_name, email: order.buyer_email }, storedDelivery: delivery };
    };

    await page.goto(origin + '/shop/#profile'); await visible('profile');
    await checked(23, 'Unsaved Profile survives actual route changes, browser Back and return to edit without auto-save', async () => {
      assert.equal(await profile(), null);
      await page.locator('#profile-form [name=fullName]').fill('Fictional unsaved profile buyer');
      await page.locator('#profile-form [name=email]').fill('profile-buyer@example.invalid');
      await sidebar('addresses'); assert.equal(await profile(), null);
      await page.goBack(); await visible('profile');
      assert.equal(await page.locator('#profile-form [name=fullName]').inputValue(), 'Fictional unsaved profile buyer');
      await sidebar('settings'); await page.locator('.settings-general a[href="#profile"]').click(); await visible('profile');
      assert.equal(await page.locator('#profile-form [name=email]').inputValue(), 'profile-buyer@example.invalid');
      assert.equal(await profile(), null); assert.deepEqual(orders(), initialDomain); assert.equal(orderPosts().length, 0);
      await shot('profile-unsaved-return');
      return { draftRetainedAcrossRoutesAndBack: true, savedProfileRemainsNull: true, autoSave: false, orderPOSTs: 0 };
    });
    await checked(23, 'Explicit Profile Save persists reload; later unsaved edit survives routes but reload restores saved state', async () => {
      await page.locator('#profile-form [type=submit]').click();
      await page.waitForFunction(() => document.querySelector('#profile-status').textContent.includes('saved'));
      const saved = await profile(); assert.equal(saved.fullName, 'Fictional unsaved profile buyer');
      await page.reload(); await visible('profile'); assert.equal(await page.locator('#profile-form [name=fullName]').inputValue(), saved.fullName);
      await page.locator('#profile-form [name=fullName]').fill('Fictional unsaved replacement');
      await sidebar('addresses'); await page.goBack(); await visible('profile');
      assert.equal(await page.locator('#profile-form [name=fullName]').inputValue(), 'Fictional unsaved replacement'); assert.deepEqual(await profile(), saved);
      await page.reload(); await visible('profile'); assert.equal(await page.locator('#profile-form [name=fullName]').inputValue(), saved.fullName); assert.deepEqual(await profile(), saved);
      await shot('profile-saved-reload');
      return { saved, sameDocumentDraftRetained: true, reloadRestoresSavedVersion: true, reloadDraftProtectionPolicy: 'UNSPECIFIED; criterion23 remains UNVERIFIED' };
    });
    await checked(23, 'Cart-origin Profile edit saves, returns with exact cart and selection and focuses Checkout', async () => {
      await addTwo(); const before = await cart(), selectionBefore = await selection();
      await page.locator('#cart-profile-state a[href="#profile"]').click(); await visible('profile');
      await page.locator('#profile-form [name=fullName]').fill('Fictional saved cart-return buyer'); await page.locator('#profile-form [type=submit]').click();
      await visible('cart'); await page.waitForFunction(() => document.activeElement?.id === 'checkout-button'); assert.deepEqual(await cart(), before); assert.deepEqual(await selection(), selectionBefore);
      assert.equal((await profile()).fullName, 'Fictional saved cart-return buyer');
      await checkout(true); assert.equal(await page.locator('#submit-order').isDisabled(), true); assert.equal(orderPosts().length, 0); assert.deepEqual(orders(), initialDomain);
      await shot('profile-return-empty-address-block'); await accountRoute('addresses');
      return { cartBefore: before, cartAfter: await cart(), selectionBefore, selectionAfter: await selection(), savedName: (await profile()).fullName, returnedCartFocus: 'checkout-button', missingAddressBlocks: true };
    });

    const alphaInput = { fullName: 'Fictional Alpha recipient', phone: '123456789', line1: 'Fictional Alpha Street', line2: '', city: 'Johor Bahru', region: 'Johor', postcode: '81100', country: 'MY' };
    const betaInput = { fullName: 'Fictional Beta recipient', phone: '123456788', line1: 'Fictional Beta Street', line2: 'Fictional Unit B', city: 'Kuala Lumpur', region: 'W.P. Kuala Lumpur', postcode: '50000', country: 'MY' };
    let alpha, beta, editPage;
    await checked(24, 'Address Add cancellation writes nothing; two explicit saves keep stable IDs/default across reload', async () => {
      const before = await addresses(); await page.locator('#add-address').click();
      await currentForm(page).locator('[name=fullName]').fill('Fictional cancelled new address'); await page.keyboard.press('Escape');
      await page.locator('.app-modal[open]').waitFor({ state: 'hidden' }); assert.deepEqual(await addresses(), before);
      alpha = await addAddress(alphaInput); beta = await addAddress(betaInput); assert.ok(alpha.id && beta.id); assert.notEqual(alpha.id, beta.id);
      const saved = await addresses(); assert.equal(saved.defaultId, alpha.id); assert.equal(saved.entries.length, 2);
      await page.reload(); await visible('addresses'); assert.deepEqual(await addresses(), saved); assert.equal(await page.locator('.address-card').count(), 2);
      await shot('addresses-add-reload'); return { initialCancelledState: before, saved, IDsStableAfterReload: true };
    });
    await checked(24, 'Edit cancellation, save, default, Delete cancel/confirm and fallback persist exact address state', async () => {
      const before = await addresses(); await addressRow(beta).locator('.address-actions button').nth(0).click();
      await currentForm(page).locator('[name=line1]').fill('Fictional cancelled replacement'); await page.locator('.app-modal[open] .modal-close').click();
      await page.locator('.app-modal[open]').waitFor({ state: 'hidden' }); assert.deepEqual(await addresses(), before);
      alpha = await editAddress(alpha, { line1: 'Fictional Alpha updated Street' }); assert.equal(alpha.id, before.entries[0].id);
      await addressRow(beta).locator('.address-actions button').nth(2).click(); assert.equal((await addresses()).defaultId, beta.id);
      const defaultBeta = await addresses(); await page.reload(); await visible('addresses'); assert.deepEqual(await addresses(), defaultBeta);
      await deleteAddress(beta, false); assert.deepEqual(await addresses(), defaultBeta);
      await deleteAddress(beta, true); const fallback = await addresses(); assert.equal(fallback.defaultId, alpha.id); assert.deepEqual(fallback.entries, [alpha]);
      await page.reload(); await visible('addresses'); assert.deepEqual(await addresses(), fallback);
      const oldBetaID = beta.id; beta = await addAddress(betaInput); assert.notEqual(beta.id, oldBetaID);
      await addressRow(beta).locator('.address-actions button').nth(2).click(); assert.equal((await addresses()).defaultId, beta.id);
      await shot('addresses-edit-default-delete'); return { editedStableID: alpha.id, cancelledEditDidNotWrite: true, defaultBeta, confirmedDefaultDeletionFallback: fallback, recreatedBetaHasNewID: true };
    });
    await checked(24, 'Checkout chooser cancel keeps selected ID; selected edits use latest address rather than different default', async () => {
      await checkout(false); assert.equal(await selected(), beta.id); assert.match(await page.locator('#checkout-address').innerText(), /Fictional Beta Street/);
      await page.locator('#change-address').click(); await page.locator(`.address-choice input[value="${alpha.id}"]`).check(); await currentForm(page).locator('[type=submit]').click();
      await page.locator('.app-modal[open]').waitFor({ state: 'hidden' }); assert.equal(await selected(), alpha.id);
      await page.locator('#change-address').click(); await page.locator(`.address-choice input[value="${beta.id}"]`).check(); await page.keyboard.press('Escape');
      await page.locator('.app-modal[open]').waitFor({ state: 'hidden' }); assert.equal(await selected(), alpha.id); assert.match(await page.locator('#checkout-address').innerText(), /Fictional Alpha updated Street/);
      await accountRoute('addresses'); alpha = await editAddress(alpha, { line1: 'Fictional Alpha selected Street' }); await checkout(false);
      assert.equal(await selected(), alpha.id); assert.equal((await addresses()).defaultId, beta.id); assert.match(await page.locator('#checkout-address').innerText(), /Fictional Alpha selected Street/);
      editPage = await context.newPage(); attach(editPage, 'address-editor'); await editPage.goto(origin + '/shop/#addresses'); await editPage.locator('#addresses-view').waitFor({ state: 'visible' });
      alpha = await editAddress(alpha, { line1: 'Fictional Alpha latest Street', line2: 'Fictional selected Unit A' }, editPage);
      await page.waitForFunction(() => document.querySelector('#checkout-address').textContent.includes('Fictional Alpha latest Street'));
      assert.equal(await selected(), alpha.id); assert.equal((await addresses()).defaultId, beta.id); await shot('checkout-selected-latest-address');
      const committed = await submitSelected(alpha); assert.equal(app.database.get('SELECT count(*) n FROM shop_order').n, 1);
      return { selectedID: alpha.id, differentDefaultID: beta.id, chooserCancelPreservedID: true, sameAndOtherTabEditsRefreshed: true, committed };
    });
    await checked(24, 'Deleting selected address blocks instead of default fallback, including reload and empty-book submit', async () => {
      await addTwo(); await checkout(false); assert.equal(await selected(), beta.id);
      const domainBefore = orders(), cartBefore = await cart(), postsBefore = orderPosts().length;
      await deleteAddress(beta, false, editPage); assert.equal(await selected(), beta.id); assert.equal(await page.locator('#submit-order').isDisabled(), false);
      await deleteAddress(beta, true, editPage); await page.waitForFunction(() => document.querySelector('#submit-order').disabled);
      assert.equal(await selected(), beta.id); assert.equal((await addresses()).defaultId, alpha.id); assert.ok(!(await page.locator('#checkout-address').innerText()).includes(alpha.line1));
      await page.reload(); await visible('checkout'); await page.waitForFunction(() => document.querySelectorAll('#assignment-list .assignment-row').length === 1); assert.equal(await page.locator('#submit-order').isDisabled(), true);
      assert.equal(await selected(), beta.id); await page.locator('#checkout-form').evaluate(form => form.requestSubmit());
      await page.waitForFunction(() => document.querySelector('#checkout-error').textContent.length > 0); assert.equal(orderPosts().length, postsBefore); assert.deepEqual(orders(), domainBefore); assert.deepEqual(await cart(), cartBefore);
      await shot('deleted-selected-address-blocks'); await deleteAddress(alpha, true, editPage); await page.waitForFunction(() => document.querySelector('#submit-order').disabled);
      assert.deepEqual((await addresses()).entries, []); assert.equal((await addresses()).defaultId, null);
      await page.locator('#checkout-form').evaluate(form => form.requestSubmit()); assert.equal(orderPosts().length, postsBefore); assert.deepEqual(orders(), domainBefore); assert.deepEqual(await cart(), cartBefore);
      await shot('empty-address-book-blocks'); report.stateEvidence.push({ width, criterion: 24, orderDomainBeforeBlockedSubmissions: domainBefore, orderDomainAfterBlockedSubmissions: orders() });
      return { deletedSelectedID: beta.id, survivingDefaultID: alpha.id, noSilentFallback: true, reloadStillBlocked: true, emptyBookBlocked: true, orderPOSTsAdded: 0, allSixOrderTablesUnchanged: true, cartPreserved: true };
    });
    await checked(24, 'Explicit replacement address restores intended checkout; final delete/reload leaves empty book', async () => {
      const replacement = { ...alphaInput, fullName: 'Fictional replacement recipient', line1: 'Fictional replacement Street', line2: 'Fictional Unit C' };
      await page.locator('#change-address').click(); await saveAddress(page, replacement);
      const current = (await addresses()).entries[0]; assert.ok(current.id !== alpha.id && current.id !== beta.id); assert.equal(await selected(), current.id);
      await page.waitForFunction(() => !document.querySelector('#submit-order').disabled); assert.match(await page.locator('#checkout-address').innerText(), /Fictional replacement Street/);
      await shot('replacement-address-explicitly-selected'); const committed = await submitSelected(current); assert.equal(app.database.get('SELECT count(*) n FROM shop_order').n, 2);
      await accountRoute('addresses'); await deleteAddress(current, true); await page.reload(); await visible('addresses');
      assert.deepEqual(await addresses(), { version: 1, entries: [], defaultId: null }); assert.equal(await page.locator('.address-empty').count(), 1); await shot('addresses-final-delete-reload');
      return { explicitlyChosenReplacementID: current.id, committed, finalEmptyState: await addresses() };
    });
    report.stateEvidence.push({ width, finalSavedProfile: await profile(), finalAddresses: await addresses(), finalDomain: orders(), workerRequests: gateway.records });
    await context.close(); context = null; await app.close(); app = null; rmSync(temp, { recursive: true, force: true }); temp = null;
  }
  assert.equal(report.pageErrors.length, 0); assert.equal(report.externalRequests.length, 0); assert.equal(report.unexpectedDialogs.length, 0);
  assert.deepEqual(hashes(), report.sourceHashes);
} catch (error) {
  process.exitCode = 1; console.error(error.stack);
} finally {
  report.applicationHeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  report.sourceHashesAfter = hashes();
  report.criterionStatus = [23, 24].map(id => {
    const cases = report.cases.filter(x => x.id === id), expected = id === 23 ? 6 : 10;
    const scopedStatus = cases.length === expected && cases.every(x => x.status === 'PASS') ? 'PASS' : cases.some(x => x.status === 'FAIL') ? 'FAIL' : 'UNVERIFIED';
    return { id, scopedStatus, status: id === 23 && scopedStatus === 'PASS' ? 'UNVERIFIED' : scopedStatus,
      ...(id === 23 ? { reason: 'Reload/close draft-protection policy unspecified; observed saved-only reload behavior, no new policy' } : {}) };
  });
  writeFileSync(out + '/results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ head, criteria: report.criterionStatus, cases: report.cases.map(({ id, width, status, error }) => ({ id, width, status, error })) }));
  if (context) await context.close(); await browser.close(); if (app) await app.close(); if (temp) rmSync(temp, { recursive: true, force: true });
}
