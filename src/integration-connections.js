import { randomUUID } from 'node:crypto';
import { ApiError } from './http.js';
import { FieldError } from './validation.js';
import { maskSecret } from './secret-box.js';

const provider = 'WHATSAPP_CLOUD';
const context = (environment) => `${provider}:${environment}`;

function validateEnvironment(environment) {
  if (!['SANDBOX', 'PRODUCTION'].includes(environment)) throw new FieldError('environment', 'Choose a supported environment.');
}

function validateActor(actor) {
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 120) throw new FieldError('actor', 'Enter a valid actor.');
}

function validateInput(input, actor) {
  const keys = ['environment', 'accessToken', 'phoneNumberId', 'businessAccountId'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !keys.includes(key))) throw new FieldError('connection', 'Enter supported connection details.');
  validateEnvironment(input.environment);
  validateActor(actor);
  if (typeof input.accessToken !== 'string' || input.accessToken.length < 20 || input.accessToken.length > 512 ||
      /[\s\p{Cc}]/u.test(input.accessToken)) throw new FieldError('accessToken', 'Enter a valid access token.');
  for (const field of ['phoneNumberId', 'businessAccountId']) {
    if (typeof input[field] !== 'string' || !/^[0-9]{5,32}$/.test(input[field])) throw new FieldError(field, 'Enter a valid numeric id.');
  }
}

const statusColumns = 'provider, environment, status, public_config, secret_hint, last_checked_at, last_error, updated_at';
const statusObject = (row) => row ? {
  provider: row.provider, environment: row.environment, status: row.status,
  publicConfig: JSON.parse(row.public_config), secretHint: row.secret_hint,
  lastCheckedAt: row.last_checked_at, lastError: row.last_error, updatedAt: row.updated_at,
} : null;

async function audit(store, environment, action, actor, detail, now) {
  await store.run(`INSERT INTO integration_audit(id, provider, environment, action, actor, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, randomUUID(), provider, environment, action, actor, detail, now);
}

export async function getWhatsAppConnection(store, environment) {
  validateEnvironment(environment);
  return statusObject(await store.get(`SELECT ${statusColumns} FROM integration_connection WHERE provider = ? AND environment = ?`, provider, environment));
}

export async function listWhatsAppConnections(store) {
  return (await store.all(`SELECT ${statusColumns} FROM integration_connection WHERE provider = ? ORDER BY environment`, provider)).map(statusObject);
}

export async function saveWhatsAppConnection(store, secretBox, transport, input, actor) {
  validateInput(input, actor);
  const { environment, accessToken, phoneNumberId, businessAccountId } = input;
  let result;
  try { result = await transport.verify({ accessToken, phoneNumberId }); }
  catch { result = { ok: false, reason: 'UNAVAILABLE' }; }
  if (result?.ok !== true) {
    const reason = result?.reason === 'REJECTED' ? 'REJECTED' : 'UNAVAILABLE';
    await audit(store, environment, 'CHECK_FAILED', actor, reason, new Date().toISOString());
    throw reason === 'REJECTED'
      ? new ApiError(400, 'CONNECTION_REJECTED', 'The provider rejected the connection.')
      : new ApiError(502, 'PROVIDER_UNAVAILABLE', 'The provider is unavailable.');
  }
  return store.transaction(async () => {
    const existing = await store.get('SELECT secret_ciphertext FROM integration_connection WHERE provider = ? AND environment = ?', provider, environment);
    const { sealed, keyId } = secretBox.seal(accessToken, context(environment));
    const now = new Date().toISOString();
    // Provider text is shown in the seller panel: keep it short, printable and free of the token.
    const publicText = (value) => typeof value === 'string' && value.length <= 100 && !/\p{Cc}/u.test(value) && !value.includes(accessToken) ? value : null;
    const publicConfig = { phoneNumberId, businessAccountId,
      displayPhoneNumber: publicText(result.displayPhoneNumber), verifiedName: publicText(result.verifiedName) };
    await store.run(`INSERT INTO integration_connection(id, provider, environment, status, public_config,
      secret_ciphertext, secret_key_id, secret_hint, last_checked_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, 'CONNECTED', ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(provider, environment) DO UPDATE SET status = 'CONNECTED', public_config = excluded.public_config,
      secret_ciphertext = excluded.secret_ciphertext, secret_key_id = excluded.secret_key_id,
      secret_hint = excluded.secret_hint, last_checked_at = excluded.last_checked_at, last_error = NULL, updated_at = excluded.updated_at`,
    randomUUID(), provider, environment, JSON.stringify(publicConfig), Buffer.from(sealed), keyId, maskSecret(accessToken), now, now, now);
    await audit(store, environment, existing?.secret_ciphertext != null ? 'ROTATE' : 'CONNECT', actor, null, now);
    return getWhatsAppConnection(store, environment);
  });
}

export async function disconnectWhatsAppConnection(store, environment, actor) {
  validateEnvironment(environment);
  validateActor(actor);
  return store.transaction(async () => {
    const row = await store.get('SELECT status, secret_ciphertext FROM integration_connection WHERE provider = ? AND environment = ?', provider, environment);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Connection not found.');
    if (row.status !== 'NOT_CONFIGURED' || row.secret_ciphertext != null) {
      const now = new Date().toISOString();
      await store.run(`UPDATE integration_connection SET secret_ciphertext = NULL, secret_key_id = NULL,
        secret_hint = NULL, status = 'NOT_CONFIGURED', updated_at = ? WHERE provider = ? AND environment = ?`, now, provider, environment);
      await audit(store, environment, 'DISCONNECT', actor, null, now);
    }
    return getWhatsAppConnection(store, environment);
  });
}

// Server-side only: this plaintext token must never be returned by any HTTP route.
export async function openWhatsAppToken(store, secretBox, environment) {
  validateEnvironment(environment);
  const row = await store.get('SELECT status, secret_ciphertext, secret_key_id FROM integration_connection WHERE provider = ? AND environment = ?', provider, environment);
  if (row?.status !== 'CONNECTED' || row.secret_ciphertext == null) throw new ApiError(409, 'NOT_CONNECTED', 'Connection is not connected.');
  return secretBox.open(Buffer.from(row.secret_ciphertext), row.secret_key_id, context(environment));
}

export async function resealWhatsAppConnections(store, secretBox) {
  return store.transaction(async () => {
    const rows = await store.all('SELECT id, environment, secret_ciphertext, secret_key_id FROM integration_connection WHERE provider = ? AND secret_ciphertext IS NOT NULL', provider);
    let count = 0;
    for (const row of rows) {
      if (!secretBox.needsRotation(row.secret_key_id)) continue;
      const { sealed, keyId } = secretBox.reseal(Buffer.from(row.secret_ciphertext), row.secret_key_id, context(row.environment));
      await store.run('UPDATE integration_connection SET secret_ciphertext = ?, secret_key_id = ?, updated_at = ? WHERE id = ?',
        Buffer.from(sealed), keyId, new Date().toISOString(), row.id);
      count++;
    }
    return count;
  });
}
