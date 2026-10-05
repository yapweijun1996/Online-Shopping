import { after } from 'node:test';
import { openDatabase } from '../../src/db.js';

/*
 * Opens a fresh store for a test. SQLite in memory by default; when PGTEST_HOST is set the
 * same tests run against a real PostgreSQL database. One connection is kept for the whole test
 * file (as the server does) and the public schema is recreated for each test.
 */
let postgresStore = null;

export async function openTestStore(t) {
  if (!process.env.PGTEST_HOST) {
    const store = openDatabase(':memory:');
    t.after(() => store.close());
    return store;
  }
  if (!postgresStore) {
    const { openPostgresStore } = await import('../../src/postgres-store.js');
    const config = { pgHost: process.env.PGTEST_HOST, pgPort: Number(process.env.PGTEST_PORT || 5432),
      pgDatabase: process.env.PGTEST_DATABASE, pgUser: process.env.PGTEST_USER, pgPasswordFile: process.env.PGTEST_PASSWORD_FILE };
    // The store creates the schema when it opens on an empty database.
    const { createRequire } = await import('node:module');
    const { readFileSync } = await import('node:fs');
    const NativeClient = createRequire(import.meta.url)('pg-native');
    const reset = new NativeClient();
    reset.connectSync(`host=${config.pgHost} port=${config.pgPort} dbname=${config.pgDatabase} user=${config.pgUser} password=${readFileSync(config.pgPasswordFile, 'utf8').trim()}`);
    reset.querySync('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await new Promise((resolve) => reset.end(resolve));
    postgresStore = openPostgresStore(config);
    after(async () => { await postgresStore.close(); postgresStore = null; });
    return postgresStore;
  }
  const { initializePostgresSchema } = await import('../../src/postgres-schema.js');
  postgresStore.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  initializePostgresSchema((sql) => postgresStore.all(sql));
  return postgresStore;
}

export const usingPostgres = Boolean(process.env.PGTEST_HOST);
