// Billable-call ledger and the per-shop daily cap. Metadata only: no prompts, images or keys.
import { checkBudget } from './budget.js';
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

const COUNTED = "('PENDING', 'OK', 'AMBIGUOUS')";

/* Calls that are in flight, billed, or may have been billed. Failures known not to be billed are released. */
export async function callsToday(store, now = new Date()) {
  const row = await store.get(`SELECT COUNT(*) AS n FROM ai_studio_usage WHERE day = ? AND outcome IN ${COUNTED}`, new Date(now).toISOString().slice(0, 10));
  return Number(row.n);
}

/*
 * Checks the daily cap and reserves the planned calls in one transaction, so concurrent requests cannot both pass.
 * Reserved rows count immediately; settle() later marks each as OK, AMBIGUOUS (may be billed) or ERROR (released).
 * A row left PENDING by a crash keeps counting until the day ends, which errs on the side of the seller's budget.
 */
export async function reserve(store, plan, actor, productId = null, now = new Date()) {
  return store.transaction(async () => {
    const [{ dailyCallCap }, used] = await Promise.all([getStudioSetting(store), callsToday(store, now)]);
    if (used + plan.length > dailyCallCap) {
      throw Object.assign(new ApiError(429, 'AI_STUDIO_CAP', `The daily limit of ${dailyCallCap} AI calls would be exceeded.`), { used, cap: dailyCallCap });
    }
    await checkBudget(store, now);
    const at = new Date(now).toISOString(), ids = [];
    for (const kind of plan) {
      if (!['ANALYZE', 'IMAGE', 'REVIEW'].includes(kind)) throw new FieldError('usage', 'Enter a valid usage record.');
      const id = randomUUID(); ids.push(id);
      await store.run("INSERT INTO ai_studio_usage (id, day, kind, actor, product_id, outcome, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?)",
        id, at.slice(0, 10), kind, String(actor).slice(0, 300), productId, at);
    }
    return ids;
  });
}

export async function settle(store, id, outcome) {
  if (!['OK', 'AMBIGUOUS', 'ERROR'].includes(outcome)) throw new FieldError('usage', 'Enter a valid usage outcome.');
  await store.run("UPDATE ai_studio_usage SET outcome = ? WHERE id = ? AND outcome = 'PENDING'", outcome, id);
}

/* A provider failure counts as billed when the request may have been processed: timeouts, unreadable or refused answers. */
export const failureOutcome = (error) => ['STUDIO_TIMEOUT', 'STUDIO_BAD_RESPONSE', 'STUDIO_REFUSED'].includes(error?.code) || error?.ambiguous === true ? 'AMBIGUOUS' : 'ERROR';
