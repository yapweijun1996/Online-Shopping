import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reviewFixture } from './helpers/mcp-review-fixture.js';

const id = '00000000-0000-4000-8000-000000000001';
for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: review shell permits bounded inert source attribution while all API/asset queries stay strict`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async t => {
      const f = await reviewFixture(t, dialect);
      const query = '?operationId=' + id;
      const plain = await f.call('/oauth/operation' + query);
      assert.equal(plain.response.status, 200);
      for (const suffix of ['&utm_source=chatgpt.com', '&utm_source=synthetic-source_1', '&utm_source=' + 'a'.repeat(128)]) {
        const page = await f.call('/oauth/operation' + query + suffix);
        assert.equal(page.response.status, 200, suffix);
        assert.equal(page.data, plain.data); // Attribution is not reflected into HTML.
      }
      for (const suffix of ['&other=1', '&utm_campaign=one', '&utm_source=', '&utm_source=' + 'a'.repeat(129),
        '&utm_source=one&utm_source=two', '&operationId=' + id, '&utm_source=%3Cscript%3E', '&utm_source=%ZZ', '&utm_source=one+two']) {
        assert.equal((await f.call('/oauth/operation' + query + suffix)).response.status, 400, suffix);
      }
      for (const suffix of ['', '?utm_source=chatgpt.com', '?operationId=bad', '?operationId=']) {
        assert.equal((await f.call('/oauth/operation' + suffix)).response.status, 400, suffix);
      }
      for (const resource of ['/oauth/operation-review.js', '/oauth/operation-review.css', '/oauth/operation-review-tokens.css', '/api/v1/seller/mcp/operations/' + id]) {
        assert.equal((await f.call(resource + '?utm_source=chatgpt.com')).response.status, 400, resource);
      }
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_operation')).n), 0);
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n), 0);
    });
}

for (const basePath of ['', '/alpha']) {
  test(`review token stylesheet uses canonical inert bytes and protected policy at ${basePath || 'root'}`, async t => {
    const f = await reviewFixture(t, 'sqlite', { config: { basePath } });
    const path = '/oauth/operation-review-tokens.css';
    const asset = await f.call(path);
    assert.equal(asset.response.status, 200);
    assert.equal(asset.data, await readFile(new URL('../public/shop/tokens.css', import.meta.url), 'utf8'));
    assert.equal(asset.response.headers.get('content-type'), 'text/css; charset=utf-8');
    const page = await f.call('/oauth/operation?operationId=' + id);
    for (const header of ['content-security-policy', 'cache-control', 'referrer-policy', 'x-content-type-options', 'x-frame-options', 'x-robots-tag']) {
      assert.equal(asset.response.headers.get(header), page.response.headers.get(header), header);
    }
    assert.equal(asset.response.headers.get('access-control-allow-origin'), null);
    for (const query of ['?operationId=' + id, '?utm_source=chatgpt.com', '?v=1&v=2']) {
      assert.equal((await f.call(path + query)).response.status, 400, query);
    }
    assert.equal((await f.call(path, 'POST')).response.status, 405);
    assert.equal((await f.call(path, 'GET', undefined, { origin: 'https://ai.example.test' })).response.status, 403);
    assert.equal((await f.call(path, 'GET', undefined, {}, 'https://shop.example.test')).response.status, 404);
    assert.equal((await f.call('/oauth/operation-review-tokens.css/extra')).response.status, 404);
  });
}
