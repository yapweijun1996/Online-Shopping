import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { recordAudit } from './platform-db.js';

// Application policy, not a public renewal control. Keep between 1 and 30 minutes.
export const CLAIM_TTL_MS = 30 * 60_000;

export async function issueAdminClaim(platform, config, startedAt, paused) {
  return platform.transaction(async () => {
    if (paused() || await platform.get('SELECT 1 AS found FROM platform_admin LIMIT 1')) return null;
    const state = await platform.get('SELECT * FROM platform_admin_claim WHERE id = 1');
    if (!state || state.closed_at) return null;
    const { now } = await platform.get(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
    // Overlapping starts share the winner; a later trusted restart rotates even a live code.
    if (state.issued_at && state.issued_at >= startedAt && state.expires_at > now) return null;
    if (await platform.get("SELECT 1 AS found FROM tenant WHERE code = 'setup' UNION ALL SELECT 1 FROM tenant_code_alias WHERE code = 'setup' LIMIT 1")) throw new Error('Setup name is unavailable.');
    const origin = config.publicOrigin || `http://localhost:${config.port ?? 3000}`;
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.host === config.platform.adminHost) throw new Error('Invalid claim origin.');
    const code = randomBytes(32).toString('base64url'), generation = randomUUID();
    const tokenHash = createHash('sha256').update('PLATFORM_ADMIN_CLAIM\0').update(code).digest('hex');
    const expiresAt = new Date(Date.parse(now) + CLAIM_TTL_MS).toISOString();
    await platform.run("INSERT INTO platform_admin_claim_generation(generation, issued_at, expires_at, outcome) VALUES (?, ?, ?, 'ISSUED')", generation, now, expiresAt);
    await platform.run("UPDATE platform_admin_claim_generation SET outcome = 'SUPERSEDED', superseded_by = ? WHERE outcome = 'ISSUED' AND generation <> ? AND consumed_at IS NULL", generation, generation);
    await platform.run('UPDATE platform_admin_claim SET generation = ?, token_hash = ?, issued_at = ?, expires_at = ?, attempts = 0, revision = revision + 1 WHERE id = 1 AND revision = ? AND closed_at IS NULL', generation, tokenHash, now, expiresAt, state.revision);
    await recordAudit(platform, { actor: 'host', action: 'ADMIN_CLAIM_ISSUED', detail: generation });
    return { event: 'platform.claim.issued', url: `${origin}/setup/#${code}`, expiresAt, generation };
  });
}
