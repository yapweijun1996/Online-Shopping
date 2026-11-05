import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { decodeViaSocket } from '../src/mcp/media-codec-client.js';

test('portable codec client rejects pre-aborted work without connecting', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(decodeViaSocket({ socketPath: '/nonexistent/synthetic.sock', token: 'A'.repeat(43),
    bytes: Buffer.from('synthetic source'), mime: 'image/png', signal: controller.signal }), { code: 'CANCELLED' });
});
test('portable codec client abort destroys only its in-flight Unix socket', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shopping-codec-cancel-')), socketPath = join(dir, 'codec.sock');
  const server = http.createServer(), peers = new Set();
  t.after(async () => { for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  server.on('connection', socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); });
  server.listen(socketPath); await once(server, 'listening');
  const arrived = once(server, 'request'), controller = new AbortController();
  const pending = decodeViaSocket({ socketPath, token: 'A'.repeat(43), bytes: Buffer.from('synthetic source'),
    mime: 'image/png', signal: controller.signal });
  const [request] = await arrived, closed = once(request.socket, 'close');
  controller.abort(); await assert.rejects(pending, { code: 'CANCELLED' }); await closed;
  assert.equal(request.socket.destroyed, true);
  const healthy = once(server, 'request');
  const other = http.request({ socketPath, path: '/synthetic-health' }); other.end();
  const [, response] = await healthy; response.end('ok');
  const [reply] = await once(other, 'response'); reply.resume(); await once(reply, 'end');
  assert.equal(reply.statusCode, 200);
});
