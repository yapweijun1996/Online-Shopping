import { readConfig } from '../src/config.js';
import { createSecretBox } from '../src/secret-box.js';
import { openPlatformDatabase } from '../src/platform/platform-db.js';
import { createAdminAuth } from '../src/platform/admin-auth.js';

const password = process.env.NEW_PLATFORM_ADMIN_PASSWORD;
if (!password) {
  console.error('Set NEW_PLATFORM_ADMIN_PASSWORD in the host process environment.');
  process.exitCode = 2;
} else {
  let platform;
  try {
    const config = readConfig();
    if (!config.platform) throw new Error('Platform configuration is required.');
    platform = await openPlatformDatabase(config.platform.databaseUrl, { max: 1 });
    await createAdminAuth({ platform, secretBox: createSecretBox(config.integrationKeys) }).reset(password);
    console.log('Platform administrator reset. Enrol an authenticator at the next sign-in.');
  } catch (error) {
    console.error('Platform administrator reset failed:', error?.code || error?.name || 'ERROR');
    process.exitCode = 1;
  } finally { await platform?.close(); }
}
