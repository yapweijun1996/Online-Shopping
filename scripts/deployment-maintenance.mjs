// Host operator helper: no HTTP control endpoint and no credential argument.
import { writeFileSync, rmSync } from 'node:fs';
import { MAINTENANCE_FILE } from '../src/deployment-maintenance.js';
const action = process.argv[2];
if (!['enter','exit'].includes(action)) throw new Error('Use enter or exit.');
if (action === 'exit') { rmSync(MAINTENANCE_FILE, { force: true }); console.log(JSON.stringify({ paused: false })); }
else {
  writeFileSync(MAINTENANCE_FILE, 'paused\n', { mode: 0o600 });
  const deadline = Date.now() + 180_000;
  let drained = false;
  while (Date.now() < deadline) {
    const response = await fetch(process.env.MAINTENANCE_HEALTH_URL || 'http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(5000) });
    const result = await response.json();
    if (!result.maintenance?.enabled) throw new Error('Backend does not support deployment maintenance.');
    if (result.maintenance.inFlight === 0 && result.maintenance.workerIdle && result.maintenance.platformIdle) { drained = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!drained) throw new Error('Backend writes did not drain.');
  console.log(JSON.stringify({ paused: true, drained: true }));
}
