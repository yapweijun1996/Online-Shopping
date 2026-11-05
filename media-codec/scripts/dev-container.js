import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, chmod, writeFile, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const exec = promisify(execFile);
export const DOCKER_HOST = 'unix:///var/run/docker.sock';
const dockerEnv = { ...process.env };
for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'BUILDX_BUILDER']) delete dockerEnv[name];
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
  const socketDir = join(base, 'socket'); await mkdir(socketDir, { mode: 0o730 }); await chmod(socketDir, 0o730);
  const tokenFile = join(base, 'token'); const token = randomBytes(32).toString('base64url');
  await writeFile(tokenFile, token, { mode: 0o640 }); await chmod(tokenFile, 0o640);
  const name = `shopping-codec-test-${randomBytes(8).toString('hex')}`;
  owned = name;
  const args = ['run', '-d', '--name', name, '--label', 'shopping.media-codec-owned=true', '--network=none',
    '--read-only', '--user=10001:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
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
      let socket;
      try { socket = await lstat(socketPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (socket?.isSocket() && socket.uid === 10001 && socket.gid === 1000 && (socket.mode & 0o7777) === 0o660) {
        // The worker cannot restore write access on this host-owned directory.
        // Never disclose a client/token until the trusted host finishes sealing.
        await chmod(socketDir, 0o710);
        const dir = await lstat(socketDir), sealedSocket = await lstat(socketPath), file = await lstat(tokenFile);
        if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== 1000 || dir.gid !== 1000 || (dir.mode & 0o7777) !== 0o710 ||
            !sealedSocket.isSocket() || sealedSocket.uid !== 10001 || sealedSocket.gid !== 1000 || (sealedSocket.mode & 0o7777) !== 0o660 ||
            sealedSocket.ino !== socket.ino || sealedSocket.dev !== socket.dev ||
            !file.isFile() || file.isSymbolicLink() || file.uid !== 1000 || file.gid !== 1000 || (file.mode & 0o7777) !== 0o640 || file.size !== 43 ||
            (await readdir(socketDir)).join(',') !== 'codec.sock') throw new Error('Invalid sealed codec filesystem.');
        return { id, image, name, socketPath, token, stop, socketDir, tokenFile };
      }
      if (await docker(['inspect', '--format={{.State.Running}}', id]) !== 'true') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Codec did not become ready.');
  } catch (error) { await stop(); throw error; }
}
