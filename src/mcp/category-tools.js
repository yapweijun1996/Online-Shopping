import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';
import { CATEGORY_CODE_PATTERN, DUPLICATE_CATEGORY_MESSAGE, categoryCreateConflicts, createCategory, normalizeCategoryCreate } from '../settings.js';
import { canonicalOperationJson } from './operation-envelope.js';
import { valid } from './tools.js';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const active = { type: 'boolean' };
const inputSchema = object({ code: text(4096), label: text(4096), active }, ['code', 'label']);
const codeSchema = { ...text(80), pattern: CATEGORY_CODE_PATTERN.source };
const categorySchema = object({ code: codeSchema, label: text(80), active });
const proposalSchema = object({ before: { type: 'null' }, after: categorySchema });
const receiptSchema = object({ code: codeSchema, active });

function checkedCategory(proposal) {
  if (!valid(proposal, proposalSchema) || canonicalOperationJson(normalizeCategoryCreate(proposal.after)) !== canonicalOperationJson(proposal.after)) {
    throw new TypeError('Invalid stored category proposal.');
  }
  return proposal.after;
}

export const catalogCreateCategoryTool = () => ({
  previewName: 'catalog.preview_create_category', commitName: 'catalog.commit_create_category',
  scope: 'catalog.write', capability: 'catalog.write', inputSchema, receiptSchema,
  adapter: {
    resourceType: 'category',
    async preview(read, args) {
      let after;
      try { after = normalizeCategoryCreate(args); }
      catch (error) {
        if (error instanceof FieldError) throw new ApiError(400, 'CATEGORY_CREATE_INPUT', 'Invalid category details.');
        throw error;
      }
      if (await categoryCreateConflicts(read, after)) throw new ApiError(409, 'DUPLICATE_CATEGORY', DUPLICATE_CATEGORY_MESSAGE);
      return { resourceId: after.code, expectedRevision: null, proposal: { before: null, after } };
    },
    async currentRevision(read, envelope) {
      const after = checkedCategory(envelope.proposal);
      if (envelope.resourceId !== after.code) throw new TypeError('Invalid category resource.');
      // The reviewed precondition is absence of both the code and the label.
      return { exists: await categoryCreateConflicts(read, after), revision: null };
    },
    async apply(store, proposal) {
      const { code, active } = await createCategory(store, checkedCategory(proposal));
      return { code, active };
    },
    validResult: value => valid(value, receiptSchema), toReceipt: value => value,
    validReceipt: value => valid(value, receiptSchema),
  },
});
