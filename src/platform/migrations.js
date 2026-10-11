// Platform version 1 is the baseline. Later versions are sequential, numbered SQL migrations.
import { readFile, readdir } from 'node:fs/promises';
import { PLATFORM_SCHEMA_VERSION } from './platform-db.js';

export async function upgradePlatformSchema(store, { targetVersion = PLATFORM_SCHEMA_VERSION, directory = new URL('./migrations/', import.meta.url) } = {}) {
  return store.transaction(async () => {
    const exists = (await store.get("SELECT to_regclass('public.schema_meta') AS name")).name;
    if (!exists) {
      if ((await store.all("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).length) throw new Error('The platform database must start empty.');
      await store.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    }
    let version = await store.schemaVersion();
    if (!Number.isInteger(version) || version < 1 || version > targetVersion) throw new Error('Unsupported platform schema version.');
    const names = await readdir(directory).catch((error) => { if (error.code === 'ENOENT' && version === targetVersion) return []; throw error; });
    while (version < targetVersion) {
      const next = version + 1, matches = names.filter((name) => new RegExp(`^${String(next).padStart(3, '0')}-[a-z0-9-]+\\.sql$`).test(name));
      if (matches.length !== 1) throw new Error('Platform migration is missing or ambiguous.');
      await store.exec(await readFile(new URL(matches[0], directory), 'utf8'));
      await store.run('UPDATE schema_meta SET version = ? WHERE id = 1 AND version = ?', next, version);
      if (await store.schemaVersion() !== next) throw new Error('Platform migration version check failed.');
      version = next;
    }
    return version;
  });
}
