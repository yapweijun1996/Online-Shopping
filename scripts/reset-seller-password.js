// Recovery on the server: sets a temporary password for a seller account (the Owner included) and ends its sessions.
// The person must choose a new password at the next sign-in (not on a quick sign-in site, where passwords cannot be changed). The password is read from the environment, never from
// the command line, so it does not end up in the shell history or the process list.
//
//   docker compose exec -e NEW_SELLER_PASSWORD='a long temporary password' backend node scripts/reset-seller-password.js owner
import { readConfig } from '../src/config.js';
import { resetPasswordFromHost } from '../src/accounts.js';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';

const username = process.argv[2];
const password = process.env.NEW_SELLER_PASSWORD;
if (!username || !password) {
  console.error('Usage: NEW_SELLER_PASSWORD=... node scripts/reset-seller-password.js <username>');
  process.exit(2);
}
const config = readConfig(process.env);
const store = config.databaseUrl ? await openPostgresDatabase(config.databaseUrl) : await openDatabase(config.dbPath);
try {
  console.log(`Temporary password set for ${await resetPasswordFromHost(store, username, password, { forceChange: !config.sellerQuickLogin })}.${config.sellerQuickLogin ? '' : ' They must change it at the next sign-in.'}`);
} catch (error) {
  console.error(`Could not reset: ${error.message}`);
  process.exitCode = 1;
} finally {
  await store.close();
}
