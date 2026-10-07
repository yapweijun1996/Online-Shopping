// Encrypts integration credentials for storage (AES-256-GCM). The master keys come from a Docker secret file,
// never from the database, so a database dump alone reveals nothing. Each sealed value is bound to a context
// (for example "NINJAVAN:SANDBOX") so it cannot be moved to another connection, and carries the id of the key
// that sealed it so keys can be rotated: add a new first key, reseal every row, then drop the old key.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1, IV_BYTES = 12, TAG_BYTES = 16, KEY_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const aad = (context) => Buffer.from(`online-shopping:secret:v${VERSION}:${context}`);
const refuse = () => new Error('The stored secret cannot be decrypted.');

/* Key file: one `id=base64key` per line (32 random bytes, base64). The first line is the active key. */
export function parseKeyFile(text) {
  const keys = new Map();
  let activeId = null;
  for (const line of String(text).split(/\r?\n/).map((value) => value.trim()).filter((value) => value && !value.startsWith('#'))) {
    const separator = line.indexOf('=');
    const id = line.slice(0, separator), encoded = line.slice(separator + 1);
    if (separator < 1 || !KEY_ID.test(id) || keys.has(id)) throw new Error('The integration key file has an invalid or repeated key id.');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== encoded) throw new Error('Each integration key must be 32 random bytes in base64.');
    keys.set(id, key);
    activeId ??= id;
  }
  if (!activeId) throw new Error('The integration key file contains no key.');
  return { activeId, keys };
}

export function createSecretBox({ activeId, keys }) {
  if (!keys.has(activeId)) throw new Error('The active integration key is missing.');
  const open = (sealed, keyId, context) => {
    const key = keys.get(keyId);
    if (!key || !Buffer.isBuffer(sealed) || sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== VERSION) throw refuse();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 1 + IV_BYTES));
      decipher.setAAD(aad(context));
      decipher.setAuthTag(sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(sealed.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch { throw refuse(); }
  };
  const seal = (plaintext, context) => {
    if (typeof plaintext !== 'string' || !plaintext || plaintext.length > 8192) throw new Error('A secret must be 1 to 8192 characters.');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', keys.get(activeId), iv);
    cipher.setAAD(aad(context));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { keyId: activeId, sealed: Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]) };
  };
  return {
    activeId, seal, open,
    needsRotation: (keyId) => keyId !== activeId,
    reseal: (sealed, keyId, context) => seal(open(sealed, keyId, context), context),
  };
}

/* What the seller page may show after saving: never the secret, only that one exists and how it ends. */
export function maskSecret(plaintext) {
  return typeof plaintext === 'string' && plaintext.length >= 12 ? `••••${plaintext.slice(-4)}` : '••••';
}
