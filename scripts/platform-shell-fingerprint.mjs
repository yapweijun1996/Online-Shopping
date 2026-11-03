// Records, per surface (platform, seller, shop), the fingerprint of the files its Service Worker caches next to the version they
// belong to. Run after bumping a version (version.js and the worker's `version`).
import { writeFileSync } from 'node:fs';
import { SURFACES, workerFingerprint, workerVersion } from '../test/helpers/shell-assets.js';

const record = Object.fromEntries(SURFACES.map((surface) => [surface, { version: workerVersion(surface), fingerprint: workerFingerprint(surface) }]));
writeFileSync(new URL('../test/platform-shell.fingerprint.json', import.meta.url), `${JSON.stringify(record, null, 2)}\n`);
for (const [surface, { version }] of Object.entries(record)) console.log(`recorded ${surface} ${version}`);
