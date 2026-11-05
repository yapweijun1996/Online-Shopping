import { randomUUID } from 'node:crypto';
import { ApiError } from '../http.js';
import { can } from '../roles.js';
import { hash, stamp } from './credentials.js';
import { canonicalOperationJson, operationPreviewHash, readStoredOperation } from './operation-envelope.js';
import { requiresCompanyCurrencyAcknowledgement, COMPANY_CURRENCY_ACKNOWLEDGED } from './company-approval-policy.js';
import { operationEpochHash } from './operation-epoch.js';
import { verifyOperationAuthority } from './operation-authorization.js';
import { MEDIA_LIMITS } from './media-schema.js';
import { mediaJson, mediaPolicyForTool, validateRetainedMediaPolicy } from './media-policy.js';
import { mediaManifestRows } from './media-manifest.js';
import { readMediaPolicy, storeMediaPolicy, withMediaWriter } from './media-storage.js';
import { persistMediaFrame, readMediaFrame } from './media-frame-storage.js';
import { readMediaApprovalEvidence } from './media-approval-policy.js';
import { operationInstant, operationReceiptExpiry, OPERATION_TERMINAL_STATES } from './operation-maintenance.js';
import { OPERATION_APPROVAL_MS, OPERATION_MUTATION_PAIRS, OPERATION_SCOPE_POLICIES, operationAuthorityPolicy } from './operation-policy.js';

const ttl = 10 * 60 * 1000;
const maxPendingPerClient = 20;
const maxPendingPerTenant = 100;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keyPattern = /^[A-Za-z0-9._~-]{16,128}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const denied = () => fail(403, 'FORBIDDEN', 'Operation authorization failed.');
function freezeJson(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

// Private hook packets are not proposals or authority. Copy bounded bytes, freeze
// metadata, and reject live readers/writers/Maps rather than leaking them past locks.
function privatePacket(value) {
  const seen = new Set(); let nodes = 0, textBytes = 0, binaryBytes = 0;
  function copy(item, depth) {
    if (++nodes > MEDIA_LIMITS.records * MEDIA_LIMITS.products || depth > 16) throw new TypeError('Invalid private media packet.');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      textBytes += Buffer.byteLength(item);
      if (!item.isWellFormed() || textBytes > MEDIA_LIMITS.graphBytes) throw new TypeError('Invalid private media packet.');
      return item;
    }
    if (typeof item === 'number' && Number.isSafeInteger(item)) return item;
    if (item instanceof Uint8Array) {
      binaryBytes += item.byteLength;
      if (item.byteLength > MEDIA_LIMITS.sourceBytes || binaryBytes > MEDIA_LIMITS.graphBytes) throw new TypeError('Invalid private media packet.');
      return Buffer.from(item);
    }
    if (!item || typeof item !== 'object' || seen.has(item) ||
        (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) throw new TypeError('Invalid private media packet.');
    seen.add(item);
    try {
      const array = Array.isArray(item), out = array ? [] : {};
      const keys = Reflect.ownKeys(item);
      if (array && keys.length !== item.length + 1) throw new TypeError('Invalid private media packet.');
      for (const key of array ? Array.from({ length: item.length }, (_, i) => String(i)) : keys) {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) ||
            !property?.enumerable || !Object.hasOwn(property, 'value')) throw new TypeError('Invalid private media packet.');
        out[key] = copy(property.value, depth + 1);
      }
      return Object.freeze(out);
    } finally { seen.delete(item); }
  }
  return copy(value, 0);
}

// Adapters are server-owned code, never supplied by MCP arguments. Their
// preview/currentRevision use this facade to guard against accidental DML;
// it is not a sandbox for untrusted adapter code. apply must call the existing
// transaction-aware business service and record its domain history.
function readOnly(store, alive) {
  const sql = (query) => {
    alive();
    if (typeof query !== 'string' || !/^\s*SELECT\b/i.test(query) || query.includes(';')) {
      throw new TypeError('Operation preview requires a read-only query.');
    }
    return query;
  };
  return Object.freeze({
    dialect: store.dialect,
    get: (query, ...values) => store.get(sql(query), ...values),
    all: (query, ...values) => store.all(sql(query), ...values),
  });
}

