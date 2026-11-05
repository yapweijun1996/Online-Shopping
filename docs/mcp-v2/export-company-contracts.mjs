// Export schema metadata from the real descriptor/registry source, without
// opening a listener, issuing credentials or executing an operation.
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../../src/db.js';
import { createOperationTools } from '../../src/mcp/operation-tools.js';
import { companyReadTool, companyMutationTool } from '../../src/mcp/company-tools.js';
import { OPERATION_SCOPE_POLICIES, OPERATION_MUTATION_PAIRS, OPERATION_PREVIEW_RISKS } from '../../src/mcp/operation-policy.js';

const store = await openDatabase(':memory:');
try {
  const issuer = 'https://schemas.example.invalid';
  const config = { mcpEnabled: true, production: false, shopMode: 'manual',
    mcpV2: { enabled: true, epoch: randomBytes(32).toString('base64url'), buildDigest: '0'.repeat(64) } };
  const registry = createOperationTools({ store, config, quickLogin: false,
    binding: { tenantId: 'default', issuer, resource: issuer + '/mcp' },
    tenantGuard: { withActiveTenant() { throw new Error('Schema export cannot execute an operation.'); } },
    entries: [companyReadTool(), companyMutationTool()] });
  const definitions = {}, policies = {};
  for (const tool of registry.catalogue) {
    definitions[tool.name + '.input'] = tool.inputSchema;
    definitions[tool.name + '.output'] = tool.outputSchema;
    const previewName = Object.entries(OPERATION_MUTATION_PAIRS).find(([preview, commit]) => tool.name === preview || tool.name === commit)?.[0];
    policies[tool.name] = { ...OPERATION_SCOPE_POLICIES[tool.name], risk: tool.annotations.readOnlyHint ? 'LOW' : OPERATION_PREVIEW_RISKS[previewName] };
  }
  const bundle = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:online-shopping:mcp-v2:company:implemented',
    $comment: 'Implemented isolated company tool arguments and structuredContent. Activation remains default-off and blocked in production.',
    $defs: definitions, 'x-toolPolicies': policies };
  await writeFile(new URL('./03-COMPANY-IMPLEMENTED.json', import.meta.url), JSON.stringify(bundle, null, 2) + '\n');
} finally { await store.close(); }
