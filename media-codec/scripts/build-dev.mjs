import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only the dependency fetch/build may use the normal TLS-verified network path.
const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env };
for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[name];
const args = ['--host=unix:///var/run/docker.sock', 'build', '--progress=plain',
  '--tag=shopping-media-codec-dev:local'];
if (process.env.CODEX_PROXY_CERT) {
  args.push('--secret', `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT}`);
}
args.push(root);
const child = spawn('docker', args, { env, stdio: 'inherit' });
const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
if (code !== 0) process.exit(code ?? 1);
const { docker } = await import('./dev-container.js');
const image = await docker(['image', 'inspect', '--format={{.Id}}', 'shopping-media-codec-dev:local']);
await mkdir(resolve(root, '../.local'), { recursive: true, mode: 0o700 });
await writeFile(resolve(root, '../.local/media-codec-image-id'), `${image}\n`, { mode: 0o600 });
process.stdout.write(`Owned development codec image: ${image}\n`);
