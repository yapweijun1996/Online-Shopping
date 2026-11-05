import { readFileSync } from 'node:fs';
import { reviewFixture } from './mcp-review-fixture.js';
import { createCategory } from '../../src/settings.js';
import { createProduct } from '../../src/products.js';
import { hash, secret } from '../../src/mcp/credentials.js';
import { operationEpochHash } from '../../src/mcp/operation-epoch.js';
import { createMediaCoordinator } from '../../src/mcp/media-coordinator.js';
import { readMediaSnapshot } from '../../src/mcp/media-resources.js';
import { sha256, CODEC } from '../../src/mcp/media-codec-wire.js';

export const png = readFileSync(new URL('../../public/shop/icons/icon-192.png', import.meta.url));
// Signature-valid synthetic packets test orchestration only, not native decode.
export const stubDecode = async ({ bytes, mime }) => ({ version: 1, codec: CODEC, sourceSha256: sha256(bytes), mime,
  width: 192, height: 192, imageBytes: bytes.length, imageSha256: sha256(bytes), thumbnailMime: 'image/png',
  thumbnailBytes: png.length, thumbnailSha256: sha256(png), image: Buffer.from(bytes), thumbnail: Buffer.from(png) });
export async function coordinatorFixture(t, dialect, extra = {}) {
  const { fixtureOptions = {}, ...overrides } = extra;
  const f = await reviewFixture(t, dialect, fixtureOptions); await f.seedGrant();
  const bearer = secret(), scopes = 'catalog.write media.write', epochHash = operationEpochHash(f.config.mcpV2.epoch);
  const grant = await f.store.get('SELECT * FROM oauth_grant WHERE id=?', f.grantId);
  await f.store.run('UPDATE oauth_grant SET scopes=? WHERE id=?', scopes, f.grantId);
  await f.store.run(`INSERT INTO mcp_v2_scope_consent(grant_id,tenant_id,account_id,client_id,scope,account_auth_version,epoch_hash,consented_at)
    VALUES(?,?,?,?,'media.write',?,?,?)`, f.grantId, f.binding.tenantId, f.account.id, f.clientId, f.account.oauth_auth_version, epochHash, grant.created_at);
  await f.store.run(`INSERT INTO oauth_token(token_hash,kind,grant_id,resource,scopes,issued_at,expires_at,generation)
    VALUES(?,'access',?,?,?,?,?,0)`, hash(bearer), f.grantId, f.binding.resource, scopes, new Date().toISOString(), grant.absolute_expires_at);
  await createCategory(f.store, { code: 'SYNTHETIC', label: 'Synthetic media' });
  const make = (sku, image = png, fields = {}) => createProduct(f.store, { sku, name: 'Synthetic ' + sku, description: 'Synthetic media coordinator',
    category: 'SYNTHETIC', priceMinor: 100, active: true, stockQuantity: 7,
    ...(image ? { imageDataUrl: 'data:image/png;base64,' + image.toString('base64') } : {}), ...fields });
  const product = await make('MEDIA-TARGET');
  let depth = 0, active = true, revision = 0;
  const guard = { withActiveTenant: async (id, work) => {
    if (!active || id !== f.binding.tenantId) throw Object.assign(new Error('Synthetic tenant unavailable'), { status: 503 });
    depth++; try { return await work({ revision }); } finally { depth--; }
  } };
  const options = { store: f.store, binding: f.binding, tenantGuard: guard, epoch: f.config.mcpV2.epoch, buildDigest: f.config.mcpV2.buildDigest,
    enabled: true, quickLogin: false, production: false, codec: { socketPath: '/synthetic/not-used.sock', token: 'A'.repeat(43), digest: 'd'.repeat(64) }, decode: stubDecode, ...overrides };
  const coordinator = createMediaCoordinator(options);
  const input = async (source = png, fields = {}) => ({ productId: product.id, targetSlot: 'MAIN', expectedRevision: (await readMediaSnapshot(f.store, product.id)).revision,
    sourceSha256: sha256(source), sourceMime: 'image/png', declaredBytes: source.length, idempotencyKey: 'synthetic-media-coordinator-0001', ...fields });
  return { ...f, make, product, options, coordinator, bearer, input, guard, depth: () => depth, suspend: () => { active = false; },
    bump: () => { revision++; }, epochHash };
}
