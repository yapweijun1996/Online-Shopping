export const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const uuidSchema = { type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
export function syntheticOperationTool() {
  return {
    previewName: 'catalog.preview_update', commitName: 'catalog.commit_update', scope: 'catalog.write', capability: 'catalog.write',
    inputSchema: objectSchema({ id: uuidSchema, expectedRevision: { type: 'integer', minimum: 1, maximum: 1000000 }, name: { type: 'string', minLength: 1, maxLength: 100 } }),
    receiptSchema: objectSchema({ id: uuidSchema, revision: { type: 'integer', minimum: 1, maximum: 1000000 } }),
    adapter: {
      resourceType: 'product',
      preview: async (read, args) => {
        const row = await read.get('SELECT name, revision FROM synthetic_protocol_product WHERE id = ?', args.id);
        if (!row || row.revision !== args.expectedRevision) throw new Error('Synthetic stale resource.');
        return { resourceId: args.id, expectedRevision: row.revision, proposal: { id: args.id, before: row.name, after: args.name } };
      },
      currentRevision: async (read, envelope) => {
        const row = await read.get('SELECT revision FROM synthetic_protocol_product WHERE id = ?', envelope.resourceId);
        return { exists: Boolean(row), revision: row?.revision ?? null };
      },
      apply: async (store, proposal) => {
        await store.run('UPDATE synthetic_protocol_product SET name = ?, revision = revision + 1 WHERE id = ?', proposal.after, proposal.id);
        return store.get('SELECT id, name, revision FROM synthetic_protocol_product WHERE id = ?', proposal.id);
      },
      validResult: value => Boolean(value && Object.keys(value).sort().join(',') === 'id,name,revision' && typeof value.name === 'string'),
      toReceipt: value => ({ id: value.id, revision: value.revision }),
      validReceipt: value => Boolean(value && Object.keys(value).sort().join(',') === 'id,revision' && Number.isSafeInteger(value.revision)),
    },
  };
}
