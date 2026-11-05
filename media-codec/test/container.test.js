import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, lstat, readdir } from 'node:fs/promises';
import sharp from 'sharp';
import { image } from './fixtures.js';
import { docker, startContainer } from '../scripts/dev-container.js';
import { decodeViaSocket } from '../src/client.js';
import { MIME, sha256 } from '../src/contract.js';

// Explicit opt-in; absent image never touches Docker from the normal repository suite.
const enabled = process.env.MEDIA_CODEC_CONTAINER_TEST === '1';
async function imageId() {
  const value = (await readFile(new URL('../../.local/media-codec-image-id', import.meta.url), 'utf8')).trim();
  assert.match(value, /^sha256:[a-f0-9]{64}$/); return value;
}
async function stats(id) {
  const values = await docker(['exec', id, 'node', '--input-type=module', '-e',
    "import fs from 'node:fs';const r={};for(const k of ['memory.max','memory.swap.max','memory.peak','pids.max','cpu.max'])r[k]=fs.readFileSync('/sys/fs/cgroup/'+k,'utf8').trim();console.log(JSON.stringify(r));"]);
  return JSON.parse(values);
}
test('actual ARM64 Alpine codec is isolated, fully decodes max raster and enforces protocol', { skip: !enabled }, async t => {
  const fixture = await startContainer(await imageId()); t.after(fixture.stop);
  const details = JSON.parse(await docker(['inspect', fixture.id]))[0];
  const config = details.HostConfig;
  assert.equal(config.NetworkMode, 'none'); assert.equal(config.ReadonlyRootfs, true);
  assert.deepEqual(config.CapDrop, ['ALL']); assert.ok(config.SecurityOpt.includes('no-new-privileges:true'));
  assert.equal(config.Memory, 192 * 1024 * 1024); assert.equal(config.MemorySwap, config.Memory);
  assert.equal(config.PidsLimit, 32); assert.equal(config.NanoCpus, 500000000);
  assert.equal(config.LogConfig.Type, 'none'); assert.equal(details.Config.User, '10001:1000');
  assert.equal(details.Mounts.length, 2); assert.deepEqual(Object.keys(details.NetworkSettings.Ports ?? {}), []);
  assert.ok(details.Mounts.every(mount => [fixture.socketDir, fixture.tokenFile].includes(mount.Source)));
  const runtime = JSON.parse(await docker(['exec', fixture.id, 'node', '--input-type=module', '-e',
    "import fs from 'node:fs';import os from 'node:os';let readonly=false;try{fs.writeFileSync('/codec/forbidden','x')}catch(e){readonly=e.code==='EROFS'}console.log(JSON.stringify({uid:process.getuid(),arch:process.arch,network:Object.keys(os.networkInterfaces()),readonly,secrets:Object.keys(process.env).filter(k=>/DATABASE|PASSWORD|SECRET|ACCESS_KEY/.test(k)),proxy:Object.entries(process.env).filter(([k,v])=>/proxy/i.test(k)&&v).length}));"]));
  assert.deepEqual(runtime, { uid: 10001, arch: 'arm64', network: ['lo'], readonly: true, secrets: [], proxy: 0 });
  const dir = await lstat(fixture.socketDir), socket = await lstat(fixture.socketPath), token = await lstat(fixture.tokenFile);
  assert.deepEqual([dir.uid, dir.gid, dir.mode & 0o7777], [1000, 1000, 0o710]);
  assert.deepEqual([socket.uid, socket.gid, socket.mode & 0o7777], [10001, 1000, 0o660]);
  assert.deepEqual([token.uid, token.gid, token.mode & 0o7777], [1000, 1000, 0o640]);
  const sealed = JSON.parse(await docker(['exec', fixture.id, 'node', '--input-type=module', '-e',
    "import fs from 'node:fs';const denied={};for(const [name,work] of Object.entries({create:()=>fs.writeFileSync('/run/media-codec/forbidden','x'),mkdir:()=>fs.mkdirSync('/run/media-codec/forbidden-dir'),chmod:()=>fs.chmodSync('/run/media-codec',0o730),unlink:()=>fs.unlinkSync('/run/media-codec/codec.sock'),rename:()=>fs.renameSync('/run/media-codec/codec.sock','/run/media-codec/other.sock'),tokenWrite:()=>fs.writeFileSync('/run/media-codec-token','x')})){try{work();denied[name]=false}catch(e){denied[name]=['EACCES','EPERM','EROFS'].includes(e.code)}}console.log(JSON.stringify(denied));"]));
  assert.deepEqual(sealed, { create: true, mkdir: true, chmod: true, unlink: true, rename: true, tokenWrite: true });
  assert.deepEqual(await readdir(fixture.socketDir), ['codec.sock']);
  assert.equal((await lstat(fixture.socketDir)).mode & 0o7777, 0o710);
  for (const format of ['png', 'jpeg', 'webp']) {
    const bytes = await image(format, { width: 2048, height: 2048 });
    const result = await decodeViaSocket({ ...fixture, bytes, mime: MIME[format] });
    assert.equal(result.sourceSha256, sha256(bytes)); assert.equal(result.width * result.height, 4194304);
    assert.equal((await sharp(result.image).metadata()).format, format);
  }
  const bytes = await image('png', { width: 2049, height: 2048 });
  await assert.rejects(decodeViaSocket({ ...fixture, bytes, mime: MIME.png }), /CODEC_FAILED/);
  await assert.rejects(decodeViaSocket({ ...fixture, bytes: await image(), mime: MIME.png, token: 'A'.repeat(43) }), /CODEC_FAILED/);
  const limits = await stats(fixture.id);
  assert.equal(limits['memory.max'], String(192 * 1024 * 1024));
  assert.equal(limits['memory.swap.max'], '0'); assert.equal(limits['pids.max'], '32');
  assert.ok(Number(limits['memory.peak']) < Number(limits['memory.max']));
  t.diagnostic(JSON.stringify({ image: fixture.image, enforced: limits, runtime }));
});

