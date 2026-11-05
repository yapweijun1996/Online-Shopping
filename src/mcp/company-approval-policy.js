export const COMPANY_CURRENCY_ACKNOWLEDGED = 'CURRENCY_CHANGE_ACKNOWLEDGED';
export const COMPANY_CURRENCY_WARNING = 'Changing the company currency changes the default for future catalog entries. Existing product prices and historical order currencies are not converted.';

// Client flags cannot change human-review policy. Only the immutable stored
// normalized before/after values establish whether currency acknowledgment is needed.
export function requiresCompanyCurrencyAcknowledgement(envelope) {
  if (envelope?.toolName !== 'company.preview_update') return false;
  const before = envelope.proposal?.before?.defaultCurrency;
  const after = envelope.proposal?.after?.defaultCurrency;
  if (!['MYR', 'SGD'].includes(before) || !['MYR', 'SGD'].includes(after)) {
    throw new TypeError('Invalid stored company currency proposal.');
  }
  return before !== after;
}
