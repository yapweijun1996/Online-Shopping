import http from 'node:http';
import { CodecError, MAX_OUTPUT, TOTAL_MS, sha256, sourceContract, decodeOutput } from './media-codec-wire.js';

/** Transport only. Caller retains all tenant/grant/consent/staging/transaction duties. */
export async function decodeViaSocket({ socketPath, token, bytes, mime }) {
  const digest = sha256(bytes);
  sourceContract(bytes, mime, digest);
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') ||
      !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new CodecError('CONFIGURATION');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const request = http.request({ socketPath, path: '/v1/decode', method: 'POST', agent: false,
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
    request.on('error', () => done(new CodecError('CODEC_FAILED')));
    request.end(bytes);
  });
}
