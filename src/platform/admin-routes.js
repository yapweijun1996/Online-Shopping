import { ApiError, json, readJson, requireOrigin } from '../http.js';
import { SqlLimiter } from '../limiter.js';
import { createAdminAuth, platformCookie, platformCookieFrom, requirePlatformCsrf } from './admin-auth.js';
import { createShopManagement } from './shops.js';
import { recordAudit } from './platform-db.js';

export function createPlatformRoutes({ platform, secretBox, config, pool, registry, deps, defaultStore, clock = Date.now }) {
  const auth = createAdminAuth({ platform, secretBox, clock });
  const shops = createShopManagement({ platform, pool, registry, deps, defaultStore, publicOrigin: config.publicOrigin, sellerOrigin: config.sellerOrigin, clock });
  const limiter = new SqlLimiter(platform, 'platform-login', { limit: 10, windowMs: 15 * 60_000, now: clock });
  const challengeLimiter = new SqlLimiter(platform, 'platform-challenge', { limit: 30, windowMs: 15 * 60_000, now: clock });
  const expectedOrigin = `https://${config.platform.adminHost}`;
  const signedIn = (value) => {
    const { token, maxAge, ...view } = value;
    return json(200, view, { 'Set-Cookie': platformCookie(token, maxAge) });
  };
  return async (request, { clientAddress = 'unknown' } = {}) => {
    const url = new URL(request.url), path = url.pathname.replace(/^\/api\/v1\/platform/, ''), method = request.method;
    const isAttempt = method === 'POST' && ['/session', '/totp/confirm'].includes(path);
    const guard = async (work) => {
      try { return await work(); }
      catch (error) { if (isAttempt) await recordAudit(platform, { actor: 'unknown', action: 'LOGIN_FAILED' }); throw error; }
    };
    if (!['GET', 'POST', 'DELETE'].includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    if (method !== 'GET') await guard(() => requireOrigin(request, expectedOrigin));
    if (path === '/csrf' && method === 'GET') {
      if (!await challengeLimiter.attempt(clientAddress)) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests.');
      const value = auth.loginChallenge(); return json(200, { csrfToken: value.csrfToken }, { 'Set-Cookie': value.cookie });
    }
    if (path === '/session' && method === 'POST') {
      await guard(() => auth.verifyLoginChallenge(request));
      await guard(async () => { if (!await limiter.attempt(clientAddress)) throw new ApiError(429, 'RATE_LIMITED', 'Too many sign-in attempts.'); });
      const body = await guard(() => readJson(request, 2048));
      return signedIn(await auth.password(body.username, body.password));
    }
    const token = platformCookieFrom(request), session = await guard(() => auth.session(token));
    if (method !== 'GET') await guard(() => requirePlatformCsrf(request, session.csrf_token));
    if (path === '/session' && method === 'GET') return json(200, { username: session.username, stage: session.stage, totpEnabled: session.totp_enabled === 1, csrfToken: session.csrf_token });
    if (path === '/totp/enrol' && method === 'POST') return json(200, await auth.enrol(token));
    if (path === '/totp/confirm' && method === 'POST') {
      await guard(async () => { if (!await limiter.attempt(clientAddress)) throw new ApiError(429, 'RATE_LIMITED', 'Too many sign-in attempts.'); });
      if (session.stage !== 'PASSWORD') await guard(() => { throw new ApiError(409, 'INVALID_STAGE', 'Start a new sign-in.'); });
      return signedIn(await auth.confirm(token, await guard(() => readJson(request, 1024))));
    }
    // A restricted session cannot read shops, audit or account state, or perform any other write.
    await auth.session(token, true);
    if (path === '/session' && method === 'DELETE') { await auth.logout(token); return json(200, { signedOut: true }, { 'Set-Cookie': platformCookie('', 0) }); }
    if (path === '/account/password' && method === 'POST') return json(200, await auth.changePassword(token, await readJson(request, 2048)));
    if (path === '/account/recovery-codes' && method === 'POST') return json(200, await auth.regenerateRecovery(token, (await readJson(request, 1024)).password));
    if (path === '/shops' && method === 'GET') return json(200, await shops.list());
    if (path === '/shops' && method === 'POST') return json(201, await shops.create(await readJson(request, 4096), session.username));
    const shop = /^\/shops\/([0-9a-f-]{36})(?:\/(suspend|resume|rename|request-deletion|cancel-deletion|reset-seller-password))?$/.exec(path);
    if (shop && method === 'GET' && !shop[2]) return json(200, await shops.detail(shop[1]));
    if (shop && method === 'POST' && shop[2]) return json(200, await shops.mutate(shop[1], shop[2], await readJson(request, 2048), session.username));
    if (path === '/audit' && method === 'GET') return json(200, await shops.audit(url.searchParams));
    if (path === '/status' && method === 'GET') return json(200, { reachable: true, poolSize: pool.size(), shops: await platform.all('SELECT status, COUNT(*) AS count FROM tenant GROUP BY status ORDER BY status') });
    throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  };
}
