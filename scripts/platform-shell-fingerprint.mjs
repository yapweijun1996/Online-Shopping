// Records the fingerprint of the cached platform shell next to the version it belongs to. Run after bumping the version.
import { readFileSync, writeFileSync } from 'node:fs';
import { shellFingerprint } from '../test/helpers/shell-assets.js';

const version = readFileSync(new URL('../public/platform/version.js', import.meta.url), 'utf8').match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
if (!version) throw new Error('APP_VERSION not found');
writeFileSync(new URL('../test/platform-shell.fingerprint.json', import.meta.url), `${JSON.stringify({ version, fingerprint: shellFingerprint() }, null, 2)}\n`);
console.log(`recorded ${version}`);
