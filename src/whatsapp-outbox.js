// Sends WhatsApp template messages for order events through the seller's connected account.
// Flow: order_event rows are turned into message_outbox rows (enqueue), then each row is claimed with one atomic
// UPDATE, sent outside any database transaction, and its outcome recorded (send). An outcome that is not definitely
// "accepted" or "rejected" becomes RECONCILE and is never retried automatically, so a message cannot be sent twice.
import { createHash, randomUUID } from 'node:crypto';
import { getShopSetup } from './shop-setup.js';
import { normalizeProviderResponse } from './integration-requests.js';
import { openWhatsAppSecrets } from './integration-connections.js';
import { senderHash } from './whatsapp-webhook.js';

const provider = 'WHATSAPP_CLOUD';
// Template contract (owner creates these in Meta with exactly these names and variables; see the plan, section 5).
export const TEMPLATES = {
  ORDER_SUBMITTED: { name: 'order_submitted', event: 'SUBMITTED' },
  ORDER_CONFIRMED: { name: 'order_confirmed', event: 'CONFIRMED' },
  ORDER_REJECTED: { name: 'order_rejected', event: 'REJECTED' },
  ORDER_SHIPPED: { name: 'order_shipped', event: 'SHIPPED' },
};
const KIND_BY_EVENT = Object.fromEntries(Object.entries(TEMPLATES).map(([kind, value]) => [value.event, kind]));
export const LANGUAGES = { en: 'en', ms: 'ms', 'zh-Hans': 'zh_CN', vi: 'vi', th: 'th', ja: 'ja', ko: 'ko' };
export const LEASE_MS = 2 * 60 * 1000;       // far beyond the 10 s transport timeout
export const MAX_AGE_MS = 6 * 60 * 60 * 1000; // an event older than this is never messaged (no backlog after a reconnect)
const MAX_PRE_SEND_ATTEMPTS = 5;
const BACKOFF_MS = 60 * 1000;

const param = (value) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 100) || '-';
export const templateParameters = (kind, order) => kind === 'ORDER_SHIPPED'
  ? [param(order.buyer_name), param(order.order_no), param(order.tracking_carrier), param(order.tracking_no)]
  : [param(order.buyer_name), param(order.order_no)];

export function buildTemplateMessage(kind, order, digits) {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to: digits, type: 'template',
    template: { name: TEMPLATES[kind].name, language: { code: LANGUAGES[order.locale] ?? 'en' },
      components: [{ type: 'body', parameters: templateParameters(kind, order).map((text) => ({ type: 'text', text })) }] } };
}

const iso = (date) => date.toISOString();
const activeConnection = (store) => store.get(`SELECT id, environment, public_config, created_at FROM integration_connection
  WHERE provider = ? AND status = 'CONNECTED' AND secret_ciphertext IS NOT NULL
  ORDER BY CASE environment WHEN 'PRODUCTION' THEN 0 ELSE 1 END LIMIT 1`, provider);

