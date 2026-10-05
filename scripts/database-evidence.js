import pg from 'pg';
import { readConfig } from '../src/config.js';
import { importTables, rowsDigest } from '../src/sqlite-import.js';

const pool = new pg.Pool({ connectionString: readConfig().databaseUrl, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot = process.argv.includes('--hold-snapshot') ? (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id : null;
  const version = Number((await client.query('SELECT version FROM schema_meta WHERE id = 1')).rows[0]?.version);
  const columns = (await client.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`)).rows;
  const tables = [];
  for (const table of importTables) {
    const rows = (await client.query(`SELECT * FROM ${table}`)).rows;
    tables.push({ table, rows: rows.length, sha256: rowsDigest(rows) });
  }
  console.log(JSON.stringify({ snapshot, schemaVersion: version, schemaSha256: rowsDigest(columns), tables }));
  if (snapshot) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Snapshot lease expired.')), 120000);
      process.stdin.once('data', () => { clearTimeout(timer); resolve(); });
      process.stdin.once('end', () => { clearTimeout(timer); resolve(); });
      process.stdin.resume();
    });
    process.stdin.pause();
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Database evidence failed:', error.code || error.name);
  process.exitCode = 1;
} finally { client.release(); await pool.end(); }
