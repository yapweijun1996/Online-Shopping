import { randomUUID, timingSafeEqual } from 'node:crypto';
import { verifyPasswordAsync, readSession, sessionCookieFrom } from '../auth.js';
import { ApiError } from '../http.js';
import { SqlLimiter } from '../limiter.js';
import { can } from '../roles.js';
import { getShopSetup } from '../shop-setup.js';
import { readStoredOperation } from './operation-envelope.js';
import { operationEpochHash } from './operation-epoch.js';
import { hash, secret, liveGrant, stamp, SCOPES, V2_SCOPES } from './credentials.js';
import { COMPANY_CURRENCY_ACKNOWLEDGED, COMPANY_CURRENCY_WARNING, requiresCompanyCurrencyAcknowledgement } from './company-approval-policy.js';
import { OPERATION_APPROVAL_TOOLS, operationAuthorityPolicy, MEDIA_REVIEW_ACKNOWLEDGED } from './operation-policy.js';
import { mediaInstant, mediaHash } from './media-policy.js';
import { clearMediaChallenge } from './media-maintenance.js';
import { mediaReviewItems, readMediaReviewState, loadMediaReviewAsset, readMediaApprovalEvidence, readMediaAcknowledgements } from './media-approval-policy.js';
import { catalogMediaAllowed } from './catalog-media-config.js';

const APPROVAL_MS = 5 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const knownScopes = new Set([...SCOPES, ...V2_SCOPES]);
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

async function humanContext(store, binding, tenantRevision, epochHash, buildDigest, session, row, mediaEnabled, catalogUpdateEnabled, catalogCreateEnabled, codecDigest) {
  if (session.account.mustChangePassword || !row || row.state !== 'PENDING_APPROVAL' || row.expires_at <= stamp() || row.created_at > stamp() ||
      row.account_id !== session.account.id || row.tenant_revision !== tenantRevision ||
      row.epoch_hash !== epochHash || row.build_digest !== buildDigest) return null;
  const shop = await getShopSetup(store);
  if (shop.mode !== 'production') return null;
  const envelope = readStoredOperation(row, binding);
  let policy;
  try { policy = operationAuthorityPolicy(row.tool_name, row.media_policy_id ?? null); } catch { return null; }
  const catalog = catalogMediaAllowed({catalogUpdateEnabled,catalogCreateEnabled},{toolName:row.tool_name,mediaPolicyId:row.media_policy_id,resourceType:row.resource_type});
  const media = ['media.prepare_upload', 'media.preview_layout'].includes(row.tool_name) || catalog;
  if (((catalogUpdateEnabled === true && row.tool_name === 'catalog.preview_update') ||
      (catalogCreateEnabled === true && row.tool_name === 'catalog.preview_create')) && row.media_policy_id === null) return null;
  if (media && mediaEnabled !== true) return null;
  const grant = await liveGrant(store, row.grant_id, binding);
  const granted = typeof grant?.scopes === 'string' ? grant.scopes.split(' ') : [];
  if (!envelope || !policy || (!OPERATION_APPROVAL_TOOLS.includes(row.tool_name) && !media) || (policy.flow === 'RESERVED' && !catalog) || !grant ||
      !mediaInstant(grant.created_at) || !mediaInstant(grant.absolute_expires_at) || !Number.isSafeInteger(grant.account_auth_version) ||
      new Set(granted).size !== granted.length || granted.some(scope => !knownScopes.has(scope)) ||
      row.required_scope !== policy.scope || row.required_capability !== policy.capability ||
      row.risk !== policy.risk || (media && row.media_policy_id !== policy.mediaPolicyId) ||
      grant.account_id !== row.account_id || grant.client_id !== row.client_id ||
      !policy.requiredScopes.every(scope => granted.includes(scope)) || !can(grant.account.role, policy.capability)) return null;
  for (const scope of policy.requiredScopes) {
  const consent = await store.get(`SELECT grant_id,consented_at FROM mcp_v2_scope_consent
    WHERE grant_id = ? AND tenant_id = ? AND account_id = ? AND client_id = ? AND scope = ?
      AND account_auth_version = ? AND epoch_hash = ? AND consented_at >= ? AND consented_at <= ?`,
  grant.id, binding.tenantId, grant.account_id, grant.client_id, scope, grant.account_auth_version, epochHash, grant.created_at, row.created_at);
  if (!consent || !mediaInstant(consent.consented_at)) return null;
  }
  const mediaContext = media ? Object.freeze({ tenantId: row.tenant_id, tenantRevision, accountId: row.account_id,
    clientId: row.client_id, grantId: row.grant_id, accountAuthVersion: grant.account_auth_version, epochHash, buildDigest,
    issuer: binding.issuer, resource: binding.resource, grantExpiresAt: grant.absolute_expires_at }) : null;
  const mediaState = media ? await readMediaReviewState(store, row, envelope, mediaContext, {catalogUpdateEnabled,catalogCreateEnabled,codecDigest}) : null;
  let currencyAcknowledgementRequired;
  try { currencyAcknowledgementRequired = requiresCompanyCurrencyAcknowledgement(envelope); } catch { return null; }
  return { envelope, grant, policy, shop, currencyAcknowledgementRequired, mediaContext, mediaState };
}

