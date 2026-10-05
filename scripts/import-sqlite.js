import { openDatabase } from '../src/db.js';
import { openPostgresDatabase } from '../src/postgres-db.js';
import { readConfig } from '../src/config.js';
import { importSqlite } from '../src/sqlite-import.js';
import { stat } from 'node:fs/promises';

const snapshot = process.argv[2];
if (!snapshot || !(await stat(snapshot)).isFile()) throw new Error('Supply an existing isolated SQLite snapshot.');
const config = readConfig();
if (!config.databaseUrl) throw new Error('PostgreSQL configuration is required.');
const source = await openDatabase(snapshot);
let target;
try {
  target = await openPostgresDatabase(config.databaseUrl);
  console.log(JSON.stringify(await importSqlite(source, target), null, 2));
} catch (error) {
  console.error('Import failed:', error.code || error.name);
  process.exitCode = 1;
} finally {
  await source.close();
  if (target) await target.close();
}
