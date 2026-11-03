// Records, per surface (platform, seller, shop), the fingerprint of the files its Service Worker caches next to the version they
// belong to. Run after bumping a version (version.js and the worker's `version`).
//
// It refuses to record a surface whose cached files changed while its version did not, compared with the committed record
// (HEAD). Recording blindly would make the CI guard pass and installed browsers would never be offered the change.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { SURFACES, workerFingerprint, workerVersion } from '../test/helpers/shell-assets.js';

const file = new URL('../test/platform-shell.fingerprint.json', import.meta.url);
let committed = {};
try {
  committed = JSON.parse(execFileSync('git', ['show', 'HEAD:test/platform-shell.fingerprint.json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
} catch {
  try { committed = JSON.parse(readFileSync(file, 'utf8')); } catch { /* First record. */ }
}
const record = Object.fromEntries(SURFACES.map((surface) => [surface, { version: workerVersion(surface), fingerprint: workerFingerprint(surface) }]));
const stale = Object.entries(record).filter(([surface, { version, fingerprint }]) =>
  committed[surface] && committed[surface].version === version && committed[surface].fingerprint !== fingerprint).map(([surface]) => surface);
if (stale.length) {
  console.error(`Cached files changed without a version bump: ${stale.join(', ')}. Bump public/<surface>/version.js and sw.js, then run this again.`);
  process.exit(1);
}
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
for (const [surface, { version }] of Object.entries(record)) console.log(`recorded ${surface} ${version}`);
