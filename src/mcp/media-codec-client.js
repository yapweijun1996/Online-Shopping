import http from 'node:http';
import { CodecError, MAX_OUTPUT, TOTAL_MS, sha256, sourceContract, decodeOutput, CODEC_READY_PATH, CODEC_READY_TEXT, CODEC_READY_MAX_BYTES } from './media-codec-wire.js';

/** Transport only. Caller retains all tenant/grant/consent/staging/transaction duties. */
export async function decodeViaSocket({ socketPath, token, bytes, mime, signal }) {
  const digest = sha256(bytes);
  sourceContract(bytes, mime, digest);
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') ||
      !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new CodecError('CONFIGURATION');
  if (signal?.aborted) throw new CodecError('CANCELLED');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const request = http.request({ socketPath, path: '/v1/decode', method: 'POST', agent: false, signal,
      maxHeaderSize: 4096, headers: { authorization: `Bearer ${token}`, 'content-type': mime,
        'content-length': bytes.length, 'x-source-sha256': digest } }, response => {
      let count = 0;
      const declared = response.headers['content-length'];
      if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/octet-stream' ||
          !/^\d{1,6}$/.test(declared ?? '') || Number(declared) > MAX_OUTPUT) {
        response.destroy(); done(new CodecError('CODEC_FAILED')); return;
      }
      const body = Buffer.allocUnsafe(Number(declared));
      response.on('data', chunk => {
        if (count + chunk.length > body.length) { response.destroy(); done(new CodecError('CODEC_FAILED')); }
        else { chunk.copy(body, count); count += chunk.length; }
      });
      response.on('end', () => {
        try {
          if (count !== Number(declared)) throw 0;
          const result = decodeOutput(body, digest);
          if (result.mime !== mime) throw 0;
          done(null, result);
        } catch { done(new CodecError('CODEC_FAILED')); }
      });
      response.on('error', () => done(new CodecError('CODEC_FAILED')));
      response.on('aborted', () => done(new CodecError('CODEC_FAILED')));
    });
    const timer = setTimeout(() => { request.destroy(); done(new CodecError('DEADLINE')); }, TOTAL_MS);
    request.on('error', () => done(new CodecError(signal?.aborted ? 'CANCELLED' : 'CODEC_FAILED')));
    request.end(bytes);
  });
}

/** Cheap authenticated IPC only; this label is not image attestation. */
export async function probeCodecViaSocket({ socketPath, token, timeoutMs = 1000, signal } = {}) {
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000 ||
      typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) throw new CodecError('CONFIGURATION');
  if (signal?.aborted) throw new CodecError('CANCELLED');
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const done = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(true); };
    const request = http.request({ socketPath, path: CODEC_READY_PATH, method: 'GET', agent: false, signal,
      maxHeaderSize: 2048, headers: { authorization: 'Bearer ' + token } }, response => {
      const names = response.rawHeaders.filter((_, index) => index % 2 === 0).map(name => name.toLowerCase());
      const length = response.headers['content-length'];
      if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/json' || response.headers['cache-control'] !== 'no-store' ||
          names.length !== new Set(names).size || names.some(name => !['content-type', 'content-length', 'cache-control', 'connection', 'date'].includes(name)) ||
          !/^[1-9][0-9]{0,2}$/.test(length ?? '') || Number(length) > CODEC_READY_MAX_BYTES || Number(length) !== Buffer.byteLength(CODEC_READY_TEXT)) {
        response.destroy(); done(new CodecError('CODEC_FAILED')); return;
      }
      const body = Buffer.allocUnsafe(Number(length)); let count = 0;
      response.on('data', chunk => {
        if (count + chunk.length > body.length) { response.destroy(); done(new CodecError('CODEC_FAILED')); }
        else { chunk.copy(body, count); count += chunk.length; }
      });
      response.on('end', () => done(count === body.length && body.toString('utf8') === CODEC_READY_TEXT ? null : new CodecError('CODEC_FAILED')));
      response.on('error', () => done(new CodecError('CODEC_FAILED')));
      response.on('aborted', () => done(new CodecError('CODEC_FAILED')));
    });
    timer = setTimeout(() => { request.destroy(); done(new CodecError('DEADLINE')); }, timeoutMs);
    request.on('error', () => done(new CodecError(signal?.aborted ? 'CANCELLED' : 'CODEC_FAILED')));
    request.end();
  });
}
