import { readMcpMaintenanceConfig } from '../src/mcp/maintenance-config.js';
import { parseCleanupArguments, runSellerMcpCleanup, runAllSellerMcpCleanup } from '../src/mcp/cleanup-runner.js';

try {
  const options = parseCleanupArguments(process.argv.slice(2));
  const run = options.all ? runAllSellerMcpCleanup : runSellerMcpCleanup;
  console.log(JSON.stringify(await run({ config: readMcpMaintenanceConfig(), ...options })));
} catch {
  // Database/client errors can include credentials or private row values.
  console.error('MCP cleanup failed. Check the arguments, private configuration and target lifecycle.');
  process.exitCode = 1;
}
