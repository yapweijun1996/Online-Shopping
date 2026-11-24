import { writeFile } from 'node:fs/promises';
import { createOperationTools } from '../../src/mcp/operation-tools.js';
import { catalogCreateCategoryTool } from '../../src/mcp/category-tools.js';
import { operationAuthorityPolicy } from '../../src/mcp/operation-policy.js';

const entry = catalogCreateCategoryTool(), issuer = 'https://schemas.example.invalid';
const registry = createOperationTools({ store: {}, quickLogin: false, entries: [entry],
  config: { mcpEnabled: true, production: false, shopMode: 'manual', sellerOrigin: issuer,
    mcpV2: { enabled: true, epoch: Buffer.alloc(32, 1).toString('base64url'), buildDigest: '0'.repeat(64) } },
  binding: { tenantId: 'default', issuer, resource: issuer + '/mcp' },
  tenantGuard: { withActiveTenant() { throw new Error('Schema export cannot execute an operation.'); } } });
const definitions = {}, policies = {};
const { scope, capability, risk } = operationAuthorityPolicy(entry.previewName);
for (const tool of registry.catalogue) {
  definitions[tool.name + '.input'] = tool.inputSchema;
  definitions[tool.name + '.output'] = tool.outputSchema;
  policies[tool.name] = { scope, capability, risk };
}
await writeFile(new URL('./03-CATEGORY-IMPLEMENTED.json', import.meta.url), JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:online-shopping:mcp-v2:category:implemented',
  $defs: definitions, 'x-toolPolicies': policies,
}, null, 2) + '\n');
