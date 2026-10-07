// Upgrades the production database schema as the database owner. Run by deploy/auto-update.py inside the
// candidate backend image, on the private network, with the owner password mounted read-only.
// The upgrade is one transaction: any failure leaves the database untouched. Prints {"version": N}.
import { readFileSync } from 'node:fs';
import { openPostgresDatabase } from '/app/src/postgres-db.js';

const password = readFileSync(process.env.OWNER_PASSWORD_FILE || '/run/secrets/owner', 'utf8').replace(/\r?\n$/, '');
const url = `postgresql://online_shopping:${encodeURIComponent(password)}@postgres:5432/online_shopping`;
const store = await openPostgresDatabase(url, { allowUpgrade: true });
try {
  console.log(JSON.stringify({ version: await store.schemaVersion() }));
} finally {
  await store.close();
}
