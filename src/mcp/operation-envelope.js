import { createHash, timingSafeEqual } from 'node:crypto';

// This module is deliberately not registered as an MCP tool or HTTP route. A
// digest is only an integrity check: it does not grant or represent approval.
const MAX_DEPTH = 16;
const MAX_NODES = 4096;
const MAX_BYTES = 64 * 1024;
const digestPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identifierPattern = /^[a-z][a-z0-9_.-]{0,127}$/;
const fields = [
  'version', 'operationId', 'tenantId', 'tenantRevision', 'accountId', 'clientId', 'grantId', 'epochHash', 'buildDigest',
  'issuer', 'resource', 'toolName', 'resourceType', 'resourceId', 'expectedRevision',
  'requiredScope', 'requiredCapability', 'risk', 'createdAt', 'expiresAt',
  'idempotencyHash', 'correlationId', 'proposal',
];

// Only bounded, well-formed JSON values are accepted. Rejecting accessors,
// holes, exotic prototypes and ambiguous Unicode avoids hashing one value while
// a later serializer displays or commits a different one.
export function canonicalOperationJson(value) {
  let nodes = 0;
  let textBytes = 0;
  const ancestors = new Set();
  const charge = (value) => {
    textBytes += Buffer.byteLength(value, 'utf8');
    if (textBytes > MAX_BYTES) throw new TypeError('Operation proposal is too large.');
  };
  function visit(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new TypeError('Operation proposal is too complex.');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (!item.isWellFormed()) throw new TypeError('Invalid operation text.');
      charge(item);
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw new TypeError('Operation numbers must be safe integers.');
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item !== 'object' || ancestors.has(item)) throw new TypeError('Invalid operation value.');
    const array = Array.isArray(item);
    if (array && item.length > MAX_NODES) throw new TypeError('Operation proposal is too complex.');
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError('Invalid operation object.');
    }
    ancestors.add(item);
    try {
      const keys = Reflect.ownKeys(item);
      if (keys.length > MAX_NODES + (array ? 1 : 0)) throw new TypeError('Operation proposal is too complex.');
      if (keys.some((key) => typeof key !== 'string')) throw new TypeError('Invalid operation key.');
      if (array) {
        if (keys.length !== item.length + 1 || !keys.includes('length')) throw new TypeError('Invalid operation array.');
        const out = [];
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid operation array.');
          out.push(visit(descriptor.value, depth + 1));
        }
        return out;
      }
      const out = Object.create(null);
      for (const key of keys.sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!key.isWellFormed() || ['__proto__', 'prototype', 'constructor'].includes(key) ||
            !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid operation key.');
        charge(key);
        out[key] = visit(descriptor.value, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(item);
    }
  }
  const json = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) throw new TypeError('Operation proposal is too large.');
  return json;
}

const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed();
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const instant = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

// Every field affecting authorization, identity, review, or commit is included
// in the digest. The caller must construct these values from trusted server
// context and store the canonical envelope; never trust model-supplied binding.
export function operationPreviewHash(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new TypeError('Invalid operation envelope.');
  // Do not read untrusted properties before checking for accessors.
  const canonical = canonicalOperationJson(envelope);
  const value = JSON.parse(canonical);
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field)) ||
      value.version !== 1 || !matches(value.operationId, uuidPattern) || !matches(value.accountId, uuidPattern) ||
      !matches(value.grantId, uuidPattern) || !matches(value.correlationId, uuidPattern) ||
      !matches(value.epochHash, digestPattern) || !matches(value.buildDigest, digestPattern) ||
      !Number.isSafeInteger(value.tenantRevision) || value.tenantRevision < 0 ||
      !text(value.tenantId, 100) || !text(value.clientId, 128) ||
      !text(value.issuer, 2048) || !text(value.resource, 2048) ||
      !matches(value.toolName, identifierPattern) || !matches(value.resourceType, identifierPattern) ||
      !(value.resourceId === null || text(value.resourceId, 128)) ||
      !(value.expectedRevision === null || text(value.expectedRevision, 128) || (Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0)) ||
      !matches(value.requiredScope, identifierPattern) || !matches(value.requiredCapability, identifierPattern) ||
      !['LOW', 'MEDIUM', 'HIGH'].includes(value.risk) || !instant(value.createdAt) || !instant(value.expiresAt) ||
      value.expiresAt <= value.createdAt || !matches(value.idempotencyHash, digestPattern) ||
      !value.proposal || typeof value.proposal !== 'object' || Array.isArray(value.proposal)) {
    throw new TypeError('Invalid operation envelope.');
  }
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function matchesOperationPreview(envelope, expectedHash) {
  if (typeof expectedHash !== 'string' || !digestPattern.test(expectedHash)) return false;
  try {
    return timingSafeEqual(Buffer.from(operationPreviewHash(envelope), 'hex'), Buffer.from(expectedHash, 'hex'));
  } catch {
    return false;
  }
}

// Validate every duplicated database binding against the canonical envelope.
// This is integrity validation only; callers must separately authorize the
// token, tenant, seller approval, resource ownership, policy and revision.
export function readStoredOperation(row, binding) {
  if (!row || !binding) return null;
  let value;
  try {
    value = JSON.parse(row.envelope_json);
    if (canonicalOperationJson(value) !== row.envelope_json || !matchesOperationPreview(value, row.preview_hash)) return null;
  } catch { return null; }
  const equal = [
    ['operationId', 'id'], ['tenantId', 'tenant_id'], ['tenantRevision', 'tenant_revision'],
    ['accountId', 'account_id'], ['clientId', 'client_id'],
    ['grantId', 'grant_id'], ['epochHash', 'epoch_hash'], ['buildDigest', 'build_digest'],
    ['issuer', 'issuer'], ['resource', 'resource'], ['toolName', 'tool_name'],
    ['requiredScope', 'required_scope'], ['requiredCapability', 'required_capability'], ['risk', 'risk'],
    ['resourceType', 'resource_type'], ['resourceId', 'resource_id'], ['createdAt', 'created_at'],
    ['expiresAt', 'expires_at'], ['idempotencyHash', 'idempotency_hash'], ['correlationId', 'correlation_id'],
  ].every(([key, column]) => value[key] === row[column]);
  if (!equal || value.tenantId !== binding.tenantId || value.issuer !== binding.issuer || value.resource !== binding.resource ||
      (value.expectedRevision === null ? row.expected_revision !== null : String(value.expectedRevision) !== row.expected_revision)) return null;
  return value;
}
