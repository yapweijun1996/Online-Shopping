import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { Client } from '../src/client.js';
import { token } from './fixtures.mjs';
test('configuration refuses missing token and credential-bearing or non-HTTP URL', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qr-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'token'); await writeFile(file, token + '\nignored-line');
  const env = { WHATSAPP_QR_TOKEN_FILE: file };
  assert.equal(readConfig(env).token, token);
  assert.equal(readConfig(env).url, 'http://backend:3001/internal/whatsapp-qr');
  assert.throws(() => readConfig({}), /CONFIG_TOKEN/);
  for (const url of ['file:///tmp/x', 'http://user:secret@backend/', 'https://backend/?token=x', 'https://backend/#token']) assert.throws(() => readConfig({ ...env, WHATSAPP_QR_BACKEND_URL: url }), /CONFIG_URL/);
  await writeFile(file, 'short'); assert.throws(() => readConfig(env), /CONFIG_TOKEN/);
});
test('client refuses oversized response and redirects without following', async t => {
  let destinationCalls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/large') { res.end('x'.repeat(512 * 1024 + 1)); return; }
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/destination' }); res.end(); return; }
    destinationCalls++; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new Client({ url: `http://127.0.0.1:${server.address().port}`, token });
  await assert.rejects(client.request('/large'), { code: 'RESPONSE_LIMIT' });
  await assert.rejects(client.request('/redirect'), TypeError);
  assert.equal(destinationCalls, 0);
});
test('client echoes broker epoch and preserves explicit revocation without sensitive response text', async t => {
  const epochs = [];
  const server = http.createServer((request, response) => {
    epochs.push(request.headers['x-binding-epoch']);
    if (request.url === '/control') {
      response.writeHead(200, { 'x-binding-epoch': '19', 'content-type': 'application/json' });
      response.end('{"generation":2,"desired":"OFF"}');
    } else if (request.url === '/v1/stopped') {
      response.end('{"stopped":true}');
    } else {
      response.writeHead(403, { 'x-binding-epoch': request.url === '/later' ? '21' : '20', 'content-type': 'application/json' });
      response.end('{"error":"QR_REVOKED","private":"fictional-private"}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new Client({ url: `http://127.0.0.1:${server.address().port}`, token });
  await client.request('/control');
  await assert.rejects(client.request('/state', { generation: 2 }), error => error.code === 'QR_REVOKED' && error.message === 'QR_REVOKED');
  await assert.rejects(client.request('/later'), { code: 'QR_REVOKED' });
  await client.request('/v1/stopped', {});
  assert.deepEqual(epochs, [undefined, '19', '19', '20']);
});

test('stop acknowledgement never substitutes the last authorized epoch when revocation has no epoch', async t => {
  const epochs = [];
  const server = http.createServer((request, response) => {
    epochs.push(request.headers['x-binding-epoch']);
    if (request.url === '/control') {
      response.writeHead(200, { 'x-binding-epoch': '19' }); response.end('{}');
    } else if (request.url === '/v1/stopped') response.end('{}');
    else { response.writeHead(403); response.end('{"error":"QR_REVOKED"}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new Client({ url: `http://127.0.0.1:${server.address().port}`, token });
  await client.request('/control');
  await assert.rejects(client.request('/state', {}), { code: 'QR_REVOKED' });
  await client.request('/v1/stopped', {});
  assert.deepEqual(epochs, [undefined, '19', undefined]);
});
