import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { cleanupOAuth } from '../src/mcp/cleanup.js';

const passes = Number(process.argv[2] ?? 100);
if (!Number.isInteger(passes) || passes < 1 || passes > 1000) throw new Error('Usage: node scripts/cleanup-seller-mcp.js [passes:1-1000]');
const config = readConfig();
const store = config.databaseUrl ? await openPostgresDatabase(config.databaseUrl) : await openDatabase(config.dbPath);
try {
  for (let i = 0; i < passes; i++) await cleanupOAuth(store);
  console.log(JSON.stringify({ cleanupPasses: passes }));
} finally { await store.close(); }