/* Turns recent order events of buyers who consented into queued messages. Idempotent: one row per order and event. */
export async function enqueueWhatsAppMessages(store, secretBox, { now = () => new Date(), limit = 50 } = {}) {
  if (!secretBox || (await getShopSetup(store)).mode !== 'production') return 0;   // a sample shop has fictional buyers
  const connection = await activeConnection(store);
  if (!connection) return 0;
  let secrets;
  try { secrets = await openWhatsAppSecrets(store, secretBox, connection.environment); } catch { return 0; }
  const current = now();
  const cutoff = [connection.created_at, iso(new Date(current.getTime() - MAX_AGE_MS))].sort().at(-1);
  const events = await store.all(`SELECT e.id AS event_id, e.order_id, e.event_type, e.occurred_at, o.buyer_phone, o.locale
    FROM order_event e JOIN shop_order o ON o.id = e.order_id
    WHERE e.event_type IN ('SUBMITTED', 'CONFIRMED', 'REJECTED', 'SHIPPED') AND o.whatsapp_opt_in = 1 AND e.occurred_at >= ?
      AND NOT EXISTS (SELECT 1 FROM message_outbox m WHERE m.idempotency_key = e.order_id || ':' || e.event_type)
    ORDER BY e.id LIMIT ?`, cutoff, limit);
  let queued = 0;
  for (const event of events) {
    const kind = KIND_BY_EVENT[event.event_type];
    const digits = String(event.buyer_phone ?? '').replace(/\D/g, '');
    const valid = /^[0-9]{6,20}$/.test(digits);
    const id = randomUUID(), stamp = iso(current);
    // An unusable number is recorded as FAILED so the same event is not examined again.
    await store.run(`INSERT INTO message_outbox(id, order_id, connection_id, kind, recipient_hash, template, locale, idempotency_key, status, last_error, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
    id, event.order_id, connection.id, kind, valid ? senderHash(secrets.hashKey, digits) : createHash('sha256').update(`invalid:${event.order_id}`).digest('hex'),
    TEMPLATES[kind].name, LANGUAGES[event.locale] ?? 'en', `${event.order_id}:${event.event_type}`, valid ? 'QUEUED' : 'FAILED',
    valid ? null : 'Invalid recipient number', valid ? stamp : null, stamp, stamp);
    if (await store.get('SELECT id FROM message_outbox WHERE id = ?', id)) queued++;
  }
  return queued;
}

async function release(store, row, reason, current) {
  const final = row.attempts >= MAX_PRE_SEND_ATTEMPTS;
  await store.run(`UPDATE message_outbox SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'SENDING'`,
    final ? 'FAILED' : 'QUEUED', final ? null : iso(new Date(current.getTime() + BACKOFF_MS * 2 ** (row.attempts - 1))), `Not sent: ${reason}`, iso(current), row.id);
}

/* Claims and sends due messages. Network calls never run inside a database transaction. */
export async function sendDueWhatsAppMessages(store, secretBox, transport, { now = () => new Date(), batch = 10 } = {}) {
  const summary = { sent: 0, failed: 0, reconcile: 0, retry: 0 };
  if (!secretBox) return summary;
  // A claim whose lease ran out (crash or very slow call) has an unknown outcome.
  await store.run(`UPDATE message_outbox SET status = 'RECONCILE', last_error = 'Outcome unknown (lease expired)', next_attempt_at = NULL, updated_at = ?
    WHERE status = 'SENDING' AND next_attempt_at <= ?`, iso(now()), iso(now()));
  const due = await store.all("SELECT id FROM message_outbox WHERE status = 'QUEUED' AND next_attempt_at <= ? ORDER BY created_at, id LIMIT ?", iso(now()), batch);
  for (const { id } of due) {
    const current = now();
    const row = await store.get(`UPDATE message_outbox SET status = 'SENDING', attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND status = 'QUEUED' RETURNING id, order_id, connection_id, kind, locale, attempts`, iso(new Date(current.getTime() + LEASE_MS)), iso(current), id);
    if (!row) continue;   // another worker won the claim
    let message, secrets, phoneNumberId;
    try {
      const order = await store.get('SELECT order_no, buyer_name, buyer_phone, locale, whatsapp_opt_in, tracking_carrier, tracking_no FROM shop_order WHERE id = ?', row.order_id);
      const connection = await store.get("SELECT environment, public_config FROM integration_connection WHERE id = ? AND status = 'CONNECTED'", row.connection_id);
      const digits = String(order?.buyer_phone ?? '').replace(/\D/g, '');
      if (!order || order.whatsapp_opt_in !== 1 || !/^[0-9]{6,20}$/.test(digits)) {   // consent or number gone: never send
        await store.run("UPDATE message_outbox SET status = 'FAILED', next_attempt_at = NULL, last_error = 'Not sent: no consent or number', updated_at = ? WHERE id = ?", iso(now()), row.id);
        summary.failed++; continue;
      }
      if (!connection) throw new Error('connection unavailable');
      secrets = await openWhatsAppSecrets(store, secretBox, connection.environment);
      phoneNumberId = JSON.parse(connection.public_config).phoneNumberId;
      message = buildTemplateMessage(row.kind, order, digits);
    } catch (error) {
      await release(store, row, /connection/.test(error?.message) ? 'connection unavailable' : 'cannot prepare message', now());
      summary.retry++; continue;
    }
    let answer;
    try { answer = await transport.send({ accessToken: secrets.accessToken, phoneNumberId, message }); } catch { answer = { status: 0, body: null }; }
    const outcome = normalizeProviderResponse(provider, answer);
    const stamp = iso(now());
    if (outcome.outcome === 'ACKNOWLEDGED') {
      await store.run(`UPDATE message_outbox SET status = 'ACCEPTED', provider_message_id = ?, next_attempt_at = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND status IN ('SENDING', 'RECONCILE')`, outcome.providerId, stamp, row.id);
      summary.sent++;
    } else if (outcome.outcome === 'REJECTED') {
      await store.run(`UPDATE message_outbox SET status = 'FAILED', next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status IN ('SENDING', 'RECONCILE')`,
        `Rejected by provider (${outcome.errorCode})`, stamp, row.id);
      summary.failed++;
    } else {
      await store.run(`UPDATE message_outbox SET status = 'RECONCILE', next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'SENDING'`,
        `Outcome unknown (${outcome.category})`, stamp, row.id);
      summary.reconcile++;
    }
  }
  return summary;
}

/* Runs enqueue and send on a timer. Ticks never overlap; errors are logged as a code only (no numbers, no bodies). */
export function startWhatsAppWorker({ store, secretBox, transport, tenants, paused = () => false, intervalMs = 15000, now = () => new Date() }) {
  let pending = null, stopped = false;
  const processStore = async (current) => {
    try { await enqueueWhatsAppMessages(current, secretBox, { now }); await sendDueWhatsAppMessages(current, secretBox, transport, { now }); return true; }
    catch (error) { console.error('WhatsApp worker failed:', error?.code || error?.name || 'ERROR'); return false; }
  };
  const tick = () => {
    if (stopped || paused()) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      if (store) await processStore(store);
      if (tenants && !stopped && !paused()) {
        let rows;
        try { rows = await tenants.list(); }
        catch (error) { console.error('WhatsApp tenant list failed:', error?.code || error?.name || 'ERROR'); return; }
        for (const row of rows) {
          if (stopped || paused()) break;
          if (row.is_default || row.status !== 'ACTIVE') continue;
          try { const current = await tenants.get(row); if (current) await processStore(current); }
          catch (error) { console.error('WhatsApp tenant worker failed:', error?.code || error?.name || 'ERROR'); }
        }
      }
    })().finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(tick, intervalMs); timer.unref();
  return { tick, isBusy: () => Boolean(pending), async stop() { stopped = true; clearInterval(timer); await pending; } };
}
