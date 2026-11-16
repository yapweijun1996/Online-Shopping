import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('seller and shop brand assets follow the synced logo standard', () => {
  const result = spawnSync(process.execPath, ['scripts/check-brand.js'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Brand source, published copies, and seller\/shop references verified/);
});
