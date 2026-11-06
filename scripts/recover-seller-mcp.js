import { readMcpMaintenanceConfig } from '../src/mcp/maintenance-config.js';
import { parseRecoveryArguments, runSellerMcpRecovery } from '../src/mcp/cleanup-runner.js';

try {
  const options = parseRecoveryArguments(process.argv.slice(2));
  console.log(JSON.stringify(await runSellerMcpRecovery({ config: readMcpMaintenanceConfig(), ...options })));
} catch {
  console.error('MCP credential recovery failed. Keep traffic stopped and check private configuration and target lifecycle.');
  process.exitCode = 1;
}
