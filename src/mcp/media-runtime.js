import { createMediaCoordinator } from './media-coordinator.js';
import { createMediaNativeSession } from './media-native.js';
import { readMediaCodecToken } from './media-config.js';

/** Trusted server construction only. Never launches a worker or accepts model paths/secrets. */
export function createMediaRuntime({ store, binding, config, tenantGuard, quickLogin, decode }) {
  if (config?.mcpMedia?.enabled !== true || config.mcpV2?.enabled !== true || config.mcpEnabled !== true ||
      config.production === true || config.shopMode !== 'manual' || quickLogin !== false ||
      typeof tenantGuard?.withActiveTenant !== 'function') throw new TypeError('Safe development media runtime required.');
  if (typeof binding?.issuer !== 'string' || binding.issuer.length > 4000) throw new TypeError('Media review requires a bounded secure issuer.');
  const media = config.mcpMedia;
  const codec = Object.freeze({ socketPath: media.socketPath, token: readMediaCodecToken(media), digest: media.codecDigest });
  const coordinator = createMediaCoordinator({ store, binding, tenantGuard, epoch: config.mcpV2.epoch,
    buildDigest: config.mcpV2.buildDigest, codec, enabled: true, production: false, quickLogin: false, decode });
  return Object.freeze({ coordinator, codecDigest: codec.digest,
    nativeSession: options => createMediaNativeSession(codec, { ...options, ...(decode ? { decode } : {}) }) });
}
