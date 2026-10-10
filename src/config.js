import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseKeyFile } from './secret-box.js';
import { checkPassword } from './accounts.js';

const weakPasswords = new Set(['password', 'password123', 'changeme', 'admin123', 'testpassword', 'replace-me']);
const placeholderWords = /password|changeme|replace[-_]?me|example|sample|default/i;

export function readShopMode(env) {
  const mode = env.SHOP_MODE ?? 'manual';
  if (!['demo', 'manual', 'public-demo'].includes(mode)) throw new Error('SHOP_MODE must be demo, public-demo or manual.');
  return mode;
}

export function readDemoRevision(env) {
  const revision = env.SHOP_DEMO_REVISION ?? 'v1';
  if (typeof revision !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(revision)) throw new Error('SHOP_DEMO_REVISION must be a bounded lowercase label.');
  return revision;
}

function validateAdmin(username, password, production) {
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    throw new Error('ADMIN_USERNAME must contain 3-64 safe characters.');
  }
  if (password.length < 16 || password.length > 256 || weakPasswords.has(password.toLowerCase()) || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('ADMIN_PASSWORD must be a non-default 16-256 character secret with letters and numbers.');
  }
  if (production && (placeholderWords.test(password) || password.toLowerCase().includes(username.toLowerCase()))) {
    throw new Error('ADMIN_PASSWORD must not contain a known placeholder or the username in production.');
  }
}

function validatePublicOrigin(publicOrigin, production) {
  if (publicOrigin === null && !production) return null;
  let parsed;
  try { parsed = new URL(publicOrigin); } catch { throw new Error('PUBLIC_ORIGIN must be an exact origin.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== publicOrigin || parsed.username || parsed.password) {
    throw new Error('PUBLIC_ORIGIN must be an exact origin.');
  }
  if (production && parsed.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must be an HTTPS origin in production.');
  return publicOrigin;
}

export function readPlatformConfig(env, integrationKeys) {
  if (!env.PLATFORM_ENABLED || env.PLATFORM_ENABLED === '0') return null;
  if (env.PLATFORM_ENABLED !== '1') throw new Error('PLATFORM_ENABLED must be 1 or 0.');
  if (!integrationKeys) throw new Error('INTEGRATION_KEY_FILE is required for the platform.');
  const adminHost = env.PLATFORM_ADMIN_HOST;
  const username = env.PLATFORM_ADMIN_USERNAME;
  if (typeof adminHost !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/.test(adminHost)) throw new Error('Invalid PLATFORM_ADMIN_HOST.');
  try { if (new URL(`https://${adminHost}`).host !== adminHost) throw new Error(); } catch { throw new Error('Invalid PLATFORM_ADMIN_HOST.'); }
  if (typeof username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username)) throw new Error('Invalid PLATFORM_ADMIN_USERNAME.');
  const readSecret = (key) => {
    let value;
    try { value = readFileSync(env[key], 'utf8').replace(/\r?\n$/, ''); } catch { throw new Error(`${key} cannot be read.`); }
    if (!value || value.length > 1024 || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${key}.`);
    return value;
  };
  const password = readSecret('PLATFORM_ADMIN_PASSWORD_FILE');
  checkPassword(password, 'PLATFORM_ADMIN_PASSWORD_FILE', username);
  const host = env.PLATFORM_DATABASE_HOST || 'postgres', database = env.PLATFORM_DATABASE_NAME || 'platform';
  const user = env.PLATFORM_DATABASE_USER || 'platform_app', provisioner = env.PLATFORM_PROVISIONER_USER || 'platform_provisioner';
  if (![host, database, user, provisioner].every((value) => /^[a-zA-Z0-9_.-]+$/.test(value))) throw new Error('Invalid platform database connection setting.');
  const connection = (role, secret, name) => `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(secret)}@${host}:5432/${name}`;
  return { adminHost, username, password, databaseUrl: connection(user, readSecret('PLATFORM_DATABASE_PASSWORD_FILE'), database),
    provisionerUrl: connection(provisioner, readSecret('PLATFORM_PROVISIONER_PASSWORD_FILE'), 'postgres') };
}

export function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const username = (env.ADMIN_USERNAME || '').trim();
  if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD_FILE) {
    throw new Error('Set only one of ADMIN_PASSWORD and ADMIN_PASSWORD_FILE.');
  }
  let password = env.ADMIN_PASSWORD || '';
  if (env.ADMIN_PASSWORD_FILE) {
    try {
      password = readFileSync(env.ADMIN_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '');
    } catch {
      throw new Error('ADMIN_PASSWORD_FILE cannot be read.');
    }
  }
  validateAdmin(username, password, production);
  const dbPath = path.resolve(env.DB_PATH || '.local/online-shopping.db');
  const publicDir = path.resolve('public');
  if (dbPath === publicDir || dbPath.startsWith(`${publicDir}${path.sep}`)) {
    throw new Error('DB_PATH must be outside the public directory.');
  }
  if (production && !env.DB_PATH && !env.DATABASE_URL && !env.DATABASE_PASSWORD_FILE) throw new Error('DB_PATH is required in production.');
  const publicOrigin = validatePublicOrigin(env.PUBLIC_ORIGIN || null, production);
  const sellerOrigin = env.SELLER_ORIGIN ? validatePublicOrigin(env.SELLER_ORIGIN, production) : publicOrigin;
  let databaseUrl = env.DATABASE_URL || null;
  if (env.DATABASE_PASSWORD_FILE) {
    if (databaseUrl) throw new Error('Set only one of DATABASE_URL and DATABASE_PASSWORD_FILE.');
    let dbPassword;
    try { dbPassword = readFileSync(env.DATABASE_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, ''); }
    catch { throw new Error('DATABASE_PASSWORD_FILE cannot be read.'); }
    if (!dbPassword) throw new Error('Database password is required.');
    const host = env.DATABASE_HOST || 'postgres';
    const user = env.DATABASE_USER || 'online_shopping';
    const name = env.DATABASE_NAME || 'online_shopping';
    if (![host, user, name].every(value => /^[a-zA-Z0-9_.-]+$/.test(value))) throw new Error('Invalid database connection setting.');
    databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(dbPassword)}@${host}:5432/${name}`;
  }
  if (databaseUrl) {
    let url;
    try { url = new URL(databaseUrl); } catch { throw new Error('Invalid DATABASE_URL.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
  }
  // Master keys for stored integration credentials. When a key file is configured it must be valid: a bad or missing
  // file stops startup (the deploy health check then fails) instead of silently running without encryption.
  let integrationKeys = null;
  if (env.INTEGRATION_KEY_FILE) {
    let text;
    try { text = readFileSync(env.INTEGRATION_KEY_FILE, 'utf8'); } catch { throw new Error('INTEGRATION_KEY_FILE cannot be read.'); }
    integrationKeys = parseKeyFile(text);
  }
  const appRevision = env.APP_REVISION || null;
  if (appRevision && !/^(local|[0-9a-f]{40})$/.test(appRevision)) throw new Error('APP_REVISION must be a commit SHA or local.');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid port.');
  const trustProxy = env.TRUST_PROXY === '1';
  if (env.TRUST_PROXY && !trustProxy) throw new Error('TRUST_PROXY must be 1 when set.');
  return { production, username, password, dbPath, databaseUrl, publicOrigin, sellerOrigin, appRevision, integrationKeys, platform: readPlatformConfig(env, integrationKeys), port, trustProxy, shopMode: readShopMode(env), sellerQuickLogin: env.SELLER_QUICK_LOGIN === '1', demoRevision: readDemoRevision(env) };
}
