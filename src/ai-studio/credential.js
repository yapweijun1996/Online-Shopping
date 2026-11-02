// The shop's OpenAI key: sealed with the integration master key, bound to this shop, never returned after saving.
import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';

const context = (shopId) => `AI_STUDIO:OPENAI:${shopId}`;
const KEY_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;
const unavailable = () => new ApiError(503, 'AI_STUDIO_UNAVAILABLE', 'AI Studio is not configured on this host.');

/* The revision is a counter on the settings row that only ever grows, so a deleted and re-created key can never
   reuse an old revision and a stale browser tab can never overwrite or delete a newer key. */
const generation = async (store) => Number((await store.get('SELECT key_generation FROM ai_studio_setting WHERE id = 1')).key_generation);

export async function keyStatus(store) {
  const revision = await generation(store);
  const row = await store.get('SELECT last4, updated_at, updated_by FROM ai_studio_credential WHERE id = 1');
  return row ? { configured: true, provider: 'OPENAI', last4: row.last4, revision, updatedAt: row.updated_at, updatedBy: row.updated_by }
    : { configured: false, provider: 'OPENAI', revision };
}

function expectedRevision(input) {
  const value = input?.expectedRevision ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new FieldError('expectedRevision', 'Reload and try again.');
  return value;
}

async function advance(store, expected) {
  const moved = await store.get('UPDATE ai_studio_setting SET key_generation = key_generation + 1 WHERE id = 1 AND key_generation = ? RETURNING key_generation', expected);
  if (!moved) throw new ApiError(409, 'STALE_REVISION', 'The key changed. Reload and try again.');
  return Number(moved.key_generation);
}

/* validate: async (key) => true, or throws; the key is stored only after the provider accepts it. */
export async function saveKey(store, secretBox, shopId, input, actor, validate) {
  if (!secretBox) throw unavailable();
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((name) => !['apiKey', 'expectedRevision'].includes(name))) {
    throw new FieldError('aiStudioKey', 'Enter the API key.');
  }
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!KEY_SHAPE.test(apiKey)) throw new FieldError('apiKey', 'Enter a valid OpenAI API key.');
  const expected = expectedRevision(input);
  try { await validate(apiKey); }
  catch (error) {
    if (error?.code === 'STUDIO_KEY_REJECTED') throw new ApiError(422, 'AI_STUDIO_KEY_REJECTED', 'OpenAI did not accept this key.');
    throw new ApiError(502, 'AI_STUDIO_UNAVAILABLE', 'The key could not be checked right now. Try again.');
  }
  const { sealed, keyId } = secretBox.seal(apiKey, context(shopId));
  const now = new Date().toISOString();
  await store.transaction(async () => {
    const revision = await advance(store, expected);
    await store.run('DELETE FROM ai_studio_credential WHERE id = 1');
    await store.run("INSERT INTO ai_studio_credential (id, provider, sealed, key_id, last4, revision, updated_by, updated_at) VALUES (1, 'OPENAI', ?, ?, ?, ?, ?, ?)",
      sealed, keyId, apiKey.slice(-4), revision, actor, now);
  });
  return keyStatus(store);
}

export async function deleteKey(store, input) {
  const expected = expectedRevision(input);
  await store.transaction(async () => {
    await advance(store, expected);
    await store.run('DELETE FROM ai_studio_credential WHERE id = 1');
  });
  return keyStatus(store);
}

/* For one outbound request only. Returns null when no key is saved. */
export async function openKey(store, secretBox, shopId) {
  if (!secretBox) throw unavailable();
  const row = await store.get('SELECT sealed, key_id FROM ai_studio_credential WHERE id = 1');
  if (!row) return null;
  try { return secretBox.open(Buffer.from(row.sealed), row.key_id, context(shopId)); }
  catch { throw new ApiError(500, 'AI_STUDIO_KEY_UNREADABLE', 'The saved key cannot be read. Enter it again.'); }
}
