import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as shared from '../../src/mcp/media-codec-wire.js';
import * as wrapper from '../src/contract.js';
import { decodeViaSocket } from '../../src/mcp/media-codec-client.js';
import { decodeViaSocket as wrappedClient } from '../src/client.js';
import { developmentBuild, requireLocalBuilder } from '../scripts/build-options.js';
import { image } from './fixtures.js';
import { decodeImage } from '../src/decode.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
test('private worker re-exports the actual shared wire and transport without parallel validation', () => {
  assert.deepEqual(Object.keys(wrapper), Object.keys(shared));
  for (const key of Object.keys(shared)) assert.equal(wrapper[key], shared[key]);
  assert.equal(wrappedClient, decodeViaSocket);
});
test('shared production-only modules validate a real codec frame without Sharp or private package', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codec-portable-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'src/mcp'), { recursive: true });
  for (const file of ['media-codec-wire.js', 'media-codec-client.js']) await cp(join(root, 'src/mcp', file), join(dir, 'src/mcp', file));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  const bytes = await image();
  const result = await decodeImage(bytes, shared.MIME.png, shared.sha256(bytes));
  await writeFile(join(dir, 'frame'), shared.encodeOutput(result));
  const program = `import assert from 'node:assert/strict';import fs from 'node:fs/promises';
    import {decodeOutput} from './src/mcp/media-codec-wire.js';import {decodeViaSocket} from './src/mcp/media-codec-client.js';
    assert.throws(()=>import.meta.resolve('sharp'),{code:'ERR_MODULE_NOT_FOUND'});
    await assert.rejects(fs.access('media-codec'));
    const result=decodeOutput(await fs.readFile('frame'),'${shared.sha256(bytes)}');
    assert.equal(result.width,24);assert.equal(typeof decodeViaSocket,'function');console.log('portable modules verified');`;
  const run = await exec(process.execPath, ['--input-type=module', '-e', program], { cwd: dir,
    env: { ...process.env, MCP_V2_MEDIA_CODEC_DESCRIPTOR_FILE: '/nonexistent/never-read-on-import' } });
  assert.equal(run.stdout.trim(), 'portable modules verified');
});
test('build cannot inherit a remote endpoint/context/builder and preserves TLS proxy credential selectors', () => {
  const source = { DOCKER_HOST: 'tcp://remote.invalid', DOCKER_CONTEXT: 'remote', DOCKER_TLS: '1',
    DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/remote/certs', BUILDX_BUILDER: 'remote-builder',
    DOCKER_CONFIG: '/trusted/docker', HTTP_PROXY: 'http://proxy:8080', HTTPS_PROXY: 'http://proxy:8080',
    CODEX_PROXY_CERT: '/trusted/public-ca.pem' };
  const { args, env } = developmentBuild('/trusted/repo', source);
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'BUILDX_BUILDER']) assert.equal(env[key], undefined);
  for (const key of ['DOCKER_CONFIG', 'HTTP_PROXY', 'HTTPS_PROXY', 'CODEX_PROXY_CERT']) assert.equal(env[key], source[key]);
  assert.deepEqual(args.slice(0, 5), ['--host=unix:///var/run/docker.sock', 'buildx', 'build', '--builder=default', '--load']);
  assert.equal(args.at(-1), '/trusted/repo');
  assert.equal(args[args.indexOf('--file') + 1], '/trusted/repo/media-codec/Dockerfile');
  assert.equal(args[args.indexOf('--secret') + 1], 'id=proxy_ca,src=/trusted/public-ca.pem');
  requireLocalBuilder('Name: default\nDriver: docker\nNodes:\nEndpoint: default\nStatus: running\n');
  for (const report of ['Driver: docker-container\nEndpoint: default', 'Driver: docker\nEndpoint: tcp://remote.invalid',
    'Driver: docker\nEndpoint: default\nEndpoint: unix:///var/run/docker.sock', 'Endpoint: default']) {
    assert.throws(() => requireLocalBuilder(report), /requires the local default/);
  }
});
test('production-shaped backend starts flag-off with neither private codec nor Sharp present', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codec-backend-')); t.after(() => rm(dir, { recursive: true, force: true }));
  // Match Dockerfile.backend inputs, with installed real backend dependencies, no native codec package.
  await cp(join(root, 'src'), join(dir, 'src'), { recursive: true });
  await cp(join(root, 'node_modules'), join(dir, 'node_modules'), { recursive: true, dereference: true });
  await cp(join(root, 'package.json'), join(dir, 'package.json'));
  await mkdir(join(dir, 'public/shared'), { recursive: true });
  for (const file of ['order-status.js', 'integration-catalog.js', 'sender-fields.js']) await cp(join(root, 'public/shared', file), join(dir, 'public/shared', file));
  await cp(join(root, 'public/setup'), join(dir, 'public/setup'), { recursive: true });
  const program = `import assert from 'node:assert/strict';import fs from 'node:fs/promises';
    import {readConfig} from './src/config.js';import {openDatabase} from './src/db.js';import {createApi} from './src/app.js';
    assert.throws(()=>import.meta.resolve('sharp'),{code:'ERR_MODULE_NOT_FOUND'});await assert.rejects(fs.access('media-codec'));
    const config=readConfig({NODE_ENV:'test',SHOP_MODE:'manual',ADMIN_USERNAME:'codec-owner',ADMIN_PASSWORD:'CodecOnlySynthetic123456',PUBLIC_ORIGIN:'https://codec.invalid',MCP_ENABLED:'0',MCP_V2_ENABLED:'0'});
    assert.equal(config.mcpEnabled,false);assert.equal(config.mcpV2.enabled,false);
    const store=await openDatabase(':memory:');try{const api=await createApi({store,config});
      assert.equal((await api(new Request('https://codec.invalid/health'))).status,200);
      assert.equal((await api(new Request('https://codec.invalid/.well-known/oauth-authorization-server'))).status,404);
      console.log('flag-off backend started');}finally{await store.close();}`;
  const run = await exec(process.execPath, ['--input-type=module', '-e', program], { cwd: dir, timeout: 15000, maxBuffer: 16384 });
  assert.equal(run.stdout.trim(), 'flag-off backend started');
});
test('root-context build is denied by default and copies only the private runtime and exact shared modules', async () => {
  const ignore = await readFile(join(root, 'media-codec/Dockerfile.dockerignore'), 'utf8');
  assert.equal(ignore.split('\n').find(line => line && !line.startsWith('#')), '**');
  const sharedExceptions = ignore.split('\n').filter(line => line.startsWith('!src/') && line.endsWith('.js'));
  assert.deepEqual(sharedExceptions.sort(), ['!src/mcp/media-codec-client.js', '!src/mcp/media-codec-wire.js']);
  const dockerfile = await readFile(join(root, 'media-codec/Dockerfile'), 'utf8');
  assert.ok(dockerfile.includes('Bounded codec build context verified.'));
  assert.ok(!/^COPY\s+\.\s/m.test(dockerfile));
  assert.ok(!/^COPY\s+(?:src\/\s|package\.json)/m.test(dockerfile));
});
