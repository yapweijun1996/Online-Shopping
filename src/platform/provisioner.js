// Creating a shop (docs/MULTI_TENANT_SUPERADMIN_PLAN.md, 4.3): its own PostgreSQL role and database, the latest schema,
// the shop settings and its single seller. Every step is safe to repeat: a half-made shop is marked FAILED and the next
// attempt removes what was left before starting again. The provisioner credential has CREATEDB and CREATEROLE; in
// PostgreSQL 16 the creator of a role gets administrative rights over it, so treat the credential as cross-shop
// privileged. This code never uses it to read shop data: the shop itself is set up through the shop's own role.
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { FieldError, boundedText } from '../validation.js';
import { ApiError } from '../http.js';
import { ensureAdmin } from '../auth.js';
import { checkPassword } from '../accounts.js';
import { setupShop } from '../shop-setup.js';
import { updateCompanySettings } from '../settings.js';
import { openPostgresDatabase } from '../postgres-db.js';
import { normalizeTenantCode } from './tenant-code.js';
import { recordAudit } from './platform-db.js';

const IDENTIFIER = /^t_[a-z0-9]{3,30}_[0-9a-f]{8}$/;
const SAFE_PASSWORD = /^[A-Za-z0-9_-]{32,64}$/;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const now = () => new Date().toISOString();
const quote = (identifier) => {
  if (!IDENTIFIER.test(identifier)) throw new Error('Unexpected database identifier.');
  return `"${identifier}"`;
};

/* The same server and port as `baseUrl`, but another role, password and database. */
export function tenantUrl(baseUrl, { role, password, database }) {
  const url = new URL(baseUrl);
  url.username = role; url.password = password; url.pathname = `/${database}`; url.search = '';
  return url.href;
}

