import { readFile } from 'node:fs/promises';
import { openPostgresStore } from './postgres-store.js';
import { SCHEMA_VERSION } from './db.js';

export async function openPostgresDatabase(url, options) {
  const store = openPostgresStore(url, options);
  try {
    await store.transaction(async () => {
      const exists = await store.get("SELECT to_regclass('public.schema_meta') AS name");
      if (!exists.name) {
        const tables = await store.all("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
        if (tables.length) throw new Error('PostgreSQL baseline requires an empty database.');
        await store.exec(await readFile(new URL('./postgres/schema.sql', import.meta.url), 'utf8'));
      }
      const version = await store.schemaVersion();
      if (version !== SCHEMA_VERSION) throw new Error(`Unsupported database schema version ${version}.`);
    });
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}