// An authenticated seller can review the complete stored proposal. This
// returns data and a session-bound review challenge, never HTML.
export function createOperationReview({ store, binding, sellerOrigin, quickLogin, epoch, buildDigest, tenantGuard, mcpMedia, enabled = false, catalogUpdateEnabled = false, catalogCreateEnabled = false }) {
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
        const context = await humanContext(store, binding, tenant.revision, epochHash, buildDigest, session, row, mcpMedia?.enabled, catalogUpdateEnabled, catalogCreateEnabled, mcpMedia?.codecDigest);
        if (!context) forbidden();
        const client = await store.get('SELECT client_name FROM oauth_client WHERE id = ?', row.client_id);
        const shop = context.shop;
        if (!client || !shop?.shopName) forbidden();
        const account = await store.get('SELECT oauth_auth_version FROM seller_account WHERE id = ?', session.account.id);
        if (!Number.isSafeInteger(account?.oauth_auth_version)) forbidden();
        const challenge = secret(), now = stamp();
        const expires = new Date(Math.min(Date.parse(now) + APPROVAL_MS, Date.parse(row.expires_at))).toISOString();
        const old = await store.all('SELECT id FROM mcp_v2_approval_challenge WHERE operation_id=? AND account_id=? LIMIT 2', row.id, session.account.id);
        if (old.length > 1) forbidden();
        for (const value of old) { await clearMediaChallenge(store, row.id, value.id); await store.run('DELETE FROM mcp_v2_approval_challenge WHERE id=?', value.id); }
        await store.run(`INSERT INTO mcp_v2_approval_challenge(id, operation_id, nonce_hash, created_at, expires_at, account_id, session_hash, account_auth_version, bound_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), row.id, hash(challenge + ':' + row.preview_hash), now, expires,
        session.account.id, session.token_hash, account.oauth_auth_version, now);
        const mediaReview = context.mediaState ? { descriptor: context.mediaState.manifest.descriptor,
          items: mediaReviewItems(context.mediaState.manifest), labels: context.mediaState.labels ?? context.mediaState.snapshot.products.map(({ productId, sku, name }) => ({ productId, sku, name })) } : null;
        const result = { mediaReview, currencyAcknowledgementRequired: context.currencyAcknowledgementRequired,
          currencyWarning: context.currencyAcknowledgementRequired ? COMPANY_CURRENCY_WARNING : null, challenge, operationId: row.id, shopName: shop.shopName, accountName: session.account.username,
          clientName: client.client_name, clientId: row.client_id, toolName: row.tool_name, resourceType: row.resource_type, resourceId: row.resource_id,
          risk: row.risk, expiresAt: row.expires_at, previewHash: row.preview_hash, proposal: context.envelope.proposal };
        if (Buffer.byteLength(JSON.stringify(result)) > 262144) throw new ApiError(503, 'MEDIA_REVIEW_LIMIT', 'Review exceeds its safe limit.');
        return result;
      });
    });
  };
}

// Protected first-party delivery children; never accepts bearer credentials.
export function createMediaReviewDelivery(options) {
  const { store, binding, sellerOrigin, quickLogin, epoch, buildDigest, tenantGuard, mcpMedia, enabled = false, catalogUpdateEnabled = false, catalogCreateEnabled = false } = options;
  const epochHash = requireSafeConfig(binding, sellerOrigin, quickLogin, enabled, epoch, buildDigest, tenantGuard);
  const limiter = new SqlLimiter(store, 'mcp-v2-media-review-account', { limit: 240, windowMs: 900000 });
  async function child(request, input, acknowledge) {
    const keys = ['operationId', 'previewHash', 'challenge', 'kind', 'itemKey', ...(acknowledge ? ['expectedHash', 'nonce'] : [])];
    if (request.method !== 'POST' || new URL(request.url).origin !== sellerOrigin || request.headers.get('origin') !== sellerOrigin ||
        !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== keys.sort().join(',') ||
        !uuid.test(input.operationId || '') || !digest.test(input.previewHash || '') ||
        !/^[A-Za-z0-9_-]{43}$/.test(input.challenge || '') || !['PAGE', 'ASSET'].includes(input.kind) ||
        typeof input.itemKey !== 'string' || !(input.kind === 'PAGE' ? /^(?:[0-9]|1[0-5])$/.test(input.itemKey) : digest.test(input.itemKey)) ||
        (acknowledge && (!digest.test(input.expectedHash || '') || !/^[A-Za-z0-9_-]{43}$/.test(input.nonce || '')))) forbidden();
    const token = sellerToken(request);
    return tenantGuard.withActiveTenant(binding.tenantId, async tenant => {
      if (!tenant || !Number.isSafeInteger(tenant.revision) || tenant.revision < 0) forbidden();
      const initial = await readSession(store, token);
      if (!initial || !sameSecret(request.headers.get('x-csrf-token'), initial.csrf_token) || !await limiter.attempt(initial.account.id)) forbidden();
      return store.transaction(async () => {
        const session = await readSession(store, token);
        if (!session || !sameSecret(request.headers.get('x-csrf-token'), session.csrf_token)) forbidden();
        const row = await store.get('SELECT * FROM mcp_v2_operation WHERE id=?', input.operationId);
        const context = await humanContext(store, binding, tenant.revision, epochHash, buildDigest, session, row, mcpMedia?.enabled, catalogUpdateEnabled, catalogCreateEnabled, mcpMedia?.codecDigest);
        if (!context?.mediaState || !sameSecret(row.preview_hash, input.previewHash)) forbidden();
        const now = stamp(), challenge = await store.get(`SELECT * FROM mcp_v2_approval_challenge WHERE operation_id=? AND nonce_hash=?
          AND account_id=? AND session_hash=? AND account_auth_version=? AND consumed_at IS NULL AND expires_at>?`,
        row.id, hash(input.challenge + ':' + row.preview_hash), session.account.id, session.token_hash, context.grant.account_auth_version, now);
        if (!challenge || ![challenge.created_at, challenge.bound_at, challenge.expires_at].every(mediaInstant) ||
            challenge.created_at < row.created_at || challenge.bound_at < challenge.created_at || challenge.bound_at > now ||
            challenge.expires_at > row.expires_at || Date.parse(challenge.expires_at) - Date.parse(challenge.created_at) > APPROVAL_MS) forbidden();
        const manifest = context.mediaState.manifest, item = mediaReviewItems(manifest).find(value => value.kind === input.kind && value.itemKey === input.itemKey);
        if (!item) forbidden();
        return deliverOrAcknowledge({ input, acknowledge, row, context, challenge, manifest, item, now });
      });
    });
  }
  async function deliverOrAcknowledge({ input, acknowledge, row, context, challenge, manifest, item, now }) {
    const nonceHash = nonce => hash([nonce, row.id, challenge.id, input.kind, input.itemKey, manifest.descriptor.manifestRoot].join(':'));
    if (acknowledge) {
      if (input.expectedHash !== item.hash) forbidden();
      const changed = await store.get(`UPDATE mcp_v2_media_delivery SET ack_at=? WHERE challenge_id=? AND operation_id=? AND kind=? AND item_key=?
        AND manifest_root=? AND expected_hash=? AND nonce_hash=? AND ack_at IS NULL AND expires_at>? RETURNING item_key`,
      now, challenge.id, row.id, item.kind, item.itemKey, manifest.descriptor.manifestRoot, item.hash, nonceHash(input.nonce), now);
      if (!changed) forbidden();
      return { operationId: row.id, kind: item.kind, itemKey: item.itemKey, acknowledged: true };
    }
    const prior = await store.get('SELECT ack_at FROM mcp_v2_media_delivery WHERE challenge_id=? AND kind=? AND item_key=?', challenge.id, item.kind, item.itemKey);
    const payload = item.kind === 'PAGE' ? { data: Buffer.from(manifest.pages[item.pageIndex].page_json), mime: 'application/json; charset=utf-8' }
      : await loadMediaReviewAsset(store, row, context.mediaState, context.mediaContext, item.assetKey);
    if (mediaHash(payload.data) !== item.hash) forbidden();
    if (prior?.ack_at) return new Response(payload.data, { headers: { 'Content-Type': payload.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Media-Acknowledged': 'true', 'X-Media-Sha256': item.hash, 'X-Media-Manifest': manifest.descriptor.manifestRoot, 'X-Media-Item': item.kind + ':' + item.itemKey } });
    const nonce = secret();
    await store.run(`INSERT INTO mcp_v2_media_delivery(challenge_id,operation_id,kind,item_key,manifest_root,expected_hash,nonce_hash,issued_at,expires_at,ack_at,page_index,asset_key)
      VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?) ON CONFLICT(challenge_id,kind,item_key) DO UPDATE SET nonce_hash=excluded.nonce_hash,issued_at=excluded.issued_at,expires_at=excluded.expires_at`,
    challenge.id, row.id, item.kind, item.itemKey, manifest.descriptor.manifestRoot, item.hash, nonceHash(nonce), now, challenge.expires_at, item.pageIndex, item.assetKey);
    return new Response(payload.data, { headers: { 'Content-Type': payload.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Media-Nonce': nonce, 'X-Media-Sha256': item.hash, 'X-Media-Manifest': manifest.descriptor.manifestRoot, 'X-Media-Item': item.kind + ':' + item.itemKey } });
  }
  return Object.freeze({ deliver: (request, input) => child(request, input, false), ack: (request, input) => child(request, input, true) });
}

// First-party seller approval only. Password verification runs without a database
// lock; a second platform fence and tenant transaction revalidate every snapshot.
export function createOperationApproval({ store, binding, sellerOrigin, quickLogin, epoch, buildDigest, tenantGuard, mcpMedia, enabled = false, catalogUpdateEnabled = false, catalogCreateEnabled = false }) {
  const epochHash = requireSafeConfig(binding, sellerOrigin, quickLogin, enabled, epoch, buildDigest, tenantGuard);
  binding = Object.freeze({ tenantId: binding.tenantId, issuer: binding.issuer, resource: binding.resource, mcpV2: binding.mcpV2 });
  const addressLimit = new SqlLimiter(store, 'mcp-v2-approval-address', { limit: 5, windowMs: 900000 });
  const accountLimit = new SqlLimiter(store, 'mcp-v2-approval-account', { limit: 20, windowMs: 900000 });
  return async function approve(request, input, clientAddress) {
    if (request.method !== 'POST' || new URL(request.url).origin !== sellerOrigin || request.headers.get('origin') !== sellerOrigin ||
        !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['operationId', 'previewHash', 'challenge', 'decision', 'password', 'currencyAcknowledged', 'mediaReviewed'].includes(key)) ||
        !['operationId', 'previewHash', 'challenge', 'decision', 'password'].every((key) => Object.hasOwn(input, key)) ||
        (Object.hasOwn(input, 'currencyAcknowledged') && input.currencyAcknowledged !== true) ||
        (Object.hasOwn(input, 'mediaReviewed') && input.mediaReviewed !== true) ||
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
        const context = await humanContext(store, binding, tenant.revision, epochHash, buildDigest, session, row, mcpMedia?.enabled, catalogUpdateEnabled, catalogCreateEnabled, mcpMedia?.codecDigest);
        if (!context || !sameSecret(row.preview_hash, input.previewHash) ||
            (Boolean(context.mediaState) && input.decision === 'approve') !== Object.hasOwn(input, 'mediaReviewed') ||
            (context.currencyAcknowledgementRequired && input.decision === 'approve') !== Object.hasOwn(input, 'currencyAcknowledged')) forbidden();
        const account = await store.get('SELECT password_hash, oauth_auth_version FROM seller_account WHERE id = ?', session.account.id);
        if (!account || !Number.isSafeInteger(account.oauth_auth_version)) forbidden();
        const challenge = await store.get(`SELECT * FROM mcp_v2_approval_challenge WHERE operation_id = ? AND nonce_hash = ?
          AND account_id = ? AND session_hash = ? AND account_auth_version = ? AND consumed_at IS NULL AND expires_at > ?`,
        row.id, hash(input.challenge + ':' + row.preview_hash), session.account.id, session.token_hash, account.oauth_auth_version, stamp());
        if (!challenge) forbidden();
        if (context.mediaState && input.decision === 'approve') await readMediaAcknowledgements(store, { operation: row, manifest: context.mediaState.manifest, challenge });
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
      const context = await humanContext(store, binding, tenant.revision, epochHash, buildDigest, session, row, mcpMedia?.enabled, catalogUpdateEnabled, catalogCreateEnabled, mcpMedia?.codecDigest);
      if (!context || !sameSecret(row.preview_hash, input.previewHash) ||
          (Boolean(context.mediaState) && input.decision === 'approve') !== Object.hasOwn(input, 'mediaReviewed') ||
          (context.currencyAcknowledgementRequired && input.decision === 'approve') !== Object.hasOwn(input, 'currencyAcknowledged')) forbidden();
      const now = stamp(), expires = new Date(Math.min(Date.parse(now) + APPROVAL_MS, Date.parse(row.expires_at))).toISOString();
      if (expires <= now) forbidden();
      const challenge = await store.get('SELECT * FROM mcp_v2_approval_challenge WHERE id=?', snapshot.challengeId);
      if (!challenge) forbidden();
      const acknowledgedAt = context.mediaState && input.decision === 'approve' ? await readMediaAcknowledgements(store,
        { operation: row, manifest: context.mediaState.manifest, challenge, before: now }) : null;
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
      if (acknowledgedAt) await store.run(`INSERT INTO mcp_v2_media_approval_evidence(operation_id,challenge_id,manifest_root,descriptor_hash,approver_id,session_hash,
        account_auth_version,epoch_hash,build_digest,tenant_revision,policy_id,approved_at,expires_at,acknowledged_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id, snapshot.challengeId, context.mediaState.manifest.descriptor.manifestRoot, context.mediaState.manifest.descriptorHash,
      snapshot.accountId, session.token_hash, snapshot.authVersion, epochHash, buildDigest, tenant.revision, row.media_policy_id, now, expires, acknowledgedAt);
      await store.run(`INSERT INTO mcp_v2_event(id, at, tenant_id, account_id, client_id, grant_id, tool_name, resource_id,
        operation_id, approver_id, event, outcome, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(), now, binding.tenantId, row.account_id, row.client_id, row.grant_id, row.tool_name,
      typeof row.resource_id === 'string' && uuid.test(row.resource_id) ? row.resource_id : null,
      row.id, snapshot.accountId, state === 'APPROVED' ? 'APPROVE' : 'REJECT',
      state === 'APPROVED' && context.mediaState ? MEDIA_REVIEW_ACKNOWLEDGED :
        state === 'APPROVED' && context.currencyAcknowledgementRequired ? COMPANY_CURRENCY_ACKNOWLEDGED : state, row.correlation_id);
      if (acknowledgedAt) await readMediaApprovalEvidence(store, { operation: row, envelope: context.envelope,
        approval: { approver_id: snapshot.accountId, session_hash: session.token_hash, approved_at: now, expires_at: expires },
        authority: { accountAuthVersion: snapshot.authVersion }, manifest: context.mediaState.manifest });
      return { operationId: row.id, status: state, expiresAt: expires };
    }));
  };
}
