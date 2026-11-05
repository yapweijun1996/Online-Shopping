import { randomUUID, timingSafeEqual } from 'node:crypto';
import { verifyPasswordAsync, readSession, sessionCookieFrom } from '../auth.js';
import { ApiError } from '../http.js';
import { SqlLimiter } from '../limiter.js';
import { can } from '../roles.js';
import { getShopSetup } from '../shop-setup.js';
import { readStoredOperation } from './operation-envelope.js';
import { operationEpochHash } from './operation-epoch.js';
import { hash, secret, liveGrant, stamp } from './credentials.js';
import { OPERATION_APPROVAL_TOOLS, OPERATION_SCOPE_POLICIES } from './operation-policy.js';

const APPROVAL_MS = 5 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const forbidden = () => { throw new ApiError(403, 'FORBIDDEN', 'Approval could not be verified.'); };
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function sellerToken(request) {
  const cookie = request.headers.get('cookie') || '';
  const matches = cookie.split(';').filter((part) => part.trim().startsWith('seller_session='));
  const token = sessionCookieFrom(cookie);
  if (request.headers.has('authorization') || matches.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(token || '')) forbidden();
  return token;
}

function requireSafeConfig(binding, sellerOrigin, quickLogin, enabled, epoch, buildDigest, tenantGuard) {
  try {
    const issuer = new URL(binding?.issuer);
    if (enabled !== true || quickLogin !== false || !binding || typeof binding.tenantId !== 'string' || !binding.tenantId ||
        typeof buildDigest !== 'string' || !digest.test(buildDigest) ||
        !tenantGuard || typeof tenantGuard.withActiveTenant !== 'function' ||
        new URL(sellerOrigin).origin !== sellerOrigin ||
        new URL(sellerOrigin).protocol !== 'https:' || issuer.origin !== sellerOrigin || issuer.username || issuer.password ||
        issuer.search || issuer.hash || !(binding.issuer === sellerOrigin || (issuer.origin === sellerOrigin && /^\/[a-z0-9]{3,30}$/.test(issuer.pathname))) ||
        binding.resource !== `${binding.issuer}/mcp`) throw new Error('Unsafe binding.');
    return operationEpochHash(epoch);
  } catch { throw new TypeError('Operation approval requires explicit enablement, a secure seller binding and password login.'); }
}

async function humanContext(store, binding, tenantRevision, epochHash, buildDigest, session, row) {
  if (session.account.mustChangePassword || !row || row.state !== 'PENDING_APPROVAL' || row.expires_at <= stamp() ||
      row.account_id !== session.account.id || row.tenant_revision !== tenantRevision ||
      row.epoch_hash !== epochHash || row.build_digest !== buildDigest) return null;
  const shop = await getShopSetup(store);
  if (shop.mode === 'demo') return null;
  const envelope = readStoredOperation(row, binding);
  const policy = Object.hasOwn(OPERATION_SCOPE_POLICIES, row.tool_name) && OPERATION_SCOPE_POLICIES[row.tool_name];
  const grant = await liveGrant(store, row.grant_id, binding);
  if (!envelope || !policy || !OPERATION_APPROVAL_TOOLS.includes(row.tool_name) || !grant ||
      row.required_scope !== policy.scope || row.required_capability !== policy.capability ||
      grant.account_id !== row.account_id || grant.client_id !== row.client_id ||
      !grant.scopes.split(' ').includes(policy.scope) || !can(grant.account.role, policy.capability)) return null;
  const consent = await store.get(`SELECT grant_id FROM mcp_v2_scope_consent
    WHERE grant_id = ? AND tenant_id = ? AND account_id = ? AND client_id = ? AND scope = ?
      AND account_auth_version = ? AND epoch_hash = ? AND consented_at <= ?`,
  grant.id, binding.tenantId, grant.account_id, grant.client_id, policy.scope, grant.account_auth_version, epochHash, stamp());
  return consent ? { envelope, grant, policy, shop } : null;
}

