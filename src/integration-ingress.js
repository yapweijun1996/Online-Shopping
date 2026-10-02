import { createHash } from 'node:crypto';
import { ApiError } from './http.js';
import { verifyMetaSignature } from './integration-contracts.js';
import { authorityUsesStore } from './integration-consent.js';

const fail = (code, message, status = 400) => { throw new ApiError(status, code, message); };
const digest = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const encode = value => JSON.stringify(canonical(value));
function string(value, pattern, max = 160) {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) fail('INVALID_PAYLOAD', 'Invalid bounded webhook payload.');
  return value;
}
const messageId = value => string(value, /^wamid\.[A-Za-z0-9+/=_-]+$/);
const phone = value => { string(value, /^\+?[1-9]\d{7,14}$/, 16); return value.startsWith('+') ? value : `+${value}`; };
function timestamp(value) {
  string(value, /^(0|[1-9]\d{0,12})$/, 13); const time = Number(value) * 1000;
  if (!Number.isSafeInteger(time)) fail('INVALID_PAYLOAD', 'Invalid webhook timestamp.'); return time;
}
function array(value) { if (!Array.isArray(value) || !value.length || value.length > 1000) fail('INVALID_PAYLOAD', 'Invalid webhook batch.'); return value; }

// Offline only: the result is an ACK descriptor, never an attached public route.
export function createOfflineMetaIngress({ store, authority, mode, appId, appSecret, now = Date.now }) {
  if (mode !== 'SYNTHETIC' || !authorityUsesStore(authority, store) || !/^synthetic-[a-z0-9-]+$/.test(appId || '') ||
      typeof appSecret !== 'string' || !/^synthetic-[A-Za-z0-9_-]{8,120}$/.test(appSecret)) fail('SYNTHETIC_ONLY', 'Use an isolated Store and clearly fictional app/key.', 409);
  store.transaction(() => store.exec(`
    CREATE TABLE IF NOT EXISTS integration_demo_webhook_receipt (
      app_id TEXT NOT NULL, digest TEXT NOT NULL, received_at INTEGER NOT NULL, event_count INTEGER NOT NULL,
      PRIMARY KEY(app_id,digest)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_signed_inbox (
      company_id TEXT NOT NULL, connection_id TEXT NOT NULL, event_key TEXT NOT NULL, app_id TEXT NOT NULL,
      digest TEXT NOT NULL, event_json TEXT NOT NULL CHECK(json_valid(event_json)), disposition TEXT NOT NULL
        CHECK(disposition IN ('APPLIED','STALE','WAITING_SUBJECT','QUARANTINED')),
      PRIMARY KEY(company_id,connection_id,event_key),
      FOREIGN KEY(company_id,connection_id) REFERENCES integration_demo_phone_binding(company_id,connection_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS integration_demo_message_projection (
      company_id TEXT NOT NULL, connection_id TEXT NOT NULL, subject_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('SENT','DELIVERED','READ','FAILED')),
      PRIMARY KEY(company_id,connection_id,subject_id),
      FOREIGN KEY(company_id,connection_id) REFERENCES integration_demo_phone_binding(company_id,connection_id)
    ) STRICT;
  `));
  const clock = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_CLOCK', 'Invalid clock.', 409); return value; };
  function parse(rawBody) {
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); }
    catch { fail('INVALID_PAYLOAD', 'Invalid UTF-8 JSON.'); }
    if (payload?.object !== 'whatsapp_business_account') fail('INVALID_PAYLOAD', 'Unsupported webhook object.');
    const events = [];
    for (const entry of array(payload.entry)) {
      const wabaId = string(entry?.id, /^\d{5,20}$/, 20);
      for (const change of array(entry.changes)) {
        const value = change?.value;
        if (change.field !== 'messages' || value?.messaging_product !== 'whatsapp') fail('INVALID_PAYLOAD', 'Unsupported webhook field.');
        const phoneId = string(value.metadata?.phone_number_id, /^\d{5,20}$/, 20);
        const binding = authority.resolvePhone(appId, wabaId, phoneId);
        const base = { binding, wabaId, phoneId };
        if (!value.messages && !value.statuses) {
          // The provider supplied no event time; receipt time must not change retry identity.
          events.push({ ...base, kind: 'UNSUPPORTED', subjectId: digest(encode(value)), status: 'UNKNOWN', occurredAt: null });
        }
        if (value.messages !== undefined) for (const message of array(value.messages)) {
          const subjectId = messageId(message?.id), recipient = phone(message.from), occurredAt = timestamp(message.timestamp);
          const supported = message.type === 'text' && typeof message.text?.body === 'string' && message.text.body.length <= 65536;
          events.push({ ...base, kind: 'INBOUND', subjectId, recipient, occurredAt, status: supported ? 'TEXT' : 'UNKNOWN',
            contentHash: digest(supported ? message.text.body : encode(message)) });
        }
        if (value.statuses !== undefined) for (const status of array(value.statuses)) {
          const subjectId = messageId(status?.id), occurredAt = timestamp(status.timestamp);
          string(status.status, /^[a-z_]{1,80}$/, 80);
          string(status.recipient_id, status.recipient_type === 'group' ? /^[A-Za-z0-9+/=_-]+$/ : /^\d{8,20}$/, status.recipient_type === 'group' ? 160 : 20);
          const normalized = Object.hasOwn({ sent: 1, delivered: 1, read: 1, failed: 1 }, status.status) && status.recipient_type !== 'group' ? status.status.toUpperCase() : 'UNKNOWN';
          events.push({ ...base, kind: 'STATUS', subjectId, occurredAt, status: normalized, providerStatus: status.status, recipientId: status.recipient_id });
        }
        if (events.length > 1000) fail('INVALID_PAYLOAD', 'The local batch limit is 1000 events.');
      }
    }
    return events;
  }
  function apply(event, time) {
    const { companyId, connectionId } = event.binding;
    if (event.occurredAt > time || event.status === 'UNKNOWN' || event.kind === 'UNSUPPORTED') return 'QUARANTINED';
    if (event.kind === 'INBOUND') {
      const existing = store.get('SELECT occurred_at FROM integration_demo_inbound_clock WHERE company_id=? AND connection_id=? AND recipient=?', companyId, connectionId, event.recipient);
      if (existing && existing.occurred_at >= event.occurredAt) return 'STALE';
      store.run('INSERT INTO integration_demo_inbound_clock(company_id,connection_id,recipient,occurred_at) VALUES (?,?,?,?) ON CONFLICT(company_id,connection_id,recipient) DO UPDATE SET occurred_at=excluded.occurred_at', companyId, connectionId, event.recipient, event.occurredAt);
      return 'APPLIED';
    }
    const operations = store.all(`SELECT o.id,json_extract(i.snapshot_json,'$.input.recipient') recipient,
      json_extract(i.snapshot_json,'$.input.phoneNumberId') phone_id FROM integration_demo_operation o JOIN integration_demo_intent i
      ON i.company_id=o.company_id AND i.id=o.intent_id JOIN integration_demo_provider_result r ON r.company_id=o.company_id AND r.outbox_id=o.id
      WHERE o.company_id=? AND o.connection_id=? AND i.kind='MESSAGE' AND json_extract(r.result_json,'$.providerId')=? AND json_extract(r.result_json,'$.category')='ACCEPTED'`,
    companyId, connectionId, event.subjectId);
    if (!operations.length) return 'WAITING_SUBJECT';
    if (operations.length !== 1) return 'QUARANTINED';
    if (`+${event.recipientId}` !== operations[0].recipient || event.phoneId !== operations[0].phone_id) return 'QUARANTINED';
    const current = store.get('SELECT * FROM integration_demo_message_projection WHERE company_id=? AND connection_id=? AND subject_id=?', companyId, connectionId, event.subjectId);
    const rank = { SENT: 1, DELIVERED: 2, READ: 3 };
    if (current) {
      // Sent is not delivered: a later failure may report a delivery failure.
      if ((current.status === 'FAILED') !== (event.status === 'FAILED') &&
          !(current.status === 'SENT' && event.status === 'FAILED' && event.occurredAt > current.occurred_at)) return 'QUARANTINED';
      if (event.occurredAt < current.occurred_at || event.status !== 'FAILED' && rank[event.status] < rank[current.status] ||
          event.occurredAt === current.occurred_at && event.status === current.status) return 'STALE';
    }
    store.run('INSERT INTO integration_demo_message_projection(company_id,connection_id,subject_id,occurred_at,status) VALUES (?,?,?,?,?) ON CONFLICT(company_id,connection_id,subject_id) DO UPDATE SET occurred_at=excluded.occurred_at,status=excluded.status', companyId, connectionId, event.subjectId, event.occurredAt, event.status);
    return 'APPLIED';
  }
  return Object.freeze({
    receive({ rawBody, signature }) {
      if (!(rawBody instanceof Uint8Array) || rawBody.byteLength > 1024 * 1024) fail('PAYLOAD_TOO_LARGE', 'Use a raw body up to 1 MiB.', 413);
      // Authenticate and persist the same snapshot even if the caller shares mutable bytes.
      const raw = Uint8Array.from(rawBody);
      if (!verifyMetaSignature(raw, signature, appSecret)) fail('INVALID_SIGNATURE', 'Invalid webhook signature.', 401);
      const time = clock(), events = parse(raw), rawDigest = digest(raw);
      const result = store.transaction(() => {
        let duplicates = 0, quarantined = 0;
        for (const event of events) {
          if (encode(authority.resolvePhone(appId, event.wabaId, event.phoneId)) !== encode(event.binding)) fail('NOT_FOUND', 'Not found.', 404);
          const { companyId, connectionId } = event.binding;
          const eventKey = digest(encode([event.kind, event.subjectId, event.kind === 'STATUS' ? event.providerStatus : '', event.kind === 'STATUS' ? event.occurredAt : 0]));
          const serialized = encode(event), eventDigest = digest(serialized);
          const existing = store.get('SELECT digest FROM integration_demo_signed_inbox WHERE company_id=? AND connection_id=? AND event_key=?', companyId, connectionId, eventKey);
          if (existing) { if (existing.digest !== eventDigest) fail('EVENT_CONFLICT', 'The event identity has conflicting content.', 409); duplicates++; continue; }
          const disposition = apply(event, time); if (disposition === 'QUARANTINED') quarantined++;
          store.run('INSERT INTO integration_demo_signed_inbox(company_id,connection_id,event_key,app_id,digest,event_json,disposition) VALUES (?,?,?,?,?,?,?)', companyId, connectionId, eventKey, appId, eventDigest, serialized, disposition);
        }
        store.run('INSERT INTO integration_demo_webhook_receipt(app_id,digest,received_at,event_count) VALUES (?,?,?,?) ON CONFLICT(app_id,digest) DO NOTHING', appId, rawDigest, time, events.length);
        return { received: events.length, duplicates, quarantined };
      });
      // Store.transaction must commit synchronously before returning; a throw produces no ACK.
      return { httpStatus: 200, receiptDigest: rawDigest, ...result };
    },
    reprocessWaiting() {
      return store.transaction(() => {
        let applied = 0;
        for (const row of store.all("SELECT * FROM integration_demo_signed_inbox WHERE app_id=? AND disposition='WAITING_SUBJECT'", appId)) {
          const event = JSON.parse(row.event_json), binding = authority.resolvePhone(appId, event.wabaId, event.phoneId);
          if (encode(binding) !== encode(event.binding)) fail('NOT_FOUND', 'Not found.', 404);
          const disposition = apply(event, clock());
          store.run('UPDATE integration_demo_signed_inbox SET disposition=? WHERE company_id=? AND connection_id=? AND event_key=?', disposition, row.company_id, row.connection_id, row.event_key);
          if (disposition === 'APPLIED') applied++;
        }
        return { applied };
      });
    },
  });
}
