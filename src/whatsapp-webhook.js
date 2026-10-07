// Turns a verified WhatsApp Cloud API webhook body into plain facts: buyer replies and delivery receipts.
// The payload shape is from Meta's public documentation and has NOT been re-verified against a live account
// (docs/INTEGRATION_DESIGN.md, section 6.5); unknown fields are ignored and malformed items are skipped, never trusted.
// Signature checking (verifyMetaSignature) must happen on the raw body before this is called.
import { createHmac } from 'node:crypto';
import { normalizeProviderStatus } from './integration-requests.js';

const MAX_ENTRIES = 50, MAX_ITEMS = 200, MAX_BODY = 4096;
const MESSAGE_ID = /^wamid\.[A-Za-z0-9+/=_-]{1,200}$/;
const PHONE = /^[0-9]{6,20}$/;
const MEDIA = new Set(['image', 'audio', 'video', 'document', 'sticker', 'voice']);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Keep line breaks, drop other control characters so a reply cannot disturb the page or the logs.
const cleanText = (value) => value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, MAX_BODY);
const instant = (seconds) => /^[0-9]{9,12}$/.test(String(seconds)) ? new Date(Number(seconds) * 1000).toISOString() : null;

export function parseWhatsAppWebhook(payload) {
  const result = { phoneNumberIds: [], messages: [], statuses: [], skipped: 0 };
  if (!isObject(payload) || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return result;
  for (const entry of payload.entry.slice(0, MAX_ENTRIES)) {
    for (const change of (isObject(entry) && Array.isArray(entry.changes) ? entry.changes : []).slice(0, MAX_ENTRIES)) {
      const value = isObject(change) && change.field === 'messages' && isObject(change.value) ? change.value : null;
      if (!value) continue;
      const phoneNumberId = isObject(value.metadata) && typeof value.metadata.phone_number_id === 'string' && /^[0-9]{1,32}$/.test(value.metadata.phone_number_id) ? value.metadata.phone_number_id : null;
      if (phoneNumberId && !result.phoneNumberIds.includes(phoneNumberId)) result.phoneNumberIds.push(phoneNumberId);
      for (const message of (Array.isArray(value.messages) ? value.messages : []).slice(0, MAX_ITEMS)) {
        const receivedAt = isObject(message) ? instant(message.timestamp) : null;
        if (!isObject(message) || !MESSAGE_ID.test(message.id) || !PHONE.test(String(message.from)) || !receivedAt) { result.skipped += 1; continue; }
        const text = message.type === 'text' && isObject(message.text) && typeof message.text.body === 'string' ? cleanText(message.text.body) : null;
        result.messages.push({ providerMessageId: message.id, from: String(message.from), receivedAt, phoneNumberId,
          kind: text !== null ? 'TEXT' : MEDIA.has(message.type) ? 'MEDIA_UNSUPPORTED' : 'OTHER', body: text });
      }
      for (const status of (Array.isArray(value.statuses) ? value.statuses : []).slice(0, MAX_ITEMS)) {
        const at = isObject(status) ? instant(status.timestamp) : null;
        if (!isObject(status) || !MESSAGE_ID.test(status.id) || typeof status.status !== 'string' || status.status.length > 20 || !at) { result.skipped += 1; continue; }
        const { status: normalized } = normalizeProviderStatus('WHATSAPP_CLOUD', status.status);
        const error = Array.isArray(status.errors) && isObject(status.errors[0]) ? status.errors[0] : null;
        result.statuses.push({ providerMessageId: status.id, status: normalized, at, phoneNumberId,
          ...(error && Number.isSafeInteger(error.code) ? { errorCode: error.code } : {}) });
      }
    }
  }
  return result;
}

/* Replies are indexed by a keyed hash of the sender's number, never the number itself. */
export function senderHash(key, number) {
  if (!Buffer.isBuffer(key) || key.length < 16 || !PHONE.test(String(number))) throw new Error('A keyed sender hash needs a key and a phone number.');
  return createHmac('sha256', key).update(`whatsapp-sender:${number}`).digest('hex');
}

// Delivery receipts arrive out of order and repeat; a receipt never moves a message backwards.
const RANK = { QUEUED: 0, SENDING: 1, ACCEPTED: 2, DELIVERED: 3, READ: 4 };
export function advanceOutboxStatus(current, receipt) {
  if (receipt === 'FAILED') return ['QUEUED', 'SENDING', 'ACCEPTED', 'RECONCILE'].includes(current) ? 'FAILED' : current;
  const incoming = { SENT: 'ACCEPTED', DELIVERED: 'DELIVERED', READ: 'READ' }[receipt];
  if (!incoming) return current;
  if (current === 'RECONCILE') return incoming;
  return RANK[incoming] > (RANK[current] ?? -1) ? incoming : current;
}
