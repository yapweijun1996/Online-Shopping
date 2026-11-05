import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, deleteSession } from '../src/auth.js';
import { createApi } from '../src/app.js';
import { secret } from '../src/mcp/credentials.js';
import { reviewFixture, sellerOrigin } from './helpers/mcp-review-fixture.js';

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: real application review and approval bind session, challenge, grant and first-party origin`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
      const f = await reviewFixture(t, dialect); await f.seedGrant();
      const op = await f.reviewedOperation({ proposal: { before: { name: 'Synthetic old' }, after: { name: '</pre><script>window.injected=true</script>' } } });
      assert.equal(op.review.data.proposal.after.name, op.value.proposal.after.name);
      assert.match(op.review.data.challenge, /^[A-Za-z0-9_-]{43}$/);
      assert.doesNotMatch(JSON.stringify(await f.store.all('SELECT * FROM mcp_v2_approval_challenge')), new RegExp(op.input.challenge));
      const page = await f.call('/oauth/operation?operationId=' + op.value.operationId);
      assert.equal(page.response.status, 200);
      assert.equal((await f.call('/oauth/operation?operationId=' + op.value.operationId, 'GET', undefined, {}, 'http://seller.example.test')).response.status, 404);
      assert.equal((await f.call('/oauth/operation?operationId=' + op.value.operationId + '&operationId=' + op.value.operationId)).response.status, 400);
      assert.equal((await f.call('/oauth/operation?operationId=' + op.value.operationId + '&extra=1')).response.status, 400);
      for (const response of [page.response, op.review.response]) {
        assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
        assert.equal(response.headers.get('x-frame-options'), 'DENY');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      }
      for (const path of ['/oauth/operation-review.js', '/oauth/operation-review.css']) assert.equal((await f.call(path)).response.status, 200);
      const deny = async (body, headers = f.headers, status = 403, path = op.path + '/approval') => {
        assert.equal((await f.call(path, 'POST', body, headers)).response.status, status);
        assert.equal((await f.store.get('SELECT state FROM mcp_v2_operation WHERE id = ?', op.value.operationId)).state, 'PENDING_APPROVAL');
      };
      assert.equal((await f.call(op.path)).response.status, 403);
      await deny({ ...op.input, approved: true });
      await deny(op.input, { ...f.headers, cookie: f.cookie + '; ' + f.cookie });
      await deny(op.input, { ...f.headers, authorization: 'Bearer synthetic' });
      await deny({ ...op.input, challenge: secret() });
      await deny({ ...op.input, password: 'wrong' });
      await deny({ ...op.input, previewHash: 'f'.repeat(64) });
      await deny(op.input, { ...f.headers, 'x-csrf-token': 'forged' });
      await deny(op.input, { ...f.headers, origin: 'null' });
      const otherOrigin = await f.call(op.path + '/approval', 'POST', op.input, { ...f.headers, origin: 'https://ai.example.test' });
      assert.equal(otherOrigin.response.status, 403);
      assert.equal(otherOrigin.response.headers.get('access-control-allow-origin'), null);
      await deny(op.input, { cookie: f.cookie, 'x-csrf-token': f.csrf });
      const anotherSession = await createSession(f.store, f.account.id);
      await deny(op.input, { ...f.headers, cookie: `seller_session=${anotherSession.token}`, 'x-csrf-token': anotherSession.csrfToken });
      await deny(JSON.stringify(op.input).replace('{', '{"decision":"reject",'), f.headers, 400);
      await deny(' '.repeat(4097), f.headers, 413);
      await deny(op.input, { ...f.headers, 'content-type': 'text/plain' }, 415);
      await deny({ ...op.input, operationId: '00000000-0000-4000-8000-000000000000' }, f.headers, 400);
      await deny(op.input, f.headers, 400, op.path + '/approval?extra=1');
      assert.equal((await f.call(op.path + '/approval', 'OPTIONS', undefined, { origin: sellerOrigin })).response.status, 405);
      assert.equal((await f.call(op.path, 'GET', undefined, f.headers, 'https://shop.example.test')).response.status, 404);
      const approved = await f.call(op.path + '/approval', 'POST', op.input, f.headers);
      assert.equal(approved.response.status, 200, JSON.stringify(approved.data));
      assert.equal(approved.data.status, 'APPROVED');
      assert.equal((await f.call(op.path + '/approval', 'POST', op.input, f.headers)).response.status, 403);
      assert.equal((await f.call(op.path, 'GET', undefined, f.headers)).response.status, 403);
      const proof = await f.store.get('SELECT * FROM mcp_v2_approval_challenge WHERE operation_id = ?', op.value.operationId);
      assert.ok(proof.consumed_at);
      assert.equal(Number((await f.store.get('SELECT COUNT(*) AS n FROM mcp_v2_approval')).n), 1);
      assert.ok(Number((await f.store.get("SELECT COUNT(*) AS n FROM mcp_audit WHERE event = 'DENY'")).n) > 0);
      assert.doesNotMatch(JSON.stringify(await f.store.all('SELECT * FROM mcp_audit')), /Synthetic-route-password|window.injected|seller_session|challenge/);
    });
}

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: real routes deny stale grants, consent, account and review challenges`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
      const f = await reviewFixture(t, dialect); await f.seedGrant();
      const op = await f.reviewedOperation();
      const denied = async () => {
        assert.equal((await f.call(op.path, 'GET', undefined, f.headers)).response.status, 403);
        assert.equal((await f.call(op.path + '/approval', 'POST', op.input, f.headers)).response.status, 403);
      };
      await f.store.run("UPDATE shop_setup SET mode = 'demo' WHERE id = 1");
      await denied(); await f.store.run("UPDATE shop_setup SET mode = 'production' WHERE id = 1");
      await f.store.run('UPDATE oauth_grant SET revoked_at = ? WHERE id = ?', new Date().toISOString(), f.grantId);
      await denied(); await f.store.run('UPDATE oauth_grant SET revoked_at = NULL WHERE id = ?', f.grantId);
      await f.store.run("UPDATE seller_account SET role = 'STAFF' WHERE id = ?", f.account.id);
      await denied(); await f.store.run("UPDATE seller_account SET role = 'OWNER' WHERE id = ?", f.account.id);
      await f.store.run('UPDATE seller_account SET active = 0 WHERE id = ?', f.account.id);
      await denied(); await f.store.run('UPDATE seller_account SET active = 1 WHERE id = ?', f.account.id);
      await f.store.run('UPDATE mcp_v2_scope_consent SET epoch_hash = ?', 'a'.repeat(64));
      await denied();
      await f.store.run('UPDATE mcp_v2_scope_consent SET epoch_hash = (SELECT epoch_hash FROM mcp_v2_operation WHERE id = ?)', op.value.operationId);
      await f.store.run('UPDATE mcp_v2_approval_challenge SET expires_at = ? WHERE operation_id = ?', new Date(Date.now() - 1).toISOString(), op.value.operationId);
      assert.equal((await f.call(op.path + '/approval', 'POST', op.input, f.headers)).response.status, 403);
      const fresh = await f.call(op.path, 'GET', undefined, f.headers); assert.equal(fresh.response.status, 200);
      assert.notEqual(fresh.data.challenge, op.input.challenge);
      assert.equal((await f.call(op.path + '/approval', 'POST', op.input, f.headers)).response.status, 403);
      const rejected = await f.call(op.path + '/approval', 'POST', { ...op.input, challenge: fresh.data.challenge, decision: 'reject' }, f.headers);
      assert.equal(rejected.response.status, 200); assert.equal(rejected.data.status, 'REJECTED');
      const bad = await f.operation({ tenantId: 'forged' });
      assert.equal((await f.call(bad.path, 'GET', undefined, f.headers)).response.status, 403);
      const expired = await f.operation({ createdAt: new Date(Date.now() - 120000).toISOString(), expiresAt: new Date(Date.now() - 60000).toISOString() });
      assert.equal((await f.call(expired.path, 'GET', undefined, f.headers)).response.status, 403);
      await deleteSession(f.store, f.cookie.split('=')[1]);
      assert.equal((await f.call(bad.path, 'GET', undefined, f.headers)).response.status, 403);
    });
}

