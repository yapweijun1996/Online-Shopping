import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, chmod, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const exec = promisify(execFile);
export const DOCKER_HOST = 'unix:///var/run/docker.sock';
const dockerEnv = { ...process.env };
for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[name];
export async function docker(args, timeout = 20000) {
  try {
    return (await exec('docker', [`--host=${DOCKER_HOST}`, ...args],
      { env: dockerEnv, timeout, maxBuffer: 256 * 1024 })).stdout.trim();
  } catch { throw new Error(`Owned codec Docker command failed: ${args[0]}`); }
}
let owned;
export async function startContainer(image, { memoryMiB = 192, command = [] } = {}) {
  if (owned || !/^sha256:[a-f0-9]{64}$/.test(image) || ![96, 128, 192].includes(memoryMiB)) throw new Error('Invalid owned codec container.');
  if (process.getuid() !== 1000 || process.getgid() !== 1000) throw new Error('Development fixture requires uid/gid1000.');
  const base = await mkdtemp(join(tmpdir(), 'shopping-codec-'));
  await chmod(base, 0o700);
  const socketDir = join(base, 'socket'); await mkdir(socketDir, { mode: 0o700 });
  const tokenFile = join(base, 'token'); const token = randomBytes(32).toString('base64url');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const name = `shopping-codec-test-${randomBytes(8).toString('hex')}`;
  owned = name;
  const args = ['run', '-d', '--name', name, '--label', 'shopping.media-codec-owned=true', '--network=none',
    '--read-only', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--cgroupns=private', '--init', '--memory', `${memoryMiB}m`, '--memory-swap', `${memoryMiB}m`,
    '--cpus=0.5', '--pids-limit=32', '--shm-size=1m', '--ulimit=core=0:0', '--ulimit=nofile=64:64',
    '--restart=no', '--log-driver=none', '--mount', `type=bind,src=${socketDir},dst=/run/media-codec`,
    '--mount', `type=bind,src=${tokenFile},dst=/run/media-codec-token,readonly`];
  for (const proxy of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) args.push('--env', `${proxy}=`);
  args.push(image, ...command);
  let id;
  const stop = async () => {
    if (owned !== name) throw new Error('Codec ownership changed.');
    // run may create the container before its client times out; the owned nonce name still fences cleanup.
    try { await docker(['rm', '-f', id ?? name]); }
    finally { owned = undefined; await rm(base, { recursive: true, force: true }); }
  };
  try {
    id = await docker(args);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid container ID.');
    const socketPath = join(socketDir, 'codec.sock');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { if ((await lstat(socketPath)).isSocket()) return { id, image, name, socketPath, token, stop, socketDir, tokenFile }; }
      catch { /* Startup polling never logs credentials or native error text. */ }
      if (await docker(['inspect', '--format={{.State.Running}}', id]) !== 'true') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Codec did not become ready.');
  } catch (error) { await stop(); throw error; }
}
