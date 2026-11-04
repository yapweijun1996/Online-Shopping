import { performance } from 'node:perf_hooks';
import { operationPreviewHash } from '../../src/mcp/operation-envelope.js';
import { operationEpochHash } from '../../src/mcp/operation-epoch.js';

// Synthetic microbenchmark only; it is not a server load or database test.
const id = '00000000-0000-4000-8000-000000000001';
const envelope = {
  version: 1, operationId: id, tenantId: 'synthetic', tenantRevision: 1, accountId: id, clientId: 'synthetic', grantId: id,
  epochHash: operationEpochHash(Buffer.alloc(32, 1).toString('base64url')), buildDigest: 'e'.repeat(64),
  issuer: 'https://seller.example.test', resource: 'https://seller.example.test/mcp',
  toolName: 'catalog.preview_update', resourceType: 'product', resourceId: id, expectedRevision: 1,
  requiredScope: 'catalog.write', requiredCapability: 'catalog.write', risk: 'MEDIUM',
  createdAt: '2026-11-04T00:00:00.000Z', expiresAt: '2026-11-04T00:10:00.000Z',
  idempotencyHash: 'a'.repeat(64), correlationId: id, proposal: { description: 'x'.repeat(60000) },
};
for (let i = 0; i < 10; i++) operationPreviewHash(envelope);
const times = [];
for (let i = 0; i < 100; i++) {
  const start = performance.now(); operationPreviewHash(envelope); times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ samples: times.length, proposalTextBytes: 60000,
  p50Ms: times[49], p95Ms: times[94], maxMs: times[99] }));
