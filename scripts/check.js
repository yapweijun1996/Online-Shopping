import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const directories = ['src', 'src/postgres', 'public/shared', 'public/shop', 'public/seller', 'public/demo', 'scripts'];
for (const directory of directories) {
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.js'))) {
    const file = `${directory}/${name}`;
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript syntax checks passed.');

const brandCheck = spawnSync(process.execPath, ['scripts/check-brand.js'], { stdio: 'inherit' });
if (brandCheck.status !== 0) process.exit(brandCheck.status || 1);