function event(store, row, name, outcome, approverId = null) {
  return store.run(`INSERT INTO mcp_v2_event(id, at, tenant_id, account_id, client_id, grant_id, tool_name, resource_id,
    operation_id, approver_id, event, outcome, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  randomUUID(), stamp(), row.tenant_id, row.account_id, row.client_id, row.grant_id, row.tool_name,
  typeof row.resource_id === 'string' && uuid.test(row.resource_id) ? row.resource_id : null,
  row.id, approverId, name, outcome, row.correlation_id);
}

function publicState(row, replayed = false) {
  return { operationId: row.id, status: row.state, previewHash: row.preview_hash, expiresAt: row.expires_at, replayed };
}

// Explicit enablement and server-constructed adapters are required. Internal
// media hooks do not register public tools or create human-review evidence.
export function createOperationEngine({ store, binding, adapters, epoch, buildDigest, tenantGuard, enabled = false, quickLogin }) {
  if (enabled !== true || quickLogin !== false || !store || !binding || typeof buildDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(buildDigest) || !tenantGuard || typeof tenantGuard.withActiveTenant !== 'function' ||
      !adapters || typeof adapters !== 'object' || Array.isArray(adapters)) {
    throw new TypeError('Operation engine requires explicit enablement and trusted adapters.');
  }
  try {
    const issuer = new URL(binding.issuer);
    if (typeof binding.tenantId !== 'string' || !binding.tenantId || issuer.protocol !== 'https:' ||
        issuer.username || issuer.password || issuer.search || issuer.hash ||
        binding.resource !== `${binding.issuer}/mcp`) throw new Error('Unsafe binding.');
  } catch { throw new TypeError('Operation engine requires a secure tenant binding.'); }
  const epochHash = operationEpochHash(epoch);
  binding = Object.freeze({ tenantId: binding.tenantId, issuer: binding.issuer, resource: binding.resource });
  // Production must supply a guard that holds the platform lifecycle fence
  // across this callback and acquires locks before the tenant store.
  const withTenant = (work) => tenantGuard.withActiveTenant(binding.tenantId, (tenant) => {
    if (!tenant || !Number.isSafeInteger(tenant.revision) || tenant.revision < 0) denied();
    return work(tenant);
  });
  const registered = Object.create(null);
  for (const [name, adapter] of Object.entries(adapters)) {
    let media = null;
    if (adapter?.media !== undefined) {
      const value = adapter.media, keys = ['policyId', 'codecDigest', 'capture', 'resolve', 'persistResources', 'consumeResources'];
      const policy = mediaPolicyForTool(name);
      if (!value || Object.keys(value).sort().join(',') !== [...keys].sort().join(',') || policy.flow !== 'DIRECT' ||
          policy.previewTool !== name || value.policyId !== policy.policyId || !/^[a-f0-9]{64}$/.test(value.codecDigest || '') ||
          adapter.resourceType !== 'product' || keys.slice(2).some(key => typeof value[key] !== 'function')) throw new TypeError('Invalid trusted media hooks.');
      media = Object.freeze({ ...value });
    }
    const commitTool = OPERATION_MUTATION_PAIRS[name] ?? (media ? mediaPolicyForTool(name).commitTool : null), previewPolicy = OPERATION_SCOPE_POLICIES[name];
    const commitPolicy = OPERATION_SCOPE_POLICIES[commitTool];
    if (!commitTool || !previewPolicy || !commitPolicy || previewPolicy.scope !== commitPolicy.scope ||
        !adapter || typeof adapter !== 'object' || typeof adapter.resourceType !== 'string' ||
        typeof adapter.preview !== 'function' || typeof adapter.currentRevision !== 'function' ||
        typeof adapter.apply !== 'function' || typeof adapter.validResult !== 'function' ||
        typeof adapter.toReceipt !== 'function' || typeof adapter.validReceipt !== 'function') {
      throw new TypeError('Invalid operation adapter.');
    }
    registered[name] = Object.freeze({ resourceType: adapter.resourceType, preview: adapter.preview,
      currentRevision: adapter.currentRevision, apply: adapter.apply, validResult: adapter.validResult, toReceipt: adapter.toReceipt, validReceipt: adapter.validReceipt, commitTool, media });
  }
  Object.freeze(registered);
  const withRead = async work => {
    let active = true;
    const read = readOnly(store, () => { if (!active) throw new TypeError('Operation reader is no longer active.'); });
    try { return await work(read); } finally { active = false; }
  };
  const contextFor = (authority, tenantRevision) => Object.freeze({ tenantId: authority.tenantId, tenantRevision,
    accountId: authority.accountId, clientId: authority.clientId, grantId: authority.grantId,
    accountAuthVersion: authority.accountAuthVersion, epochHash, buildDigest, issuer: binding.issuer,
    resource: binding.resource, grantExpiresAt: authority.grantExpiresAt });

  async function metadata(row, adapter, tenantRevision, grant, authority) {
    let policy;
    try { policy = operationAuthorityPolicy(row?.tool_name, row?.media_policy_id ?? null); } catch { return false; }
    if (!row || !adapter || !grant || !uuid.test(row.id || '') || !uuid.test(row.account_id || '') ||
        !uuid.test(row.grant_id || '') || !uuid.test(row.correlation_id || '') ||
        row.tenant_id !== binding.tenantId || row.issuer !== binding.issuer || row.resource !== binding.resource ||
        row.tenant_revision !== tenantRevision || row.epoch_hash !== epochHash || row.build_digest !== buildDigest ||
        typeof row.client_id !== 'string' || !row.client_id.length || row.client_id.length > 128 ||
        row.resource_type !== adapter.resourceType || !/^[a-z][a-z0-9_.-]{0,127}$/.test(row.resource_type) ||
        !(row.resource_id === null || (typeof row.resource_id === 'string' && row.resource_id.length > 0 && row.resource_id.length <= 128)) ||
        !(row.expected_revision === null || (typeof row.expected_revision === 'string' && row.expected_revision.length > 0 && row.expected_revision.length <= 128)) ||
        !operationInstant(row.created_at) || !operationInstant(row.expires_at) || row.created_at >= row.expires_at ||
        Date.parse(row.expires_at) - Date.parse(row.created_at) !== ttl || row.created_at > stamp() ||
        !operationInstant(row.receipt_expires_at) || row.receipt_expires_at !== operationReceiptExpiry(grant.absolute_expires_at) ||
        row.receipt_expires_at <= stamp() ||
        !['request_hash', 'preview_hash', 'idempotency_hash'].every((key) => /^[0-9a-f]{64}$/.test(row[key] || '')) ||
        !Object.hasOwn(OPERATION_SCOPE_POLICIES, row.tool_name) ||
        row.required_scope !== OPERATION_SCOPE_POLICIES[row.tool_name].scope ||
        row.required_capability !== OPERATION_SCOPE_POLICIES[row.tool_name].capability ||
        row.risk !== policy.risk || (row.media_policy_id ?? null) !== (adapter.media?.policyId ?? null)) return false;
    const envelope = row.redacted_at === null ? readStoredOperation(row, binding) : null;
    if (row.redacted_at === null && !envelope) return false;
    try {
      const stored = await readMediaPolicy(store, contextFor(authority, tenantRevision), row.id);
      const descriptor = validateRetainedMediaPolicy(row, stored,
        envelope && Object.hasOwn(envelope.proposal, 'media') ? envelope.proposal.media : undefined);
      if (adapter.media && (!descriptor || descriptor.codecDigest !== adapter.media.codecDigest || descriptor.graphRevision !== row.expected_revision)) return false;
    } catch { return false; }
    if (row.redacted_at !== null) return OPERATION_TERMINAL_STATES.includes(row.state) && row.envelope_json === null &&
      operationInstant(row.redacted_at) && row.redacted_at >= row.expires_at && row.redacted_at <= stamp();
    return true;
  }

  async function receipt(adapter, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid operation receipt.');
    const serialized = canonicalOperationJson(value);
    if (Buffer.byteLength(serialized) > 2048) throw new TypeError('Operation receipt is too large.');
    const safe = freezeJson(JSON.parse(serialized));
    // The trusted domain adapter must use a strict non-sensitive receipt schema.
    // Generic JSON validity cannot establish that text contains no personal data.
    if (await adapter.validReceipt(safe) !== true) throw new TypeError('Invalid operation receipt.');
    return { value: safe, serialized };
  }

  async function mediaResources(row, adapter, envelope, context) {
    const manifest = await readMediaFrame(store, context, row.id, envelope.proposal.media);
    if (manifest.descriptor.codecDigest !== adapter.media.codecDigest || manifest.descriptor.graphRevision !== row.expected_revision ||
        !manifest.effects.some(effect => effect.kind === 'PRODUCT' && effect.productId === row.resource_id) ||
        (adapter.media.policyId === 'media-upload-v1' ? manifest.stages.length !== 1 : manifest.stages.length !== 0)) denied();
    await withMediaWriter(store, context, async writer => {
      for (const expected of manifest.stages) {
        const stage = await writer.inspect(expected.stage_id), bytes = await writer.boundBytes(expected.stage_id, row.id);
        if (stage.productId !== row.resource_id || stage.expectedRevision !== row.expected_revision ||
            stage.receiptExpiresAt !== row.receipt_expires_at || stage.correlationId !== row.correlation_id ||
            bytes.codecDigest !== adapter.media.codecDigest || bytes.canonicalSha256 !== expected.canonical_sha256) denied();
        const asset = manifest.assets.find(asset => asset.mime === bytes.mime && asset.byte_sha256 === bytes.canonicalSha256);
        const product = manifest.effects.find(effect => effect.kind === 'PRODUCT' && effect.productId === stage.productId);
        const listing = manifest.effects.find(effect => effect.kind === 'LISTING' && effect.listingId === product?.after?.listingId);
        if (!asset || (stage.targetSlot === 'MAIN' ? product?.after?.mainAssetKey !== asset.asset_key
          : !listing?.after?.galleryAssetKeys.includes(asset.asset_key))) denied();
      }
    });
    return manifest;
  }

  async function resolveOutside(adapter, resources) {
    const controller = new AbortController(), deadline = performance.now() + MEDIA_LIMITS.coordinatorMs;
    let timer;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new ApiError(503, 'MEDIA_DEADLINE', 'Media preparation timed out.'));
    }, MEDIA_LIMITS.coordinatorMs); });
    try {
      const result = await Promise.race([adapter.media.resolve(resources, Object.freeze({ signal: controller.signal, deadline })), expired]);
      if (controller.signal.aborted || performance.now() >= deadline) fail(503, 'MEDIA_DEADLINE', 'Media preparation timed out.');
      return privatePacket(result);
    } finally { clearTimeout(timer); }
  }

  async function existingState({ authority, originalGrant, toolName, requestHash, idempotencyKey, adapter, tenant }) {
    const row = await store.get(`SELECT * FROM mcp_v2_operation
      WHERE tenant_id=? AND account_id=? AND client_id=? AND idempotency_hash=?`,
    authority.tenantId, authority.accountId, authority.clientId, hash(idempotencyKey));
    if (!row) return null;
    if (row.request_hash !== requestHash || row.tool_name !== toolName) fail(409, 'IDEMPOTENCY_CONFLICT', 'The operation key has another request.');
    if (row.grant_id !== authority.grantId || !await metadata(row, adapter, tenant.revision, originalGrant, authority)) denied();
    if (['PREPARED', 'PENDING_APPROVAL', 'APPROVED'].includes(row.state)) {
      if (row.expires_at <= stamp()) {
        const expired = await store.get("UPDATE mcp_v2_operation SET state='EXPIRED' WHERE id=? AND state=? RETURNING id", row.id, row.state);
        if (!expired) denied();
        if (row.state === 'APPROVED') await store.run('UPDATE mcp_v2_approval SET consumed_at=? WHERE operation_id=? AND consumed_at IS NULL', stamp(), row.id);
        await event(store, row, 'EXPIRE', 'EXPIRED'); return publicState({ ...row, state: 'EXPIRED' }, true);
      }
      if (adapter.media) await mediaResources(row, adapter, readStoredOperation(row, binding), contextFor(authority, tenant.revision));
    }
    return publicState(row, true);
  }
  async function pendingLimit(authority) {
    const active = "state IN ('PREPARED','PENDING_APPROVAL','APPROVED') AND expires_at>?", now = stamp();
    const tenant = await store.get(`SELECT COUNT(*) AS n FROM mcp_v2_operation WHERE tenant_id=? AND ${active}`, authority.tenantId, now);
    const client = await store.get(`SELECT COUNT(*) AS n FROM mcp_v2_operation WHERE tenant_id=? AND client_id=? AND ${active}`, authority.tenantId, authority.clientId, now);
    if (Number(tenant.n) >= maxPendingPerTenant || Number(client.n) >= maxPendingPerClient) fail(429, 'RATE_LIMITED', 'Too many pending operations.');
  }

  async function prepare(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 4 ||
        !['bearer', 'toolName', 'args', 'idempotencyKey'].every((key) => Object.hasOwn(input, key))) {
      fail(400, 'INVALID_INPUT', 'Invalid operation request.');
    }
    const { bearer, toolName, args, idempotencyKey } = input;
    const adapter = typeof toolName === 'string' && Object.hasOwn(registered, toolName) && registered[toolName];
    if (!adapter || !args || typeof args !== 'object' || Array.isArray(args) ||
        ['tenantId', 'shopId', 'accountId', 'approved', 'mediaReviewed', 'requiredScopes', 'mediaPolicyId'].some((key) => Object.hasOwn(args, key)) ||
        typeof idempotencyKey !== 'string' || !keyPattern.test(idempotencyKey)) {
      fail(400, 'INVALID_INPUT', 'Invalid operation request.');
    }
    let requestHash, safeArgs;
    try {
      safeArgs = freezeJson(JSON.parse(canonicalOperationJson(args)));
      requestHash = hash(canonicalOperationJson({ toolName, args: safeArgs }));
    }
    catch { fail(400, 'INVALID_INPUT', 'Invalid operation request.'); }
    let captured = null, resolved = null;
    if (adapter.media) {
      const initial = await withTenant(tenant => store.transaction(async () => {
        const authority = await verifyOperationAuthority(store, { bearer, binding, toolName, epochHash, mediaPolicyId: adapter.media.policyId });
        const originalGrant = await store.get('SELECT absolute_expires_at FROM oauth_grant WHERE id=?', authority.grantId);
        const replayed = await existingState({ authority, originalGrant, toolName, requestHash, idempotencyKey, adapter, tenant });
        if (replayed) return { replayed };
        await pendingLimit(authority);
        const context = contextFor(authority, tenant.revision);
        const packet = privatePacket(await withMediaWriter(store, context,
          writer => withRead(read => adapter.media.capture(read, safeArgs, context, writer))));
        if (!packet || Object.keys(packet).sort().join(',') !== 'expectedRevision,resourceId,resources' ||
            !uuid.test(packet.resourceId || '') || !/^[a-f0-9]{64}$/.test(packet.expectedRevision || '')) throw new TypeError('Invalid media capture.');
        return { captured: Object.freeze({ ...packet, context }) };
      }));
      if (initial.replayed) return initial.replayed;
      captured = initial.captured;
      resolved = await resolveOutside(adapter, captured.resources);
    }
    return withTenant((tenant) => store.transaction(async () => {
      const authority = await verifyOperationAuthority(store, { bearer, binding, toolName, epochHash, mediaPolicyId: adapter.media?.policyId ?? null });
      const originalGrant = await store.get('SELECT absolute_expires_at FROM oauth_grant WHERE id = ?', authority.grantId);
      const receiptExpiry = operationReceiptExpiry(originalGrant.absolute_expires_at), idem = hash(idempotencyKey);
      const context = contextFor(authority, tenant.revision);
      if (captured && mediaJson(captured.context) !== mediaJson(context)) denied();
      const replayed = await existingState({ authority, originalGrant, toolName, requestHash, idempotencyKey, adapter, tenant });
      if (replayed) return replayed;
      await pendingLimit(authority);
      const draft = await withRead(read => adapter.media ? adapter.preview(read, safeArgs, resolved, context) : adapter.preview(read, safeArgs));
      if (!draft || typeof draft !== 'object' || Array.isArray(draft) ||
          Object.keys(draft).sort().join(',') !== (adapter.media ? 'expectedRevision,mediaManifest,proposal,resourceId' : 'expectedRevision,proposal,resourceId')) {
        throw new TypeError('Invalid server operation draft.');
      }
      const policy = operationAuthorityPolicy(toolName, adapter.media?.policyId ?? null);
      let proposal = JSON.parse(canonicalOperationJson(draft.proposal)), correlationId = randomUUID();
      const now = stamp();
      if (!proposal || Array.isArray(proposal) || Object.hasOwn(proposal, 'media')) throw new TypeError('Invalid server operation proposal.');
      if (adapter.media) {
        const manifest = draft.mediaManifest;
        if (draft.expectedRevision !== captured.expectedRevision) fail(409, 'STALE_REVISION', 'The resource changed.');
        if (!manifest || manifest.descriptor?.policyId !== adapter.media.policyId || manifest.descriptor.codecDigest !== adapter.media.codecDigest ||
            draft.resourceId !== captured.resourceId ||
            manifest.descriptor.graphRevision !== draft.expectedRevision ||
            (adapter.media.policyId === 'media-upload-v1' ? manifest.stages?.length !== 1 : manifest.stages?.length !== 0)) denied();
        proposal = { ...proposal, media: manifest.descriptor };
        if (manifest.stages.length) {
          const stage = await withMediaWriter(store, context, writer => writer.inspect(manifest.stages[0].stage_id));
          if (stage.productId !== draft.resourceId || stage.expectedRevision !== draft.expectedRevision || stage.state !== 'VALIDATING' ||
              stage.codecDigest !== adapter.media.codecDigest || stage.receiptExpiresAt !== receiptExpiry || stage.leaseUntil <= now ||
              stage.absoluteExpiresAt < new Date(Date.parse(now) + ttl).toISOString()) denied();
          correlationId = stage.correlationId;
        }
      }
      const envelope = {
        version: 1, operationId: randomUUID(), tenantId: authority.tenantId, tenantRevision: tenant.revision, accountId: authority.accountId,
        clientId: authority.clientId, grantId: authority.grantId, epochHash, buildDigest, issuer: binding.issuer, resource: binding.resource,
        toolName, resourceType: adapter.resourceType, resourceId: draft.resourceId, expectedRevision: draft.expectedRevision,
        requiredScope: policy.scope, requiredCapability: policy.capability, risk: policy.risk,
        createdAt: now, expiresAt: new Date(Date.parse(now) + ttl).toISOString(), idempotencyHash: idem, correlationId, proposal,
      };
      if (adapter.media) {
        mediaManifestRows(draft.mediaManifest, { operationId: envelope.operationId, toolName, createdAt: now, expiresAt: envelope.expiresAt });
        const current = await withRead(read => adapter.currentRevision(read, freezeJson(JSON.parse(canonicalOperationJson(envelope)))));
        if (!current || current.exists !== true || current.revision !== captured.expectedRevision) fail(409, 'STALE_REVISION', 'The resource changed.');
      }
      const previewHash = operationPreviewHash(envelope), serialized = canonicalOperationJson(envelope);
      const immutableEnvelope = freezeJson(JSON.parse(serialized));
      await store.run(`INSERT INTO mcp_v2_operation(id, tenant_id, tenant_revision, account_id, client_id, grant_id, epoch_hash, build_digest, issuer, resource,
        tool_name, required_scope, required_capability, risk, resource_type, resource_id, expected_revision,
        envelope_json, preview_hash, request_hash, idempotency_hash, state, created_at, expires_at, correlation_id, receipt_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?, ?, ?)`,
      envelope.operationId, envelope.tenantId, envelope.tenantRevision, envelope.accountId, envelope.clientId, envelope.grantId, epochHash, buildDigest,
      envelope.issuer, envelope.resource, toolName, policy.scope, policy.capability, envelope.risk,
      envelope.resourceType, envelope.resourceId, envelope.expectedRevision === null ? null : String(envelope.expectedRevision),
      serialized, previewHash, requestHash, idem, now, envelope.expiresAt, envelope.correlationId, receiptExpiry);
      if (adapter.media) {
        await storeMediaPolicy(store, context, envelope.operationId, immutableEnvelope.proposal.media);
        await withMediaWriter(store, context, writer => adapter.media.persistResources(writer, immutableEnvelope, resolved, context));
        await persistMediaFrame(store, context, envelope.operationId, draft.mediaManifest);
      }
      const row = await store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', envelope.operationId);
      if (!await metadata(row, adapter, tenant.revision, originalGrant, authority)) denied();
      if (adapter.media) {
        await mediaResources(row, adapter, immutableEnvelope, context);
        const finalAuthority = await verifyOperationAuthority(store, { bearer, binding, toolName, epochHash, mediaPolicyId: adapter.media.policyId });
        if (mediaJson(contextFor(finalAuthority, tenant.revision)) !== mediaJson(context)) denied();
        const current = await withRead(read => adapter.currentRevision(read, immutableEnvelope));
        if (!current || current.exists !== true || current.revision !== captured.expectedRevision) fail(409, 'STALE_REVISION', 'The resource changed.');
      }
      await event(store, row, 'PREPARE', 'PREPARED');
      const changed = await store.get(`UPDATE mcp_v2_operation SET state = 'PENDING_APPROVAL'
        WHERE id = ? AND state = 'PREPARED' RETURNING id`, row.id);
      if (!changed) throw new Error('Operation transition failed.');
      await event(store, row, 'REQUEST_APPROVAL', 'PENDING_APPROVAL');
      return publicState({ ...row, state: 'PENDING_APPROVAL' });
    }));
  }

  async function commit(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3 ||
        !['bearer', 'toolName', 'operationId'].every((key) => Object.hasOwn(input, key))) {
      fail(400, 'INVALID_INPUT', 'Invalid operation request.');
    }
    const { bearer, toolName, operationId } = input;
    if (typeof operationId !== 'string' || !uuid.test(operationId) || typeof toolName !== 'string') {
      fail(400, 'INVALID_INPUT', 'Invalid operation request.');
    }
    let attempted = false;
    try {
      return await withTenant((tenant) => store.transaction(async () => {
        let authority = await verifyOperationAuthority(store, { bearer, binding, toolName, epochHash });
        const row = await store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', operationId);
        const adapter = row && Object.hasOwn(registered, row.tool_name) && registered[row.tool_name];
        if (row?.media_policy_id) authority = await verifyOperationAuthority(store, { bearer, binding, toolName, epochHash, mediaPolicyId: row.media_policy_id });
        const originalGrant = await store.get('SELECT absolute_expires_at FROM oauth_grant WHERE id = ?', authority.grantId);
        const stored = row?.redacted_at === null && readStoredOperation(row, binding);
        const envelope = stored && freezeJson(stored);
        if (!row || !adapter || !await metadata(row, adapter, tenant.revision, originalGrant, authority) || row.tenant_revision !== tenant.revision ||
            row.epoch_hash !== epochHash || row.build_digest !== buildDigest ||
            adapter.commitTool !== toolName || row.grant_id !== authority.grantId ||
            row.account_id !== authority.accountId || row.client_id !== authority.clientId ||
            row.required_scope !== OPERATION_SCOPE_POLICIES[toolName].scope ||
            row.required_capability !== OPERATION_SCOPE_POLICIES[toolName].capability ||
            row.risk !== operationAuthorityPolicy(row.tool_name, row.media_policy_id).risk || row.resource_type !== adapter.resourceType) denied();
        if (row.state === 'COMMITTED') {
          let result;
          try {
            const saved = await receipt(adapter, JSON.parse(row.result_json));
            if (saved.serialized !== row.result_json) denied();
            result = saved.value;
          } catch { denied(); }
          return { operationId: row.id, status: 'COMMITTED', result, replayed: true };
        }
        const now = stamp();
        if (row.state !== 'APPROVED' || !envelope) denied();
        const approval = await store.get('SELECT * FROM mcp_v2_approval WHERE operation_id = ?', row.id);
        if (!approval || approval.decision !== 'APPROVED' || approval.consumed_at || approval.preview_hash !== row.preview_hash ||
            approval.approver_id !== row.account_id || typeof approval.approved_at !== 'string' ||
            typeof approval.expires_at !== 'string' || !instantPattern.test(approval.approved_at) ||
            !instantPattern.test(approval.expires_at) || Number.isNaN(Date.parse(approval.approved_at)) ||
            Number.isNaN(Date.parse(approval.expires_at)) ||
            new Date(approval.approved_at).toISOString() !== approval.approved_at ||
            new Date(approval.expires_at).toISOString() !== approval.expires_at || approval.approved_at < row.created_at ||
            approval.approved_at > now || approval.expires_at > row.expires_at ||
            Date.parse(approval.expires_at) - Date.parse(approval.approved_at) > OPERATION_APPROVAL_MS) denied();
        if (row.expires_at <= now || approval.expires_at <= now) {
          const consumed = await store.get(`UPDATE mcp_v2_approval SET consumed_at = ?
            WHERE operation_id = ? AND consumed_at IS NULL RETURNING operation_id`, now, row.id);
          const expired = await store.get(`UPDATE mcp_v2_operation SET state = 'EXPIRED'
            WHERE id = ? AND state = 'APPROVED' RETURNING id`, row.id);
          if (!consumed || !expired) denied();
          await event(store, row, 'EXPIRE', 'EXPIRED', approval.approver_id);
          return { operationId: row.id, error: 'EXPIRED' };
        }
        const session = await store.get(`SELECT s.expires_at, a.id, a.role, a.active, a.must_change_password
          FROM session s JOIN seller_account a ON a.id = s.account_id WHERE s.token_hash = ?`, approval.session_hash);
        if (!session || session.id !== row.account_id || session.active !== 1 || session.must_change_password !== 0 ||
            session.expires_at <= now || !can(session.role, row.required_capability)) denied();
        let currencyAcknowledgementRequired;
        try { currencyAcknowledgementRequired = requiresCompanyCurrencyAcknowledgement(envelope); }
        catch { denied(); }
        if (currencyAcknowledgementRequired) {
          const acknowledged = await store.get(`SELECT id FROM mcp_v2_event WHERE operation_id = ? AND tenant_id = ?
            AND account_id = ? AND client_id = ? AND grant_id = ? AND tool_name = ? AND approver_id = ?
            AND correlation_id = ? AND at = ? AND event = 'APPROVE' AND outcome = ? LIMIT 1`,
          row.id, row.tenant_id, row.account_id, row.client_id, row.grant_id, row.tool_name, approval.approver_id,
          row.correlation_id, approval.approved_at, COMPANY_CURRENCY_ACKNOWLEDGED);
          if (!acknowledged) denied();
        }
        const context = contextFor(authority, tenant.revision);
        let manifest = null;
        if (adapter.media) {
          manifest = await mediaResources(row, adapter, envelope, context);
          await readMediaApprovalEvidence(store, { operation: row, envelope, approval, authority, manifest });
        }
        const current = await withRead(read => adapter.currentRevision(read, envelope));
        if (!current || typeof current !== 'object' || typeof current.exists !== 'boolean' ||
            !Object.hasOwn(current, 'revision')) throw new TypeError('Invalid server revision.');
        const expectedExists = envelope.expectedRevision !== null;
        if (current.exists !== expectedExists || current.revision !== envelope.expectedRevision) {
          const consumed = await store.get(`UPDATE mcp_v2_approval SET consumed_at = ?
            WHERE operation_id = ? AND consumed_at IS NULL RETURNING operation_id`, now, row.id);
          const conflict = await store.get(`UPDATE mcp_v2_operation SET state = 'CONFLICT'
            WHERE id = ? AND state = 'APPROVED' RETURNING id`, row.id);
          if (!consumed || !conflict) denied();
          await event(store, row, 'CONFLICT', 'STALE_REVISION', approval.approver_id);
          return { operationId: row.id, error: 'STALE_REVISION' };
        }
        const consumed = await store.get(`UPDATE mcp_v2_approval SET consumed_at = ?
          WHERE operation_id = ? AND decision = 'APPROVED' AND consumed_at IS NULL AND preview_hash = ? AND expires_at > ? RETURNING operation_id`,
        now, row.id, row.preview_hash, now);
        if (!consumed) denied();
        attempted = true;
        // Only the stored, hashed proposal reaches the trusted domain adapter.
        const result = await adapter.apply(store, envelope.proposal, {
          accountId: authority.accountId, clientId: authority.clientId, grantId: authority.grantId,
          operationId: row.id, correlationId: row.correlation_id,
          ...(adapter.media ? { mediaContext: context } : {}),
        });
        if (!result || typeof result !== 'object' || Array.isArray(result) || await adapter.validResult(result) !== true) {
          throw new TypeError('Invalid operation result.');
        }
        const savedReceipt = await receipt(adapter, await adapter.toReceipt(result));
        if (adapter.media) await withMediaWriter(store, context, async writer => {
          await adapter.media.consumeResources(writer, envelope, context);
          for (const stage of manifest.stages) {
            const after = await writer.inspect(stage.stage_id);
            if (after.state !== 'CONSUMED' || after.operationId !== row.id) denied();
          }
        });
        // Long-running adapters cannot turn an expired token or approval into
        // a successful commit. An error here rolls all domain changes back.
        const finalAuthority = await verifyOperationAuthority(store, { bearer, binding, toolName, epochHash, mediaPolicyId: adapter.media?.policyId ?? null });
        if (finalAuthority.grantId !== authority.grantId || finalAuthority.accountId !== authority.accountId ||
            finalAuthority.clientId !== authority.clientId) denied();
        if (approval.expires_at <= stamp() || row.expires_at <= stamp()) {
          fail(409, 'EXPIRED', 'Operation approval expired.');
        }
        const finalSession = await store.get(`SELECT s.expires_at, a.id, a.role, a.active, a.must_change_password
          FROM session s JOIN seller_account a ON a.id = s.account_id WHERE s.token_hash = ?`, approval.session_hash);
        if (!finalSession || finalSession.id !== row.account_id || finalSession.active !== 1 ||
            finalSession.must_change_password !== 0 || finalSession.expires_at <= stamp() ||
            !can(finalSession.role, row.required_capability)) denied();
        const finalRow = await store.get('SELECT * FROM mcp_v2_operation WHERE id=?', row.id);
        if (finalRow?.preview_hash !== row.preview_hash || finalRow?.envelope_json !== row.envelope_json ||
            !await metadata(finalRow, adapter, tenant.revision, originalGrant, finalAuthority)) denied();
        if (adapter.media) await readMediaApprovalEvidence(store, { operation: finalRow, envelope, approval, authority: finalAuthority, manifest });
        const serialized = savedReceipt.serialized;
        const changed = await store.get(`UPDATE mcp_v2_operation SET state = 'COMMITTED', result_json = ?
          WHERE id = ? AND state = 'APPROVED' RETURNING id`, serialized, row.id);
        if (!changed) throw new Error('Operation transition failed.');
        await event(store, row, 'COMMIT', 'COMMITTED', approval.approver_id);
        return { operationId: row.id, status: 'COMMITTED', result: savedReceipt.value, replayed: false };
      }));
    } catch (error) {
      if (attempted) {
        // The mutation and approval consumption rolled back. Best effort records
        // a terminal failure separately; a database outage may prevent it.
        try {
          await withTenant((tenant) => store.transaction(async () => {
            const row = await store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', operationId);
            const status = error?.code === 'EXPIRED' ? 'EXPIRED' : 'FAILED';
            const changed = row && row.tenant_revision === tenant.revision && await store.get(`UPDATE mcp_v2_operation SET state = ?
              WHERE id = ? AND state = 'APPROVED' RETURNING id`, status, operationId);
            if (changed) {
              const approval = await store.get('SELECT approver_id FROM mcp_v2_approval WHERE operation_id = ?', operationId);
              if (status === 'EXPIRED') {
                await store.run('UPDATE mcp_v2_approval SET consumed_at = ? WHERE operation_id = ? AND consumed_at IS NULL', stamp(), operationId);
              }
              await event(store, row, status === 'EXPIRED' ? 'EXPIRE' : 'FAIL', status, approval?.approver_id || null);
            }
          }));
        } catch { /* Never turn a failed mutation into a success. */ }
      }
      throw error;
    }
  }
  return Object.freeze({ prepare, commit });
}
