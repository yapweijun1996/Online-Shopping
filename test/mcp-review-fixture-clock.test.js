import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { readOperationRecord } from '../src/mcp/operation-record.js';

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: review fixture retains exact operation TTL across a clock tick`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
      const base = Date.now();
      t.mock.timers.enable({ apis: ['Date'], now: base });
      // Model a millisecond passing between the creation and expiry clock reads.
      t.mock.method(Date, 'now', () => base + 1);
      const f = await reviewFixture(t, dialect); await f.seedGrant();
      const operation = await f.operation();
      const row = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', operation.value.operationId);
      assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 10 * 60000);
      const grant = await f.store.get('SELECT * FROM oauth_grant WHERE id = ?', f.grantId);
      const context = { ...f.binding, tenantRevision: 0, accountId: f.account.id, clientId: f.clientId,
        grantId: f.grantId, accountAuthVersion: f.account.oauth_auth_version, epochHash: row.epoch_hash,
        buildDigest: row.build_digest, grantExpiresAt: grant.absolute_expires_at };
      const options = { binding: f.binding, tenantRevision: 0, epochHash: row.epoch_hash,
        buildDigest: row.build_digest, grant, context, expected: { resourceType: 'product' } };
      assert.ok(await readOperationRecord(f.store, row, options), 'fixture is accepted by the production record validator');
      // Invalid lifetimes still fail even with a matching immutable envelope/hash.
      for (const delta of [-1, 1]) {
        const invalid = await f.operation({ expiresAt: new Date(Date.parse(row.expires_at) + delta).toISOString() });
        const stored = await f.store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', invalid.value.operationId);
        assert.equal(await readOperationRecord(f.store, stored, options), null);
      }
    });
}
