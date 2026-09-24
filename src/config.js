import path from 'node:path';

const weakPasswords = new Set(['password', 'password123', 'changeme', 'admin123', 'testpassword', 'replace-me']);

export function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const username = (env.ADMIN_USERNAME || '').trim();
  const password = env.ADMIN_PASSWORD || '';
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    throw new Error('ADMIN_USERNAME must contain 3-64 safe characters.');
  }
  if (password.length < 16 || password.length > 256 || weakPasswords.has(password.toLowerCase()) || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('ADMIN_PASSWORD must be a non-default 16-256 character secret with letters and numbers.');
  }
  const dbPath = path.resolve(env.DB_PATH || '.local/online-shopping.db');
  const publicDir = path.resolve('public');
  if (dbPath === publicDir || dbPath.startsWith(`${publicDir}${path.sep}`)) {
    throw new Error('DB_PATH must be outside the public directory.');
  }
  if (production && !env.DB_PATH) throw new Error('DB_PATH is required in production.');
  const publicOrigin = env.PUBLIC_ORIGIN || null;
  if (production) {
    let parsed;
    try { parsed = new URL(publicOrigin); } catch { throw new Error('PUBLIC_ORIGIN must be an HTTPS origin in production.'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin || parsed.username || parsed.password) {
      throw new Error('PUBLIC_ORIGIN must be an HTTPS origin in production.');
    }
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid port.');
  return { production, username, password, dbPath, publicOrigin, port };
}
