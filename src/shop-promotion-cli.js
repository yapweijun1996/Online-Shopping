import { readMcpMaintenanceConfig } from './mcp/maintenance-config.js';
import { parsePromotionArguments, runShopPromotion } from './shop-promotion-runner.js';

try {
  // Explicit production/manual intent is required; never inherit the defaults
  // of a development or sample-site invocation. No schema initialization occurs.
  if (process.env.NODE_ENV !== 'production' || process.env.SHOP_MODE !== 'manual') throw new Error();
  const input = parsePromotionArguments(process.argv.slice(2));
  console.log(JSON.stringify(await runShopPromotion({ config: readMcpMaintenanceConfig(), ...input })));
} catch {
  // Driver errors can include credentials. PREPARED receipts are retained for
  // read-back/retry if a commit outcome or receipt update is uncertain.
  console.error('Shop promotion failed. Check the private plan/receipt and current setup before retrying.');
  process.exitCode = 1;
}
