import { readMediaCodecToken } from './media-config.js';
import { probeCodecViaSocket } from './media-codec-client.js';

// Validated config only. No decode, database, queue reservation or secret cache.
export async function mediaCodecReady(config, { timeoutMs = 1000 } = {}) {
  if (config?.enabled !== true || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000) return false;
  try {
    const token = readMediaCodecToken(config);
    return await probeCodecViaSocket({ socketPath: config.socketPath, token, timeoutMs });
  } catch { return false; }
}
