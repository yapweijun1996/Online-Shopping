import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { ApiError } from '../http.js';

const MAX_BYTES = 524288;
const DEADLINE_MS = 10000;
let activeDownloads = 0;
const invalid = () => new ApiError(400, 'MEDIA_FILE_INPUT', 'Invalid media file reference.');
const unavailable = () => new ApiError(503, 'MEDIA_FILE_UNAVAILABLE', 'Media file could not be read safely.');

// Source capabilities are untrusted inputs, never seller or product authority.
export function validateMediaFileUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\#]/.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'files.oaiusercontent.com' ||
      url.username || url.password || url.hash || (url.port && url.port !== '443')) throw invalid();
  return url;
}

export function isPublicMediaAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('.')) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left,...Array(8-left.length-right.length).fill('0'),...right] : left;
  const [a,b,c] = words.map(value => Number.parseInt(value,16));
  // Only global unicast; exclude translation/tunnel, special-purpose and documentation ranges.
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && a !== 0x3fff &&
    !(a === 0x2001 && (b === 0 || b === 2 || b === 0xdb8 || (b >= 0x10 && b <= 0x2f))) &&
    !(a === 0x2001 && b === 0x20 && c === 0);
}

function sniff(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  throw invalid();
}

function makeDownloader(resolve, request, timeoutMs) {
  return async function download(file) {
    if (!file || typeof file !== 'object' || Array.isArray(file) ||
        Object.keys(file).some(key => !['download_url','file_id','mime_type','file_name'].includes(key)) ||
        typeof file.file_id !== 'string' || !file.file_id.length || file.file_id.length > 256 ||
        (file.mime_type !== undefined && !['image/jpeg','image/png','image/webp'].includes(file.mime_type)) ||
        (file.file_name !== undefined && (typeof file.file_name !== 'string' || file.file_name.length > 256))) throw invalid();
    const url = validateMediaFileUrl(file.download_url);
    // Bound pre-stage buffering too; stage quota is acquired only after download.
    if (activeDownloads >= 4) throw unavailable();
    activeDownloads++;
    let active, timer, expired = false;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(unavailable()); active?.destroy(); }, timeoutMs);
    });
    try {
      const work = (async () => {
        const addresses = await resolve(url.hostname, { all: true, verbatim: true });
        if (expired) throw unavailable();
        if (!Array.isArray(addresses) || !addresses.length || addresses.some(row => !isPublicMediaAddress(row.address) ||
            row.family !== isIP(row.address))) throw unavailable();
        const selected = addresses[0];
        const bytes = await new Promise((accept, reject) => {
          active = request(url, { method: 'GET', agent: false, headers: { 'Accept': 'image/jpeg,image/png,image/webp', 'Accept-Encoding': 'identity' },
            // Pin the validated DNS answer while preserving hostname/SNI/TLS checks.
            lookup: (_host, options, callback) => options?.all
              ? callback(null, [{ address: selected.address, family: selected.family }])
              : callback(null, selected.address, selected.family),
          }, response => {
            const fail = () => { response.destroy(); active.destroy(); reject(unavailable()); };
            if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) return fail();
            const length = response.headers['content-length'];
            if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) < 1 || Number(length) > MAX_BYTES)) return fail();
            let count = 0; const chunks = [];
            response.on('data', data => {
              const chunk = Buffer.from(data); count += chunk.length;
              if (count > MAX_BYTES) return fail();
              chunks.push(chunk);
            });
            response.on('error', () => reject(unavailable()));
            response.on('aborted', () => reject(unavailable()));
            response.on('end', () => {
              if (!count || !response.complete || (length !== undefined && Number(length) !== count)) return reject(unavailable());
              accept(Buffer.concat(chunks,count));
            });
          });
          active.on('error', () => reject(unavailable()));
          active.end();
        });
        const mime = sniff(bytes);
        if (file.mime_type !== undefined && file.mime_type !== mime) throw invalid();
        return { bytes, mime, sourceSha256: createHash('sha256').update(bytes).digest('hex') };
      })();
      return await Promise.race([work,timedOut]);
    } catch (error) {
      active?.destroy();
      if (error instanceof ApiError) throw error;
      throw unavailable();
    } finally { clearTimeout(timer); activeDownloads--; }
  };
}

export const downloadMediaFile = makeDownloader(lookup, https.request, DEADLINE_MS);

// Synthetic transport tests cannot replace the production closure above.
export function createMediaFileDownloaderForTest({ resolve, request, timeoutMs = DEADLINE_MS }) {
  if (process.env.NODE_ENV !== 'test' || typeof resolve !== 'function' || typeof request !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEADLINE_MS) throw new TypeError('Test downloader requires explicit test configuration.');
  return makeDownloader(resolve,request,timeoutMs);
}
