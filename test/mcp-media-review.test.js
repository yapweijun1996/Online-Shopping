import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaReviewFixture, sharedReviewGraph } from './helpers/mcp-media-review-fixture.js';
import { updateProduct } from '../src/products.js';

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: actual first-party media delivery and explicit approval commit once`, async t => {
    const f = await mediaReviewFixture(t, dialect), review = await f.review();
    assert.equal(review.mediaReview.descriptor.policyId, 'media-upload-v1');
    assert.ok(review.mediaReview.items.some(item => item.kind === 'ASSET'));
    assert.equal((await f.approve(review, { mediaReviewed: true })).status, 403);
    await f.complete(review);
    assert.equal((await f.approve(review)).status, 403);
    const approval = await f.approve(review, { mediaReviewed: true });
    assert.equal(approval.status, 200, await approval.text());
    assert.equal((await f.commit()).replayed, false);
    assert.equal((await f.commit()).replayed, true);
  });
  test(`${dialect}: protected delivery and nonce ACK reject forgery, cross-session and replay`, async t => {
    const f = await mediaReviewFixture(t, dialect), review = await f.review(), item = review.mediaReview.items[0];
    for (const headers of [ {}, { ...f.headers, origin: 'https://foreign.example.test' }, { ...f.headers, 'x-csrf-token': 'forged' },
      { authorization: 'Bearer ' + f.bearer, origin: f.config.sellerOrigin } ]) assert.equal((await f.deliver(review, item, headers)).status, 403);
    assert.equal((await f.acknowledge(review, item, 'A'.repeat(43))).status, 403);
    const first = await f.deliver(review, item), oldNonce = first.headers.get('x-media-nonce');
    assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store'); assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
    const second = await f.deliver(review, item), nonce = second.headers.get('x-media-nonce');
    assert.notEqual(nonce, oldNonce); assert.equal((await f.acknowledge(review, item, oldNonce)).status, 403);
    assert.equal((await f.acknowledge(review, { ...item, hash: 'f'.repeat(64) }, nonce)).status, 403);
    assert.equal((await f.acknowledge(review, item, nonce)).status, 200);
    assert.equal((await f.acknowledge(review, item, nonce)).status, 403);
    const fresh = await f.review(); assert.notEqual(fresh.challenge, review.challenge);
    assert.equal((await f.deliver(review, item)).status, 403);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_media_delivery')).n), 0);
    const login = await f.call('/api/v1/seller/session', 'POST', { username: 'synthetic_owner', password: 'Synthetic-route-password-2026!' }, { origin: f.config.sellerOrigin });
    const other = { origin: f.config.sellerOrigin, cookie: login.response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': login.data.csrfToken };
    assert.equal((await f.deliver(fresh, item, other)).status, 403);
  });
  test(`${dialect}: reject needs fresh password but no image ACK and leaves image data unchanged`, async t => {
    const f = await mediaReviewFixture(t, dialect), review = await f.review();
    const before = await f.store.get('SELECT image_data FROM product WHERE id=?', f.product.id);
    const bad = await f.approve(review, { password: 'Incorrect synthetic password' }, 'reject'); assert.equal(bad.status, 403);
    const rejected = await f.approve(review, {}, 'reject'); assert.equal(rejected.status, 200, await rejected.text());
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', f.operation.operationId)).state, 'REJECTED');
    assert.equal(await f.store.get('SELECT operation_id FROM mcp_v2_media_approval_evidence'), undefined);
    assert.deepEqual((await f.store.get('SELECT image_data FROM product WHERE id=?', f.product.id)).image_data, before.image_data);
    await assert.rejects(f.commit(), { status: 403 });
  });
  test(`${dialect}: media review independently fences current grant, consent cutoff, account and tenant revision`, async t => {
    const f = await mediaReviewFixture(t, dialect), review = await f.review(), item = review.mediaReview.items[0];
    const changes = [
      ["UPDATE oauth_grant SET revoked_at=? WHERE id=?", new Date().toISOString(), f.grantId],
      ["UPDATE oauth_grant SET scopes='catalog.write' WHERE id=?", f.grantId],
      ["DELETE FROM mcp_v2_scope_consent WHERE grant_id=? AND scope='media.write'", f.grantId],
      ["UPDATE mcp_v2_scope_consent SET consented_at=? WHERE grant_id=? AND scope='media.write'", new Date(Date.parse((await f.store.get('SELECT created_at FROM mcp_v2_operation WHERE id=?', f.operation.operationId)).created_at) + 1).toISOString(), f.grantId],
      ["UPDATE seller_account SET active=0 WHERE id=?", f.account.id],
      ["UPDATE seller_account SET role='STAFF' WHERE id=?", f.account.id],
      ["UPDATE mcp_v2_operation SET tenant_revision=tenant_revision+1 WHERE id=?", f.operation.operationId],
    ];
    for (const [sql, ...args] of changes) {
      const rollback = new Error('Synthetic rollback');
      await assert.rejects(f.store.transaction(async () => {
        await f.store.run(sql, ...args); assert.equal((await f.deliver(review, item)).status, 403); throw rollback;
      }), error => error === rollback);
    }
    f.config.mcpMedia.enabled = false;
    assert.equal((await f.deliver(review, item)).status, 403);
    assert.equal((await f.approve(review, { mediaReviewed: true })).status, 403);
  });
  test(`${dialect}: password work releases writer lock and a concurrent portal edit invalidates all prior image ACKs`, async t => {
    const f = await mediaReviewFixture(t, dialect), review = await f.review(); await f.complete(review);
    const get = f.store.get; let edited, scheduled = false;
    const changed = new Promise((resolve, reject) => { edited = { resolve, reject }; });
    f.store.get = async (sql, ...args) => {
      const result = await get(sql, ...args);
      if (!scheduled && /SELECT password_hash, oauth_auth_version/.test(sql)) {
        scheduled = true; setImmediate(() => updateProduct(f.store, f.product.id, { name: 'Concurrent synthetic portal edit' }).then(edited.resolve, edited.reject));
      }
      return result;
    };
    const approving = f.approve(review, { mediaReviewed: true }); await changed;
    const response = await approving; f.store.get = get;
    assert.equal(response.status, 403);
    assert.equal(await f.store.get('SELECT operation_id FROM mcp_v2_approval WHERE operation_id=?', f.operation.operationId), undefined);
    assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id=?', f.operation.operationId)).state, 'PENDING_APPROVAL');
  });
  test(`${dialect}: approval audit failure atomically rolls back evidence and challenge consumption`, async t => {
    const f = await mediaReviewFixture(t, dialect), review = await f.review(); await f.complete(review);
    const run = f.store.run;
    f.store.run = (sql, ...args) => {
      if (/INSERT INTO mcp_v2_event/.test(sql) && args.includes('APPROVE')) throw new Error('Synthetic media approval audit failure');
      return run(sql, ...args);
    };
    assert.equal((await f.approve(review, { mediaReviewed: true })).status, 503); f.store.run = run;
    assert.equal(await f.store.get('SELECT operation_id FROM mcp_v2_approval WHERE operation_id=?', f.operation.operationId), undefined);
    assert.equal(await f.store.get('SELECT operation_id FROM mcp_v2_media_approval_evidence WHERE operation_id=?', f.operation.operationId), undefined);
    assert.equal((await f.store.get('SELECT consumed_at FROM mcp_v2_approval_challenge WHERE operation_id=?', f.operation.operationId)).consumed_at, null);
    assert.equal((await f.approve(review, { mediaReviewed: true })).status, 200);
  });
  test(`${dialect}: expired review challenges cannot approve and refresh replaces only unapproved proof`, async t => {
    const f = await mediaReviewFixture(t, dialect), review = await f.review(); await f.complete(review);
    const challenge = await f.store.get('SELECT expires_at FROM mcp_v2_approval_challenge WHERE operation_id=?', f.operation.operationId);
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(challenge.expires_at) + 1 });
    assert.equal((await f.approve(review, { mediaReviewed: true })).status, 403);
    assert.equal((await f.deliver(review, review.mediaReview.items[0])).status, 403);
    const fresh = await f.review(); assert.notEqual(fresh.challenge, review.challenge);
    assert.equal(Number((await f.store.get('SELECT COUNT(*) n FROM mcp_v2_media_delivery WHERE operation_id=?', f.operation.operationId)).n), 0);
    await f.complete(fresh); assert.equal((await f.approve(fresh, { mediaReviewed: true })).status, 200);
    const old = await f.call(f.path, 'GET', undefined, f.headers); assert.equal(old.response.status, 403);
    assert.ok(await f.store.get('SELECT operation_id FROM mcp_v2_media_approval_evidence WHERE operation_id=?', f.operation.operationId));
  });
  test(`${dialect}: complete300-member graph with full shared gallery stays bounded through repeated review and commit`, { timeout: 120000 }, async t => {
    const f = await mediaReviewFixture(t, dialect, { prepareGraph: value => sharedReviewGraph(value, 300) });
    const start = performance.now(); let review;
    for (let n = 0; n < 3; n++) review = await f.review();
    const reviewMs = performance.now() - start;
    assert.equal(review.mediaReview.labels.length, 300);
    const pages = await f.store.all('SELECT page_json FROM mcp_v2_media_manifest_page WHERE operation_id=? ORDER BY page_index', f.operation.operationId);
    const records = pages.flatMap(value => JSON.parse(value.page_json).records);
    assert.equal(records.filter(value => value.kind === 'PRODUCT').length, 300);
    assert.equal(records.find(value => value.kind === 'LISTING').before.galleryAssetKeys.length, 10);
    assert.equal(records.find(value => value.kind === 'LISTING').after.galleryAssetKeys.length, 10);
    const proofStart = performance.now(); await f.complete(review);
    assert.equal((await f.approve(review, { mediaReviewed: true })).status, 200);
    const committed = await f.commit(); assert.equal(committed.replayed, false);
    t.diagnostic(JSON.stringify({ members: 300, pages: pages.length, uniqueAssets: review.mediaReview.descriptor.assetCount,
      repeatedFullReviews: 3, reviewMs: Math.round(reviewMs), deliveryApprovalCommitMs: Math.round(performance.now() - proofStart) }));
  });
}
