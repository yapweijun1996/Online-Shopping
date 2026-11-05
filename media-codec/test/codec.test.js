import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, writeFile, rm, lstat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import sharp from 'sharp';
import { image } from './fixtures.js';
import { decodeImage } from '../src/decode.js';
import { sha256, MIME, encodeOutput, decodeOutput, MAX_SOURCE, MAX_PIXELS } from '../src/contract.js';
import { startCodec, createCodecServer } from '../src/server.js';
import { decodeViaSocket } from '../src/client.js';

test('fully decodes allowed formats and validates bounded hash-bound binary receipts', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const bytes = await image(format);
    const result = await decodeImage(bytes, MIME[format], sha256(bytes));
    assert.equal(result.width, 24); assert.equal(result.height, 16);
    assert.ok(result.imageBytes <= MAX_SOURCE); assert.ok(result.thumbnailBytes <= 81920);
    const decoded = decodeOutput(encodeOutput(result), sha256(bytes));
    const repeated = await decodeImage(bytes, MIME[format], sha256(bytes));
    assert.deepEqual(repeated.image, result.image); assert.deepEqual(repeated.thumbnail, result.thumbnail);
    assert.equal(decoded.mime, MIME[format]);
    assert.equal((await sharp(decoded.image).metadata()).format, format);
    assert.equal((await sharp(decoded.thumbnail).metadata()).format, 'png');
    assert.throws(() => decodeOutput(encodeOutput(result), '0'.repeat(64)), /CODEC_FAILED/);
    const corrupt = encodeOutput(result); corrupt[corrupt.length - 1] ^= 1;
    assert.throws(() => decodeOutput(corrupt, sha256(bytes)), /CODEC_FAILED/);
  }
});
test('applies EXIF orientation to pixels then strips all metadata', async () => {
  const bytes = await image('jpeg', { orientation: 6 });
  const result = await decodeImage(bytes, MIME.jpeg, sha256(bytes));
  assert.deepEqual([result.width, result.height], [16, 24]);
  const metadata = await sharp(result.image).metadata();
  for (const name of ['exif', 'icc', 'xmp', 'iptc', 'orientation']) assert.equal(metadata[name], undefined);
});
test('rejects APNG controls and JPEG MPF even when a still loader would ignore them', async () => {
  const png = await image();
  // Generated ancillary PNG control chunk with CRC; no downloaded images.
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  }
  const control = Buffer.alloc(8); control.writeUInt32BE(1);
  const animatedPng = Buffer.concat([png.subarray(0, 33), chunk('acTL', control), png.subarray(33)]);
  await assert.rejects(decodeImage(animatedPng, MIME.png, sha256(animatedPng)), /INVALID_IMAGE/);
  const jpeg = await image('jpeg');
  const mpf = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([255, 226, 0, 6]), Buffer.from('MPF\0'), jpeg.subarray(2)]);
  await assert.rejects(decodeImage(mpf, MIME.jpeg, sha256(mpf)), /INVALID_IMAGE/);
});
test('rejects fixed canonical output above512KiB without changing quality or dimensions', async () => {
  const pixels = Buffer.alloc(2048 * 2048 * 3); let value = 12345;
  for (let i = 0; i < pixels.length; i++) { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; pixels[i] = value >>> 24; }
  const bytes = await sharp(pixels, { raw: { width: 2048, height: 2048, channels: 3 } }).jpeg({ quality: 5 }).toBuffer();
  assert.ok(bytes.length <= MAX_SOURCE);
  await assert.rejects(decodeImage(bytes, MIME.jpeg, sha256(bytes)), /INVALID_IMAGE/);
});
test('closed canonical response header rejects duplicate fields, unknown fields, dimensions and forged receipts', async () => {
  const bytes = await image(); const result = await decodeImage(bytes, MIME.png, sha256(bytes));
  const { image: full, thumbnail, ...header } = result;
  function frame(value, binary = full) {
    const json = Buffer.from(value); const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
    return Buffer.concat([length, json, binary, thumbnail]);
  }
  for (const json of [JSON.stringify({ ...header, unexpected: true }), JSON.stringify({ ...header, width: 0 }),
    JSON.stringify({ ...header, codec: 'untrusted' }), JSON.stringify({ ...header, imageSha256: '0'.repeat(64) }),
    `{"version":0,${JSON.stringify(header).slice(1)}`, JSON.stringify(header) + ' ']) {
    assert.throws(() => decodeOutput(frame(json), sha256(bytes)), /CODEC_FAILED/);
  }
  const fake = Buffer.alloc(full.length, 65);
  assert.throws(() => decodeOutput(frame(JSON.stringify({ ...header, imageSha256: sha256(fake) }), fake), sha256(bytes)), /CODEC_FAILED/);
});
test('rejects digest/mime/length/signature-only/truncated/non-image input without native error text', async () => {
  const bytes = await image();
  for (const [data, mime, digest] of [[bytes, MIME.jpeg, sha256(bytes)], [bytes, MIME.png, '0'.repeat(64)],
    [bytes.subarray(0, 32), MIME.png, sha256(bytes.subarray(0, 32))],
    [Buffer.from('<svg/>'), MIME.png, sha256(Buffer.from('<svg/>'))],
    [Buffer.alloc(MAX_SOURCE + 1), MIME.png, sha256(Buffer.alloc(MAX_SOURCE + 1))]]) {
    await assert.rejects(decodeImage(data, mime, digest), error => error.message === 'INVALID_IMAGE');
  }
});
test('rejects oversized raster,16bit and animated WebP rather than decoding only first frame', async () => {
  const over = await image('png', { width: 2049, height: 2048 });
  assert.ok(2049 * 2048 > MAX_PIXELS);
  await assert.rejects(decodeImage(over, MIME.png, sha256(over)), /INVALID_IMAGE/);
  const highDepth = await sharp({ create: { width: 2, height: 2, channels: 3,
    background: 'red' } }).toColourspace('rgb16').png().toBuffer();
  await assert.rejects(decodeImage(highDepth, MIME.png, sha256(highDepth)), /INVALID_IMAGE/);
  const frames = Buffer.alloc(8 * 16 * 4, 120); frames.fill(220, 8 * 8 * 4);
  const animated = await sharp(frames, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } })
    .webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  await assert.rejects(decodeImage(animated, MIME.webp, sha256(animated)), /INVALID_IMAGE/);
});

