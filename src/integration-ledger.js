import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './http.js';
import { messagingPolicy } from './integration-contracts.js';
import { isPreparedIntegrationRequest, isTrustedMessageRequest, assertTrustedMessagePermission } from './integration-requests.js';

const error = (code, message, status = 409) => { throw new ApiError(status, code, message); };
const missing = () => error('NOT_FOUND', 'Not found.', 404);
function text(value, maximum = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) error('INVALID_INPUT', 'Invalid bounded text.', 400);
  return value;
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) error('INVALID_INPUT', 'Unexpected fields.', 400);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const encode = value => JSON.stringify(canonical(value));
const hash = value => createHash('sha256').update(value).digest('hex');

// Explicit synthetic opt-in, separate tables, and no import from app/db startup.
// Authorization must be supplied by the future tenant adapter before binding a company.
export function createSyntheticIntegrationLedger(store, { mode, now = Date.now } = {}) {
  if (mode !== 'SYNTHETIC') error('SYNTHETIC_ONLY', 'Only an isolated synthetic ledger is supported.');
  store.transaction(() => store.exec(`
    CREATE TABLE IF NOT EXISTS integration_demo_company (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_connection (
      company_id TEXT NOT NULL REFERENCES integration_demo_company(id), id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('NINJA_VAN','SPX','WHATSAPP_CLOUD','WHATSAPP_QR')),
      environment TEXT NOT NULL CHECK(environment IN ('SYNTHETIC','SANDBOX','PRODUCTION')),
      account_id TEXT NOT NULL, secret_reference TEXT,
      status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK(status = 'NOT_CONFIGURED'),
      PRIMARY KEY(company_id,id), UNIQUE(provider,environment,account_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_intent (
      company_id TEXT NOT NULL, id TEXT NOT NULL, connection_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('SHIPMENT','MESSAGE')), snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
      PRIMARY KEY(company_id,id), FOREIGN KEY(company_id,connection_id) REFERENCES integration_demo_connection(company_id,id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_operation (
      company_id TEXT NOT NULL, id TEXT NOT NULL, connection_id TEXT NOT NULL, intent_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      PRIMARY KEY(company_id,id), UNIQUE(company_id,connection_id,idempotency_key),
      FOREIGN KEY(company_id,connection_id) REFERENCES integration_demo_connection(company_id,id),
      FOREIGN KEY(company_id,intent_id) REFERENCES integration_demo_intent(company_id,id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_outbox (
      company_id TEXT NOT NULL, id TEXT NOT NULL, operation_id TEXT NOT NULL, state TEXT NOT NULL
        CHECK(state IN ('PENDING','LEASED','RETRY','DONE','FAILED','RECONCILE')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3), lease_token TEXT, lease_until INTEGER,
      PRIMARY KEY(company_id,id), UNIQUE(company_id,operation_id),
      FOREIGN KEY(company_id,operation_id) REFERENCES integration_demo_operation(company_id,id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_reconciliation (
      company_id TEXT NOT NULL, outbox_id TEXT NOT NULL, result TEXT NOT NULL CHECK(result IN ('UNKNOWN','FOUND','ABSENT')),
      PRIMARY KEY(company_id,outbox_id), FOREIGN KEY(company_id,outbox_id) REFERENCES integration_demo_outbox(company_id,id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_provider_result (
      company_id TEXT NOT NULL, outbox_id TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
      PRIMARY KEY(company_id,outbox_id), FOREIGN KEY(company_id,outbox_id) REFERENCES integration_demo_outbox(company_id,id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_projection (
      company_id TEXT NOT NULL, connection_id TEXT NOT NULL, subject_id TEXT NOT NULL,
      sequence INTEGER NOT NULL, status TEXT NOT NULL,
      PRIMARY KEY(company_id,connection_id,subject_id), FOREIGN KEY(company_id,connection_id) REFERENCES integration_demo_connection(company_id,id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_inbox (
      company_id TEXT NOT NULL, connection_id TEXT NOT NULL, event_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      subject_id TEXT NOT NULL, sequence INTEGER NOT NULL, applied INTEGER NOT NULL CHECK(applied IN (0,1)),
      PRIMARY KEY(company_id,connection_id,event_id), FOREIGN KEY(company_id,connection_id) REFERENCES integration_demo_connection(company_id,id)
    ) STRICT;
  `));
  const clock = () => { const time = now(); if (!Number.isSafeInteger(time) || time < 0) error('INVALID_CLOCK', 'Invalid clock.'); return time; };
  return {
    addCompany(companyId) {
      text(companyId); if (!/^synthetic-[a-z0-9-]+$/.test(companyId)) error('SYNTHETIC_ONLY', 'Use a fictional company identifier.');
      store.run('INSERT INTO integration_demo_company(id) VALUES (?)', companyId);
    },
    forCompany(companyId) {
      text(companyId); if (!store.get('SELECT id FROM integration_demo_company WHERE id = ?', companyId)) missing();
      const connection = id => { text(id); const row = store.get('SELECT * FROM integration_demo_connection WHERE company_id = ? AND id = ?', companyId, id); if (!row) missing(); return row; };
      const synthetic = row => { if (row.environment !== 'SYNTHETIC') error('NOT_CONFIGURED', 'Provider is not configured.'); if (['SPX','WHATSAPP_QR'].includes(row.provider)) error('CONTRACT_REQUIRED', 'Provider contract or risk review is required.'); };
      function validateProviderRequest(connectionId, prepared) {
        if (!isPreparedIntegrationRequest(prepared)) error('INVALID_INPUT', 'Use a validated provider descriptor.', 400);
        const bound = connection(connectionId), binding = prepared.binding;
        if (binding.companyId !== companyId || binding.connectionId !== connectionId || binding.accountId !== bound.account_id ||
            binding.provider !== bound.provider || binding.environment !== bound.environment) missing();
        synthetic(bound);
      }
      const outbox = id => { text(id); const row = store.get('SELECT * FROM integration_demo_outbox WHERE company_id = ? AND id = ?', companyId, id); if (!row) missing(); return row; };
      function reconcile(row) {
        store.run("UPDATE integration_demo_outbox SET state = 'RECONCILE', lease_token = NULL, lease_until = NULL WHERE company_id = ? AND id = ?", companyId, row.id);
        store.run("INSERT INTO integration_demo_reconciliation(company_id,outbox_id,result) VALUES (?,?,'UNKNOWN') ON CONFLICT(company_id,outbox_id) DO UPDATE SET result = 'UNKNOWN'", companyId, row.id);
      }
      function enqueue(connectionId, key, kind, input, validateNew = () => {}) {
        const bound = connection(connectionId); synthetic(bound); text(key, 128);
        if (kind === 'SHIPMENT' && bound.provider !== 'NINJA_VAN' || kind === 'MESSAGE' && bound.provider !== 'WHATSAPP_CLOUD') error('CAPABILITY_DISABLED', 'Capability is unavailable.');
        const serialized = encode(input), requestHash = hash(encode({ kind, input }));
        return store.transaction(() => {
          const existing = store.get('SELECT * FROM integration_demo_operation WHERE company_id = ? AND connection_id = ? AND idempotency_key = ?', companyId, connectionId, key);
          if (existing) { if (existing.request_hash !== requestHash) error('IDEMPOTENCY_CONFLICT', 'The key was used for a different request.'); return { operationId: existing.id, outboxId: existing.id, replayed: true }; }
          // A replay recovers a stored fact; only a new intent needs current-time permission.
          validateNew();
          const id = randomUUID();
          store.run('INSERT INTO integration_demo_intent(company_id,id,connection_id,kind,snapshot_json) VALUES (?,?,?,?,?)', companyId, id, connectionId, kind, serialized);
          store.run('INSERT INTO integration_demo_operation(company_id,id,connection_id,intent_id,idempotency_key,request_hash) VALUES (?,?,?,?,?,?)', companyId, id, connectionId, id, key, requestHash);
          store.run("INSERT INTO integration_demo_outbox(company_id,id,operation_id,state) VALUES (?,?,?,'PENDING')", companyId, id, id);
          return { operationId: id, outboxId: id, replayed: false };
        });
      }
      return {
        addConnection(input) {
          fields(input, ['id','provider','environment','accountId','secretReference']);
          text(input.id); text(input.accountId);
          if (!['NINJA_VAN','SPX','WHATSAPP_CLOUD','WHATSAPP_QR'].includes(input.provider) || !['SYNTHETIC','SANDBOX','PRODUCTION'].includes(input.environment)) error('INVALID_INPUT', 'Invalid provider or environment.', 400);
          if (input.environment === 'SYNTHETIC' && !input.accountId.startsWith('synthetic-')) error('SYNTHETIC_ONLY', 'Use a fictional account identifier.');
          const prefix = `secret-ref://${companyId}/${input.provider}/${input.environment}/`;
          if (input.secretReference != null && (typeof input.secretReference !== 'string' || !input.secretReference.startsWith(prefix) || !/^[a-z0-9-]{1,80}$/.test(input.secretReference.slice(prefix.length)))) error('INVALID_INPUT', 'Only a company-bound secret reference is permitted.', 400);
          store.run('INSERT INTO integration_demo_connection(company_id,id,provider,environment,account_id,secret_reference) VALUES (?,?,?,?,?,?)', companyId, input.id, input.provider, input.environment, input.accountId, input.secretReference ?? null);
          return { id: input.id, status: 'NOT_CONFIGURED', dispatchEnabled: false };
        },
        createShipment(connectionId, key, input) {
          fields(input, ['orderRef','addressSnapshot','weightGrams']); text(input.orderRef);
          fields(input.addressSnapshot, ['name','line1','city','region','postcode','country']);
          for (const key of ['name','line1','city','region','postcode']) text(input.addressSnapshot[key]);
          if (!['MY','SG'].includes(input.addressSnapshot.country) || !Number.isSafeInteger(input.weightGrams) || input.weightGrams < 1 || input.weightGrams > 30000) error('INVALID_INPUT', 'Invalid parcel.', 400);
          return enqueue(connectionId, key, 'SHIPMENT', input);
        },
        createMessage(connectionId, key, input) {
          error('TRUSTED_CONSENT_REQUIRED', 'Caller flags cannot authorize a message.');
        },
        queueProviderRequest(connectionId, key, prepared) {
          validateProviderRequest(connectionId, prepared);
          if (prepared.kind === 'MESSAGE' && !isTrustedMessageRequest(prepared)) error('TRUSTED_CONSENT_REQUIRED', 'Use a server-owned consent proof.');
          return enqueue(connectionId, key, prepared.kind, prepared, () => {
            if (prepared.kind === 'MESSAGE') messagingPolicy(assertTrustedMessagePermission(prepared).policy, clock());
          });
        },
        validateProviderRequest,
        getOperation(id) {
          text(id); const row = store.get('SELECT * FROM integration_demo_operation WHERE company_id = ? AND id = ?', companyId, id); if (!row) missing();
          const intent = store.get('SELECT kind,snapshot_json FROM integration_demo_intent WHERE company_id = ? AND id = ?', companyId, row.intent_id);
          const result = store.get('SELECT result_json FROM integration_demo_provider_result WHERE company_id = ? AND outbox_id = ?', companyId, row.id);
          return { id: row.id, connectionId: row.connection_id, kind: intent.kind, intent: JSON.parse(intent.snapshot_json), state: outbox(row.id).state,
            providerResult: result ? JSON.parse(result.result_json) : null };
        },
        beginAttempt(id) {
          return store.transaction(() => {
            const row = outbox(id), time = clock();
            if (row.state === 'LEASED' && row.lease_until <= time) { reconcile(row); return { state: 'RECONCILE' }; }
            if (!['PENDING','RETRY'].includes(row.state)) error('INVALID_STATE', 'This operation cannot be attempted.');
            if (row.attempts >= 3) error('RETRY_EXHAUSTED', 'Retry limit reached.');
            const token = randomUUID();
            store.run("UPDATE integration_demo_outbox SET state = 'LEASED', attempts = attempts + 1, lease_token = ?, lease_until = ? WHERE company_id = ? AND id = ?", token, time + 30000, companyId, id);
            return { state: 'LEASED', leaseToken: token };
          });
        },
        finishAttempt(id, leaseToken, outcome, result) {
          text(leaseToken); if (!['ACKNOWLEDGED','SAFE_RETRY','UNKNOWN','REJECTED'].includes(outcome)) error('INVALID_INPUT', 'Invalid outcome.', 400);
          if (result !== undefined) {
            fields(result, ['outcome','category','providerId','errorCode','httpStatus']);
            if (result.outcome !== outcome || !['ACCEPTED','UNVERIFIED_RESPONSE','INVALID_REQUEST','CONFIGURATION_REQUIRED','RATE_LIMIT_RECONCILE','PROVIDER_RECONCILE','NETWORK_UNKNOWN','POLICY_BLOCKED'].includes(result.category)) error('INVALID_INPUT', 'Invalid provider result.', 400);
            if (result.providerId !== undefined) text(result.providerId, 160);
            if (result.errorCode !== undefined && (typeof result.errorCode !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(result.errorCode))) error('INVALID_INPUT', 'Invalid provider result.', 400);
            if (result.httpStatus !== undefined && (!Number.isInteger(result.httpStatus) || result.httpStatus < 100 || result.httpStatus > 599)) error('INVALID_INPUT', 'Invalid provider result.', 400);
          }
          return store.transaction(() => {
            const row = outbox(id);
            if (row.state !== 'LEASED' || row.lease_token !== leaseToken) error('STALE_ATTEMPT', 'The lease is no longer current.');
            // An expired lease cannot persist a late provider response as an accepted fact.
            if (row.lease_until <= clock()) { reconcile(row); return { state: 'RECONCILE' }; }
            if (result !== undefined) store.run('INSERT INTO integration_demo_provider_result(company_id,outbox_id,result_json) VALUES (?,?,?) ON CONFLICT(company_id,outbox_id) DO UPDATE SET result_json = excluded.result_json', companyId, id, encode(result));
            if (outcome === 'UNKNOWN') { reconcile(row); return { state: 'RECONCILE' }; }
            const state = outcome === 'ACKNOWLEDGED' ? 'DONE' : outcome === 'REJECTED' || row.attempts >= 3 ? 'FAILED' : 'RETRY';
            store.run('UPDATE integration_demo_outbox SET state = ?, lease_token = NULL, lease_until = NULL WHERE company_id = ? AND id = ?', state, companyId, id);
            return { state };
          });
        },
        recordReconciliation(id, result) {
          if (!['FOUND','ABSENT'].includes(result)) error('INVALID_INPUT', 'An explicit reconciliation result is required.', 400);
          const row = outbox(id); if (row.state !== 'RECONCILE') error('INVALID_STATE', 'Reconciliation is not pending.');
          error('PROVIDER_LOOKUP_REQUIRED', 'No verified provider lookup evidence is implemented; the result remains UNKNOWN.');
        },
        receiveSyntheticEvent(connectionId, input) {
          const bound = connection(connectionId); synthetic(bound);
          fields(input, ['accountId','eventId','subjectId','sequence','status']);
          for (const key of ['accountId','eventId','subjectId','status']) text(input[key]);
          if (input.accountId !== bound.account_id) missing();
          if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) error('INVALID_INPUT', 'Invalid synthetic event sequence.', 400);
          const digest = hash(encode(input));
          return store.transaction(() => {
            const existing = store.get('SELECT * FROM integration_demo_inbox WHERE company_id = ? AND connection_id = ? AND event_id = ?', companyId, connectionId, input.eventId);
            if (existing) { if (existing.request_hash !== digest) error('EVENT_CONFLICT', 'The event identifier has different content.'); return { duplicate: true, applied: Boolean(existing.applied) }; }
            const current = store.get('SELECT * FROM integration_demo_projection WHERE company_id = ? AND connection_id = ? AND subject_id = ?', companyId, connectionId, input.subjectId);
            const applied = !current || input.sequence > current.sequence;
            store.run('INSERT INTO integration_demo_inbox(company_id,connection_id,event_id,request_hash,subject_id,sequence,applied) VALUES (?,?,?,?,?,?,?)', companyId, connectionId, input.eventId, digest, input.subjectId, input.sequence, Number(applied));
            if (applied) store.run('INSERT INTO integration_demo_projection(company_id,connection_id,subject_id,sequence,status) VALUES (?,?,?,?,?) ON CONFLICT(company_id,connection_id,subject_id) DO UPDATE SET sequence = excluded.sequence, status = excluded.status', companyId, connectionId, input.subjectId, input.sequence, input.status);
            return { duplicate: false, applied };
          });
        },
        getProjection(connectionId, subjectId) {
          connection(connectionId); text(subjectId);
          const row = store.get('SELECT sequence,status FROM integration_demo_projection WHERE company_id = ? AND connection_id = ? AND subject_id = ?', companyId, connectionId, subjectId); if (!row) missing(); return row;
        },
      };
    },
  };
}
