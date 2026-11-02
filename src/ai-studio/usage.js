// Billable-call ledger and the per-shop daily cap. Metadata only: no prompts, images or keys.
import { randomUUID } from 'node:crypto';
import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';

export async function getStudioSetting(store) {
  const row = await store.get('SELECT daily_call_cap, revision FROM ai_studio_setting WHERE id = 1');
  return { dailyCallCap: Number(row.daily_call_cap), revision: Number(row.revision) };
}

export async function updateStudioSetting(store, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((name) => !['dailyCallCap', 'expectedRevision'].includes(name))) {
    throw new FieldError('aiStudioSetting', 'Enter supported settings.');
  }
  const { dailyCallCap: cap, expectedRevision: revision } = input;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 500) throw new FieldError('dailyCallCap', 'Use a whole number from 1 to 500.');
  if (!Number.isSafeInteger(revision) || revision < 1) throw new FieldError('expectedRevision', 'Reload and try again.');
  const updated = await store.get('UPDATE ai_studio_setting SET daily_call_cap = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ? RETURNING id',
    cap, new Date().toISOString(), revision);
  if (!updated) throw new ApiError(409, 'STALE_REVISION', 'Settings changed. Reload and try again.');
  return getStudioSetting(store);
}

export async function callsToday(store, now = new Date()) {
  const row = await store.get('SELECT COUNT(*) AS n FROM ai_studio_usage WHERE day = ?', new Date(now).toISOString().slice(0, 10));
  return Number(row.n);
}

/* Throws 429 when `planned` more billable calls would pass today's cap. */
export async function requireBudget(store, planned, now = new Date()) {
  const [{ dailyCallCap }, used] = await Promise.all([getStudioSetting(store), callsToday(store, now)]);
  if (used + planned > dailyCallCap) {
    throw Object.assign(new ApiError(429, 'AI_STUDIO_CAP', `The daily limit of ${dailyCallCap} AI calls would be exceeded.`), { used, cap: dailyCallCap });
  }
  return { used, cap: dailyCallCap };
}

export async function recordCall(store, { kind, actor, productId = null, outcome, now = new Date() }) {
  if (!['ANALYZE', 'IMAGE', 'REVIEW'].includes(kind) || !['OK', 'ERROR', 'AMBIGUOUS'].includes(outcome)) throw new FieldError('usage', 'Enter a valid usage record.');
  const at = new Date(now).toISOString();
  await store.run('INSERT INTO ai_studio_usage (id, day, kind, actor, product_id, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    randomUUID(), at.slice(0, 10), kind, String(actor).slice(0, 300), productId, outcome, at);
}
