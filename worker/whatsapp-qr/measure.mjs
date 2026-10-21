import { performance } from 'node:perf_hooks';
const start = performance.now();
const { workload } = await import('./offline.mjs');
const importedMs = performance.now() - start;
await new Promise(resolve => setTimeout(resolve, 1000));
const idle = process.memoryUsage();
const result = await workload(500);
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  importMs: importedMs, idle, workload: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS,
  records: result.store.records.size, qrPngBytes: result.png.length }, null, 2));
