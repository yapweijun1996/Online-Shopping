import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { ApiError } from '../http.js';
import { MEDIA_FILE_MIME_TYPES, mediaFileMimeHint } from './media-contracts.js';
import { MEDIA_LIMITS } from './media-schema.js';

const MAX_BYTES = MEDIA_LIMITS.sourceBytes;
const DEADLINE_MS = 10000;
let activeDownloads = 0;
const invalid = (code = 'MEDIA_FILE_INPUT') => new ApiError(400, code, 'Invalid media file reference.');
const unavailable = () => new ApiError(503, 'MEDIA_FILE_UNAVAILABLE', 'Media file could not be read safely.');

// Source capabilities are untrusted inputs, never seller or product authority.
export function validateMediaFileUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\#]/.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' ||
      url.username || url.password || url.hash || (url.port && url.port !== '443')) throw invalid();
  // ChatGPT file bridges also use regional hosts (observed sdmntprseasia).
  // Permit one DNS label within OpenAI's documented file domain, never suffix lookalikes.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.oaiusercontent\.com$/.test(url.hostname)) {
    const error = invalid('MEDIA_FILE_SOURCE');
    // Only the public source hostname is diagnostic; never retain a signed URL.
    error.sourceHost = /^[a-z0-9.-]{1,253}$/.test(url.hostname) ? url.hostname : null;
    throw error;
  }
  return url;
}

function validateMediaSourceUrl(value) {
  // Only clean, absolute DNS names. No literal IPs, signed queries, userinfo,
  // local names or URL-parser aliases in the authority (including empty userinfo).
  if (typeof value !== 'string' || value.length > 4096 || /[\s\x00-\x1f\x7f\\?#]/.test(value) ||
      !/^https:\/\/[a-z0-9.-]+(?::443)?(?:\/|$)/i.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  const host = url.hostname, label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!host.includes('.') || host.length > 253 || isIP(host) || host.split('.').some(part => !label.test(part)) ||
      /(?:^|\.)(?:localhost|local|internal|home\.arpa|onion)$/.test(host)) throw invalid();
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
      (a === 203 && b === 0 && c === 113) || address === '168.63.129.16'); // Azure platform virtual IP.
  }
  if (family !== 6 || /[.%]/.test(address)) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left,...Array(8-left.length-right.length).fill('0'),...right] : left;
  const [a,b] = words.map(value => Number.parseInt(value,16));
  // Only global unicast; exclude translation/tunnel, special-purpose and documentation ranges.
  return a >= 0x2000 && a < 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
}

export function detectMediaMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1',0,4) === 'RIFF' && bytes.toString('latin1',8,12) === 'WEBP') return 'image/webp';
  throw invalid('MEDIA_FILE_CONTENT');
}

function makeDownloader(resolve, request, timeoutMs) {
  return async function download(url, publicSource) {
    // Shared across both download transports and all shops; stage quota is acquired later.
    if (activeDownloads >= 4) throw unavailable();
    activeDownloads++;
    let active, timer, pendingDns, expired = false;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(unavailable()); active?.destroy(); }, timeoutMs);
    });
    try {
      const work = (async () => {
        // User-selected names are absolute in DNS; never try resolver search suffixes.
        pendingDns = resolve(publicSource ? url.hostname + '.' : url.hostname, { all: true, verbatim: true });
        const addresses = await pendingDns;
        pendingDns = undefined;
        if (expired) throw unavailable();
        if (!Array.isArray(addresses) || !addresses.length || addresses.some(row => !isPublicMediaAddress(row.address) ||
            row.family !== isIP(row.address))) throw unavailable();
        const selected = addresses[0];
        const { bytes, contentType } = await new Promise((accept, reject) => {
          active = request(url, { method: 'GET', agent: false, rejectUnauthorized: true,
            headers: { 'Accept': 'image/jpeg,image/png,image/webp', 'Accept-Encoding': 'identity' },
            // Pin the validated DNS answer while preserving hostname/SNI/TLS checks.
            lookup: (_host, options, callback) => options?.all
              ? callback(null, [{ address: selected.address, family: selected.family }])
              : callback(null, selected.address, selected.family),
          }, response => {
            const fail = (error = unavailable()) => { response.destroy(); active.destroy(); reject(error); };
            if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) return fail();
            const type = response.headers['content-type'];
            const contentType = typeof type === 'string' ? type.split(';', 1)[0].trim().toLowerCase() : undefined;
            if (publicSource && !['image/png','image/jpeg','image/webp'].includes(contentType)) return fail(invalid('MEDIA_FILE_MIME'));
            const length = response.headers['content-length'];
            if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) < 1 || Number(length) > MAX_BYTES)) return fail();
            let count = 0;
            const bytes = Buffer.allocUnsafe(length === undefined ? MAX_BYTES : Number(length));
            response.on('data', data => {
              if (count + data.length > bytes.length) return fail();
              data.copy(bytes, count);
              count += data.length;
            });
            response.on('error', () => reject(unavailable()));
            response.on('aborted', () => reject(unavailable()));
            response.on('end', () => {
              if (!count || !response.complete || (length !== undefined && Number(length) !== count)) return reject(unavailable());
              accept({ bytes: bytes.subarray(0, count), contentType });
            });
          });
          active.on('error', () => reject(unavailable()));
          active.end();
        });
        const mime = detectMediaMime(bytes);
        if (publicSource && contentType !== mime) throw invalid('MEDIA_FILE_MIME');
        return { bytes, mime };
      })();
      return await Promise.race([work,timedOut]);
    } catch (error) {
      active?.destroy();
      if (error instanceof ApiError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
      // getaddrinfo cannot be cancelled. Keep its permit until an abandoned lookup settles.
      const release = () => { activeDownloads--; };
      if (pendingDns) Promise.resolve(pendingDns).then(release, release);
      else release();
    }
  };
}

const forFile = download => async file => {
  if (!file || typeof file !== 'object' || Array.isArray(file) ||
      Object.keys(file).some(key => !['download_url','file_id','mime_type','file_name'].includes(key)) ||
      typeof file.file_id !== 'string' || !file.file_id.length || file.file_id.length > 256 ||
      (file.mime_type !== undefined && !MEDIA_FILE_MIME_TYPES.includes(file.mime_type)) ||
      (file.file_name !== undefined && (typeof file.file_name !== 'string' || file.file_name.length > 256))) throw invalid();
  const { bytes, mime } = await download(validateMediaFileUrl(file.download_url), false);
  const hint = mediaFileMimeHint(file.mime_type);
  if (hint !== undefined && hint !== mime) throw invalid('MEDIA_FILE_MIME');
  return { bytes, mime, sourceSha256: createHash('sha256').update(bytes).digest('hex') };
};
const forSource = download => async url => download(validateMediaSourceUrl(url), true);
const download = makeDownloader(lookup, https.request, DEADLINE_MS);
export const downloadMediaFile = forFile(download);
export const downloadMediaSource = forSource(download);

// Synthetic transport tests cannot replace the production closures above.
function testDownloader({ resolve, request, timeoutMs = DEADLINE_MS }) {
  if (process.env.NODE_ENV !== 'test' || typeof resolve !== 'function' || typeof request !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEADLINE_MS) throw new TypeError('Test downloader requires explicit test configuration.');
  return makeDownloader(resolve,request,timeoutMs);
}
export const createMediaFileDownloaderForTest = options => forFile(testDownloader(options));
export const createMediaSourceDownloaderForTest = options => forSource(testDownloader(options));
