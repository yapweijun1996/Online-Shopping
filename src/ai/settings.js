import { randomUUID } from 'node:crypto';
import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';

const fields = { enabled: 'enabled', level: 'level', tone: 'tone', businessNotes: 'business_notes', dailyTokenCap: 'daily_token_cap' };

export async function getAiSettings(store) {
  const row = await store.get('SELECT * FROM ai_setting WHERE id = 1');
  return { enabled: Boolean(row.enabled), level: row.level, tone: row.tone, businessNotes: row.business_notes,
    dailyTokenCap: row.daily_token_cap, revision: row.revision, updatedAt: row.updated_at };
}

function integer(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new FieldError(field, `Use an integer between ${min} and ${max}.`);
  return value;
}

function text(value, field, max, notes = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || (notes ? /[\x00-\x09\x0b-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/).test(value)) {
    throw new FieldError(field, 'Enter valid text without control characters.');
  }
  value = value.trim();
  if (value.length > max) throw new FieldError(field, `Use at most ${max} characters.`);
  return value;
}

export async function updateAiSettings(store, input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(fields, key) && key !== 'expectedRevision')) {
    throw new FieldError('aiSettings', 'Enter supported AI settings.');
  }
  const revision = integer(input.expectedRevision, 'expectedRevision', 1, Number.MAX_SAFE_INTEGER - 1);
  const patch = {};
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (key === 'enabled') {
      if (typeof value !== 'boolean') throw new FieldError(key, 'Choose AI availability.');
      patch[key] = Number(value);
    } else if (key === 'level') patch[key] = integer(value, key, 0, 1);
    else if (key === 'dailyTokenCap') patch[key] = integer(value, key, 1000, 2000000);
    else patch[key] = text(value, key, key === 'tone' ? 300 : 3000, key === 'businessNotes');
  }
  if (!Object.keys(patch).length) throw new FieldError('aiSettings', 'Enter settings to update.');
  return store.transaction(async () => {
    const keys = Object.keys(patch);
    const result = await store.get(`UPDATE ai_setting SET ${keys.map(key => `${fields[key]} = ?`).join(', ')}, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ? RETURNING id`,
      ...keys.map(key => patch[key]), new Date().toISOString(), revision);
    if (!result) throw new ApiError(409, 'STALE_REVISION', 'AI settings changed. Reload and try again.');
    await store.run("INSERT INTO ai_suggestion_audit (id,actor,thread_id,created_at,action) VALUES (?,?,'',?,'SETTINGS_UPDATED')", randomUUID(), text(actor, 'actor', 300), new Date().toISOString());
    return getAiSettings(store);
  });
}

export async function todayTokens(store, now = new Date()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const row = await store.get('SELECT COALESCE(SUM(input_tokens) + SUM(output_tokens), 0) AS tokens FROM ai_usage WHERE day = ?', day);
  return Number(row.tokens);
}

// Deliberately select metadata fields; prompts, customer text and model output are never stored.
export async function recordUsage(store, { kind = 'SUGGEST', actor, threadId = null, inputTokens, outputTokens, outcome, now = new Date() }) {
  integer(inputTokens, 'inputTokens', 0, 2147483647);
  integer(outputTokens, 'outputTokens', 0, 2147483647);
  if (kind !== 'SUGGEST' || !['OK', 'HANDOFF', 'ERROR', 'CAP'].includes(outcome)) throw new FieldError('usage', 'Enter a valid usage kind and outcome.');
  actor = text(actor, 'actor', 300);
  if (!actor) throw new FieldError('actor', 'Enter an actor.');
  if (threadId !== null) threadId = text(threadId, 'threadId', 300);
  const createdAt = new Date(now).toISOString(), id = randomUUID();
  await store.run('INSERT INTO ai_usage (id, day, kind, actor, thread_id, input_tokens, output_tokens, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, createdAt.slice(0, 10), kind, actor, threadId, inputTokens, outputTokens, outcome, createdAt);
  return { id };
}