test('missing optional v2 configuration keeps v1 healthy and review disabled with no operation authority', async (t) => {
  const f = await reviewFixture(t, 'sqlite', { config: { mcpV2: undefined } });
  const id = '00000000-0000-4000-8000-000000000001';
  for (const path of ['/oauth/operation?operationId=' + id, '/oauth/operation-review.js', '/api/v1/seller/mcp/operations/' + id]) {
    assert.equal((await f.call(path, 'GET', undefined, f.headers)).response.status, 404);
  }
  assert.equal((await f.call('/.well-known/oauth-authorization-server')).response.status, 200);
  assert.equal((await f.call('/ready')).response.status, 200);
  assert.equal((await f.store.get("SELECT name FROM sqlite_master WHERE name = 'mcp_v2_operation'")).name, 'mcp_v2_operation');
  for (const table of ['mcp_v2_operation', 'mcp_v2_scope_consent', 'mcp_v2_approval_challenge', 'mcp_v2_approval']) {
    assert.equal(Number((await f.store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n), 0);
  }
  assert.ok(!(await f.call('/.well-known/oauth-authorization-server')).data.scopes_supported.includes('catalog.write'));
  for (const patch of [{ sellerQuickLogin: true }, { shopMode: 'public-demo' }, { production: true }]) {
    const api = await createApi({ store: f.store, config: { ...f.config, ...patch, mcpV2: { enabled: true, epoch: secret(), buildDigest: 'e'.repeat(64) } } });
    assert.equal((await api(new Request(sellerOrigin + '/api/v1/seller/mcp/operations/' + id, { headers: f.headers }))).status, 404);
  }
});

test('PostgreSQL platform registry fences cached suspension and rename before tenant review work',
  { skip: !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
    const [{ default: pg }, { randomUUID }, { openPlatformDatabase }, { createPlatformRegistry }] = await Promise.all([
      import('pg'), import('node:crypto'), import('../src/platform/platform-db.js'), import('../src/platform/registry.js'),
    ]);
    const admin = new pg.Pool({ connectionString: process.env.SHOP_TEST_DATABASE_URL });
    const databaseName = `shopping_test_review_platform_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(process.env.SHOP_TEST_DATABASE_URL); url.pathname = '/' + databaseName;
    let other;
    const platform = await openPlatformDatabase(url.href), tenantId = randomUUID(), now = new Date().toISOString();
    t.after(async () => { if (other) await other.end(); await platform.close(); await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`); await admin.end(); });
    await platform.run(`INSERT INTO tenant(id, code, name, status, currency, database_name, database_role,
      database_password_sealed, database_key_id, created_at, updated_at) VALUES (?, 'alpha', 'Synthetic alpha', 'ACTIVE', 'MYR', ?, ?, ?, 'k1', ?, ?)`,
    tenantId, 't_alpha_12345678', 't_alpha_12345678', Buffer.from('synthetic'), now, now);
    let tenantReads = 0, pauseQuery = null;
    const f = await reviewFixture(t, 'postgres', { tenantId, config: { basePath: '/alpha', platform: { adminHost: 'admin.example.test' } },
      registry: (store, config) => {
        const counted = { ...store, get: async (...args) => {
          tenantReads++; const result = await store.get(...args);
          if (pauseQuery) await pauseQuery(args[0]);
          return result;
        } };
        return createPlatformRegistry({ store, config, platform, pool: { get: async () => counted } });
      } });
    await f.seedGrant();
    const op = await f.reviewedOperation({ proposal: { before: { url: '/api/old' }, after: { url: '/api/new' } } });
    assert.equal(op.review.data.proposal.after.url, '/api/new');
    let entered, release;
    const inside = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    pauseQuery = async sql => {
      if (sql !== 'SELECT * FROM mcp_v2_operation WHERE id = ?') return;
      pauseQuery = null; entered(); await held;
    };
    const reviewing = f.call(op.path, 'GET', undefined, f.headers); await inside;
    other = new pg.Client({ connectionString: url.href }); await other.connect();
    const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let suspended = false;
    const suspension = other.query("UPDATE tenant SET status = 'SUSPENDED', revision = revision + 1 WHERE id = $1", [tenantId])
      .then(() => { suspended = true; });
    try {
      let waiting;
      for (let attempt = 0; attempt < 30; attempt++) {
        waiting = (await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0]?.wait_event_type;
        if (waiting === 'Lock') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(waiting, 'Lock'); assert.equal(suspended, false);
    } finally { release(); }
    assert.equal((await reviewing).response.status, 200);
    await suspension; assert.equal(suspended, true);
    let before = tenantReads;
    assert.equal((await f.call(op.path, 'GET', undefined, f.headers)).response.status, 503);
    assert.equal((await f.call(op.path + '/approval', 'POST', op.input, f.headers)).response.status, 503);
    assert.equal(tenantReads, before);
    await platform.run("UPDATE tenant SET status = 'ACTIVE', revision = revision + 1 WHERE id = ?", tenantId);
    assert.equal((await f.call(op.path, 'GET', undefined, f.headers)).response.status, 403);
    await platform.run("UPDATE tenant SET code = 'bravo', revision = revision + 1 WHERE id = ?", tenantId);
    before = tenantReads;
    assert.equal((await f.call(op.path, 'GET', undefined, f.headers)).response.status, 503);
    assert.equal(tenantReads, before);
  });

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: actual HTTP approval authorizes one synthetic commit and audit failure rolls it back`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
      const [{ createOperationEngine }, { singleTenantRegistry }] = await Promise.all([
        import('../src/mcp/operation-engine.js'), import('../src/tenants.js'),
      ]);
      const f = await reviewFixture(t, dialect); await f.seedGrant();
      await f.store.exec('CREATE TABLE synthetic_review_product (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL)');
      const bearer = secret(), now = new Date().toISOString(), later = new Date(Date.now() + 600000).toISOString();
      const { hash } = await import('../src/mcp/credentials.js');
      await f.store.run(`INSERT INTO oauth_token(token_hash, kind, grant_id, resource, scopes, issued_at, expires_at, generation)
        VALUES (?, 'access', ?, ?, 'catalog.write', ?, ?, 0)`, hash(bearer), f.grantId, f.binding.resource, now, later);
      const registry = singleTenantRegistry({ store: f.store, config: f.config });
      const tenantGuard = registry.operationGuard(await registry.resolve());
      const adapter = {
        resourceType: 'product', preview: async () => { throw new Error('Synthetic prepared operation fixture only.'); },
        currentRevision: async (read, envelope) => {
          const row = await read.get('SELECT revision FROM synthetic_review_product WHERE id = ?', envelope.resourceId);
          return { exists: Boolean(row), revision: row?.revision ?? null };
        },
        apply: async (store, proposal) => {
          await store.run('UPDATE synthetic_review_product SET name = ?, revision = revision + 1 WHERE id = ?', proposal.after.name, proposal.id);
          return store.get('SELECT id, revision FROM synthetic_review_product WHERE id = ?', proposal.id);
        },
        validResult: value => Boolean(value && Object.keys(value).sort().join(',') === 'id,revision'),
        toReceipt: value => ({ id: value.id, revision: value.revision }),
        validReceipt: value => Boolean(value && Object.keys(value).sort().join(',') === 'id,revision' && Number.isSafeInteger(value.revision)),
      };
      const options = { store: f.store, binding: { ...f.binding, mcpV2: f.config.mcpV2 }, enabled: true, quickLogin: false,
        epoch: f.config.mcpV2.epoch, buildDigest: f.config.mcpV2.buildDigest, tenantGuard, adapters: { 'catalog.preview_update': adapter } };
      const engine = createOperationEngine(options);
      async function syntheticOperation() {
        const { randomUUID } = await import('node:crypto'); const id = randomUUID();
        await f.store.run('INSERT INTO synthetic_review_product(id, name, revision) VALUES (?, ?, 1)', id, 'Synthetic old');
        return f.reviewedOperation({ resourceId: id, proposal: { id, before: { name: 'Synthetic old' }, after: { name: 'Synthetic new' } } });
      }
      const op = await syntheticOperation();
      const commit = (operation, runner = engine) => runner.commit({ bearer, toolName: 'catalog.commit_update', operationId: operation.value.operationId });
      await assert.rejects(commit(op), { status: 403 });
      assert.equal((await f.call(op.path + '/approval', 'POST', op.input, f.headers)).response.status, 200);
      const results = await Promise.all([commit(op), commit(op)]);
      assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
      assert.equal((await f.store.get('SELECT revision FROM synthetic_review_product WHERE id = ?', op.value.resourceId)).revision, 2);
      const failed = await syntheticOperation();
      assert.equal((await f.call(failed.path + '/approval', 'POST', failed.input, f.headers)).response.status, 200);
      const faultStore = { ...f.store, run: async (sql, ...values) => {
        if (sql.includes('INSERT INTO mcp_v2_event') && values.includes('COMMIT')) throw new Error('Synthetic commit audit failure.');
        return f.store.run(sql, ...values);
      } };
      const faultEngine = createOperationEngine({ ...options, store: faultStore });
      await assert.rejects(commit(failed, faultEngine), /Synthetic commit audit failure/);
      assert.equal((await f.store.get('SELECT name FROM synthetic_review_product WHERE id = ?', failed.value.resourceId)).name, 'Synthetic old');
      assert.equal((await f.store.get('SELECT revision FROM synthetic_review_product WHERE id = ?', failed.value.resourceId)).revision, 1);
      assert.equal(await f.store.get("SELECT id FROM mcp_v2_event WHERE operation_id = ? AND event = 'COMMIT'", failed.value.operationId), undefined);
    });
}

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: public review assets and rejected authentication cannot drive operation maintenance`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
      const f = await reviewFixture(t, dialect); await f.seedGrant();
      const op = await f.reviewedOperation();
      const expired = await f.operation({ createdAt: new Date(Date.now() - 120000).toISOString(), expiresAt: new Date(Date.now() - 60000).toISOString(),
        proposal: { before: 'Synthetic expired private text', after: 'Synthetic replacement' } });
      const before = await f.store.all('SELECT * FROM mcp_v2_operation ORDER BY id');
      const originalAll = f.store.all; let maintenanceQueries = 0;
      f.store.all = async (sql, ...values) => {
        if (sql.includes('mcp_v2_operation') || sql.includes('mcp_v2_approval')) maintenanceQueries++;
        return originalAll(sql, ...values);
      };
      try {
        for (const path of ['/oauth/operation?operationId=' + op.value.operationId, '/oauth/operation-review.js', '/oauth/operation-review.css']) {
          assert.equal((await f.call(path)).response.status, 200);
        }
        assert.equal((await f.call(op.path)).response.status, 403);
        assert.equal((await f.call(op.path + '/approval', 'POST', { ...op.input, password: 'wrong' }, f.headers)).response.status, 403);
      } finally { f.store.all = originalAll; }
      assert.equal(maintenanceQueries, 0);
      assert.deepEqual(await f.store.all('SELECT * FROM mcp_v2_operation ORDER BY id'), before);
      assert.equal((await f.call(op.path, 'GET', undefined, f.headers)).response.status, 200);
      const cleaned = await f.store.get('SELECT state, envelope_json FROM mcp_v2_operation WHERE id = ?', expired.value.operationId);
      assert.equal(cleaned.state, 'EXPIRED'); assert.equal(cleaned.envelope_json, null);
    });
}

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: approval lifetime uses one timestamp when the clock advances between reads`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
      const f = await reviewFixture(t, dialect); await f.seedGrant();
      const op = await f.reviewedOperation();
      const originalNow = Date.now, base = originalNow(); let ticks = 0, response;
      Date.now = () => base + ++ticks;
      try {
        const review = await f.call(op.path, 'GET', undefined, f.headers);
        assert.equal(review.response.status, 200); op.input.challenge = review.data.challenge;
        const challenge = await f.store.get('SELECT created_at, expires_at FROM mcp_v2_approval_challenge WHERE operation_id = ?', op.value.operationId);
        assert.equal(Date.parse(challenge.expires_at) - Date.parse(challenge.created_at), 5 * 60000);
        response = await f.call(op.path + '/approval', 'POST', op.input, f.headers);
      } finally { Date.now = originalNow; }
      assert.equal(response.response.status, 200, JSON.stringify(response.data));
      const proof = await f.store.get('SELECT approved_at, expires_at FROM mcp_v2_approval WHERE operation_id = ?', op.value.operationId);
      assert.equal(Date.parse(proof.expires_at) - Date.parse(proof.approved_at), 5 * 60000);
    });
}
