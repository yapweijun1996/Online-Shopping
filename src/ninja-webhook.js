// Turns a verified Ninja Van status webhook into one normalized shipment event.
// The field names follow Ninja Van's public webhook documentation (not re-verified against a live account);
// signature checking (verifyNinjaSignature) must happen on the raw body before this is called.
import { createHash } from 'node:crypto';
import { normalizeProviderStatus } from './integration-requests.js';

const TRACKING = /^([a-zA-Z0-9]+-)*[a-zA-Z0-9]+$/;
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function parseNinjaWebhook(payload) {
  if (!isObject(payload) || typeof payload.tracking_id !== 'string' || payload.tracking_id.length > 160 || !TRACKING.test(payload.tracking_id) ||
      typeof payload.status !== 'string' || payload.status.length > 80 || typeof payload.timestamp !== 'string') return null;
  // Ninja Van writes offsets as +0000; Date.parse needs +00:00.
  const at = Date.parse(payload.timestamp.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (!Number.isFinite(at)) return null;
  const { status, requiresReconciliation } = normalizeProviderStatus('NINJA_VAN', payload.status);
  return {
    trackingNo: payload.tracking_id, status, rawStatus: payload.status, requiresReconciliation, at: new Date(at).toISOString(),
    // The same event is retried; this key makes recording it idempotent.
    dedupeKey: createHash('sha256').update(`NINJAVAN|${payload.tracking_id}|${payload.status}|${payload.timestamp}`).digest('hex'),
  };
}
