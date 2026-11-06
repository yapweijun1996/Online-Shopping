import { readConfig } from '../config.js';

// Only host hygiene commands use this reader. It cannot enable an application,
// worker, OAuth or business operation. Keep real NODE_ENV and DB/tenant secrets.
export function readMcpMaintenanceConfig(env = process.env) {
  const disabled = ['MCP_ENABLED', 'MCP_V2_ENABLED', 'MCP_V2_MEDIA_ENABLED',
    'MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED', 'MCP_V2_CATALOG_MEDIA_CREATE_ENABLED'];
  const removed = new Set([...disabled, 'MCP_V2_PRODUCTION_PROFILE', 'MCP_V2_BACKEND_IDENTITY']);
  const maintenance = {};
  for (const key of Object.keys(env)) if (!removed.has(key) && !key.startsWith('MCP_V2_')) maintenance[key] = env[key];
  for (const key of disabled) maintenance[key] = '0';
  return readConfig(maintenance);
}
