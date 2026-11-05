// Export real read descriptor metadata without a database, listener or credentials.
import { writeFile } from 'node:fs/promises';
import { createOperationTools } from '../../src/mcp/operation-tools.js';
import { analyticsSalesTrendTool, analyticsTopProductsTool, analyticsInventoryRiskTool } from '../../src/mcp/analytics-tools.js';
import { OPERATION_SCOPE_POLICIES } from '../../src/mcp/operation-policy.js';
const issuer = 'https://schemas.example.invalid';
const registry = createOperationTools({ store: {}, config: { mcpEnabled: true, production: false, shopMode: 'manual',
  mcpV2: { enabled: true, epoch: Buffer.alloc(32, 1).toString('base64url'), buildDigest: '0'.repeat(64) } }, quickLogin: false,
  binding: { tenantId: 'synthetic-schema', issuer, resource: issuer + '/mcp' },
  tenantGuard: { withActiveTenant() { throw new Error('Schema export cannot execute a read.'); } },
  entries: [analyticsSalesTrendTool(), analyticsTopProductsTool(), analyticsInventoryRiskTool()] });
const bundle = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:online-shopping:mcp-v2:analytics:implemented',
  $comment: 'Actual isolated analytics descriptor contracts. No default registration in this checkpoint; configuration remains default-off and production is blocked. Arguments below are synthetic examples.',
  $defs: Object.fromEntries(registry.catalogue.flatMap(tool => [[tool.name + '.input', tool.inputSchema], [tool.name + '.output', tool.outputSchema]])),
  'x-toolPolicies': Object.fromEntries(registry.catalogue.map(tool => [tool.name, { ...OPERATION_SCOPE_POLICIES[tool.name], risk: 'LOW' }])),
  'x-syntheticArguments': {
    'analytics.sales_trend': { from: '2026-10-01', toExclusive: '2026-11-01', groupBy: 'week', comparePrevious: true, limit: 50 },
    'analytics.top_products': { from: '2026-10-01', toExclusive: '2026-11-01', groupBy: 'category', currency: 'MYR', sortBy: 'value', limit: 50 },
    'analytics.inventory_risk': { threshold: 5, slowDays: 30, mode: 'either', activeOnly: true, limit: 50 },
  } };
await writeFile(new URL('./03-ANALYTICS-IMPLEMENTED.json', import.meta.url), JSON.stringify(bundle, null, 2) + '\n');
