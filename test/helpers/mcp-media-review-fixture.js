import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { coordinatorFixture } from './mcp-media-coordinator-fixture.js';
import { syntheticMediaPng } from './mcp-media-hooks-fixture.js';
import { createOperationEngine } from '../../src/mcp/operation-engine.js';
import { mediaHash } from '../../src/mcp/media-storage.js';
import { reviewPassword } from './mcp-review-fixture.js';
import { hash, secret } from '../../src/mcp/credentials.js';
import { readMediaSnapshot } from '../../src/mcp/media-resources.js';

async function freshOAuth(f) {
  const redirect = 'https://connector.example.com/callback', verifier = secret() + secret();
  const registered = await f.call('/oauth/register', 'POST', { client_name: 'Synthetic media reviewer', redirect_uris: [redirect],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  assert.equal(registered.response.status, 201, JSON.stringify(registered.data));
  const clientId = registered.data.client_id, scope = 'catalog.write media.write';
  const staged = await f.call('/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect,
    scope, state: secret(), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: f.binding.resource }));
  assert.equal(staged.response.status, 200);
  const authorizationRequestId = /data-request="([^"]+)"/.exec(staged.data)?.[1], proof = /data-proof="([^"]+)"/.exec(staged.data)?.[1];
  assert.ok(authorizationRequestId && proof);
  const signed = await f.call('/api/v1/seller/session', 'POST', { username: 'synthetic_owner', password: reviewPassword,
    mcpAuthorization: { authorizationRequestId, proof } }, { origin: f.config.sellerOrigin });
  assert.equal(signed.response.status, 200);
  f.cookie = signed.response.headers.get('set-cookie').split(';')[0]; f.csrf = signed.data.csrfToken;
  f.headers = { origin: f.config.sellerOrigin, cookie: f.cookie, 'x-csrf-token': f.csrf };
  const consent = await f.call('/api/v1/seller/mcp/consent', 'POST', { authorizationRequestId, decision: 'approve', scopes: scope.split(' ') }, f.headers);
  assert.equal(consent.response.status, 200, JSON.stringify(consent.data));
  const code = new URL(consent.data.redirectTo).searchParams.get('code');
  const token = await f.call('/oauth/token', 'POST', new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code,
    code_verifier: verifier, redirect_uri: redirect, resource: f.binding.resource }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(token.response.status, 200, JSON.stringify(token.data));
  f.bearer = token.data.access_token; f.clientId = clientId;
  f.grantId = (await f.store.get('SELECT grant_id FROM oauth_token WHERE token_hash=?', hash(f.bearer))).grant_id;
}

// Supported persisted boundary fixture, not an application business-write path.
// A variant owns a separate main image plus a holder's full10-slot shared layout.
export async function sharedReviewGraph(f, members = 2) {
  const old = await f.store.get('SELECT image_data FROM product WHERE id=?', f.product.id), rows = [], values = [];
  for (let n = 1; n < members; n++) {
    const id = randomUUID();
    rows.push("(?,?,'Synthetic shared member','Synthetic media','SYNTHETIC',100,'MYR',1,?,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','image/png',?)");
    values.push(id, 'SHARED-' + n, f.product.listingId, old.image_data);
  }
  await f.store.run('INSERT INTO product(id,sku,name,description,category,price_minor,currency,active,listing_id,created_at,updated_at,image_mime,image_data) VALUES ' + rows.join(','), ...values);
  const holder = (await readMediaSnapshot(f.store, f.product.id)).views.find(value => value.productId === f.product.id).holderId;
  const gallery = [];
  for (let n = 0; n < 10; n++) {
    const id = randomUUID(); gallery.push(id);
    await f.store.run("INSERT INTO product_gallery_image(id,product_id,position,mime,data,created_at) VALUES(?,?,?,'image/png',?,'2026-01-01T00:00:00.000Z')", id, holder, n + 1, syntheticMediaPng(20 + n));
  }
  await f.store.run('UPDATE product SET gallery_layout_json=? WHERE id=?', JSON.stringify(gallery), holder);
}

// Actual coordinator/business/HTTP handlers. Decoder packet is explicitly synthetic.
export async function mediaReviewFixture(t, dialect, options = {}) {
  const { fixtureOptions = {}, prepareGraph, ...rest } = options;
  const f = await coordinatorFixture(t, dialect, { ...rest, fixtureOptions: { ...fixtureOptions,
    config: { mcpMedia: { enabled: true }, mcpRedirectUris: ['https://connector.example.com/callback'], ...fixtureOptions.config } } }), source = syntheticMediaPng();
  await freshOAuth(f);
  if (prepareGraph) await prepareGraph(f);
  const begun = await f.coordinator.begin(f.bearer, await f.input(source));
  await f.coordinator.append(f.bearer, { stageId: begun.stageId, offset: 0, dataParts: [source.toString('base64')] });
  const engine = createOperationEngine({ ...f.options, adapters: { 'media.prepare_upload': f.coordinator.uploadAdapter } });
  const operation = await engine.prepare({ bearer: f.bearer, toolName: 'media.prepare_upload', args: { stageId: begun.stageId }, idempotencyKey: 'synthetic-review-operation-0001' });
  const path = '/api/v1/seller/mcp/operations/' + operation.operationId;
  const request = (suffix, input, headers = f.headers) => f.api(new Request(f.config.sellerOrigin + path + suffix, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) }), { clientAddress: 'synthetic-media-review' });
  const review = async () => {
    const value = await f.call(path, 'GET', undefined, f.headers); assert.equal(value.response.status, 200, JSON.stringify(value.data)); return value.data;
  };
  const deliver = (value, item, headers) => request('/media/delivery', { operationId: operation.operationId, previewHash: operation.previewHash,
    challenge: value.challenge, kind: item.kind, itemKey: item.itemKey }, headers);
  const acknowledge = (value, item, nonce, headers) => request('/media/ack', { operationId: operation.operationId, previewHash: operation.previewHash,
    challenge: value.challenge, kind: item.kind, itemKey: item.itemKey, expectedHash: item.hash, nonce }, headers);
  const complete = async value => {
    for (const item of value.mediaReview.items) {
      const response = await deliver(value, item); assert.equal(response.status, 200, await response.clone().text());
      assert.equal(mediaHash(Buffer.from(await response.arrayBuffer())), item.hash);
      assert.equal((await acknowledge(value, item, response.headers.get('x-media-nonce'))).status, 200);
    }
  };
  const approve = (value, extra = {}, decision = 'approve') => request('/approval', { operationId: operation.operationId,
    previewHash: operation.previewHash, challenge: value.challenge, decision, password: reviewPassword, ...extra });
  const commit = () => engine.commit({ bearer: f.bearer, toolName: 'media.commit_upload', operationId: operation.operationId });
  return { ...f, source, stage: begun, engine, operation, path, request, review, deliver, acknowledge, complete, approve, commit };
}
