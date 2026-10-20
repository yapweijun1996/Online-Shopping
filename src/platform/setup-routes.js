import { readFile } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError, json, readJson, requireOrigin } from '../http.js';
import { SqlLimiter } from '../limiter.js';
import { checkPassword } from '../accounts.js';
import { encodePassword } from '../auth.js';
import { createAdminAuth, platformCookie } from './admin-auth.js';
import { recordAudit } from './platform-db.js';

const MAX_ATTEMPTS = 5;
const missing = () => json(404, { error: { code: 'NOT_FOUND', message: 'Not found.' } }, { 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
const digest = (code) => createHash('sha256').update('PLATFORM_ADMIN_CLAIM\0').update(code).digest();
const emailPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function createSetupRoutes({ platform, secretBox, config, clock = Date.now }) {
  const auth = createAdminAuth({ platform, secretBox, clock });
  const limiter = new SqlLimiter(platform, 'platform-claim', { limit: 5, windowMs: 15 * 60_000, now: clock });
  const throttleAudit = new SqlLimiter(platform, 'platform-claim-throttle-audit', { limit: 1, windowMs: 15 * 60_000, now: clock });
  const origin = config.publicOrigin || `http://localhost:${config.port ?? 3000}`;
  async function eligible() {
    return platform.get(`SELECT c.*, to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
      FROM platform_admin_claim c WHERE id = 1 AND closed_at IS NULL AND token_hash IS NOT NULL AND attempts < ?
      AND expires_at > to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      AND NOT EXISTS (SELECT 1 FROM platform_admin)`, MAX_ATTEMPTS);
  }
  return async (request, { clientAddress = 'unknown' } = {}) => {
    const url = new URL(request.url);
    if (!config.platform.claimEnabled || url.origin !== origin || url.search || !await eligible()) return missing();
    const assets = { '/setup/': ['index.html', 'text/html'], '/setup/setup.js': ['setup.js', 'text/javascript'], '/setup/setup.css': ['setup.css', 'text/css'] };
    if (request.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
      const [file, type] = assets[url.pathname];
      return new Response(await readFile(new URL(`../../public/setup/${file}`, import.meta.url)), { headers: {
        'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
      } });
    }
    if (url.pathname === '/api/v1/setup/status' && request.method === 'GET') return json(200, { open: true }, { 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
    if (url.pathname !== '/api/v1/setup/claim' || request.method !== 'POST') return missing();
    // The non-ambient bearer plus exact Origin and JSON are the claim CSRF proof.
    try { requireOrigin(request, origin); } catch { return missing(); }
    if (!await limiter.attempt(clientAddress)) {
      if (await throttleAudit.attempt(clientAddress)) await recordAudit(platform, { actor: 'unknown', action: 'ADMIN_CLAIM_RATE_LIMITED' });
      return missing();
    }
    let body;
    try { body = await readJson(request, 4096); } catch { return missing(); }
    return platform.transaction(async () => {
      const state = await eligible();
      if (!state) return missing();
      const code = typeof body.code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.code) ? body.code : '';
      if (!timingSafeEqual(digest(code), Buffer.from(state.token_hash, 'hex'))) {
        await platform.run('UPDATE platform_admin_claim SET attempts = attempts + 1, revision = revision + 1 WHERE id = 1');
        await platform.run('UPDATE platform_admin_claim_generation SET attempts = attempts + 1 WHERE generation = ?', state.generation);
        await recordAudit(platform, { actor: 'unknown', action: 'ADMIN_CLAIM_DENIED', detail: state.generation });
        return missing();
      }
      if (Object.keys(body).some((key) => !['code', 'email', 'username', 'password'].includes(key))) throw new ApiError(400, 'INVALID_INPUT', 'Invalid claim fields.');
      const email = typeof body.email === 'string' ? body.email.toLowerCase() : '';
      if (email.length > 254 || /[\s\u0000-\u001f\u007f-\uffff]/.test(email) || email.split('@')[0].length > 64 || !emailPattern.test(email)) throw new ApiError(400, 'INVALID_INPUT', 'Invalid contact email.');
      if (typeof body.username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(body.username) || /\s/.test(body.username)) throw new ApiError(400, 'INVALID_INPUT', 'Invalid username.');
      checkPassword(body.password, 'password', body.username);
      const passwordHash = encodePassword(body.password), id = randomUUID();
      if (!await eligible()) return missing();
      // Deferred admin FK: close before INSERT, otherwise the admin trigger closes it prematurely.
      const changed = await platform.get(`UPDATE platform_admin_claim SET closed_at = ?, used_at = ?, claimed_admin_id = ?, token_hash = NULL, revision = revision + 1
        WHERE id = 1 AND revision = ? AND closed_at IS NULL RETURNING id`, state.now, state.now, id, state.revision);
      if (!changed) return missing();
      await platform.run('INSERT INTO platform_admin(id, username, username_key, email, email_key, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, body.username, body.username.toLowerCase(), email, email, passwordHash, state.now, state.now);
      await platform.run("UPDATE platform_admin_claim_generation SET outcome = 'CLAIMED', consumed_at = ? WHERE generation = ?", state.now, state.generation);
      await recordAudit(platform, { actor: body.username, action: 'ADMIN_CLAIMED', detail: state.generation });
      const { token, maxAge, ...view } = await auth.claimedSession(id);
      return json(200, { ...view, nextUrl: new URL('/platform/', `https://${config.platform.adminHost}`).href }, { 'Set-Cookie': platformCookie(token, maxAge), 'Referrer-Policy': 'no-referrer' });
    });
  };
}
