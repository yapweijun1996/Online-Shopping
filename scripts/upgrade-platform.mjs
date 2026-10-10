// Runs in the candidate image on the private network. Only identifiers and versions enter the durable report.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openPostgresStore } from '../src/postgres-store.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { createSecretBox, parseKeyFile } from '../src/secret-box.js';
import { tenantUrl } from '../src/platform/provisioner.js';
import { upgradePlatformSchema } from '../src/platform/migrations.js';
import { PLATFORM_SCHEMA_VERSION } from '../src/platform/platform-db.js';
import { SCHEMA_VERSION } from '../src/db.js';

export async function upgradePlatform({ platformUrl, secretBox, reportPath, backup, openTenant = openPostgresDatabase }) {
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : { format: 1, attempted: [], upgraded: [], complete: false };
  if (report.format !== 1 || report.complete || report.attempted.some((name) => name !== 'online_shopping')) throw new Error('Unexpected existing migration intent.');
  const writeReport = () => { const temporary = reportPath + '.tmp'; writeFileSync(temporary, JSON.stringify(report), { mode: 0o600 }); renameSync(temporary, reportPath); };
  const intent = (database) => { if (!backup.databases.some((item) => item.database === database)) throw new Error('Database has no deployment backup.'); report.attempted.push(database); writeReport(); };
  if (backup.format !== 1 || backup.restoreVerified !== true) throw new Error('A verified deployment backup is required.');
  writeReport();
  const platform = openPostgresStore(platformUrl, { max: 1 });
  try {
    const hasMeta = (await platform.get("SELECT to_regclass('public.schema_meta') AS name")).name;
    const previous = hasMeta ? await platform.schemaVersion() : 0;
    if (previous !== PLATFORM_SCHEMA_VERSION) intent('platform');
    await upgradePlatformSchema(platform);
    if (previous !== PLATFORM_SCHEMA_VERSION) { report.upgraded.push('platform'); writeReport(); }
    const shops = await platform.all("SELECT id, database_name, database_role, database_password_sealed, database_key_id FROM tenant WHERE is_default = 0 AND status IN ('ACTIVE','SUSPENDED','DELETING') ORDER BY code LIMIT 20");
    // Reject incomplete backup coverage before changing any tenant database.
    for (const shop of shops) if (!backup.databases.some((item) => item.database === shop.database_name)) throw new Error('Shop has no deployment backup.');
    for (const shop of shops) {
      const password = secretBox.open(shop.database_password_sealed, shop.database_key_id, `TENANT_DB:${shop.id}`);
      const url = tenantUrl(platformUrl, { database: shop.database_name, role: shop.database_role, password });
      const check = openPostgresStore(url, { max: 1 });
      let version;
      try { version = await check.schemaVersion(); } finally { await check.close(); }
      if (version > SCHEMA_VERSION || !Number.isInteger(version)) throw new Error('Unsupported shop schema version.');
      if (version === SCHEMA_VERSION) continue;
      intent(shop.database_name);
      const store = await openTenant(url, { allowUpgrade: true, max: 1 });
      try { if (await store.schemaVersion() !== SCHEMA_VERSION) throw new Error('Shop upgrade version check failed.'); }
      finally { await store.close(); }
      report.upgraded.push(shop.database_name); writeReport();
    }
    report.complete = true; writeReport();
    return { platformVersion: PLATFORM_SCHEMA_VERSION, version: SCHEMA_VERSION, upgraded: report.upgraded };
  } finally { await platform.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const password = readFileSync(process.env.PLATFORM_PASSWORD_FILE || '/run/secrets/platform', 'utf8').replace(/\r?\n$/, '');
    const platformUrl = tenantUrl(process.env.PLATFORM_DATABASE_URL || 'postgresql://platform_app@postgres:5432/platform', { role: 'platform_app', password, database: 'platform' });
    const secretBox = createSecretBox(parseKeyFile(readFileSync(process.env.INTEGRATION_KEY_FILE || '/run/secrets/integration_keys', 'utf8')));
    const backup = JSON.parse(readFileSync(process.env.BACKUP_MANIFEST_FILE || '/run/backup/manifest.json', 'utf8'));
    console.log(JSON.stringify(await upgradePlatform({ platformUrl, secretBox, backup, reportPath: process.env.UPGRADE_REPORT_FILE || '/run/upgrade/report.json' })));
  } catch (error) { console.error('Platform upgrade failed:', error?.code || error?.name || 'ERROR'); process.exitCode = 1; }
}
