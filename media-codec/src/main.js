import { startCodec } from './server.js';

// Fixed container paths. No caller path, URL, DB or application configuration.
try {
  if (process.getuid() !== 10001 || process.getgid() !== 1000) throw new Error('Invalid runtime identity.');
  const { decodeImage } = await import('./decode.js');
  const server = await startCodec({ socketPath: '/run/media-codec/codec.sock',
    tokenFile: '/run/media-codec-token', decode: decodeImage });
  process.once('SIGTERM', () => { server.close(); setTimeout(() => process.exit(0), 100).unref(); });
} catch { process.stderr.write('CODEC_START_FAILED\n'); process.exit(1); }