async function fixture(t, decode = decodeImage) {
  const dir = await mkdtemp(join(tmpdir(), 'codec-unit-')); await chmod(dir, 0o700);
  const socketDir = join(dir, 'socket'); await mkdir(socketDir); await chmod(socketDir, 0o730);
  const token = randomBytes(32).toString('base64url');
  const tokenFile = join(dir, 'token'); await writeFile(tokenFile, token, { mode: 0o640 }); await chmod(tokenFile, 0o640);
  const socketPath = join(socketDir, 'codec.sock');
  const server = await startCodec({ socketPath, tokenFile, decode });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { socketPath, token };
}
test('private socket roundtrip rejects wrong token and invalid source with controlled transport errors', async t => {
  const connection = await fixture(t);
  assert.equal((await lstat(connection.socketPath)).mode & 0o7777, 0o660);
  const bytes = await image();
  const result = await decodeViaSocket({ ...connection, bytes, mime: MIME.png });
  assert.equal(result.sourceSha256, sha256(bytes));
  await assert.rejects(decodeViaSocket({ ...connection, token: 'A'.repeat(43), bytes, mime: MIME.png }), /CODEC_FAILED/);
  await assert.rejects(decodeViaSocket({ ...connection, bytes: bytes.subarray(0, 32), mime: MIME.png }), /CODEC_FAILED/);
});
test('startup requires host-owned group-scoped directory/token with exact initial modes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codec-config-')); await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socketDir = join(dir, 'socket'); await mkdir(socketDir); await chmod(socketDir, 0o730);
  const tokenFile = join(dir, 'token'); await writeFile(tokenFile, 'A'.repeat(43), { mode: 0o640 }); await chmod(tokenFile, 0o640);
  const options = { socketPath: join(socketDir, 'codec.sock'), tokenFile, decode: decodeImage };
  for (const mode of [0o700, 0o710, 0o770, 0o1730, 0o2730]) {
    await chmod(socketDir, mode); await assert.rejects(startCodec(options), /CONFIGURATION/);
  }
  await chmod(socketDir, 0o730);
  for (const mode of [0o600, 0o660, 0o644, 0o1640]) {
    await chmod(tokenFile, mode); await assert.rejects(startCodec(options), /CONFIGURATION/);
  }
  await chmod(tokenFile, 0o640);
  const tokenLink = join(dir, 'token-link'); await symlink(tokenFile, tokenLink);
  await assert.rejects(startCodec({ ...options, tokenFile: tokenLink }), /CONFIGURATION/);
  const socketLink = join(dir, 'socket-link'); await symlink(socketDir, socketLink);
  await assert.rejects(startCodec({ ...options, socketPath: join(socketLink, 'codec.sock') }), /CONFIGURATION/);
});
test('fixed executable refuses the host identity before loading the native decoder', async () => {
  assert.equal(process.getuid(), 1000); assert.equal(process.getgid(), 1000);
  await assert.rejects(promisify(execFile)(process.execPath, [new URL('../src/main.js', import.meta.url).pathname]),
    error => error.code === 1 && error.stdout === '' && error.stderr === 'CODEC_START_FAILED\n');
});
test('one active decode, four waiting jobs and fifth queued job rejected before buffering', async t => {
  let unblock, entered = 0;
  const latch = new Promise(resolve => { unblock = resolve; });
  const connection = await fixture(t, async (...args) => { entered++; await latch; return decodeImage(...args); });
  const bytes = await image();
  const requests = Array.from({ length: 5 }, () => decodeViaSocket({ ...connection, bytes, mime: MIME.png }));
  while (entered === 0) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(decodeViaSocket({ ...connection, bytes, mime: MIME.png }), /CODEC_FAILED/);
  assert.equal(entered, 1); unblock();
  await Promise.all(requests); assert.equal(entered, 5);
});
test('total deadline includes queued wait and running deadline retires the codec', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codec-time-'));
  const token = randomBytes(32).toString('base64url'); let retired = false;
  const server = createCodecServer({ token, decode: () => new Promise(() => {}), fatal: () => { retired = true; }, totalMs: 80 });
  const socketPath = join(dir, 'codec.sock'); await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const bytes = await image();
  const attempts = await Promise.allSettled(Array.from({ length: 2 }, () => decodeViaSocket({ socketPath, token, bytes, mime: MIME.png })));
  assert.ok(attempts.every(attempt => attempt.status === 'rejected' && attempt.reason.code === 'CODEC_FAILED'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(retired, true);
});
test('rejects duplicate authorization and unknown headers without reading the source', async t => {
  const connection = await fixture(t);
  for (const headers of [ ['Authorization', `Bearer ${connection.token}`, 'Authorization', `Bearer ${connection.token}`],
    ['Authorization', `Bearer ${connection.token}`, 'X-Path', '/tmp/image'] ]) {
    const status = await new Promise((resolve, reject) => {
      const socket = net.connect(connection.socketPath);
      socket.on('error', reject); let response = '';
      socket.on('data', bytes => { response += bytes; });
      socket.on('end', () => resolve(Number(response.split(' ')[1])));
      socket.on('connect', () => {
        const lines = ['POST /v1/decode HTTP/1.1', 'Host: localhost', 'Content-Length: 1', 'Connection: close'];
        for (let i = 0; i < headers.length; i += 2) lines.push(`${headers[i]}: ${headers[i + 1]}`);
        socket.end(`${lines.join('\r\n')}\r\n\r\nx`);
      });
    });
    assert.equal(status, 401);
  }
});
