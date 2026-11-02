// Exercise only the restored database while the real backend remains paused.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

export async function restoreSmoke(config) {
  const directory = mkdtempSync(join(tmpdir(), 'online-shopping-restore-smoke-'));
  let app;
  try {
    app = await createApp({ ...config, platform: null, maintenancePath: join(directory, 'maintenance') });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + app.server.address().port;
    for (const path of ['/ready', '/api/v1/products']) {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('Restore smoke failed.');
      await response.arrayBuffer();
    }
  } finally {
    if (app) await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await restoreSmoke(readConfig()); }
  catch (error) { console.error('Restore smoke failed:', error?.code || error?.name || 'ERROR'); process.exitCode = 1; }
}