async function parentApi(t, fixture) {
  const bytes = await image(); const pid = process.pid; let healthCalls = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === '/health') { response.end(JSON.stringify({ pid, healthCalls: ++healthCalls })); return; }
    try { await decodeViaSocket({ ...fixture, bytes, mime: MIME.png }); response.end('decoded'); }
    catch { response.writeHead(503); response.end('CODEC_UNAVAILABLE'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, pid };
}
for (const failure of ['crash', 'oom']) {
  test(`owned codec genuine ${failure} leaves synthetic parent API alive and fails closed`, { skip: !enabled }, async t => {
    // Only a controlled allocation test. No malformed-image exploit or host allocation.
    const oomCommand = ['node', '--max-old-space-size=16', '--input-type=module', '-e',
      "await import('./src/main.js');setTimeout(()=>{const retained=[];setInterval(()=>retained.push(Buffer.alloc(8*1024*1024,1)),20)},1500);"];
    const fixture = await startContainer(await imageId(), { command: failure === 'oom' ? oomCommand : [] });
    t.after(fixture.stop);
    const parent = await parentApi(t, fixture);
    assert.equal((await fetch(`${parent.base}/decode`)).status, 200);
    const before = await (await fetch(`${parent.base}/health`)).json();
    if (failure === 'crash') await docker(['kill', '--signal=KILL', fixture.id]);
    const exit = Number(await docker(['wait', fixture.id], 15000));
    const state = JSON.parse(await docker(['inspect', '--format={{json .State}}', fixture.id]));
    assert.equal(exit, 137); assert.equal(state.OOMKilled, failure === 'oom');
    assert.equal((await fetch(`${parent.base}/decode`)).status, 503);
    const after = await (await fetch(`${parent.base}/health`)).json();
    assert.equal(after.pid, parent.pid); assert.equal(after.healthCalls, before.healthCalls + 1);
    t.diagnostic(JSON.stringify({ failure, exit, oomKilled: state.OOMKilled, parentAlive: after.pid === before.pid }));
  });
}
test('five-second total watchdog terminates an unfinished codec job and its whole process', { skip: !enabled }, async t => {
  const command = ['node', '--input-type=module', '-e',
    "import {startCodec} from './src/server.js';await startCodec({socketPath:'/run/media-codec/codec.sock',tokenFile:'/run/media-codec-token',decode:()=>new Promise(()=>{})});"];
  const fixture = await startContainer(await imageId(), { command }); t.after(fixture.stop);
  const parent = await parentApi(t, fixture); const started = Date.now();
  assert.equal((await fetch(`${parent.base}/decode`)).status, 503);
  assert.equal(Number(await docker(['wait', fixture.id], 5000)), 70);
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs >= 4500 && elapsedMs < 6500);
  assert.equal((await (await fetch(`${parent.base}/health`)).json()).pid, parent.pid);
  t.diagnostic(JSON.stringify({ deadlineMs: 5000, elapsedMs, exit: 70, parentAlive: true }));
});
