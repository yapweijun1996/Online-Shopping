import { startCodec } from './server.js';
import { decodeImage } from './decode.js';

// Fixed container paths. No caller path, URL, DB or application configuration.
try {
  const server = await startCodec({ socketPath: '/run/media-codec/codec.sock',
    tokenFile: '/run/media-codec-token', decode: decodeImage });
  process.once('SIGTERM', () => { server.close(); setTimeout(() => process.exit(0), 100).unref(); });
} catch { process.stderr.write('CODEC_START_FAILED\n'); process.exit(1); }
