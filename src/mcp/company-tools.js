import { createHash } from 'node:crypto';
import { ApiError } from '../http.js';
import { getCompanySettings, prepareCompanySettings, updateCompanySettings } from '../settings.js';
import { FieldError } from '../validation.js';
import { senderFields } from '../sender-settings.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { valid } from './tools.js';
import { COMPANY_CURRENCY_WARNING } from './company-approval-policy.js';
export { COMPANY_CURRENCY_WARNING } from './company-approval-policy.js';

const text = (maximum) => ({ type: 'string', minLength: 0, maxLength: maximum });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const revision = { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]{64}$' };
const fieldSchemas = {
  defaultCurrency: { type: 'string', minLength: 3, maxLength: 3, enum: ['MYR', 'SGD'] },
  sellerWhatsAppPhone: nullable(text(32)), mobileHideBarsOnScroll: { type: 'boolean' },
  availabilityText: nullable(text(4096)), shippingText: nullable(text(4096)), returnsText: nullable(text(4096)),
  ...Object.fromEntries(Object.keys(senderFields).map((field) => [field, nullable(text(field === 'senderPhone' ? 32 : 4096))])),
};
export const COMPANY_FIELDS = Object.freeze(Object.keys(fieldSchemas));
const snapshotFields = {
  ...fieldSchemas,
  sellerWhatsAppPhone: nullable(text(15)), availabilityText: nullable(text(1000)), shippingText: nullable(text(1000)), returnsText: nullable(text(1000)),
  ...Object.fromEntries(Object.entries(senderFields).map(([field, [, maximum]]) => [field, nullable(text(maximum))])),
};
const settingsSchema = object(snapshotFields);
const changedFields = { type: 'array', minItems: 0, maxItems: COMPANY_FIELDS.length, items: { type: 'string', minLength: 1, maxLength: 32, enum: [...COMPANY_FIELDS] } };
const receiptSchema = object({ revision, changedFields, currencyChanged: { type: 'boolean' } });
const snapshotSchema = object({ company: object({ ...snapshotFields, revision }) });
const CAP = 10000;

// Call only while holding the tenant fence and shared shop writer lock.
// The complete company row covers portal/setup writes; bounded exact currency
// counts cover the existing currency-conflict predicate without reading prices.
export async function companyRevision(read) {
  const company = await read.get('SELECT * FROM company_setting WHERE id = 1');
  if (!company) throw new ApiError(404, 'NOT_FOUND', 'Company settings are unavailable.');
  const currencies = await read.all(`SELECT currency, COUNT(*) AS count FROM
    (SELECT currency FROM product ORDER BY id LIMIT ${CAP + 1}) bounded_currency
    GROUP BY currency ORDER BY currency`);
  if (currencies.reduce((total, row) => total + row.count, 0) > CAP) {
    throw new ApiError(503, 'COMPANY_REVISION_TOO_LARGE', 'The company currency review exceeds its catalog limit.');
  }
  return createHash('sha256').update(canonicalOperationJson({ company, currencies })).digest('hex');
}

// This implementation is not authority. The trusted v2 read registry must
// check company.read/current RBAC and hold the tenant fence/store lock plus audit.
export async function getCompanyToolSnapshot(read) {
  const value = { company: { ...await getCompanySettings(read), revision: await companyRevision(read) } };
  if (!valid(value, snapshotSchema)) throw new TypeError('Invalid stored company settings.');
  return value;
}
const changed = (before, after) => COMPANY_FIELDS.filter((field) => before[field] !== after[field]);
function receiptValid(value) {
  return valid(value, receiptSchema) && new Set(value.changedFields).size === value.changedFields.length;
}
function proposalValid(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'after,before,changedFields,currencyChanged,warnings' ||
      !valid(value.before, settingsSchema) || !valid(value.after, settingsSchema) || !Array.isArray(value.changedFields) || !Array.isArray(value.warnings)) return false;
  const fields = changed(value.before, value.after), currencyChanged = value.before.defaultCurrency !== value.after.defaultCurrency;
  return canonicalOperationJson(fields) === canonicalOperationJson(value.changedFields) && value.currencyChanged === currencyChanged &&
    canonicalOperationJson(value.warnings) === canonicalOperationJson(currencyChanged ? [COMPANY_CURRENCY_WARNING] : []);
}

export function companyMutationTool() {
  const inputSchema = object({ expectedRevision: revision, changes: object(fieldSchemas, []) });
  return {
    previewName: 'company.preview_update', commitName: 'company.commit_update', scope: 'company.write', capability: 'settings.write', inputSchema, receiptSchema,
    adapter: {
      resourceType: 'company',
      async preview(read, args) {
        if (!valid(args, inputSchema)) throw new ApiError(400, 'INVALID_INPUT', 'Invalid company changes.');
        const currentRevision = await companyRevision(read);
        if (currentRevision !== args.expectedRevision) throw new ApiError(409, 'STALE_REVISION', 'Company settings changed. Review a fresh snapshot.');
        let normalized;
        try { normalized = await prepareCompanySettings(read, args.changes); }
        catch (error) {
          if (error instanceof FieldError) throw new ApiError(400, 'INVALID_INPUT', 'Invalid company changes.');
          throw error;
        }
        const { before, after } = normalized;
        const currencyChanged = before.defaultCurrency !== after.defaultCurrency;
        const proposal = { before, after, changedFields: changed(before, after), currencyChanged, warnings: currencyChanged ? [COMPANY_CURRENCY_WARNING] : [] };
        if (!proposalValid(proposal)) throw new TypeError('Invalid company proposal.');
        return { resourceId: '1', expectedRevision: currentRevision, proposal };
      },
      async currentRevision(read, envelope) {
        if (envelope.resourceId !== '1') return { exists: false, revision: null };
        return { exists: true, revision: await companyRevision(read) };
      },
      async apply(store, proposal) {
        if (!proposalValid(proposal)) throw new TypeError('Invalid stored company proposal.');
        // Only the stored normalized after-state reaches the existing service.
        // Independent first-party approval remains the framework's responsibility.
        const after = await updateCompanySettings(store, proposal.after);
        if (canonicalOperationJson(after) !== canonicalOperationJson(proposal.after)) throw new TypeError('Company normalization changed during commit.');
        return { revision: await companyRevision(store), changedFields: [...proposal.changedFields], currencyChanged: proposal.currencyChanged };
      },
      validResult: receiptValid,
      toReceipt: (value) => ({ revision: value.revision, changedFields: [...value.changedFields], currencyChanged: value.currencyChanged }),
      validReceipt: receiptValid,
    },
  };
}

// Importing this module does not register any tools. The shared read registry
// owns authentication, lifecycle serialization and metadata-only read audit.
export const companyReadContract = Object.freeze({ name: 'company.get', scope: 'company.read', capability: 'settings.write',
  inputSchema: object({}), outputSchema: snapshotSchema });

export function companyReadTool() {
  return { kind: 'read', ...companyReadContract, read: getCompanyToolSnapshot };
}
