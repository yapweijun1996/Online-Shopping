import { mcpMediaRuntimeEnabled } from './deployment-profile.js';
import { createMediaCoordinator } from './media-coordinator.js';
import { createMediaNativeSession } from './media-native.js';
import { readMediaCodecToken } from './media-config.js';

/** Trusted server construction only. Never launches a worker or accepts model paths/secrets. */
export function createMediaRuntime({ store, binding, config, tenantGuard, quickLogin, decode }) {
  if (!mcpMediaRuntimeEnabled(config,{tenantGuard,quickLogin}) || (config.production === true && decode !== undefined)) throw new TypeError('Safe trusted media runtime required.');
  if (typeof binding?.issuer !== 'string' || binding.issuer.length > 4000) throw new TypeError('Media review requires a bounded secure issuer.');
  const media = config.mcpMedia;
  const codec = Object.freeze({ socketPath: media.socketPath, token: readMediaCodecToken(media), digest: media.codecDigest });
  const coordinator = createMediaCoordinator({ store, binding, tenantGuard, epoch: config.mcpV2.epoch,
    buildDigest: config.mcpV2.buildDigest, codec, enabled: true, production: config.production, profile: config.mcpV2.profile, quickLogin, decode });
  return Object.freeze({ coordinator, codecDigest: codec.digest,
    nativeSession: options => createMediaNativeSession(codec, { ...options, ...(decode ? { decode } : {}) }) });
}
