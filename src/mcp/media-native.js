import { ApiError } from '../http.js';
import { MEDIA_LIMITS } from './media-schema.js';
import { decodeViaSocket } from './media-codec-client.js';
import { sourceContract, decodeOutput, encodeOutput } from './media-codec-wire.js';
const failed = () => new ApiError(503, 'MEDIA_CODEC_FAILED', 'Media validation failed.');
const expired = () => new ApiError(503, 'MEDIA_DEADLINE', 'Media validation exceeded its time budget.');

/** One engine-owned lock-free resolve budget, shared by upload and existing layout. */
export function createMediaNativeSession(codec, { signal, deadline, decode = decodeViaSocket }) {
  if (!Number.isFinite(deadline) || typeof decode !== 'function') throw new TypeError('A bounded trusted media session is required.');
  const stop = Math.min(deadline, performance.now() + MEDIA_LIMITS.coordinatorMs);
  let calls = 0;
  return Object.freeze({
    async decode(bytes, mime, sha256) {
      if (signal?.aborted || stop - performance.now() < MEDIA_LIMITS.decodeMs) throw expired();
      if (++calls > MEDIA_LIMITS.oldAssets + 1) throw failed();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MEDIA_LIMITS.sourceBytes) throw failed();
      const input = Buffer.from(bytes);
      try { sourceContract(input, mime, sha256); } catch { throw failed(); }
      const controller = new AbortController(), cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(expired()); }, MEDIA_LIMITS.decodeMs); });
      try {
        const raw = await Promise.race([decode({ socketPath: codec.socketPath, token: codec.token, bytes: input, mime, signal: controller.signal }), timeout]);
        const result = decodeOutput(encodeOutput(raw), sha256);
        if (signal?.aborted || performance.now() >= stop) throw expired();
        if (result.mime !== mime) throw failed();
        return result;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw failed();
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    },
  });
}
