import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { developmentBuild, requireLocalBuilder } from './build-options.js';
import { docker } from './dev-container.js';

// Only the dependency fetch/build may use the normal TLS-verified network path.
const root = fileURLToPath(new URL('../..', import.meta.url));
const { env, args } = developmentBuild(root);
// Explicit local endpoint plus the implicit docker-driver builder prevent a saved remote builder.
requireLocalBuilder(await docker(['buildx', 'inspect', 'default']));
const child = spawn('docker', args, { env, stdio: 'inherit' });
const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
if (code !== 0) process.exit(code ?? 1);
const image = await docker(['image', 'inspect', '--format={{.Id}}', 'shopping-media-codec-dev:local']);
await mkdir(resolve(root, '.local'), { recursive: true, mode: 0o700 });
await writeFile(resolve(root, '.local/media-codec-image-id'), `${image}\n`, { mode: 0o600 });
process.stdout.write(`Owned development codec image: ${image}\n`);
