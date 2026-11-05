import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const invalid = () => { throw new Error('MCP media requires a trusted sealed local codec configuration.'); };
const mode = value => value.mode & 0o7777;
const canonicalPath = value => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || realpathSync(value) !== path.resolve(value)) invalid();
  return path.resolve(value);
};

/** Fixed development harness policy, not remote worker attestation. Never logs secrets. */
export function readMediaCodecToken(config) {
  let descriptor;
  try {
    if (!config || config.enabled !== true || process.platform !== 'linux' || process.getuid() !== 1000 || process.getgid() !== 1000 ||
        typeof config.codecDigest !== 'string' || !/^[a-f0-9]{64}$/.test(config.codecDigest)) invalid();
    const socketPath = canonicalPath(config.socketPath), tokenFile = canonicalPath(config.tokenFile);
    const socketDir = path.dirname(socketPath), base = path.dirname(socketDir);
    if (path.dirname(tokenFile) !== base) invalid();
    const dir = lstatSync(socketDir), parent = lstatSync(base), socket = lstatSync(socketPath), file = lstatSync(tokenFile);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== 1000 || dir.gid !== 1000 || mode(dir) !== 0o710 ||
        !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 1000 || parent.gid !== 1000 || mode(parent) !== 0o700 ||
        !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== 10001 || socket.gid !== 1000 || mode(socket) !== 0o660 ||
        !file.isFile() || file.isSymbolicLink() || file.uid !== 1000 || file.gid !== 1000 || mode(file) !== 0o640 || file.size !== 43) invalid();
    descriptor = openSync(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== file.dev || opened.ino !== file.ino || mode(opened) !== 0o640 ||
        opened.uid !== 1000 || opened.gid !== 1000 || opened.size !== 43) invalid();
    const token = readFileSync(descriptor, 'utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').length !== 32 ||
        Buffer.from(token, 'base64url').toString('base64url') !== token) invalid();
    return token;
  } catch { invalid(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function readMcpMediaConfig(env, { production, mcpEnabled, mcpV2, shopMode, sellerQuickLogin, dbPath } = {}) {
  const flag = env.MCP_V2_MEDIA_ENABLED ?? '0';
  if (!['0','1'].includes(flag)) throw new Error('MCP_V2_MEDIA_ENABLED must be 0 or 1.');
  if (flag === '0') return Object.freeze({ enabled: false });
  if (production === true || !['development','test'].includes(env.NODE_ENV)) throw new Error('MCP media requires explicit development or test mode; production activation is blocked.');
  if (mcpEnabled !== true || mcpV2?.enabled !== true || shopMode !== 'manual' || sellerQuickLogin !== false) throw new Error('MCP media requires safe MCP v2 and a manual shop without quick login.');
  const identity = env.MCP_V2_MEDIA_CODEC_IDENTITY;
  if (typeof identity !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(identity)) throw new Error('MCP_V2_MEDIA_CODEC_IDENTITY must be a trusted configured sha256 artifact identity.');
  const config = Object.freeze({ enabled: true, socketPath: env.MCP_V2_MEDIA_SOCKET_PATH, tokenFile: env.MCP_V2_MEDIA_TOKEN_FILE, codecDigest: identity.slice(7) });
  try {
    const base = path.dirname(path.dirname(canonicalPath(config.socketPath)));
    const publicPath = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
    const databasePath = path.dirname(path.resolve(dbPath ?? '.local/shop.db'));
    const boundaries = [publicPath, databasePath];
    try { boundaries.push(realpathSync(databasePath)); } catch { /* A fresh database directory may not exist. */ }
    if (boundaries.some(parent => base === parent || base.startsWith(parent + path.sep))) invalid();
    readMediaCodecToken(config);
  } catch { invalid(); }
  return config;
}
