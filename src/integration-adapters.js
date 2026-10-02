import { ApiError } from './http.js';
import { messagingPolicy } from './integration-contracts.js';
import { isPreparedIntegrationRequest, restoreIntegrationRequest, normalizeProviderResponse } from './integration-requests.js';

const fixtures = new WeakSet();
const fail = (code, message, status = 409) => { throw new ApiError(status, code, message); };
function fixtureData(value, depth = 0, budget = { nodes: 0 }) {
  if (depth > 12 || ++budget.nodes > 2000) fail('INVALID_INPUT', 'Fixture data is too complex.', 400);
  if (value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 64 * 1024 || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_INPUT', 'Use plain JSON fixture data.', 400);
  const array = Array.isArray(value), result = array ? [] : {};
  if (array && value.length > 2000) fail('INVALID_INPUT', 'Fixture array is too large.', 400);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
        array && !/^(0|[1-9]\d*)$/.test(key)) fail('INVALID_INPUT', 'Use plain JSON fixture data.', 400);
    Object.defineProperty(result, key, { value: fixtureData(descriptor.value, depth + 1, budget), enumerable: true, writable: true, configurable: true });
  }
  if (array && (result.length !== value.length || Object.keys(result).length !== value.length)) fail('INVALID_INPUT', 'Use dense JSON arrays.', 400);
  return result;
}

// Data-only injection deliberately excludes fetch, callbacks, credentials and live activation.
export function createFixtureIntegrationTransport(responses) {
  if (!Array.isArray(responses) || responses.length > 100) fail('INVALID_INPUT', 'Invalid fixture responses.', 400);
  const values = fixtureData(responses).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['status','body','networkFailure'].includes(key))) fail('INVALID_INPUT', 'Invalid fixture response.', 400);
    if (value.networkFailure !== undefined) {
      if (!['TIMEOUT','DISCONNECTED'].includes(value.networkFailure) || Object.hasOwn(value, 'status') || Object.hasOwn(value, 'body')) fail('INVALID_INPUT', 'Invalid fixture failure.', 400);
    } else if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599 || !Object.hasOwn(value, 'body')) fail('INVALID_INPUT', 'Invalid fixture response.', 400);
    const serialized = JSON.stringify(value);
    if (serialized.length > 64 * 1024) fail('INVALID_INPUT', 'Fixture response is too large.', 400);
    return JSON.parse(serialized);
  });
  const requests = [];
  const transport = Object.freeze({
    send(prepared) {
      if (!isPreparedIntegrationRequest(prepared)) fail('INVALID_INPUT', 'Use a validated synthetic request.', 400);
      if (!values.length) throw new Error('Synthetic response unavailable.');
      requests.push(structuredClone(prepared.request));
      const value = values.shift();
      if (value.networkFailure) throw new Error('Synthetic network uncertainty.');
      return structuredClone(value);
    },
    requests: () => structuredClone(requests),
  });
  fixtures.add(transport); return transport;
}

export function createSyntheticProviderAdapter({ ledger, companyId, connectionId, transport, now = Date.now }) {
  if (transport !== undefined && !fixtures.has(transport)) fail('SYNTHETIC_ONLY', 'Only the data-only fixture transport is supported.');
  const scope = ledger.forCompany(companyId);
  return Object.freeze({
    async execute(operationId) {
      if (!transport) fail('NOT_CONFIGURED', 'Provider transport is not configured.');
      const operation = scope.getOperation(operationId);
      if (operation.connectionId !== connectionId || operation.intent.binding?.companyId !== companyId ||
          operation.intent.binding?.connectionId !== connectionId) fail('NOT_FOUND', 'Not found.', 404);
      if (operation.state === 'DONE' || operation.state === 'FAILED') return { state: operation.state, result: operation.providerResult, replayed: true };
      const prepared = restoreIntegrationRequest(operation.intent);
      scope.validateProviderRequest(connectionId, prepared);
      if (prepared.kind !== operation.kind) fail('INVALID_INPUT', 'Operation kind does not match.', 400);
      if (prepared.policy) {
        const time = now();
        if (!Number.isSafeInteger(time) || time < 0) fail('INVALID_CLOCK', 'Invalid clock.');
        messagingPolicy(prepared.policy, time);
      }
      const lease = scope.beginAttempt(operationId);
      if (lease.state !== 'LEASED') return { state: lease.state, result: null, replayed: false };
      let result;
      try { result = normalizeProviderResponse(prepared.binding.provider, await transport.send(prepared)); }
      catch { result = { outcome: 'UNKNOWN', category: 'NETWORK_UNKNOWN' }; }
      const completed = scope.finishAttempt(operationId, lease.leaseToken, result.outcome, result);
      return { state: completed.state, result: completed.state === 'RECONCILE' ? scope.getOperation(operationId).providerResult : result, replayed: false };
    },
  });
}
