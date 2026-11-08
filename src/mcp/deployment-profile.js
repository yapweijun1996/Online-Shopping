// Deployment eligibility only. These values never authorize a user or operation.
const NAME = 'seller-operations-v1';
const identity = /^sha256:[0-9a-f]{64}$/;
const fullFlags = ['MCP_ENABLED', 'MCP_V2_ENABLED', 'MCP_V2_MEDIA_ENABLED',
  'MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED', 'MCP_V2_CATALOG_MEDIA_CREATE_ENABLED'];
const v2Flags = fullFlags.slice(1);
const fail = () => { throw new Error('MCP v2 production activation requires a reviewed release profile, complete flags and immutable backend identity.'); };
const secure = value => {
  try { const url = new URL(value); return typeof value === 'string' && url.protocol === 'https:' && url.origin === value && !url.username && !url.password; }
  catch { return false; }
};

export function deploymentProfileAllowsProduction(profile) {
  if (!profile || Object.getPrototypeOf(profile) !== Object.prototype || !Object.isFrozen(profile) ||
      Reflect.ownKeys(profile).length !== 4 || Object.keys(profile).sort().join(',') !== 'backendIdentity,kind,name,version' ||
      Object.values(Object.getOwnPropertyDescriptors(profile)).some(field => !Object.hasOwn(field, 'value'))) return false;
  return profile.version === 1 && profile.kind === 'production' && profile.name === NAME &&
    typeof profile.backendIdentity === 'string' && identity.test(profile.backendIdentity);
}

export function readMcpDeploymentProfile(env, { production = env.NODE_ENV === 'production', mcpEnabled,
  sellerOrigin, shopMode = env.SHOP_MODE ?? 'manual', sellerQuickLogin = env.SELLER_QUICK_LOGIN === '1' } = {}) {
  if (production !== (env.NODE_ENV === 'production')) fail();
  const requested = env.MCP_V2_PRODUCTION_PROFILE;
  if (requested !== undefined && requested !== NAME) fail();
  const enabled = v2Flags.some(flag => env[flag] !== undefined && env[flag] !== '0');
  if (!production) {
    if (requested !== undefined) fail();
    return Object.freeze({ version: 1, kind: enabled ? 'development' : 'disabled', name: NAME });
  }
  if (!enabled && requested === undefined) return Object.freeze({ version: 1, kind: 'disabled', name: NAME });
  if (requested !== NAME || env.NODE_ENV !== 'production' || mcpEnabled !== true ||
      fullFlags.some(flag => env[flag] !== '1') || env.TRUST_PROXY !== '1' || !secure(sellerOrigin) || shopMode !== 'manual' ||
      sellerQuickLogin !== false || ![undefined, '0'].includes(env.SELLER_QUICK_LOGIN)) fail();
  const backendIdentity = env.MCP_V2_BACKEND_IDENTITY;
  if (typeof backendIdentity !== 'string' || !identity.test(backendIdentity)) fail();
  return Object.freeze({ version: 1, kind: 'production', name: NAME, backendIdentity });
}

export function mcpOperationRuntimeEnabled(config, { quickLogin, tenantGuard } = {}) {
  if (config?.mcpEnabled !== true || config.mcpV2?.enabled !== true || config.shopMode === 'public-demo' ||
      quickLogin !== false || typeof tenantGuard?.withActiveTenant !== 'function') return false;
  if (config.production !== true) return true; // Preserve existing isolated constructor semantics.
  return deploymentProfileAllowsProduction(config.mcpV2.profile) && secure(config.sellerOrigin) && config.shopMode === 'manual' &&
    /^[0-9a-f]{64}$/.test(config.mcpV2.buildDigest ?? '') && config.mcpMedia?.enabled === true &&
    /^[0-9a-f]{64}$/.test(config.mcpMedia.codecDigest ?? '') &&
    config.mcpCatalogMediaCreate?.enabled === true && config.mcpCatalogMediaUpdate?.enabled === true;
}

export function mcpMediaRuntimeEnabled(config, context) {
  return mcpOperationRuntimeEnabled(config, context) && config.shopMode === 'manual' &&
    (config.production === false || deploymentProfileAllowsProduction(config.mcpV2.profile)) &&
    config.mcpMedia?.enabled === true && /^[0-9a-f]{64}$/.test(config.mcpMedia.codecDigest ?? '');
}

// Finish is optional within the reviewed full profile, never a substitute for
// it. Production storage must already be installed and structurally verified.
export function mcpFinishRuntimeEnabled(config, context = {}) {
  return config?.mcpFinish?.enabled === true && mcpOperationRuntimeEnabled(config, context) &&
    (config.production === false || deploymentProfileAllowsProduction(config.mcpV2.profile));
}
