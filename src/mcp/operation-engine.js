import { randomUUID } from 'node:crypto';
import { ApiError } from '../http.js';
import { can } from '../roles.js';
import { hash, stamp } from './credentials.js';
import { canonicalOperationJson, operationPreviewHash, readStoredOperation } from './operation-envelope.js';
import { operationEpochHash } from './operation-epoch.js';
import { verifyOperationAuthority } from './operation-authorization.js';
import { OPERATION_MUTATION_PAIRS, OPERATION_PREVIEW_RISKS, OPERATION_SCOPE_POLICIES } from './operation-policy.js';

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

// Adapters are server-owned code, never supplied by MCP arguments. Their
// preview/currentRevision use this facade to guard against accidental DML;
// it is not a sandbox for untrusted adapter code. apply must call the existing
// transaction-aware business service and record its domain history.
function readOnly(store) {
  const sql = (query) => {
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

// This experimental engine is intentionally not registered with the app.
// It requires explicit enablement and a server-constructed adapter map. It
// cannot be considered a release-ready write surface until a trusted preview
// UI, consent flow, migrations, actual business adapters and their tests exist.
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
    const commitTool = OPERATION_MUTATION_PAIRS[name], previewPolicy = OPERATION_SCOPE_POLICIES[name];
    const commitPolicy = OPERATION_SCOPE_POLICIES[commitTool];
    if (!commitTool || !previewPolicy || !commitPolicy || previewPolicy.scope !== commitPolicy.scope ||
        !adapter || typeof adapter !== 'object' || typeof adapter.resourceType !== 'string' ||
        typeof adapter.preview !== 'function' || typeof adapter.currentRevision !== 'function' ||
        typeof adapter.apply !== 'function' || typeof adapter.validResult !== 'function') {
      throw new TypeError('Invalid operation adapter.');
    }
    registered[name] = Object.freeze({ resourceType: adapter.resourceType, preview: adapter.preview,
      currentRevision: adapter.currentRevision, apply: adapter.apply, validResult: adapter.validResult, commitTool });
  }
  Object.freeze(registered);
  const read = readOnly(store);

  async function prepare(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 4 ||
        !['bearer', 'toolName', 'args', 'idempotencyKey'].every((key) => Object.hasOwn(input, key))) {
      fail(400, 'INVALID_INPUT', 'Invalid operation request.');
    }
    const { bearer, toolName, args, idempotencyKey } = input;
    const adapter = typeof toolName === 'string' && Object.hasOwn(registered, toolName) && registered[toolName];
    if (!adapter || !args || typeof args !== 'object' || Array.isArray(args) ||
        ['tenantId', 'shopId', 'accountId'].some((key) => Object.hasOwn(args, key)) ||
        typeof idempotencyKey !== 'string' || !keyPattern.test(idempotencyKey)) {
      fail(400, 'INVALID_INPUT', 'Invalid operation request.');
    }
    let requestHash, safeArgs;
    try {
      safeArgs = freezeJson(JSON.parse(canonicalOperationJson(args)));
      requestHash = hash(canonicalOperationJson({ toolName, args: safeArgs }));
    }
    catch { fail(400, 'INVALID_INPUT', 'Invalid operation request.'); }
    return withTenant((tenant) => store.transaction(async () => {
      const authority = await verifyOperationAuthority(store, { bearer, binding, toolName, epochHash });
      const idem = hash(idempotencyKey);
      const existing = await store.get(`SELECT * FROM mcp_v2_operation
        WHERE tenant_id = ? AND account_id = ? AND client_id = ? AND idempotency_hash = ?`,
      authority.tenantId, authority.accountId, authority.clientId, idem);
      if (existing) {
        if (existing.request_hash !== requestHash || existing.tool_name !== toolName) {
          fail(409, 'IDEMPOTENCY_CONFLICT', 'The operation key has another request.');
        }
        if (existing.grant_id !== authority.grantId || existing.tenant_revision !== tenant.revision ||
            existing.epoch_hash !== epochHash || existing.build_digest !== buildDigest ||
            !readStoredOperation(existing, binding)) denied();
        if (['PREPARED', 'PENDING_APPROVAL', 'APPROVED'].includes(existing.state) && existing.expires_at <= stamp()) {
          const expired = await store.get(`UPDATE mcp_v2_operation SET state = 'EXPIRED'
            WHERE id = ? AND state = ? RETURNING id`, existing.id, existing.state);
          if (!expired) denied();
          if (existing.state === 'APPROVED') {
            await store.run('UPDATE mcp_v2_approval SET consumed_at = ? WHERE operation_id = ? AND consumed_at IS NULL', stamp(), existing.id);
          }
          await event(store, existing, 'EXPIRE', 'EXPIRED');
          return publicState({ ...existing, state: 'EXPIRED' }, true);
        }
        return publicState(existing, true);
      }
      const active = "state IN ('PREPARED','PENDING_APPROVAL','APPROVED') AND expires_at > ?";
      const now = stamp();
      const tenantCount = await store.get(`SELECT COUNT(*) AS n FROM mcp_v2_operation WHERE tenant_id = ? AND ${active}`,
        authority.tenantId, now);
      const clientCount = await store.get(`SELECT COUNT(*) AS n FROM mcp_v2_operation WHERE tenant_id = ? AND client_id = ? AND ${active}`,
        authority.tenantId, authority.clientId, now);
      if (Number(tenantCount.n) >= maxPendingPerTenant || Number(clientCount.n) >= maxPendingPerClient) {
        fail(429, 'RATE_LIMITED', 'Too many pending operations.');
      }
      const draft = await adapter.preview(read, safeArgs);
      if (!draft || typeof draft !== 'object' || Array.isArray(draft) ||
          Object.keys(draft).sort().join(',') !== 'expectedRevision,proposal,resourceId') {
        throw new TypeError('Invalid server operation draft.');
      }
      const policy = OPERATION_SCOPE_POLICIES[toolName];
      const envelope = {
        version: 1, operationId: randomUUID(), tenantId: authority.tenantId, tenantRevision: tenant.revision, accountId: authority.accountId,
        clientId: authority.clientId, grantId: authority.grantId, epochHash, buildDigest, issuer: binding.issuer, resource: binding.resource,
        toolName, resourceType: adapter.resourceType, resourceId: draft.resourceId, expectedRevision: draft.expectedRevision,
        requiredScope: policy.scope, requiredCapability: policy.capability, risk: OPERATION_PREVIEW_RISKS[toolName],
        createdAt: now, expiresAt: stamp(ttl), idempotencyHash: idem, correlationId: randomUUID(), proposal: draft.proposal,
      };
      const previewHash = operationPreviewHash(envelope), serialized = canonicalOperationJson(envelope);
      await store.run(`INSERT INTO mcp_v2_operation(id, tenant_id, tenant_revision, account_id, client_id, grant_id, epoch_hash, build_digest, issuer, resource,
        tool_name, required_scope, required_capability, risk, resource_type, resource_id, expected_revision,
        envelope_json, preview_hash, request_hash, idempotency_hash, state, created_at, expires_at, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?, ?)`,
      envelope.operationId, envelope.tenantId, envelope.tenantRevision, envelope.accountId, envelope.clientId, envelope.grantId, epochHash, buildDigest,
      envelope.issuer, envelope.resource, toolName, policy.scope, policy.capability, envelope.risk,
      envelope.resourceType, envelope.resourceId, envelope.expectedRevision === null ? null : String(envelope.expectedRevision),
      serialized, previewHash, requestHash, idem, now, envelope.expiresAt, envelope.correlationId);
      const row = await store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', envelope.operationId);
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
        const authority = await verifyOperationAuthority(store, { bearer, binding, toolName, epochHash });
        const row = await store.get('SELECT * FROM mcp_v2_operation WHERE id = ?', operationId);
        const adapter = row && Object.hasOwn(registered, row.tool_name) && registered[row.tool_name];
        const stored = row && readStoredOperation(row, binding);
        const envelope = stored && freezeJson(stored);
        if (!row || !adapter || !envelope || row.tenant_revision !== tenant.revision ||
            row.epoch_hash !== epochHash || row.build_digest !== buildDigest ||
            adapter.commitTool !== toolName || row.grant_id !== authority.grantId ||
            row.account_id !== authority.accountId || row.client_id !== authority.clientId ||
            row.required_scope !== OPERATION_SCOPE_POLICIES[toolName].scope ||
            row.required_capability !== OPERATION_SCOPE_POLICIES[toolName].capability ||
            row.risk !== OPERATION_PREVIEW_RISKS[row.tool_name] || row.resource_type !== adapter.resourceType) denied();
        if (row.state === 'COMMITTED') {
          let result;
          try {
            result = JSON.parse(row.result_json);
            if (canonicalOperationJson(result) !== row.result_json || await adapter.validResult(result) !== true) denied();
          } catch { denied(); }
          return { operationId: row.id, status: 'COMMITTED', result, replayed: true };
        }
        const now = stamp();
        if (row.state !== 'APPROVED') denied();
        const approval = await store.get('SELECT * FROM mcp_v2_approval WHERE operation_id = ?', row.id);
        if (!approval || approval.decision !== 'APPROVED' || approval.consumed_at || approval.preview_hash !== row.preview_hash ||
            approval.approver_id !== row.account_id || typeof approval.approved_at !== 'string' ||
            typeof approval.expires_at !== 'string' || !instantPattern.test(approval.approved_at) ||
            !instantPattern.test(approval.expires_at) || Number.isNaN(Date.parse(approval.approved_at)) ||
            Number.isNaN(Date.parse(approval.expires_at)) ||
            new Date(approval.approved_at).toISOString() !== approval.approved_at ||
            new Date(approval.expires_at).toISOString() !== approval.expires_at || approval.approved_at < row.created_at ||
            approval.approved_at > now || approval.expires_at > row.expires_at ||
            Date.parse(approval.expires_at) - Date.parse(approval.approved_at) > 5 * 60 * 1000) denied();
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
        const current = await adapter.currentRevision(read, envelope);
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
        });
        if (!result || typeof result !== 'object' || Array.isArray(result) || await adapter.validResult(result) !== true) {
          throw new TypeError('Invalid operation result.');
        }
        // Long-running adapters cannot turn an expired token or approval into
        // a successful commit. An error here rolls all domain changes back.
        const finalAuthority = await verifyOperationAuthority(store, { bearer, binding, toolName, epochHash });
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
        const serialized = canonicalOperationJson(result);
        const changed = await store.get(`UPDATE mcp_v2_operation SET state = 'COMMITTED', result_json = ?
          WHERE id = ? AND state = 'APPROVED' RETURNING id`, serialized, row.id);
        if (!changed) throw new Error('Operation transition failed.');
        await event(store, row, 'COMMIT', 'COMMITTED', approval.approver_id);
        return { operationId: row.id, status: 'COMMITTED', result, replayed: false };
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