// An authenticated seller can review the complete stored proposal. This
// returns data and a session-bound review challenge, never HTML.
export function createOperationReview({ store, binding, sellerOrigin, quickLogin, epoch, buildDigest, tenantGuard, enabled = false }) {
  const epochHash = requireSafeConfig(binding, sellerOrigin, quickLogin, enabled, epoch, buildDigest, tenantGuard);
  binding = Object.freeze({ tenantId: binding.tenantId, issuer: binding.issuer, resource: binding.resource, mcpV2: binding.mcpV2 });
  const reviewLimit = new SqlLimiter(store, 'mcp-v2-review-account', { limit: 30, windowMs: 900000 });
  return async function review(request, operationId) {
    const origin = request.headers.get('origin');
    if (request.method !== 'GET' || new URL(request.url).origin !== sellerOrigin ||
        (origin !== null && origin !== sellerOrigin) || typeof operationId !== 'string' || !uuid.test(operationId)) forbidden();
    const token = sellerToken(request);
    return tenantGuard.withActiveTenant(binding.tenantId, async (tenant) => {
      const initial = await readSession(store, token);
      if (!initial || !await reviewLimit.attempt(initial.account.id)) forbidden();
      return store.transaction(async () => {
        if (!tenant || !Number.isSafeInteger(tenant.revision) || tenant.revision < 0) forbidden();
        const session = await readSession(store, token);
        if (!session) forbidden();
        const row = await store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', operationId);
        const context = await humanContext(store, binding, tenant.revision, epochHash, buildDigest, session, row);
        if (!context) forbidden();
        const client = await store.get('SELECT client_name FROM oauth_client WHERE id = ?', row.client_id);
        const shop = context.shop;
        if (!client || !shop?.shopName) forbidden();
        const account = await store.get('SELECT oauth_auth_version FROM seller_account WHERE id = ?', session.account.id);
        if (!Number.isSafeInteger(account?.oauth_auth_version)) forbidden();
        const challenge = secret(), now = stamp();
        const expires = new Date(Math.min(Date.parse(now) + APPROVAL_MS, Date.parse(row.expires_at))).toISOString();
        await store.run('DELETE FROM mcp_v2_approval_challenge WHERE operation_id = ? AND account_id = ?', row.id, session.account.id);
        await store.run(`INSERT INTO mcp_v2_approval_challenge(id, operation_id, nonce_hash, created_at, expires_at, account_id, session_hash, account_auth_version, bound_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), row.id, hash(challenge + ':' + row.preview_hash), now, expires,
        session.account.id, session.token_hash, account.oauth_auth_version, now);
        return { challenge, operationId: row.id, shopName: shop.shopName, accountName: session.account.username,
          clientName: client.client_name, clientId: row.client_id, toolName: row.tool_name, resourceType: row.resource_type, resourceId: row.resource_id,
          risk: row.risk, expiresAt: row.expires_at, previewHash: row.preview_hash, proposal: context.envelope.proposal };
      });
    });
  };
}

// First-party seller approval only. Password verification runs without a database
// lock; a second platform fence and tenant transaction revalidate every snapshot.
export function createOperationApproval({ store, binding, sellerOrigin, quickLogin, epoch, buildDigest, tenantGuard, enabled = false }) {
  const epochHash = requireSafeConfig(binding, sellerOrigin, quickLogin, enabled, epoch, buildDigest, tenantGuard);
  binding = Object.freeze({ tenantId: binding.tenantId, issuer: binding.issuer, resource: binding.resource, mcpV2: binding.mcpV2 });
  const addressLimit = new SqlLimiter(store, 'mcp-v2-approval-address', { limit: 5, windowMs: 900000 });
  const accountLimit = new SqlLimiter(store, 'mcp-v2-approval-account', { limit: 20, windowMs: 900000 });
  return async function approve(request, input, clientAddress) {
    if (request.method !== 'POST' || new URL(request.url).origin !== sellerOrigin || request.headers.get('origin') !== sellerOrigin ||
        !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 5 || !['operationId', 'previewHash', 'challenge', 'decision', 'password'].every((key) => Object.hasOwn(input, key)) ||
        typeof input.operationId !== 'string' || !uuid.test(input.operationId) ||
        typeof input.previewHash !== 'string' || !digest.test(input.previewHash) ||
        typeof input.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge) ||
        !['approve', 'reject'].includes(input.decision) ||
        typeof input.password !== 'string' || !input.password.length || input.password.length > 256 ||
        typeof clientAddress !== 'string' || !clientAddress.length || clientAddress.length > 200) forbidden();
    const token = sellerToken(request);
    const snapshot = await tenantGuard.withActiveTenant(binding.tenantId, async (tenant) => {
      if (!tenant || !Number.isSafeInteger(tenant.revision) || tenant.revision < 0) forbidden();
      const initial = await readSession(store, token);
      if (!initial || !sameSecret(request.headers.get('x-csrf-token'), initial.csrf_token)) forbidden();
      // Reservations survive a subsequent denied decision or transaction rollback.
      if (!await addressLimit.attempt(clientAddress) || !await accountLimit.attempt(initial.account.id)) {
        throw new ApiError(429, 'RATE_LIMITED', 'Too many approval attempts.');
      }
      return store.transaction(async () => {
        const session = await readSession(store, token);
        if (!session || !sameSecret(request.headers.get('x-csrf-token'), session.csrf_token)) forbidden();
        const row = await store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', input.operationId);
        if (!await humanContext(store, binding, tenant.revision, epochHash, buildDigest, session, row) ||
            !sameSecret(row.preview_hash, input.previewHash)) forbidden();
        const account = await store.get('SELECT password_hash, oauth_auth_version FROM seller_account WHERE id = ?', session.account.id);
        if (!account || !Number.isSafeInteger(account.oauth_auth_version)) forbidden();
        const challenge = await store.get(`SELECT id FROM mcp_v2_approval_challenge WHERE operation_id = ? AND nonce_hash = ?
          AND account_id = ? AND session_hash = ? AND account_auth_version = ? AND consumed_at IS NULL AND expires_at > ?`,
        row.id, hash(input.challenge + ':' + row.preview_hash), session.account.id, session.token_hash, account.oauth_auth_version, stamp());
        if (!challenge) forbidden();
        return { passwordHash: account.password_hash, authVersion: account.oauth_auth_version,
          accountId: session.account.id, sessionHash: session.token_hash, tenantRevision: tenant.revision, challengeId: challenge.id };
      });
    });
    if (!await verifyPasswordAsync(input.password, snapshot.passwordHash)) forbidden();
    return tenantGuard.withActiveTenant(binding.tenantId, (tenant) => store.transaction(async () => {
      if (!tenant || tenant.revision !== snapshot.tenantRevision) forbidden();
      const session = await readSession(store, token);
      if (!session || session.account.id !== snapshot.accountId || session.token_hash !== snapshot.sessionHash ||
          !sameSecret(request.headers.get('x-csrf-token'), session.csrf_token)) forbidden();
      const account = await store.get('SELECT password_hash, oauth_auth_version FROM seller_account WHERE id = ?', session.account.id);
      if (!account || account.oauth_auth_version !== snapshot.authVersion || !sameSecret(account.password_hash, snapshot.passwordHash)) forbidden();
      const row = await store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', input.operationId);
      if (!await humanContext(store, binding, tenant.revision, epochHash, buildDigest, session, row) ||
          !sameSecret(row.preview_hash, input.previewHash)) forbidden();
      const now = stamp(), expires = new Date(Math.min(Date.parse(now) + APPROVAL_MS, Date.parse(row.expires_at))).toISOString();
      if (expires <= now) forbidden();
      const consumed = await store.get(`UPDATE mcp_v2_approval_challenge SET consumed_at = ? WHERE id = ? AND operation_id = ?
        AND nonce_hash = ? AND account_id = ? AND session_hash = ? AND account_auth_version = ? AND consumed_at IS NULL AND expires_at > ? RETURNING id`,
      now, snapshot.challengeId, row.id, hash(input.challenge + ':' + row.preview_hash), snapshot.accountId, snapshot.sessionHash, snapshot.authVersion, now);
      if (!consumed) forbidden();
      const state = input.decision === 'approve' ? 'APPROVED' : 'REJECTED';
      const changed = await store.get(`UPDATE mcp_v2_operation SET state = ?
        WHERE id = ? AND state = 'PENDING_APPROVAL' AND preview_hash = ? RETURNING id`, state, row.id, row.preview_hash);
      if (!changed) forbidden();
      await store.run(`INSERT INTO mcp_v2_approval(operation_id, approver_id, session_hash, preview_hash, decision, approved_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, row.id, snapshot.accountId, session.token_hash, row.preview_hash, state, now, expires);
      await store.run(`INSERT INTO mcp_v2_event(id, at, tenant_id, account_id, client_id, grant_id, tool_name, resource_id,
        operation_id, approver_id, event, outcome, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(), now, binding.tenantId, row.account_id, row.client_id, row.grant_id, row.tool_name,
      typeof row.resource_id === 'string' && uuid.test(row.resource_id) ? row.resource_id : null,
      row.id, snapshot.accountId, state === 'APPROVED' ? 'APPROVE' : 'REJECT', state, row.correlation_id);
      return { operationId: row.id, status: state, expiresAt: expires };
    }));
  };
}
