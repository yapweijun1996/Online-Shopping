import { readConfig } from '../src/config.js';
import { parseCleanupArguments, runSellerMcpCleanup } from '../src/mcp/cleanup-runner.js';

try {
  const options = parseCleanupArguments(process.argv.slice(2));
  console.log(JSON.stringify(await runSellerMcpCleanup({ config: readConfig(), ...options })));
} catch {
  // Database/client errors can include credentials or private row values.
  console.error('MCP cleanup failed. Check the arguments, private configuration and target lifecycle.');
  process.exitCode = 1;
}