async function withProvisioner(provisionerUrl, work) {
  const client = new pg.Client({ connectionString: provisionerUrl, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

async function dropArtifacts(provisionerUrl, tenant) {
  if (!tenant.database_name) return;
  await withProvisioner(provisionerUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${quote(tenant.database_name)} WITH (FORCE)`);
    await client.query(`DROP ROLE IF EXISTS ${quote(tenant.database_role)}`);
  });
}

export function validateTenantInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['code', 'name', 'currency', 'sellerUsername', 'sellerPassword'].includes(key))) {
    throw new FieldError('tenant', 'Send code, name, currency, sellerUsername and optionally sellerPassword.');
  }
  const code = normalizeTenantCode(input.code);
  const name = boundedText(input.name, 'name', 80);
  if (!['MYR', 'SGD'].includes(input.currency)) throw new FieldError('currency', 'Choose MYR or SGD.');
  if (typeof input.sellerUsername !== 'string' || !USERNAME.test(input.sellerUsername)) throw new FieldError('sellerUsername', 'Use 3 to 64 letters, digits, dots, dashes or underscores.');
  const generated = input.sellerPassword === undefined;
  const sellerPassword = generated ? randomBytes(18).toString('base64url') : checkPassword(input.sellerPassword, 'sellerPassword', input.sellerUsername);
  return { code, name, currency: input.currency, sellerUsername: input.sellerUsername, sellerPassword, generated };
}

/* Creates a shop. Returns the tenant row and, only when the password was generated here, that one-time password. */
export async function createTenant(platform, { provisionerUrl, baseUrl, secretBox }, input, actor) {
  const wanted = validateTenantInput(input);
  const row = await platform.transaction(async () => {
    if (await platform.get('SELECT 1 AS found FROM tenant_code_alias WHERE code = ?', wanted.code)) throw new ApiError(409, 'CODE_TAKEN', 'This shop code is already used.');
    const existing = await platform.get('SELECT * FROM tenant WHERE code = ?', wanted.code);
    if (existing && existing.status !== 'FAILED') throw new ApiError(409, 'CODE_TAKEN', 'This shop code is already used.');
    if (!existing && (await platform.get("SELECT COUNT(*) AS n FROM tenant WHERE status <> 'PURGED'")).n >= 20) throw new ApiError(409, 'TENANT_LIMIT', 'This host supports at most 20 shops.');
    const id = existing?.id ?? randomUUID(), stamp = now();
    const database = `t_${wanted.code}_${id.replaceAll('-', '').slice(0, 8)}`;
    if (existing) {
      // A left-over attempt: its artifacts are removed below, then it starts again under the same id.
      await platform.run("UPDATE tenant SET status = 'PROVISIONING', revision = revision + 1, name = ?, currency = ?, seller_username = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'FAILED'",
        wanted.name, wanted.currency, wanted.sellerUsername, stamp, id);
      await recordAudit(platform, { actor, action: 'TENANT_CLEANUP', tenantId: id, detail: 'retry of an unfinished shop' });
    } else {
      const sealed = secretBox.seal(randomBytes(32).toString('base64url'), `TENANT_DB:${id}`);
      await platform.run(`INSERT INTO tenant(id, code, name, status, currency, database_name, database_role, database_password_sealed, database_key_id, seller_username, created_at, updated_at)
        VALUES (?, ?, ?, 'PROVISIONING', ?, ?, ?, ?, ?, ?, ?, ?)`, id, wanted.code, wanted.name, wanted.currency, database, database, sealed.sealed, sealed.keyId, wanted.sellerUsername, stamp, stamp);
    }
    await recordAudit(platform, { actor, action: 'TENANT_CREATE', tenantId: id, detail: wanted.code });
    // Capture the reservation before commit; a failed read must roll it back, not strand PROVISIONING outside try.
    return platform.get('SELECT * FROM tenant WHERE id = ?', id);
  });
  const tenantId = row.id;
  try {
    await dropArtifacts(provisionerUrl, row);
    const password = secretBox.open(row.database_password_sealed, row.database_key_id, `TENANT_DB:${tenantId}`);
    if (!SAFE_PASSWORD.test(password)) throw new Error('Unexpected database password format.');
    await withProvisioner(provisionerUrl, async (client) => {
      await client.query(`CREATE ROLE ${quote(row.database_role)} LOGIN PASSWORD '${password}'`);
      await client.query(`CREATE DATABASE ${quote(row.database_name)} OWNER ${quote(row.database_role)}`);
      // Only this shop's role may connect to this shop's database.
      await client.query(`REVOKE ALL ON DATABASE ${quote(row.database_name)} FROM PUBLIC`);
    });
    const store = await openPostgresDatabase(tenantUrl(baseUrl, { role: row.database_role, password, database: row.database_name }));
    try {
      await setupShop(store, { mode: 'production', shopName: wanted.name });
      await updateCompanySettings(store, { defaultCurrency: wanted.currency });
      await ensureAdmin(store, wanted.sellerUsername, wanted.sellerPassword);
      // The first password is handed over by the SuperAdmin, so the seller must replace it at the first sign-in.
      await store.run('UPDATE seller_account SET must_change_password = 1');
    } finally { await store.close(); }
    await platform.transaction(async () => {
      await platform.run("UPDATE tenant SET status = 'ACTIVE', revision = revision + 1, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'PROVISIONING' AND revision = ?", now(), tenantId, row.revision);
      await recordAudit(platform, { actor, action: 'TENANT_ACTIVE', tenantId, detail: wanted.code });
    });
  } catch (error) {
    // Only a code is kept: no message text that could carry a connection string or a password.
    const code = String(error?.code ?? error?.name ?? 'ERROR').slice(0, 60);
    await platform.transaction(async () => {
      await platform.run("UPDATE tenant SET status = 'FAILED', revision = revision + 1, last_error = ?, updated_at = ? WHERE id = ? AND status = 'PROVISIONING' AND revision = ?", code, now(), tenantId, row.revision);
      await recordAudit(platform, { actor, action: 'TENANT_FAILED', tenantId, detail: code });
    });
    throw error;
  }
  const tenant = await platform.get('SELECT id, code, name, status, currency, seller_username, created_at FROM tenant WHERE id = ?', tenantId);
  return { tenant, ...(wanted.generated ? { sellerPassword: wanted.sellerPassword } : {}) };
}
