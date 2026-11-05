import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { COMPANY_CURRENCY_ACKNOWLEDGED, COMPANY_CURRENCY_WARNING } from '../src/mcp/company-approval-policy.js';

for (const dialect of ['sqlite', 'postgres']) {
  test(`${dialect}: currency changes require a separate server-derived human acknowledgment`,
    { skip: dialect === 'postgres' && !process.env.SHOP_TEST_DATABASE_URL }, async (t) => {
      const f = await reviewFixture(t, dialect); await f.seedGrant();
      await f.store.run("UPDATE oauth_grant SET scopes = 'catalog.write company.write' WHERE id = ?", f.grantId);
      await f.store.run(`INSERT INTO mcp_v2_scope_consent(grant_id, tenant_id, account_id, client_id, scope, account_auth_version, epoch_hash, consented_at)
        SELECT grant_id, tenant_id, account_id, client_id, 'company.write', account_auth_version, epoch_hash, consented_at
        FROM mcp_v2_scope_consent WHERE grant_id = ? AND scope = 'catalog.write'`, f.grantId);
      const company = (before = 'MYR', after = 'SGD', claimed = false) => f.reviewedOperation({
        toolName: 'company.preview_update', requiredScope: 'company.write', requiredCapability: 'settings.write', risk: 'HIGH',
        resourceType: 'company', resourceId: null,
        proposal: { before: { defaultCurrency: before }, after: { defaultCurrency: after }, currencyChanged: claimed },
      });
      const op = await company();
      assert.equal(op.review.data.currencyAcknowledgementRequired, true);
      assert.equal(op.review.data.currencyWarning, COMPANY_CURRENCY_WARNING);
      for (const patch of [{}, { currencyAcknowledged: false }, { currencyAcknowledged: 'true' }, { approved: true, currencyAcknowledged: true }]) {
        assert.equal((await f.call(op.path + '/approval', 'POST', { ...op.input, ...patch }, f.headers)).response.status, 403);
      }
      assert.equal((await f.call(op.path + '/approval', 'POST', { ...op.input, currencyAcknowledged: true }, f.headers)).response.status, 200);
      const event = await f.store.get("SELECT * FROM mcp_v2_event WHERE operation_id = ? AND event = 'APPROVE'", op.value.operationId);
      const proof = await f.store.get('SELECT * FROM mcp_v2_approval WHERE operation_id = ?', op.value.operationId);
      assert.equal(event.outcome, COMPANY_CURRENCY_ACKNOWLEDGED); assert.equal(event.at, proof.approved_at);
      assert.equal(event.approver_id, f.account.id); assert.equal(event.grant_id, f.grantId);
      const unchanged = await company('MYR', 'MYR', true);
      assert.equal(unchanged.review.data.currencyAcknowledgementRequired, false); assert.equal(unchanged.review.data.currencyWarning, null);
      assert.equal((await f.call(unchanged.path + '/approval', 'POST', { ...unchanged.input, currencyAcknowledged: true }, f.headers)).response.status, 403);
      assert.equal((await f.call(unchanged.path + '/approval', 'POST', unchanged.input, f.headers)).response.status, 200);
      const rejected = await company();
      assert.equal((await f.call(rejected.path + '/approval', 'POST', { ...rejected.input, decision: 'reject' }, f.headers)).response.status, 200);
      assert.equal((await f.store.get("SELECT outcome FROM mcp_v2_event WHERE operation_id = ? AND event = 'REJECT'", rejected.value.operationId)).outcome, 'REJECTED');
      assert.doesNotMatch(JSON.stringify(event), /password|challenge|Synthetic-route-password/);
    });
}
