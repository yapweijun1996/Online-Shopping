// Disposable rehearsal database fixtures only. Credentials are read in-container and never printed.
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { createSecretBox } from '../src/secret-box.js';
import { openPlatformDatabase } from '../src/platform/platform-db.js';
import { openPostgresStore } from '../src/postgres-store.js';
import { createCategory } from '../src/settings.js';
import { createProduct } from '../src/products.js';
import { createTenant, tenantUrl } from '../src/platform/provisioner.js';

if (process.env.QA_REHEARSAL !== '1' || !process.env.HOSTNAME) throw new Error('Explicit isolated rehearsal required.');
const config = readConfig(), platform = await openPlatformDatabase(config.platform.databaseUrl), secretBox = createSecretBox(config.integrationKeys);
const mode = process.argv[2];
try {
  for (const code of mode === 'seed' ? ['alpha', 'bravo'] : ['alpha', 'bravo', 'charlie']) {
    if (!await platform.get('SELECT id FROM tenant WHERE code = ?', code)) await createTenant(platform,
      { secretBox, provisionerUrl: config.platform.provisionerUrl, baseUrl: config.platform.databaseUrl },
      { code, name: 'Fictional ' + code, currency: 'MYR', sellerUsername: code + '.owner' }, 'fixture');
  }
  const shops = await platform.all("SELECT * FROM tenant WHERE is_default = 0 ORDER BY code");
  for (const shop of shops) {
    const password = secretBox.open(shop.database_password_sealed, shop.database_key_id, `TENANT_DB:${shop.id}`);
    const store = openPostgresStore(tenantUrl(config.platform.databaseUrl, { database: shop.database_name, role: shop.database_role, password }));
    try {
      if (mode === 'seed' || mode === 'older') {
        if (!await store.get("SELECT id FROM product WHERE sku='FICTIONAL-1'")) {
          if (!await store.get("SELECT code FROM category WHERE code='FIXTURE'")) await createCategory(store, { code: 'FIXTURE', label: 'Fictional goods' });
          await createProduct(store, { sku: 'FICTIONAL-1', name: 'Fictional ' + shop.code + ' item', description: 'Synthetic backup verification item', category: 'FIXTURE', priceMinor: 1200, currency: 'MYR', active: true });
        }
      }
      if (mode === 'older') {
        await store.setSchemaVersion(23);
        if (shop.code === 'bravo') {
          await store.exec('ALTER TABLE product_gallery_image DROP CONSTRAINT IF EXISTS fixture_upgrade_failure');
          await store.exec('ALTER TABLE product_gallery_image ADD CONSTRAINT fixture_upgrade_failure CHECK (position > 0)');
        }
      } else if (mode === 'verify-failure') {
        assert.equal(await store.schemaVersion(), 23);
        if (shop.code === 'alpha') assert.equal((await store.get("SELECT has_table_privilege('online_shopping_app','public.option_type','SELECT') AS allowed")).allowed, false);
      } else if (mode === 'repair') {
        if (shop.code === 'bravo') await store.exec('ALTER TABLE product_gallery_image DROP CONSTRAINT IF EXISTS fixture_upgrade_failure');
        await store.setSchemaVersion(24);
      }
    } finally { await store.close(); }
  }
  console.log(JSON.stringify({ mode, shops: shops.map(({ code, database_name }) => ({ code, database: database_name })) }));
} finally { await platform.close(); }
