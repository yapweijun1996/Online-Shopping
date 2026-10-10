import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { openPlatformDatabase } from '../../src/platform/platform-db.js';
import { createTenantPool } from '../../src/platform/tenant-pool.js';
import { createSecretBox, parseKeyFile } from '../../src/secret-box.js';

export const platformTestUrl = process.env.SHOP_TEST_DATABASE_URL;
if (platformTestUrl && (process.env.NODE_ENV !== 'test' || !/test/i.test(new URL(platformTestUrl).pathname))) throw new Error('Use a disposable test database.');
export async function platformFixture(t, options = {}) {
  const baseUrl = options.baseUrl || platformTestUrl;
  const name = `shopping_test_platform_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: baseUrl, max: 2 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(baseUrl); url.pathname = `/${name}`;
  const platform = await openPlatformDatabase(url.href, { max: 3 });
  const integrationKeys = parseKeyFile(`k1=${randomBytes(32).toString('base64')}`), secretBox = createSecretBox(integrationKeys);
  const pool = createTenantPool({ secretBox, baseUrl, connectionsPerTenant: 3 });
  t.after(async () => {
    const tenants = await platform.all('SELECT database_name, database_role FROM tenant WHERE database_name IS NOT NULL');
    await pool.closeAll(); await platform.close();
    for (const row of tenants) {
      if (!/^t_[a-z0-9]{3,30}_[0-9a-f]{8}$/.test(row.database_name) || row.database_role !== row.database_name) throw new Error('Unexpected fixture artifact.');
      await admin.query(`DROP DATABASE IF EXISTS "${row.database_name}" WITH (FORCE)`); await admin.query(`DROP ROLE IF EXISTS "${row.database_role}"`);
    }
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end();
  });
  return { platform, pool, secretBox, integrationKeys, platformUrl: url.href, baseUrl, deps: { provisionerUrl: process.env.SHOP_TEST_PROVISIONER_URL || baseUrl, baseUrl, secretBox } };
}
