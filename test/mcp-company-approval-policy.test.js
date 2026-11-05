import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresCompanyCurrencyAcknowledgement as required } from '../src/mcp/company-approval-policy.js';

test('company currency acknowledgment follows immutable normalized currencies, not proposal flags', () => {
  assert.equal(required({ toolName: 'catalog.preview_update', proposal: {} }), false);
  const company = (before, after, currencyChanged) => ({ toolName: 'company.preview_update',
    proposal: { before: { defaultCurrency: before }, after: { defaultCurrency: after }, currencyChanged } });
  assert.equal(required(company('MYR', 'SGD', false)), true);
  assert.equal(required(company('SGD', 'MYR', false)), true);
  assert.equal(required(company('MYR', 'MYR', true)), false);
  assert.throws(() => required(company('USD', 'MYR', false)), TypeError);
  assert.throws(() => required(company(undefined, 'MYR', false)), TypeError);
});
