import http from 'node:http';
import { chmod, lstat, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { CodecError, MAX_SOURCE, TOTAL_MS, encodeOutput } from './contract.js';

const ALLOWED_HEADERS = new Set(['authorization', 'content-type', 'content-length', 'x-source-sha256', 'host', 'connection']);
function reply(response, status, code) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
  response.end(JSON.stringify({ error: code }));
}

/** Only the executable entry loads sharp; the HTTP boundary is independently testable. */
export function createCodecServer({ token, decode, fatal = () => process.exit(70), totalMs = TOTAL_MS }) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || typeof decode !== 'function' ||
      !Number.isInteger(totalMs) || totalMs < 1 || totalMs > TOTAL_MS) throw new TypeError('Invalid codec configuration.');
  const expected = Buffer.from(`Bearer ${token}`);
  let active = false;
  const queue = [];
  const server = http.createServer({ maxHeaderSize: 4096 }, (request, response) => {
    // Reject duplicate/extra headers before reading any binary data.
    const names = request.rawHeaders.filter((_, index) => index % 2 === 0).map(name => name.toLowerCase());
    const presented = Buffer.from(request.headers.authorization ?? '');
    if (names.length !== new Set(names).size || names.some(name => !ALLOWED_HEADERS.has(name)) ||
        expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      reply(response, 401, 'UNAUTHORIZED'); return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/decode') { reply(response, 404, 'NOT_FOUND'); return; }
    const size = request.headers['content-length'];
    const mime = request.headers['content-type'];
    const digest = request.headers['x-source-sha256'];
    if (!/^[1-9]\d{0,5}$/.test(size ?? '') || Number(size) > MAX_SOURCE ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(mime) || !/^[a-f0-9]{64}$/.test(digest ?? '')) {
      reply(response, 400, 'INVALID_IMAGE'); return;
    }
    if ((active ? 1 : 0) + queue.length >= 5) { reply(response, 503, 'BUSY'); return; }
    const job = { request, response, size: Number(size), mime, digest,
      body: Buffer.allocUnsafe(Number(size)), received: 0, ready: false, done: false };
    request.socket.codecJob = job;
    const finish = () => {
      if (job.done) return;
      job.done = true; clearTimeout(job.timer); job.body = undefined;
      const index = queue.indexOf(job); if (index !== -1) queue.splice(index, 1);
      if (job.running) active = false;
      pump();
    };
    job.timer = setTimeout(() => {
      reply(response, 408, 'DEADLINE');
      // Native work cannot be safely returned to the pool after a wall deadline.
      if (job.running) fatal();
      else { finish(); request.destroy(); }
    }, Math.max(1, Math.min(totalMs, request.socket.codecDeadline - performance.now())));
    job.timer.unref();
    request.on('data', chunk => {
      if (job.done) return;
      if (job.received + chunk.length > job.size) { reply(response, 400, 'INVALID_IMAGE'); finish(); request.destroy(); }
      else { chunk.copy(job.body, job.received); job.received += chunk.length; }
    });
    request.on('end', () => {
      if (job.done) return;
      if (job.received !== job.size) { reply(response, 400, 'INVALID_IMAGE'); finish(); return; }
      job.ready = true; pump();
    });
    request.on('error', () => { if (!job.running) finish(); });
    response.on('close', () => { if (!job.running) finish(); });
    queue.push(job); pump();
    function pump() {
      if (active) return;
      const next = queue[0];
      // FIFO includes bounded body upload and queue time in the same deadline.
      if (!next || !next.ready || next.done) return;
      queue.shift(); active = true; next.running = true;
      Promise.resolve().then(() => {
        const bytes = next.body; next.body = undefined;
        return decode(bytes, next.mime, next.digest);
      })
        .then(result => {
          const bytes = encodeOutput(result);
          if (!next.response.destroyed) {
            next.response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length,
              'cache-control': 'no-store', connection: 'close' });
            next.response.end(bytes);
          }
        }, () => reply(next.response, 400, 'INVALID_IMAGE'))
        .catch(() => reply(next.response, 500, 'CODEC_FAILED'))
        .finally(next.finish);
    }
    job.finish = finish;
  });
  server.maxConnections = 8;
  server.headersTimeout = TOTAL_MS;
  server.requestTimeout = TOTAL_MS;
  server.keepAliveTimeout = 1;
  server.on('connection', socket => {
    socket.codecDeadline = performance.now() + totalMs;
    const timer = setTimeout(() => {
      if (socket.codecJob?.running && !socket.codecJob.done) fatal();
      socket.destroy();
    }, totalMs);
    timer.unref(); socket.once('close', () => clearTimeout(timer));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

export async function startCodec({ socketPath, tokenFile, decode }) {
  const dir = await lstat(dirname(socketPath));
  const file = await lstat(tokenFile);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700 ||
      dir.uid !== process.getuid() || !file.isFile() || file.isSymbolicLink() ||
      (file.mode & 0o777) !== 0o600 || file.uid !== process.getuid() || file.size !== 43) throw new CodecError('CONFIGURATION');
  const token = await readFile(tokenFile, 'utf8');
  const server = createCodecServer({ token, decode });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return server;
}
