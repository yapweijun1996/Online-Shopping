// A separate real provisioner process for the isolated kill-midway drill.
import { readConfig } from '../src/config.js';
import { createSecretBox } from '../src/secret-box.js';
import { openPlatformDatabase } from '../src/platform/platform-db.js';
import { createTenant } from '../src/platform/provisioner.js';
if (process.env.QA_REHEARSAL !== '1' || process.env.PLATFORM_ADMIN_USERNAME !== 'fixtureadmin' ||
    !/^admin\.gmb01\.xyz:\d{4,5}$/.test(process.env.PLATFORM_ADMIN_HOST || '') || !/^drillkill[a-z0-9]+$/.test(process.argv[2] || '')) {
  throw new Error('Explicit isolated provisioner drill required.');
}
console.log(JSON.stringify({ pid: process.pid }));
let platform;
try {
  const config = readConfig(); platform = await openPlatformDatabase(config.platform.databaseUrl);
  await createTenant(platform, { secretBox: createSecretBox(config.integrationKeys), provisionerUrl: config.platform.provisionerUrl, baseUrl: config.platform.databaseUrl },
    { code: process.argv[2], name: 'Fictional interrupted provisioner', currency: 'MYR', sellerUsername: process.argv[2] + '.owner' }, 'fixture');
  console.log('Provisioner finished');
} catch { console.error('Provisioner drill failed'); process.exitCode = 1; }
finally { await platform?.close(); }
