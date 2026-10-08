// Receives WhatsApp Cloud webhook deliveries: delivery receipts advance the outbox, buyer replies are stored for the
// seller panel. Order of work: signature over the raw bytes, then dedupe, then parsing; nothing is trusted before the
// signature matches the app secret of one connected account (see docs/INTEGRATION_DESIGN.md sections 6.3, 6.5 and 8).
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError } from './http.js';
import { verifyMetaSignature } from './integration-contracts.js';
import { listConnectedWhatsApp, openWhatsAppSecrets } from './integration-connections.js';
import { advanceOutboxStatus, parseWhatsAppWebhook, senderHash } from './whatsapp-webhook.js';

const provider = 'WHATSAPP_CLOUD';
export const MAX_WEBHOOK_BYTES = 256 * 1024;
const invalidSignature = () => new ApiError(401, 'INVALID_SIGNATURE', 'The webhook signature is not valid.');
const sameText = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

/* Meta's subscribe handshake: answers the challenge only when the verify token matches a connected account. */
export async function answerWhatsAppHandshake(store, params) {
  const challenge = params.get('hub.challenge');
  const token = params.get('hub.verify_token');
  if (params.get('hub.mode') !== 'subscribe' || typeof token !== 'string' || !token || typeof challenge !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(challenge)) throw new ApiError(403, 'FORBIDDEN', 'The webhook handshake was refused.');
  let matched = false;
  for (const connection of await listConnectedWhatsApp(store)) {
    if (typeof connection.publicConfig.verifyToken === 'string' && sameText(connection.publicConfig.verifyToken, token)) matched = true;
  }
  if (!matched) throw new ApiError(403, 'FORBIDDEN', 'The webhook handshake was refused.');
  return challenge;
}

async function matchConnection(store, secretBox, rawBody, signature) {
  for (const connection of await listConnectedWhatsApp(store)) {
    let secrets;
    try { secrets = await openWhatsAppSecrets(store, secretBox, connection.environment); } catch { continue; }
    if (verifyMetaSignature(rawBody, signature, secrets.appSecret)) return { connection, secrets };
  }
  return null;
}

export async function receiveWhatsAppWebhook(store, secretBox, { rawBody, signature }, now = () => new Date()) {
  if (!secretBox) throw new ApiError(503, 'INTEGRATIONS_UNAVAILABLE', 'Integrations are not configured.');
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength > MAX_WEBHOOK_BYTES) throw new ApiError(413, 'INVALID_INPUT', 'Request body is too large.');
  const match = await matchConnection(store, secretBox, rawBody, signature);
  if (!match) throw invalidSignature();   // nothing is stored for unverified requests
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(rawBody)); } catch { throw new ApiError(400, 'INVALID_INPUT', 'Invalid JSON object.'); }
  const { connection, secrets } = match;
  const parsed = parseWhatsAppWebhook(payload);
  const mine = (item) => item.phoneNumberId === connection.publicConfig.phoneNumberId;
  const dedupeKey = createHash('sha256').update(rawBody).digest('hex');

  return store.transaction(async () => {
    const stamp = now().toISOString();
    const receiptId = randomUUID();
    await store.run(`INSERT INTO webhook_receipt(id, provider, dedupe_key, verified, received_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(provider, dedupe_key) DO NOTHING`, receiptId, provider, dedupeKey, stamp);
    if (!await store.get('SELECT id FROM webhook_receipt WHERE id = ?', receiptId)) return { outcome: 'duplicate', statuses: 0, messages: 0, skipped: 0 };

    let statuses = 0, messages = 0, skipped = parsed.skipped;
    for (const receipt of parsed.statuses) {
      if (!mine(receipt)) { skipped++; continue; }
      const row = await store.get('SELECT id, status FROM message_outbox WHERE provider_message_id = ? AND connection_id = ?', receipt.providerMessageId, connection.id);
      if (!row) { skipped++; continue; }
      const next = advanceOutboxStatus(row.status, receipt.status);
      if (next === row.status) continue;
      await store.run('UPDATE message_outbox SET status = ?, last_error = ?, updated_at = ? WHERE id = ?',
        next, next === 'FAILED' ? `Provider error ${receipt.errorCode ?? 'unknown'}` : null, stamp, row.id);
      statuses++;
    }
    for (const message of parsed.messages) {
      if (!mine(message)) { skipped++; continue; }
      const fromHash = senderHash(secrets.hashKey, message.from);
      // A reply belongs to the order of the most recent message this connection sent to that buyer.
      const order = await store.get('SELECT order_id FROM message_outbox WHERE connection_id = ? AND recipient_hash = ? ORDER BY created_at DESC LIMIT 1', connection.id, fromHash);
      const id = randomUUID();
      await store.run(`INSERT INTO message_inbound(id, connection_id, order_id, from_hash, provider_message_id, kind, body, received_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider_message_id) DO NOTHING`,
      id, connection.id, order?.order_id ?? null, fromHash, message.providerMessageId, message.kind, message.kind === 'TEXT' ? message.body : null, message.receivedAt, stamp);
      if (await store.get('SELECT id FROM message_inbound WHERE id = ?', id)) messages++;
    }
    return { outcome: 'processed', statuses, messages, skipped };
  });
}
